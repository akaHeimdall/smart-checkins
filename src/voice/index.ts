import { createChildLogger } from "../logger";

const log = createChildLogger("voice");

// ── Voice calls (Phase 3 — ElevenLabs integration) ────────────────
// Placeholder for Phase 3 implementation.

export async function initiateVoiceCall(
  _briefing: string,
  _phoneNumber: string
): Promise<{ success: boolean; callId?: string }> {
  log.warn("Voice calls not yet implemented (Phase 3)");
  return { success: false };
}
