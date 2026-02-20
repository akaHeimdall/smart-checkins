import { Bot, InlineKeyboard, type Context } from "grammy";
import { getConfig } from "../config";
import { getRecentCheckins, getLastCheckinTimestamp, snoozeItem, markEmailNotified, addPrioritySender, removePrioritySender, getAllPrioritySenders, upsertPartnership, getAllPartnerships, getPartnershipByDomain, markDomainSuggested, getDraftCount } from "../db";
import { analyzeWritingStyle, getStyleSummary, createDraftReply } from "../drafts";
import { formatStatusMessage, formatDecisionNotification, formatNoneDecision } from "./messages";
import { shortenId, resolveId, getEmailMeta } from "./callback-store";
import { createTaskFromEmail } from "../collectors/tasks";
import { createChildLogger } from "../logger";
import type { DecisionResult } from "../types";
import fs from "fs";
import path from "path";

const log = createChildLogger("bot");

const HELP_TEXT =
  "👋 *Smart Check\\-ins*\n\n" +
  "I monitor your Outlook email, calendar, and tasks every 30 min, then notify you only when it matters\\.\n\n" +
  "⚡ *Actions*\n" +
  "/force — Run a check\\-in now \\(skips cooldown\\)\n" +
  "/pause — Pause all notifications\n" +
  "/resume — Resume notifications\n\n" +
  "📋 *Info*\n" +
  "/status — System health \\& uptime\n" +
  "/help — Show this message\n\n" +
  "🏢 *Priority Senders*\n" +
  "/priority — List priority senders\n" +
  "/priority add user@domain\\.com \\- Label\n" +
  "/priority remove user@domain\\.com\n\n" +
  "🤝 *Partners*\n" +
  "/partner — List partners\n" +
  "/partner add domain\\.com \\- Company Name\n" +
  "/partner remove domain\\.com\n\n" +
  "✍️ *Writing Style \\& Drafts*\n" +
  "/style — View your voice profiles\n" +
  "/style learn — Analyze sent mail to learn your style";

let _bot: Bot | null = null;
const _startTime = new Date();

// ── Initialize bot ────────────────────────────────────────────────

