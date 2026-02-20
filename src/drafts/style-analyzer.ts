import Anthropic from "@anthropic-ai/sdk";
import { getConfig } from "../config";
import { graphGet } from "../graph";
import {
  upsertVoiceProfile,
  getAllVoiceProfiles,
  type StyleMode,
  type VoiceProfile,
} from "../db";
import { createChildLogger } from "../logger";

const log = createChildLogger("style-analyzer");

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!_client) {
    const config = getConfig();
    _client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  }
  return _client;
}

// ── Types for Graph API sent mail response ──────────────────────

interface GraphMailMessage {
  id: string;
  subject: string;
  body: { contentType: string; content: string };
  toRecipients: Array<{
    emailAddress: { name: string; address: string };
  }>;
  sentDateTime: string;
}

interface GraphMailResponse {
  value: GraphMailMessage[];
}

// ── Internal domain detection ────────────────────────────────────
// Emails to these domains are considered "internal"
// The user's own domain will be auto-detected from their sent mail

let _userDomain: string | null = null;

function detectUserDomain(messages: GraphMailMessage[]): string | null {
  // Look at the sender patterns in "to" addresses — the most common
  // non-external domain is likely the user's org
  const domainCounts = new Map<string, number>();
  for (const msg of messages) {
    for (const r of msg.toRecipients) {
      const domain = r.emailAddress.address.split("@")[1]?.toLowerCase();
      if (domain) {
        domainCounts.set(domain, (domainCounts.get(domain) || 0) + 1);
      }
    }
  }

  // Return the most-used domain as the user's internal domain
  let maxDomain: string | null = null;
  let maxCount = 0;
  for (const [domain, count] of domainCounts) {
    if (count > maxCount) {
      maxDomain = domain;
      maxCount = count;
    }
  }
  return maxDomain;
}

// ── Classify a sent email into a style mode ──────────────────────

function classifyEmail(
  msg: GraphMailMessage,
  userDomain: string
): StyleMode {
  const recipients = msg.toRecipients.map((r) =>
    r.emailAddress.address.toLowerCase()
  );

  const isInternal = recipients.some((addr) => addr.endsWith(`@${userDomain}`));

  // Simple heuristic: if body is short and uses casual language cues
  const bodyText = stripHtml(msg.body.content).toLowerCase();
  const casualSignals = [
    "hey ",
    "hi ",
    "yo ",
    "sup ",
    "lol",
    "haha",
    "btw",
    "gonna",
    "wanna",
    "gotta",
    "nah",
    "yep",
    "nope",
    "cool",
    "awesome",
    "dope",
    "bro",
    "fam",
    "💯",
    "😂",
    "🙏",
    "👀",
  ];

  const isCasual = casualSignals.some((signal) => bodyText.includes(signal));

  if (isCasual) return "casual";
  if (isInternal) return "internal_formal";
  return "external_formal";
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

// ── Fetch sent mail samples from Graph API ───────────────────────

async function fetchSentMail(count: number): Promise<GraphMailMessage[]> {
  log.info({ count }, "Fetching sent mail samples from Graph API");

  const response = await graphGet<GraphMailResponse>(
    "/mailFolders/sentitems/messages",
    {
      $top: String(count),
      $select: "id,subject,body,toRecipients,sentDateTime",
      $orderby: "sentDateTime desc",
    }
  );

  log.info(
    { fetched: response.value.length },
    "Fetched sent mail samples"
  );
  return response.value;
}

// ── Analyze style using Claude ───────────────────────────────────

async function analyzeStyleWithClaude(
  samples: string[],
  styleMode: StyleMode
): Promise<string> {
  const client = getClient();

  const modeLabel =
    styleMode === "internal_formal"
      ? "Internal (Formal)"
      : styleMode === "external_formal"
        ? "External (Formal)"
        : "Casual";

  const prompt = `Analyze the following ${samples.length} email samples written by the user in their "${modeLabel}" communication style. Extract a detailed voice profile that can be used to generate future emails that sound exactly like the user.

Focus on:
1. **Greeting patterns** — How they open emails (e.g., "Hi [Name],", "Good morning,", "Hey!", no greeting at all)
2. **Sign-off patterns** — How they close (e.g., "Best,", "Thanks,", "Blessings,", name only, no sign-off)
3. **Tone** — Professional, warm, direct, enthusiastic, measured, etc.
4. **Sentence structure** — Short and punchy vs. longer flowing sentences. Use of fragments.
5. **Vocabulary** — Any distinctive words, phrases, or expressions they commonly use
6. **Formatting habits** — Do they use bullet points? Paragraphs? One-liners? Bold/italic?
7. **Personality markers** — Humor, empathy, authority, humility, faith-based language, etc.
8. **Response length** — Typical email length in this mode

Return a JSON object with these fields:
{
  "greeting_patterns": ["list of common greetings"],
  "signoff_patterns": ["list of common sign-offs"],
  "tone_keywords": ["warm", "direct", etc.],
  "sentence_style": "description of sentence patterns",
  "vocabulary_notes": "distinctive words/phrases they use",
  "formatting_style": "how they structure emails",
  "personality_markers": "distinctive personality traits in writing",
  "avg_length": "short/medium/long",
  "example_phrases": ["characteristic phrases"],
  "writing_rules": ["specific rules to follow when writing in this style"]
}

EMAIL SAMPLES (${modeLabel} style):

${samples.map((s, i) => `--- Sample ${i + 1} ---\n${s}\n`).join("\n")}

Return ONLY the JSON object, no explanation.`;

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2048,
    messages: [{ role: "user", content: prompt }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Claude did not return text for style analysis");
  }

  // Extract JSON from response (may be wrapped in markdown code block)
  let jsonStr = textBlock.text.trim();
  const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    jsonStr = jsonMatch[1].trim();
  }

  // Validate it's parseable JSON
  JSON.parse(jsonStr);

  return jsonStr;
}

