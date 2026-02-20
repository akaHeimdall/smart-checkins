import Anthropic from "@anthropic-ai/sdk";
import { getConfig } from "../config";
import { graphGet, graphPost } from "../graph";
import {
  getVoiceProfile,
  logDraft,
  type StyleMode,
} from "../db";
import { createChildLogger } from "../logger";

const log = createChildLogger("draft-creator");

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!_client) {
    const config = getConfig();
    _client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  }
  return _client;
}

// ── Types ────────────────────────────────────────────────────────

interface GraphFullEmail {
  id: string;
  conversationId: string;
  subject: string;
  from: {
    emailAddress: { name: string; address: string };
  };
  toRecipients: Array<{ emailAddress: { name: string; address: string } }>;
  ccRecipients: Array<{ emailAddress: { name: string; address: string } }>;
  body: { contentType: string; content: string };
  receivedDateTime: string;
}

interface DraftResult {
  draftId: string;
  subject: string;
  styleMode: StyleMode;
  bodyPreview: string;
}

// ── Detect which style mode to use for a reply ──────────────────

function detectReplyStyle(email: GraphFullEmail): StyleMode {
  const senderDomain = email.from.emailAddress.address.split("@")[1]?.toLowerCase() || "";

  // Check if it looks casual based on body content
  const bodyLower = stripHtml(email.body.content).toLowerCase();
  const casualSignals = [
    "hey ", "hi ", "yo ", "sup ", "lol", "haha", "btw",
    "gonna", "wanna", "nah", "yep", "nope", "bro", "fam",
  ];
  const isCasual = casualSignals.some((s) => bodyLower.includes(s));
  if (isCasual) return "casual";

  // For now, default internal vs external based on common free email domains
  // A more robust check would use the user's own domain
  const externalDomains = [
    "gmail.com", "yahoo.com", "hotmail.com", "outlook.com",
    "aol.com", "icloud.com", "protonmail.com",
  ];

  // If sender is from a known organization domain (not free email), treat as external formal
  if (!externalDomains.includes(senderDomain)) {
    return "external_formal";
  }

  return "internal_formal";
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

// ── Fetch full email details ────────────────────────────────────

async function fetchFullEmail(emailId: string): Promise<GraphFullEmail> {
  return graphGet<GraphFullEmail>(`/messages/${emailId}`, {
    $select: "id,conversationId,subject,from,toRecipients,ccRecipients,body,receivedDateTime",
  });
}

// ── Generate draft body using Claude + voice profile ────────────

async function generateDraftBody(
  email: GraphFullEmail,
  styleMode: StyleMode
): Promise<string> {
  const client = getClient();

  // Get the voice profile for this style
  const profile = getVoiceProfile(styleMode);

  const modeLabel =
    styleMode === "internal_formal"
      ? "Internal (Formal)"
      : styleMode === "external_formal"
        ? "External (Formal)"
        : "Casual";

  let styleInstructions: string;
  if (profile) {
    styleInstructions = `You have a detailed voice profile for the user's "${modeLabel}" writing style:

${profile.profileData}

Use this profile to write EXACTLY like the user would. Match their greeting patterns, sign-off, tone, sentence structure, vocabulary, and personality markers. The reply should be indistinguishable from one the user wrote themselves.`;
  } else {
    styleInstructions = `No voice profile is available for the "${modeLabel}" style yet. Write a professional, ${styleMode === "casual" ? "friendly and casual" : "polished and clear"} reply. Keep it concise and natural.`;
  }

  const senderName = email.from.emailAddress.name || email.from.emailAddress.address.split("@")[0];
  const bodyText = stripHtml(email.body.content);

  const prompt = `Draft a reply to the following email. The user's name is Saeed.

${styleInstructions}

IMPORTANT RULES:
- Write ONLY the email body text (no subject line, no "From:", no headers)
- Do NOT include any metadata or explanation — just the reply text
- Keep it natural and concise — don't over-explain
- If the email asks a question, address it directly
- If the email is informational, acknowledge appropriately
- This is a DRAFT — the user will review and edit before sending

ORIGINAL EMAIL:
From: ${senderName} <${email.from.emailAddress.address}>
Subject: ${email.subject}
Date: ${new Date(email.receivedDateTime).toLocaleString()}

${bodyText.slice(0, 2000)}

Write the draft reply now:`;

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Claude did not return text for draft generation");
  }

  return textBlock.text.trim();
}

// ── Create draft via Graph API ───────────────────────────────────

async function createGraphDraft(
  originalEmail: GraphFullEmail,
  bodyText: string
): Promise<string> {
  // Build the reply-to draft
  const replySubject = originalEmail.subject.startsWith("Re:")
    ? originalEmail.subject
    : `Re: ${originalEmail.subject}`;

  // Convert plain text to simple HTML
  const bodyHtml = bodyText
    .split("\n")
    .map((line) => (line.trim() === "" ? "<br>" : `<p>${escapeHtml(line)}</p>`))
    .join("");

  const draftPayload = {
    subject: replySubject,
    body: {
      contentType: "HTML",
      content: bodyHtml,
    },
    toRecipients: [
      {
        emailAddress: {
          name: originalEmail.from.emailAddress.name,
          address: originalEmail.from.emailAddress.address,
        },
      },
    ],
    // Link to the conversation so it threads properly
    conversationId: originalEmail.conversationId,
  };

  const result = await graphPost<{ id: string }>(
    "/messages",
    draftPayload
  );

  log.info({ draftId: result.id }, "Draft created in Outlook");
  return result.id;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Main draft creation function ─────────────────────────────────

export async function createDraftReply(
  emailId: string
): Promise<DraftResult> {
  log.info({ emailId }, "Creating draft reply");

  // 1. Fetch the full email
  const email = await fetchFullEmail(emailId);

  // 2. Detect the appropriate style mode
  const styleMode = detectReplyStyle(email);
  log.info({ emailId, styleMode }, "Detected reply style mode");

  // 3. Generate the draft body using Claude + voice profile
  const draftBody = await generateDraftBody(email, styleMode);

  // 4. Create the draft in Outlook via Graph API
  const draftId = await createGraphDraft(email, draftBody);

  // 5. Log the draft
  logDraft(emailId, email.conversationId, styleMode, draftId);

  const result: DraftResult = {
    draftId,
    subject: email.subject.startsWith("Re:")
      ? email.subject
      : `Re: ${email.subject}`,
    styleMode,
    bodyPreview: draftBody.slice(0, 100) + (draftBody.length > 100 ? "..." : ""),
  };

  log.info(
    { draftId, styleMode, subject: result.subject },
    "Draft reply created successfully"
  );

  return result;
}
