import { Bot, type Context } from "grammy";
import { getConfig } from "../config";
import { getRecentCheckins, getLastCheckinTimestamp } from "../db";
import { formatStatusMessage, formatRawSummary } from "./messages";
import { createChildLogger } from "../logger";
import type { CollectedContext } from "../types";
import fs from "fs";
import path from "path";

const log = createChildLogger("bot");

let _bot: Bot | null = null;
const _startTime = new Date();

// ── Initialize bot ────────────────────────────────────────────────

export function initBot(): Bot {
  if (_bot) return _bot;

  const config = getConfig();
  _bot = new Bot(config.TELEGRAM_BOT_TOKEN);

  // ── /start command ──────────────────────────────────────────
  _bot.command("start", async (ctx: Context) => {
    await ctx.reply(
      "👋 *Smart Check-ins* is active\\!\n\n" +
        "I monitor your Outlook email, calendar, and tasks, then contact you only when it matters\\.\n\n" +
        "Commands:\n" +
        "/status \\- System health\n" +
        "/force \\- Run a check\\-in now\n" +
        "/pause \\- Pause notifications\n" +
        "/resume \\- Resume notifications",
      { parse_mode: "MarkdownV2" }
    );
  });

  // ── /status command ─────────────────────────────────────────
  _bot.command("status", async (ctx: Context) => {
    const lastCheckin = getLastCheckinTimestamp();
    const recent = getRecentCheckins(1);
    const uptimeMs = Date.now() - _startTime.getTime();
    const uptime = formatUptime(uptimeMs);

    const dbPath = path.resolve(getConfig().DATABASE_PATH);
    let dbSize = "Unknown";
    try {
      const stats = fs.statSync(dbPath);
      dbSize = `${(stats.size / 1024).toFixed(1)} KB`;
    } catch {
      dbSize = "Not found";
    }

    const statusText = formatStatusMessage({
      lastCycleTime: lastCheckin ?? undefined,
      lastDecision: recent[0]?.decision ?? undefined,
      sourcesStatus: [
        "📧 Outlook Mail — configured",
        "📅 Outlook Calendar — configured",
        "✅ Microsoft To Do — configured",
        "🤖 Claude AI — configured",
      ],
      uptime,
      dbSize,
    });

    await ctx.reply(statusText, { parse_mode: "Markdown" });
  });

  // ── /force command (trigger immediate cycle) ────────────────
  _bot.command("force", async (ctx: Context) => {
    await ctx.reply("⚡ Forcing an immediate check-in cycle...");
    // The actual cycle trigger is handled by the scheduler module
    // which listens for this event via the onForceCheck callback
    if (_onForceCheck) {
      _onForceCheck();
    } else {
      await ctx.reply("⚠️ Scheduler not connected yet. Try again in a moment.");
    }
  });

  // ── /pause command ──────────────────────────────────────────
  _bot.command("pause", async (ctx: Context) => {
    // TODO: Implement pause with duration parsing
    _isPaused = true;
    await ctx.reply("⏸ Notifications paused. Use /resume to re-enable.");
    log.info("Notifications paused by user");
  });

  // ── /resume command ─────────────────────────────────────────
  _bot.command("resume", async (ctx: Context) => {
    _isPaused = false;
    await ctx.reply("▶️ Notifications resumed.");
    log.info("Notifications resumed by user");
  });

  // ── Callback query handler (for inline buttons) ─────────────
  _bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    log.info({ callbackData: data }, "Received callback query");

    // TODO: Phase 2 — handle snooze, evaluate, mark done, call approval
    await ctx.answerCallbackQuery({ text: `Action: ${data} (coming in Phase 2)` });
  });

  log.info("Telegram bot initialized");
  return _bot;
}

// ── Send notification to user ─────────────────────────────────────

export async function sendNotification(text: string): Promise<void> {
  if (_isPaused) {
    log.info("Notification suppressed — bot is paused");
    return;
  }

  const config = getConfig();
  const bot = getBot();

  try {
    await bot.api.sendMessage(config.TELEGRAM_CHAT_ID, text, {
      parse_mode: "Markdown",
    });
    log.debug("Notification sent");
  } catch (error) {
    log.error({ error }, "Failed to send Telegram notification");
    throw error;
  }
}

// ── Send raw summary (Phase 1) ────────────────────────────────────

export async function sendRawSummary(context: CollectedContext): Promise<void> {
  const text = formatRawSummary(context);
  await sendNotification(text);
}

// ── Start bot polling ─────────────────────────────────────────────

export async function startBot(): Promise<void> {
  const bot = getBot();
  log.info("Starting Telegram bot polling...");
  bot.start({
    onStart: () => log.info("Telegram bot is running"),
  });
}

// ── Stop bot ──────────────────────────────────────────────────────

export async function stopBot(): Promise<void> {
  if (_bot) {
    await _bot.stop();
    log.info("Telegram bot stopped");
  }
}

// ── Getters / state ───────────────────────────────────────────────

export function getBot(): Bot {
  if (!_bot) {
    throw new Error("Bot not initialized. Call initBot() first.");
  }
  return _bot;
}

let _isPaused = false;
export function isPaused(): boolean {
  return _isPaused;
}

// ── Force check callback ─────────────────────────────────────────
let _onForceCheck: (() => void) | null = null;
export function setOnForceCheck(callback: () => void): void {
  _onForceCheck = callback;
}

// ── Helpers ───────────────────────────────────────────────────────

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}