// ── Main analysis function ───────────────────────────────────────

export async function analyzeWritingStyle(): Promise<{
  analyzed: Record<StyleMode, number>;
  total: number;
}> {
  log.info("Starting writing style analysis");

  // Fetch the last 60 sent emails for analysis
  const sentMails = await fetchSentMail(60);

  if (sentMails.length === 0) {
    log.warn("No sent mail found for style analysis");
    return { analyzed: { internal_formal: 0, external_formal: 0, casual: 0 }, total: 0 };
  }

  // Detect user's domain
  _userDomain = detectUserDomain(sentMails);
  log.info({ userDomain: _userDomain }, "Detected user domain");

  // Classify each email into a style mode
  const buckets: Record<StyleMode, string[]> = {
    internal_formal: [],
    external_formal: [],
    casual: [],
  };

  for (const msg of sentMails) {
    const bodyText = stripHtml(msg.body.content);
    // Skip very short emails (auto-replies, forwarded-only, etc.)
    if (bodyText.length < 30) continue;

    const mode = classifyEmail(msg, _userDomain || "");
    // Include subject + body as sample text
    const sample = `Subject: ${msg.subject}\nTo: ${msg.toRecipients.map((r) => r.emailAddress.address).join(", ")}\n\n${bodyText}`;
    buckets[mode].push(sample);
  }

  const analyzed: Record<StyleMode, number> = {
    internal_formal: 0,
    external_formal: 0,
    casual: 0,
  };

  // Analyze each bucket that has enough samples (minimum 3)
  for (const mode of Object.keys(buckets) as StyleMode[]) {
    const samples = buckets[mode];
    if (samples.length < 3) {
      log.info(
        { mode, count: samples.length },
        "Skipping style mode — not enough samples (need 3+)"
      );
      continue;
    }

    // Use up to 15 samples per mode (to keep Claude prompt reasonable)
    const selectedSamples = samples.slice(0, 15);

    try {
      const profileJson = await analyzeStyleWithClaude(selectedSamples, mode);
      upsertVoiceProfile(mode, profileJson, selectedSamples.length);
      analyzed[mode] = selectedSamples.length;
      log.info(
        { mode, samples: selectedSamples.length },
        "Voice profile analyzed and stored"
      );
    } catch (error) {
      log.error({ error, mode }, "Failed to analyze style for mode");
    }
  }

  const total = Object.values(analyzed).reduce((a, b) => a + b, 0);
  log.info({ analyzed, total }, "Style analysis complete");

  return { analyzed, total };
}

// ── Get a human-readable summary of stored profiles ─────────────

export function getStyleSummary(): string {
  const profiles = getAllVoiceProfiles();

  if (profiles.length === 0) {
    return "No voice profiles yet. Run /style learn to analyze your sent emails.";
  }

  const modeLabels: Record<StyleMode, string> = {
    internal_formal: "Internal (Formal)",
    external_formal: "External (Formal)",
    casual: "Casual",
  };

  const lines = profiles.map((p) => {
    const label = modeLabels[p.styleMode as StyleMode] || p.styleMode;
    let traits = "";
    try {
      const data = JSON.parse(p.profileData);
      const tone = (data.tone_keywords || []).slice(0, 3).join(", ");
      const greetings = (data.greeting_patterns || []).slice(0, 2).join(", ");
      const signoffs = (data.signoff_patterns || []).slice(0, 2).join(", ");
      traits = `\n  Tone: ${tone}\n  Opens: ${greetings}\n  Closes: ${signoffs}`;
    } catch {
      traits = " (profile data error)";
    }
    return `• *${label}* — ${p.sampleCount} samples (last: ${p.lastAnalyzed})${traits}`;
  });

  return lines.join("\n\n");
}
