import { createChildLogger } from "../logger";
import type { CollectedContext, DecisionResult } from "../types";

const log = createChildLogger("engine");

// ── Decision engine (Phase 2 — Claude integration) ────────────────
// In Phase 1, this returns a placeholder NONE decision.
// Phase 2 will replace this with the full Claude prompt + API call.

export async function makeDecision(
  context: CollectedContext
): Promise<DecisionResult> {
  log.info(
    {
      emails: context.emails.length,
      events: context.calendar.length,
      tasks: context.tasks.length,
    },
    "Decision engine called (Phase 1 — placeholder)"
  );

  // Phase 1: Always return NONE with a summary
  // Phase 2: This will call Claude API with the full context
  return {
    decision: "NONE",
    urgency: 0,
    summary: "Phase 1: Decision engine not yet active. Data collection is working.",
    reasoning: "Placeholder — Claude integration coming in Phase 2.",
    actionButtons: [],
  };
}
