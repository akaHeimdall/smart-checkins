import cron from "node-cron";
import { getConfig } from "./config";
import { collectContext } from "./collectors";
import { enrichEmails } from "./enrichment";
import { checkGating } from "./gating";
import { makeDecision } from "./engine";
import { sendDecisionNotification, sendNoneNotification, sendPlainNotification, isPaused, setOnForceCheck } from "./bot";
import { storeEmailMeta } from "./bot/callback-store";
import { logCheckin, cleanExpiredSnoozes } from "./db";
import { createChildLogger } from "./logger";
import type { CycleResult } from "./types";

const log = createChildLogger("scheduler");

let _task: cron.ScheduledTask | null = null;
let _lastCycleResult: CycleResult | null = null;
let _isRunning = false;

// ── Run a single check-in cycle ───────────────────────────────────

export async function runCycle(options?: { skipGating?: boolean }): Promise<CycleResult> {
  if (_isRunning) {
    log.warn("Cycle already in progress — skipping");
    return {
      cycleId: "skipped",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      gatingResult: { status: "BLOCKED", reason: "Previous cycle still running" },
    };
  }

  _isRunning = true;
  const cycleId = generateCycleId();
  const startedAt = new Date().toISOString();

  log.info({ cycleId }, "Starting check-in cycle");

  try {
    // Check if bot is paused
    if (isPaused()) {
      log.info({ cycleId }, "Bot is paused — skipping cycle");
      return {
        cycleId,
        startedAt,
        completedAt: new Date().toISOString(),
        gatingResult: { status: "BLOCKED", reason: "Bot is paused by user" },
      };
    }

    // Stage 3: Gating check (skipped for startup and /force)
    const gatingResult = options?.skipGating
      ? { status: "PROCEED" as const }
      : checkGating();
    if (gatingResult.status === "BLOCKED") {
      log.info({ cycleId, reason: gatingResult.reason }, "Cycle blocked by gating");
      return {
        cycleId,
        startedAt,
        completedAt: new Date().toISOString(),
        gatingResult,
      };
    }

    // Stage 1: Collect data
    const context = await collectContext();

    // Stage 2: Enrich
    context.emails = await enrichEmails(context.emails);

    // Store email metadata for "Create Task" callback lookups
    for (const email of context.emails) {
      storeEmailMeta(email.id, {
        subject: email.subject,
        sender: email.from.name || email.from.address,
      });
    }

    // Clean expired snoozes
    const cleaned = cleanExpiredSnoozes();
    if (cleaned > 0) {
      log.debug({ cleaned }, "Cleaned expired snoozes");
    }

    // Stage 4: Decision (Claude AI)
    const decision = await makeDecision(context);

    // Stage 5: Act — send all decisions to Telegram
    if (decision.decision === "TEXT" || decision.decision === "CALL") {
      await sendDecisionNotification(decision);
    } else {
      // NONE — send a quiet summary so user can see reasoning
      await sendNoneNotification(decision);
    }

    // Log the check-in
    logCheckin(
      decision.decision,
      decision.urgency,
      decision.summary,
      context.sourcesAvailable
    );

    const result: CycleResult = {
      cycleId,
      startedAt,
      completedAt: new Date().toISOString(),
      gatingResult,
      context,
      decision,
      actionTaken:
        decision.decision === "NONE"
          ? "No action needed"
          : `Sent ${decision.decision} notification (urgency ${decision.urgency})`,
    };

    _lastCycleResult = result;
    log.info(
      {
        cycleId,
        decision: decision.decision,
        urgency: decision.urgency,
        elapsed: Date.now() - new Date(startedAt).getTime(),
      },
      "Cycle complete"
    );

    return result;
  } catch (error) {
    log.error({ cycleId, error }, "Cycle failed");

    try {
      // Send error as plain text — error messages often contain
      // special chars that break Markdown parsing
      await sendPlainNotification(
        `⚠️ Smart Check-in Error\n\nCycle ${cycleId} failed: ${(error as Error).message}`
      );
    } catch {
      log.error("Failed to send error notification to Telegram");
    }

    return {
      cycleId,
      startedAt,
      completedAt: new Date().toISOString(),
      gatingResult: { status: "PROCEED" },
      actionTaken: `Error: ${(error as Error).message}`,
    };
  } finally {
    _isRunning = false;
  }
}

// ── Start the cron scheduler ──────────────────────────────────────

export function startScheduler(): void {
  const config = getConfig();
  const schedule = config.CRON_SCHEDULE;

  log.info({ schedule }, "Starting scheduler");

  _task = cron.schedule(schedule, async () => {
    await runCycle();
  });

  // Wire up the /force command — bypasses gating
  setOnForceCheck(() => {
    log.info("Force check-in triggered via Telegram");
    runCycle({ skipGating: true }).catch((err) =>
      log.error({ error: err }, "Force cycle failed")
    );
  });

  log.info("Scheduler started");
}

// ── Stop the scheduler ────────────────────────────────────────────

export function stopScheduler(): void {
  if (_task) {
    _task.stop();
    _task = null;
    log.info("Scheduler stopped");
  }
}

// ── Getters ───────────────────────────────────────────────────────

export function getLastCycleResult(): CycleResult | null {
  return _lastCycleResult;
}

// ── Helpers ───────────────────────────────────────────────────────

function generateCycleId(): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, "");
  const time = now.toISOString().slice(11, 19).replace(/:/g, "");
  const rand = Math.random().toString(36).slice(2, 6);
  return `cyc_${date}_${time}_${rand}`;
}
