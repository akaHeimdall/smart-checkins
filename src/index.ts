import { loadConfig } from "./config";
import { initDatabase, closeDatabase } from "./db";
import { initBot, startBot, stopBot, sendNotification } from "./bot";
import { startScheduler, stopScheduler, runCycle } from "./scheduler";
import { createChildLogger } from "./logger";

const log = createChildLogger("main");

async function main(): Promise<void> {
  log.info("Smart Check-ins starting...");

  // 1. Load and validate configuration
  try {
    loadConfig();
    log.info("Configuration loaded");
  } catch (error) {
    log.fatal({ error }, "Failed to load configuration");
    process.exit(1);
  }

  // 2. Initialize database
  try {
    initDatabase();
    log.info("Database initialized");
  } catch (error) {
    log.fatal({ error }, "Failed to initialize database");
    process.exit(1);
  }

  // 3. Initialize and start Telegram bot
  try {
    initBot();
    await startBot();
    log.info("Telegram bot started");
  } catch (error) {
    log.fatal({ error }, "Failed to start Telegram bot");
    process.exit(1);
  }

  // 4. Start the scheduler
  startScheduler();

  // 5. Send startup notification
  try {
    await sendNotification(
      "🚀 *Smart Check-ins* is online\\!\n\n" +
        "Monitoring your Outlook email, calendar, and tasks\\.\n" +
        "Use /status to check system health\\."
    );
  } catch (error) {
    log.warn({ error }, "Failed to send startup notification (bot may not be fully connected yet)");
  }

  // 6. Run initial cycle immediately
  log.info("Running initial check-in cycle...");
  await runCycle();

  log.info("Smart Check-ins is running. Press Ctrl+C to stop.");
}

// ── Graceful shutdown ─────────────────────────────────────────────

function shutdown(signal: string): void {
  log.info({ signal }, "Shutting down...");

  stopScheduler();
  stopBot().catch(() => {});
  closeDatabase();

  log.info("Shutdown complete");
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", (error) => {
  log.fatal({ error }, "Uncaught exception");
  shutdown("uncaughtException");
});
process.on("unhandledRejection", (reason) => {
  log.fatal({ reason }, "Unhandled rejection");
  shutdown("unhandledRejection");
});

// ── Start ─────────────────────────────────────────────────────────

main().catch((error) => {
  log.fatal({ error }, "Fatal error during startup");
  process.exit(1);
});
