import type { CollectedContext, DecisionResult } from "../types";

// ── Format a raw data summary (Phase 1 — before Claude integration) ──

export function formatRawSummary(context: CollectedContext): string {
  const lines: string[] = [];

  lines.push("📊 *Smart Check-in Summary*");
  lines.push(`_${new Date().toLocaleString()}_`);
  lines.push("");

  // Sources status
  const available = context.sourcesAvailable.join(", ");
  lines.push(`✅ Sources: ${available}`);
  if (context.sourceErrors.length > 0) {
    lines.push(`⚠️ Errors: ${context.sourceErrors.join("; ")}`);
  }
  lines.push("");

  // Emails
  if (context.emails.length > 0) {
    lines.push(`📧 *Unread Emails (${context.emails.length})*`);
    for (const email of context.emails.slice(0, 5)) {
      const from = email.from.name || email.from.address;
      const date = new Date(email.receivedDateTime).toLocaleDateString();
      lines.push(`  • ${from}: ${truncate(email.subject, 60)} _(${date})_`);
    }
    if (context.emails.length > 5) {
      lines.push(`  _...and ${context.emails.length - 5} more_`);
    }
    lines.push("");
  } else {
    lines.push("📧 No unread emails");
    lines.push("");
  }

  // Calendar
  if (context.calendar.length > 0) {
    lines.push(`📅 *Upcoming Events (${context.calendar.length})*`);
    for (const event of context.calendar.slice(0, 5)) {
      const start = new Date(event.start.dateTime);
      const timeStr = event.isAllDay
        ? "All day"
        : start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const dateStr = start.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
      lines.push(`  • ${dateStr} ${timeStr}: ${truncate(event.subject, 50)}`);
    }
    if (context.calendar.length > 5) {
      lines.push(`  _...and ${context.calendar.length - 5} more_`);
    }
    lines.push("");
  } else {
    lines.push("📅 No upcoming events");
    lines.push("");
  }

  // Tasks
  if (context.tasks.length > 0) {
    lines.push(`✅ *Open Tasks (${context.tasks.length})*`);
    for (const task of context.tasks.slice(0, 5)) {
      const importance = task.importance === "high" ? "🔴" : task.importance === "normal" ? "🟡" : "⚪";
      const due = task.dueDateTime
        ? ` _(due ${new Date(task.dueDateTime).toLocaleDateString()})_`
        : "";
      lines.push(`  ${importance} ${truncate(task.title, 55)}${due}`);
    }
    if (context.tasks.length > 5) {
      lines.push(`  _...and ${context.tasks.length - 5} more_`);
    }
    lines.push("");
  } else {
    lines.push("✅ No open tasks");
    lines.push("");
  }

  return lines.join("\n");
}

// ── Format a Claude decision notification (TEXT/CALL) ────────────

export function formatDecisionNotification(result: DecisionResult): string {
  const lines: string[] = [];

  const urgencyEmoji =
    result.urgency >= 8 ? "🔴" : result.urgency >= 5 ? "🟠" : "🟢";

  lines.push(`${urgencyEmoji} *Smart Check-in* — ${result.decision}`);
  lines.push("");
  lines.push(result.summary);
  lines.push("");
  lines.push("*Why:*");
  lines.push(formatReasoning(result.reasoning));

  return lines.join("\n");
}

// ── Format a quiet NONE decision summary ─────────────────────────

export function formatNoneDecision(result: DecisionResult): string {
  const lines: string[] = [];

  lines.push("🟢 *Smart Check-in* — All clear");
  lines.push("");
  lines.push(formatReasoning(result.reasoning));

  return lines.join("\n");
}

// ── Format reasoning as clean bullet points ──────────────────────

function formatReasoning(reasoning: string): string {
  // If Claude already formatted with bullet points, clean them up
  const bulletLines = reasoning
    .split(/\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const hasBullets = bulletLines.some((line) => line.startsWith("• ") || line.startsWith("- "));

  if (hasBullets) {
    return bulletLines
      .map((line) => {
        const text = line.replace(/^[•\-]\s*/, "");
        return `  • _${escapeMarkdown(text)}_`;
      })
      .join("\n");
  }

  // Fallback: split numbered items like "1) ... 2) ..."
  const numbered = reasoning.split(/\d+\)\s*/);
  if (numbered.length > 2) {
    return numbered
      .filter((s) => s.trim().length > 0)
      .map((s) => `  • _${escapeMarkdown(s.trim())}_`)
      .join("\n");
  }

  // Last resort: single italic block
  return `_${escapeMarkdown(reasoning)}_`;
}

// ── Escape Telegram Markdown special chars in user-facing text ────

function escapeMarkdown(text: string): string {
  return text.replace(/([_*\[\]`])/g, "\\$1");
}

// ── Format system status message ──────────────────────────────────

export function formatStatusMessage(status: {
  lastCycleTime?: string;
  lastDecision?: string;
  sourcesStatus: string[];
  nextRun?: string;
  lastBackup?: string;
  uptime: string;
  dbSize: string;
}): string {
  const lines: string[] = [];

  lines.push("🤖 *Smart Check-ins Status*");
  lines.push("");
  lines.push(`⏱ Uptime: ${status.uptime}`);
  lines.push(`💾 Database: ${status.dbSize}`);
  lines.push(`🕐 Last cycle: ${status.lastCycleTime ?? "None yet"}`);
  lines.push(`📋 Last decision: ${status.lastDecision ?? "N/A"}`);
  lines.push(`⏭ Next run: ${status.nextRun ?? "Unknown"}`);
  lines.push(`📦 Last backup: ${status.lastBackup ?? "Never"}`);
  lines.push("");
  lines.push("*Data Sources:*");
  for (const source of status.sourcesStatus) {
    lines.push(`  ${source}`);
  }

  return lines.join("\n");
}

// ── Helpers ───────────────────────────────────────────────────────

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + "…";
}
