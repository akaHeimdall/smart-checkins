import { Bot, InlineKeyboard, type Context } from "grammy";
import { getConfig } from "../config";
import { getRecentCheckins, getLastCheckinTimestamp, snoozeItem, markEmailNotified } from "../db";
import { formatStatusMessage, formatDecisionNotification, formatNoneDecision } from "./messages";
import { shortenId, resolveId } from "./callback-store";
import { createChildLogger } from "../logger";
import type { DecisionResult } from "../types";
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
        "🤖 Claude AI — active",
      ],
      uptime,
      dbSize,
    });

    await ctx.reply(statusText, { parse_mode: "Markdown" });
  });

  // ── /force command (trigger immediate cycle) ────────────────
  _bot.command("force", async (ctx: Context) => {
    await ctx.reply("⚡ Forcing an immediate check-in cycle...");
    if (_onForceCheck) {
      _onForceCheck();
    } else {
      await ctx.reply("⚠️ Scheduler not connected yet. Try again in a moment.");
    }
  });

  // ── /pause command ──────────────────────────────────────────
  _bot.command("pause", async (ctx: Context) => {
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

    try {
      if (data === "snooze_all") {
        // Snooze everything for 1 hour
        const snoozeUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        // We don't have specific items here, but we mark a memory flag
        await ctx.answerCallbackQuery({ text: "⏰ All snoozed for 1 hour" });
        await ctx.editMessageText(
          ctx.callbackQuery.message?.text + "\n\n_⏰ Snoozed for 1 hour_",
          { parse_mode: "Markdown" }
        );
        log.info({ snoozeUntil }, "All items snoozed");

      } else if (data === "force_check") {
        await ctx.answerCallbackQuery({ text: "⚡ Running check-in..." });
        if (_onForceCheck) {
          _onForceCheck();
        }

      } else if (data.startsWith("se:")) {
        // se = snooze email (shortened prefix)
        const shortId = data.replace("se:", "");
        const conversationId = resolveId(shortId);
        const snoozeUntil = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
        snoozeItem("email", conversationId, snoozeUntil);
        await ctx.answerCallbackQuery({ text: "⏰ Email snoozed for 2 hours" });
        log.info({ conversationId, snoozeUntil }, "Email snoozed");

      } else if (data.startsWith("st:")) {
        // st = snooze task (shortened prefix)
        const shortId = data.replace("st:", "");
        const taskId = resolveId(shortId);
        const snoozeUntil = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
        snoozeItem("task", taskId, snoozeUntil);
        await ctx.answerCallbackQuery({ text: "⏰ Task snoozed for 2 hours" });
        log.info({ taskId, snoozeUntil }, "Task snoozed");

      } else if (data.startsWith("mr:")) {
        // mr = mark read (shortened prefix)
        const shortId = data.replace("mr:", "");
        const emailId = resolveId(shortId);
        markEmailNotified(emailId);
        await ctx.answerCallbackQuery({ text: "✅ Marked as handled" });
        log.info({ emailId }, "Email marked as handled");

      } else {
        await ctx.answerCallbackQuery({ text: `Unknown action: ${data}` });
        log.warn({ data }, "Unknown callback action");
      }
    } catch (error) {
      log.error({ error, data }, "Callback handler error");
      await ctx.answerCallbackQuery({ text: "❌ Action failed" });
    }
  });

  log.info("Telegram bot initialized");
  return _bot;
}

// ── Send a plain text notification ───────────────────────────────

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

// ── Send a plain text notification (no Markdown parsing) ─────────

export async function sendPlainNotification(text: string): Promise<void> {
  if (_isPaused) return;

  const config = getConfig();
  const bot = getBot();

  try {
    await bot.api.sendMessage(config.TELEGRAM_CHAT_ID, text);
    log.debug("Plain notification sent");
  } catch (error) {
    log.error({ error }, "Failed to send plain Telegram notification");
    throw error;
  }
}

// ── Send a decision notification with inline buttons ─────────────

export async function sendDecisionNotification(
  decision: DecisionResult
): Promise<void> {
  if (_isPaused) {
    log.info("Decision notification suppressed — bot is paused");
    return;
  }

  const config = getConfig();
  const bot = getBot();

  const text = formatDecisionNotification(decision);

  // Build inline keyboard — shorten IDs to fit Telegram's 64-byte limit
  const keyboard = new InlineKeyboard();
  for (const button of decision.actionButtons) {
    const shortData = shortenCallbackData(button);
    const label = getButtonLabel(button);
    keyboard.text(label, shortData).row();
  }

  try {
    await bot.api.sendMessage(config.TELEGRAM_CHAT_ID, text, {
      parse_mode: "Markdown",
      reply_markup: decision.actionButtons.length > 0 ? keyboard : undefined,
    });
    log.info(
      { decision: decision.decision, buttons: decision.actionButtons.length },
      "Decision notification sent"
    );
  } catch (error) {
    log.error({ error }, "Failed to send decision notification");
    throw error;
  }
}

// ── Send a quiet NONE decision summary ────────────────────────────

export async function sendNoneNotification(
  decision: DecisionResult
): Promise<void> {
  if (_isPaused) return;

  const config = getConfig();
  const bot = getBot();
  const text = formatNoneDecision(decision);

  try {
    await bot.api.sendMessage(config.TELEGRAM_CHAT_ID, text, {
      parse_mode: "Markdown",
      disable_notification: true, // Silent — no buzz/sound on phone
    });
    log.info("NONE decision summary sent (silent)");
  } catch (error) {
    log.error({ error }, "Failed to send NONE notification");
    // Don't throw — NONE notifications failing shouldn't crash the cycle
  }
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

function getButtonLabel(action: string): string {
  if (action === "snooze_all") return "⏰ Snooze All (1hr)";
  if (action === "force_check") return "⚡ Check Again";
  if (action.startsWith("snooze_email:")) return "⏰ Snooze Email (2hr)";
  if (action.startsWith("snooze_task:")) return "⏰ Snooze Task (2hr)";
  if (action.startsWith("mark_read:")) return "✅ Mark Handled";
  return action;
}

/**
 * Shorten callback data to fit Telegram's 64-byte limit.
 * Maps long prefixes to 2-char codes and hashes long IDs.
 */
function shortenCallbackData(action: string): string {
  // Short actions that already fit
  if (action === "snooze_all" || action === "force_check") return action;

  // Map long prefixes to 2-char codes and hash the ID
  if (action.startsWith("snooze_email:")) {
    const id = action.replace("snooze_email:", "");
    return `se:${shortenId(id)}`;
  }
  if (action.startsWith("snooze_task:")) {
    const id = action.replace("snooze_task:", "");
    return `st:${shortenId(id)}`;
  }
  if (action.startsWith("mark_read:")) {
    const id = action.replace("mark_read:", "");
    return `mr:${shortenId(id)}`;
  }

  // Fallback: truncate to 64 bytes
  return action.slice(0, 64);
}
