import { getPartnershipByDomain, trackDomainInteraction } from "../db";
import { checkSentReply } from "../collectors/mail";
import { createChildLogger } from "../logger";
import type { EmailMessage } from "../types";

const log = createChildLogger("enrichment");

// Common domains to skip for partner tracking (bulk senders, big providers)
const IGNORED_DOMAINS = new Set([
  "gmail.com", "outlook.com", "hotmail.com", "yahoo.com", "aol.com",
  "icloud.com", "live.com", "msn.com", "protonmail.com",
  "noreply.com", "no-reply.com", "mailchimp.com", "sendgrid.net",
  "amazonses.com", "constantcontact.com", "mailgun.org",
  "linkedin.com", "facebook.com", "twitter.com", "instagram.com",
  "github.com", "google.com", "microsoft.com", "apple.com",
]);

// ── Enrich emails with partnership info and reply status ──────────

export async function enrichEmails(
  emails: EmailMessage[]
): Promise<EmailMessage[]> {
  const enriched: EmailMessage[] = [];
  const trackedDomains = new Set<string>(); // Dedupe per cycle

  for (const email of emails) {
    const domain = extractDomain(email.from.address);

    // Look up partnership info
    if (domain) {
      const partnership = getPartnershipByDomain(domain);
      if (partnership) {
        email.partnershipInfo = partnership;
      }

      // Track domain interactions (for auto-suggestion)
      // Only track non-partner, non-ignored, non-duplicate-per-cycle domains
      if (!partnership && !IGNORED_DOMAINS.has(domain) && !trackedDomains.has(domain)) {
        trackedDomains.add(domain);
        const senderName = email.from.name || domain;
        trackDomainInteraction(domain, senderName);
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
      domainsTracked: trackedDomains.size,
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
