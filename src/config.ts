import { z } from "zod";
import type { GatingConfig } from "./types";

// ── Environment variable schema ───────────────────────────────────

const envSchema = z.object({
  // Microsoft Entra / Graph
  AZURE_TENANT_ID: z.string().min(1, "AZURE_TENANT_ID is required"),
  AZURE_CLIENT_ID: z.string().min(1, "AZURE_CLIENT_ID is required"),
  AZURE_CLIENT_SECRET: z.string().optional(), // For client credentials flow
  AZURE_REFRESH_TOKEN: z.string().optional(), // For delegated flow
  GRAPH_USER_ID: z.string().optional(), // For app-only access (user ID or UPN)

  // Claude
  ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY is required"),

  // Telegram
  TELEGRAM_BOT_TOKEN: z.string().min(1, "TELEGRAM_BOT_TOKEN is required"),
  TELEGRAM_CHAT_ID: z.string().min(1, "TELEGRAM_CHAT_ID is required"),

  // ElevenLabs (Phase 3)
  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_VOICE_ID: z.string().optional(),
  ELEVENLABS_PHONE_NUMBER: z.string().optional(),

  // App config
  DATABASE_PATH: z.string().default("./data/checkins.db"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  TZ: z.string().default("America/New_York"),
  CRON_SCHEDULE: z.string().default("*/30 * * * *"), // Every 30 minutes
});

export type EnvConfig = z.infer<typeof envSchema>;

// ── Validate and export config ────────────────────────────────────

let _config: EnvConfig | null = null;

export function loadConfig(): EnvConfig {
  if (_config) return _config;

  // Debug: log what we're receiving for the client secret (masked)
  const rawSecret = process.env.AZURE_CLIENT_SECRET || "";
  const secretLen = rawSecret.length;
  const firstChar = secretLen > 0 ? rawSecret[0] : "?";
  const lastChar = secretLen > 1 ? rawSecret[secretLen - 1] : "?";
  const hasQuotes = rawSecret.startsWith('"') || rawSecret.startsWith("'");
  console.log(
    `[config-debug] AZURE_CLIENT_SECRET: len=${secretLen}, first="${firstChar}", last="${lastChar}", hasQuotes=${hasQuotes}`
  );

  // Strip wrapping quotes if the YAML editor double-quoted values
  for (const key of Object.keys(process.env)) {
    const val = process.env[key];
    if (val && val.length >= 2) {
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        process.env[key] = val.slice(1, -1);
      }
    }
  }

  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const errors = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Configuration validation failed:\n${errors}`);
  }

  // Validate that at least one auth flow is configured
  const { AZURE_CLIENT_SECRET, AZURE_REFRESH_TOKEN } = result.data;
  if (!AZURE_CLIENT_SECRET && !AZURE_REFRESH_TOKEN) {
    throw new Error(
      "Either AZURE_CLIENT_SECRET (client credentials flow) or AZURE_REFRESH_TOKEN (delegated flow) must be set."
    );
  }

  _config = result.data;
  return _config;
}

export function getConfig(): EnvConfig {
  if (!_config) {
    throw new Error("Config not loaded. Call loadConfig() first.");
  }
  return _config;
}

// ── Gating defaults ───────────────────────────────────────────────

export const DEFAULT_GATING_CONFIG: GatingConfig = {
  cooldownMinutes: 120,
  urgencyOverrideThreshold: 9,
  quietHours: { start: "22:00", end: "07:00" },
  focusHours: { start: "07:00", end: "10:00" },
  pickupTimes: [], // User configures these
  pickupReminderMinutes: 30,
  weekendMode: "reduced",
  weekendUrgencyThreshold: 7,
};

// ── Graph auth mode detection ─────────────────────────────────────

export type AuthMode = "client_credentials" | "delegated";

export function getAuthMode(): AuthMode {
  const config = getConfig();
  // If a refresh token is present, we're using delegated flow
  // (even though we also have a client secret for the confidential app)
  if (config.AZURE_REFRESH_TOKEN) {
    return "delegated";
  }
  // Client secret without refresh token = app-only client credentials
  if (config.AZURE_CLIENT_SECRET) {
    return "client_credentials";
  }
  return "delegated";
}