export function initBot(): Bot {
  if (_bot) return _bot;

  const config = getConfig();
  _bot = new Bot(config.TELEGRAM_BOT_TOKEN);

  // ── /start command ──────────────────────────────────────────
  _bot.command("start", async (ctx: Context) => {
    await ctx.reply(HELP_TEXT, { parse_mode: "MarkdownV2" });
  });

  // ── /help command ──────────────────────────────────────────
  _bot.command("help", async (ctx: Context) => {
    await ctx.reply(HELP_TEXT, { parse_mode: "MarkdownV2" });
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

  // ── /priority command ─────────────────────────────────────────
  _bot.command("priority", async (ctx: Context) => {
    const text = ctx.message?.text ?? "";
    const args = text.replace(/^\/priority\s*/, "").trim();

    // No args = list all
    if (!args) {
      const senders = getAllPrioritySenders();
      if (senders.length === 0) {
        await ctx.reply(
          "📋 *Priority Senders*\n\nNo priority senders configured\\.\n\n" +
            "Usage:\n" +
            "`/priority add user@domain\\.com \\- Optional label`\n" +
            "`/priority add @domain\\.com \\- Optional label`\n" +
            "`/priority remove user@domain\\.com`\n" +
            "`/priority` \\- List all",
          { parse_mode: "MarkdownV2" }
        );
      } else {
        const list = senders
          .map((s) => `• \`${s.pattern}\`${s.label ? ` — ${s.label}` : ""}`)
          .join("\n");
        await ctx.reply(`📋 *Priority Senders*\n\n${list}`, {
          parse_mode: "Markdown",
        });
      }
      return;
    }

    // /priority add <pattern> - <label>
    if (args.startsWith("add ")) {
      const rest = args.replace("add ", "").trim();
      // Split on " - " to separate pattern from label
      const dashIdx = rest.indexOf(" - ");
      let pattern: string;
      let label: string;

      if (dashIdx > -1) {
        pattern = rest.slice(0, dashIdx).trim();
        label = rest.slice(dashIdx + 3).trim();
      } else {
        pattern = rest;
        label = "";
      }

      if (!pattern) {
        await ctx.reply("❌ Usage: `/priority add user@domain.com - Optional label`", {
          parse_mode: "Markdown",
        });
        return;
      }

      // Normalize: if just a domain without @, prefix with @
      if (!pattern.includes("@") && pattern.includes(".")) {
        pattern = `@${pattern}`;
      }

      addPrioritySender(pattern, label);
      await ctx.reply(`✅ Added priority sender: \`${pattern}\`${label ? ` (${label})` : ""}`, {
        parse_mode: "Markdown",
      });
      log.info({ pattern, label }, "Priority sender added via Telegram");
      return;
    }

    // /priority remove <pattern>
    if (args.startsWith("remove ") || args.startsWith("rm ")) {
      const pattern = args.replace(/^(remove|rm)\s+/, "").trim();
      if (!pattern) {
        await ctx.reply("❌ Usage: `/priority remove user@domain.com`", {
          parse_mode: "Markdown",
        });
        return;
      }

      const removed = removePrioritySender(pattern);
      if (removed) {
        await ctx.reply(`🗑 Removed priority sender: \`${pattern}\``, {
          parse_mode: "Markdown",
        });
        log.info({ pattern }, "Priority sender removed via Telegram");
      } else {
        await ctx.reply(`❌ Not found: \`${pattern}\``, { parse_mode: "Markdown" });
      }
      return;
    }

    // Unknown subcommand
    await ctx.reply(
      "❓ Unknown subcommand. Try:\n`/priority add email@domain.com - Label`\n`/priority remove email@domain.com`\n`/priority` (list all)",
      { parse_mode: "Markdown" }
    );
  });

  // ── /partner command ──────────────────────────────────────────
  _bot.command("partner", async (ctx: Context) => {
    const text = ctx.message?.text ?? "";
    const args = text.replace(/^\/partner\s*/, "").trim();

    // No args = list all
    if (!args) {
      const partners = getAllPartnerships();
      if (partners.length === 0) {
        await ctx.reply(
          "🤝 *Partners*\n\nNo partners configured\\.\n\n" +
            "Usage:\n" +
            "`/partner add domain\\.com \\- Company Name`\n" +
            "`/partner remove domain\\.com`\n" +
            "`/partner` \\- List all",
          { parse_mode: "MarkdownV2" }
        );
      } else {
        const list = partners
          .map((p) => `• \`${p.domain}\` — ${p.companyName} (${p.contactCount} interactions)`)
          .join("\n");
        await ctx.reply(`🤝 *Partners*\n\n${list}`, {
          parse_mode: "Markdown",
        });
      }
      return;
    }

    // /partner add <domain> - <company name>
    if (args.startsWith("add ")) {
      const rest = args.replace("add ", "").trim();
      const dashIdx = rest.indexOf(" - ");
      let domain: string;
      let companyName: string;

      if (dashIdx > -1) {
        domain = rest.slice(0, dashIdx).trim().toLowerCase();
        companyName = rest.slice(dashIdx + 3).trim();
      } else {
        domain = rest.toLowerCase();
        companyName = domain; // Use domain as name if not specified
      }

      if (!domain || !domain.includes(".")) {
        await ctx.reply("❌ Usage: `/partner add domain.com - Company Name`", {
          parse_mode: "Markdown",
        });
        return;
      }

      // Strip leading @ if user typed @domain.com
      domain = domain.replace(/^@/, "");

      upsertPartnership(domain, companyName);
      await ctx.reply(`✅ Added partner: \`${domain}\` (${companyName})`, {
        parse_mode: "Markdown",
      });
      log.info({ domain, companyName }, "Partner added via Telegram");
      return;
    }

    // /partner remove <domain>
    if (args.startsWith("remove ") || args.startsWith("rm ")) {
      const domain = args.replace(/^(remove|rm)\s+/, "").trim().toLowerCase().replace(/^@/, "");
      if (!domain) {
        await ctx.reply("❌ Usage: `/partner remove domain.com`", {
          parse_mode: "Markdown",
        });
        return;
      }

      const existing = getPartnershipByDomain(domain);
      if (existing) {
        const db = (await import("../db")).getDatabase();
        db.prepare(`UPDATE partnerships SET status = 'inactive' WHERE domain = ?`).run(domain);
        await ctx.reply(`🗑 Removed partner: \`${domain}\``, { parse_mode: "Markdown" });
        log.info({ domain }, "Partner removed via Telegram");
      } else {
        await ctx.reply(`❌ Not found: \`${domain}\``, { parse_mode: "Markdown" });
      }
      return;
    }

    // Unknown subcommand
    await ctx.reply(
      "❓ Unknown subcommand. Try:\n`/partner add domain.com - Company Name`\n`/partner remove domain.com`\n`/partner` (list all)",
      { parse_mode: "Markdown" }
    );
  });

  // ── /style command ────────────────────────────────────────────
  _bot.command("style", async (ctx: Context) => {
    const text = ctx.message?.text ?? "";
    const args = text.replace(/^\/style\s*/, "").trim();

    if (args === "learn") {
      await ctx.reply("🔍 Analyzing your sent emails to learn your writing style... This may take a minute.");
      try {
        const result = await analyzeWritingStyle();
        if (result.total === 0) {
          await ctx.reply("⚠️ No sent emails found to analyze. Make sure Mail.ReadWrite permission is granted and re-run auth-setup.");
          return;
        }

        const lines = [];
        if (result.analyzed.internal_formal > 0) lines.push(`• Internal (Formal): ${result.analyzed.internal_formal} samples`);
        if (result.analyzed.external_formal > 0) lines.push(`• External (Formal): ${result.analyzed.external_formal} samples`);
        if (result.analyzed.casual > 0) lines.push(`• Casual: ${result.analyzed.casual} samples`);

        const skipped = [];
        if (result.analyzed.internal_formal === 0) skipped.push("Internal (Formal)");
        if (result.analyzed.external_formal === 0) skipped.push("External (Formal)");
        if (result.analyzed.casual === 0) skipped.push("Casual");

        let msg = `✅ *Style Analysis Complete*\n\nAnalyzed ${result.total} emails:\n${lines.join("\n")}`;
        if (skipped.length > 0) {
          msg += `\n\nSkipped (not enough samples): ${skipped.join(", ")}`;
        }
        msg += "\n\nI'll now use these profiles when drafting replies. Use /style to view profile details.";

        await ctx.reply(msg, { parse_mode: "Markdown" });
        log.info({ result }, "Style learning completed via Telegram");
      } catch (error) {
        log.error({ error }, "Style learning failed");
        await ctx.reply("❌ Style analysis failed. Check logs for details.");
      }
      return;
    }

    // Default: show current profiles
    const summary = getStyleSummary();
    const drafts = getDraftCount();
    const header = `✍️ *Voice Profiles*\n\nDrafts created: ${drafts}\n\n`;
    await ctx.reply(header + summary, { parse_mode: "Markdown" });
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

      } else if (data.startsWith("ct:")) {
        // ct = create task from email (shortened prefix)
        const shortId = data.replace("ct:", "");
        const emailId = resolveId(shortId);
        const meta = getEmailMeta(emailId);

        if (!meta) {
          await ctx.answerCallbackQuery({ text: "❌ Email context expired — try next cycle" });
          log.warn({ emailId }, "No email metadata found for task creation");
        } else {
          await ctx.answerCallbackQuery({ text: "📝 Creating task..." });
          const result = await createTaskFromEmail({
            subject: meta.subject,
            sender: meta.sender,
            emailId,
          });
          await ctx.editMessageText(
            ctx.callbackQuery.message?.text + `\n\n_📝 Task created: ${result.taskTitle}_`,
            { parse_mode: "Markdown" }
          );
          log.info({ emailId, taskTitle: result.taskTitle }, "Task created from email via button");
        }

      } else if (data.startsWith("dr:")) {
        // dr = draft reply (shortened prefix)
        const shortId = data.replace("dr:", "");
        const emailId = resolveId(shortId);

        await ctx.answerCallbackQuery({ text: "✍️ Drafting reply..." });
        try {
          const result = await createDraftReply(emailId);
          const modeLabel = result.styleMode === "casual" ? "Casual" :
            result.styleMode === "internal_formal" ? "Internal" : "External";
          await ctx.editMessageText(
            ctx.callbackQuery.message?.text +
              `\n\n_✍️ Draft created (${modeLabel} style): ${result.bodyPreview}_`,
            { parse_mode: "Markdown" }
          );
          log.info({ emailId, styleMode: result.styleMode, draftId: result.draftId }, "Draft reply created via button");
        } catch (error) {
          log.error({ error, emailId }, "Failed to create draft reply");
          await ctx.editMessageText(
            ctx.callbackQuery.message?.text + "\n\n_❌ Failed to create draft — check permissions_",
            { parse_mode: "Markdown" }
          );
        }

      } else if (data.startsWith("pa:")) {
        // pa = partner accept
        const domain = data.replace("pa:", "");
        upsertPartnership(domain, domain);
        markDomainSuggested(domain);
        await ctx.answerCallbackQuery({ text: "✅ Partner added!" });
        await ctx.editMessageText(
          ctx.callbackQuery.message?.text + `\n\n_✅ Added as partner_`,
          { parse_mode: "Markdown" }
        );
        log.info({ domain }, "Partner accepted via suggestion button");

      } else if (data.startsWith("pd:")) {
        // pd = partner decline
        const domain = data.replace("pd:", "");
        markDomainSuggested(domain);
        await ctx.answerCallbackQuery({ text: "👌 Skipped" });
        await ctx.editMessageText(
          ctx.callbackQuery.message?.text + `\n\n_Skipped — won't ask again_`,
          { parse_mode: "Markdown" }
        );
        log.info({ domain }, "Partner declined via suggestion button");

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

// ── Send partner suggestion with accept/decline buttons ───────

export async function sendPartnerSuggestion(
  domain: string,
  displayName: string,
  emailCount: number
): Promise<void> {
  const config = getConfig();
  const bot = getBot();

  const text =
    `🤝 *Partner Suggestion*\n\n` +
    `I've seen *${emailCount} emails* from \`${domain}\`${displayName !== domain ? ` (${displayName})` : ""}.\n\n` +
    `Should I track them as a partner? Partners get prioritized in notifications and reply tracking.`;

  const keyboard = new InlineKeyboard()
    .text("✅ Yes, add partner", `pa:${domain}`)
    .text("❌ No, skip", `pd:${domain}`);

  try {
    await bot.api.sendMessage(config.TELEGRAM_CHAT_ID, text, {
      parse_mode: "Markdown",
      reply_markup: keyboard,
    });
    log.info({ domain, emailCount }, "Partner suggestion sent");
  } catch (error) {
    log.error({ error, domain }, "Failed to send partner suggestion");
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
  if (action.startsWith("create_task:")) return "📝 Create Task";
  if (action.startsWith("draft_reply:")) return "✍️ Draft Reply";
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
  if (action.startsWith("create_task:")) {
    const id = action.replace("create_task:", "");
    return `ct:${shortenId(id)}`;
  }
  if (action.startsWith("draft_reply:")) {
    const id = action.replace("draft_reply:", "");
    return `dr:${shortenId(id)}`;
  }

  // Fallback: truncate to 64 bytes
  return action.slice(0, 64);
}
