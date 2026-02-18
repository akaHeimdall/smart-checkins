import crypto from "crypto";

// ── Short ID store for Telegram callback data ─────────────────────
// Telegram limits callback_data to 64 bytes. Microsoft Graph IDs
// can be 100+ chars. We map short hashes to full IDs at runtime.

export interface EmailMeta {
  subject: string;
  sender: string;
}

const _idMap = new Map<string, string>();
const _emailMetaMap = new Map<string, EmailMeta>();

/**
 * Generate a short hash (8 chars) for a long ID.
 * Stores the mapping so we can resolve it later.
 */
export function shortenId(fullId: string): string {
  const hash = crypto
    .createHash("sha256")
    .update(fullId)
    .digest("hex")
    .slice(0, 8);
  _idMap.set(hash, fullId);
  return hash;
}

/**
 * Resolve a short hash back to the full ID.
 * Returns the hash itself if no mapping exists (for already-short IDs).
 */
export function resolveId(shortId: string): string {
  return _idMap.get(shortId) ?? shortId;
}

/**
 * Store email metadata (subject + sender) keyed by emailId.
 * Used by the "Create Task" callback to build a task title
 * without re-fetching the email from Graph.
 */
export function storeEmailMeta(emailId: string, meta: EmailMeta): void {
  _emailMetaMap.set(emailId, meta);
}

/**
 * Retrieve stored email metadata by emailId.
 */
export function getEmailMeta(emailId: string): EmailMeta | undefined {
  return _emailMetaMap.get(emailId);
}
