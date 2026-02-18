import crypto from "crypto";

// ── Short ID store for Telegram callback data ─────────────────────
// Telegram limits callback_data to 64 bytes. Microsoft Graph IDs
// can be 100+ chars. We map short hashes to full IDs at runtime.

const _idMap = new Map<string, string>();

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
