import { getLastCheckinTimestamp } from "../db";
import { createChildLogger } from "../logger";
import { DEFAULT_GATING_CONFIG } from "../config";
import type { GatingConfig, GatingResult } from "../types";

const log = createChildLogger("gating");

// ── Main gating check ─────────────────────────────────────────────

export function checkGating(
  config: GatingConfig = DEFAULT_GATING_CONFIG,
  now: Date = new Date()
): GatingResult {
  const currentTime = formatTime(now);
  const dayOfWeek = now.getDay(); // 0 = Sunday, 6 = Saturday
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

  // 1. Focus hours — absolute, no override
  if (isInTimeRange(currentTime, config.focusHours.start, config.focusHours.end)) {
    log.debug({ currentTime }, "Blocked: focus hours");
    return { status: "BLOCKED", reason: `Focus hours (${config.focusHours.start}–${config.focusHours.end}). Zero interruptions.` };
  }

  // 2. Quiet hours — absolute, no override
  if (isInTimeRange(currentTime, config.quietHours.start, config.quietHours.end)) {
    log.debug({ currentTime }, "Blocked: quiet hours");
    return { status: "BLOCKED", reason: `Quiet hours (${config.quietHours.start}–${config.quietHours.end}). Notifications held until morning.` };
  }

  // 3. Weekend mode
  if (isWeekend && config.weekendMode === "quiet") {
    log.debug("Blocked: weekend quiet mode");
    return { status: "BLOCKED", reason: "Weekend quiet mode. All notifications paused." };
  }

  // 4. Pickup window — 30 min before each pickup time
  for (const pickupTime of config.pickupTimes) {
    const minutesUntilPickup = minutesUntilTime(now, pickupTime);
    if (minutesUntilPickup >= 0 && minutesUntilPickup <= config.pickupReminderMinutes) {
      log.debug({ pickupTime, minutesUntilPickup }, "Blocked: pickup window");
      return { status: "BLOCKED", reason: `Pickup window (${pickupTime}). Only gentle reminders allowed.` };
    }
  }

  // 5. Cooldown check
  const lastCheckin = getLastCheckinTimestamp();
  if (lastCheckin) {
    const lastCheckinDate = new Date(lastCheckin);
    const minutesSinceLastCheckin =
      (now.getTime() - lastCheckinDate.getTime()) / (1000 * 60);

    if (minutesSinceLastCheckin < config.cooldownMinutes) {
      log.debug(
        { minutesSinceLastCheckin, cooldownMinutes: config.cooldownMinutes },
        "Blocked: cooldown period"
      );
      return {
        status: "BLOCKED",
        reason: `Cooldown: last check-in was ${Math.round(minutesSinceLastCheckin)} minutes ago (minimum: ${config.cooldownMinutes} minutes).`,
      };
    }
  }

  log.debug("Gating passed — proceeding to decision engine");
  return { status: "PROCEED" };
}

// ── Time helpers ──────────────────────────────────────────────────

function formatTime(date: Date): string {
  return `${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}`;
}

function parseTime(timeStr: string): { hours: number; minutes: number } {
  const [hours, minutes] = timeStr.split(":").map(Number);
  return { hours, minutes };
}

function timeToMinutes(timeStr: string): number {
  const { hours, minutes } = parseTime(timeStr);
  return hours * 60 + minutes;
}

function isInTimeRange(current: string, start: string, end: string): boolean {
  const currentMin = timeToMinutes(current);
  const startMin = timeToMinutes(start);
  const endMin = timeToMinutes(end);

  // Handle ranges that cross midnight (e.g., 22:00 – 07:00)
  if (startMin > endMin) {
    return currentMin >= startMin || currentMin < endMin;
  }

  return currentMin >= startMin && currentMin < endMin;
}

function minutesUntilTime(now: Date, timeStr: string): number {
  const { hours, minutes } = parseTime(timeStr);
  const target = new Date(now);
  target.setHours(hours, minutes, 0, 0);
  return (target.getTime() - now.getTime()) / (1000 * 60);
}
