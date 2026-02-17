import { getPartnershipByDomain } from "../db";
import { checkSentReply } from "../collectors/mail";
import { createChildLogger } from "../logger";
import type { EmailMessage } from "../types";

const log = createChildLogger("enrichment");

// ── Enrich emails with partnership info and reply status ──────────

export async function enrichEmails(
  emails: EmailMessage[]
): Promise<EmailMessage[]> {
  const enriched: EmailMessage[] = [];

  for (const email of emails) {
    const domain = extractDomain(email.from.address);

    // Look up partnership info
    if (domain) {
      const partnership = getPartnershipByDomain(domain);
      if (partnership) {
        email.partnershipInfo = partnership;
      }
    }

    // Check if we already replied (only for emails that seem important)
    // In Phase 2, Claude will decide which emails warrant a reply check.
    // For now, check all emails from known partners.
    if (email.partnershipInfo) {
      try {
        email.hasReply = await checkSentReply(email.conversationId);
      } catch {
        log.warn(
          { conversationId: email.conversationId },
          "Failed to check reply status"
        );
        email.hasReply = undefined;
      }
    }

    enriched.push(email);
  }

  log.info(
    {
      total: emails.length,
      withPartnership: enriched.filter((e) => e.partnershipInfo).length,
      withReply: enriched.filter((e) => e.hasReply === true).length,
    },
    "Email enrichment complete"
  );

  return enriched;
}

// ── Extract domain from email address ─────────────────────────────

function extractDomain(email: string): string | null {
  const match = email.match(/@(.+)$/);
  return match ? match[1].toLowerCase() : null;
}
