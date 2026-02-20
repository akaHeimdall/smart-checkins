import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { getConfig } from "../config";
import { createChildLogger } from "../logger";
import type {
  CheckinLogEntry,
  Decision,
  EmailTracking,
  MemoryEntry,
  PartnershipInfo,
} from "../types";

const log = createChildLogger("db");

let _db: Database.Database | null = null;

// ── Initialize database ───────────────────────────────────────────

export function initDatabase(): Database.Database {
  if (_db) return _db;

  const config = getConfig();
  const dbPath = path.resolve(config.DATABASE_PATH);
  log.info({ dbPath }, "Initializing SQLite database");

  // Ensure the parent directory exists
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    log.info({ dir }, "Created database directory");
  }

  _db = new Database(dbPath);

  // Enable WAL mode for better concurrent read performance
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");

  runMigrations(_db);

  log.info("Database initialized successfully");
  return _db;
}

export function getDatabase(): Database.Database {
  if (!_db) {
    throw new Error("Database not initialized. Call initDatabase() first.");
  }
  return _db;
}

export function closeDatabase(): void {
  if (_db) {
    _db.close();
    _db = null;
    log.info("Database closed");
  }
}

// ── Migrations ────────────────────────────────────────────────────

function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS checkin_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      decision TEXT NOT NULL CHECK (decision IN ('NONE', 'TEXT', 'CALL')),
      urgency INTEGER NOT NULL DEFAULT 0,
      summary TEXT NOT NULL DEFAULT '',
      sources_available TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS partnerships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      domain TEXT NOT NULL UNIQUE,
      company_name TEXT NOT NULL,
      last_contact TEXT,
      quote_amount REAL,
      contact_count INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'active'
    );

    CREATE TABLE IF NOT EXISTS snoozed_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_type TEXT NOT NULL CHECK (source_type IN ('email', 'task', 'calendar')),
      source_id TEXT NOT NULL,
      snooze_until TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(source_type, source_id)
    );

    CREATE TABLE IF NOT EXISTS memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      value TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS call_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      outcome TEXT NOT NULL DEFAULT 'unknown',
      duration INTEGER,
      summary TEXT
    );

    CREATE TABLE IF NOT EXISTS email_tracking (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL UNIQUE,
      first_seen TEXT NOT NULL DEFAULT (datetime('now')),
      last_notified TEXT,
      reply_detected INTEGER NOT NULL DEFAULT 0,
      snooze_until TEXT
    );

    CREATE TABLE IF NOT EXISTS domain_interactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      domain TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL DEFAULT '',
      email_count INTEGER NOT NULL DEFAULT 0,
      first_seen TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen TEXT NOT NULL DEFAULT (datetime('now')),
      suggested INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS priority_senders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pattern TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL DEFAULT '',
      added_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS voice_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      style_mode TEXT NOT NULL UNIQUE CHECK (style_mode IN ('internal_formal', 'external_formal', 'casual')),
      profile_data TEXT NOT NULL DEFAULT '{}',
      sample_count INTEGER NOT NULL DEFAULT 0,
      last_analyzed TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS draft_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      style_mode TEXT NOT NULL,
      draft_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_checkin_log_timestamp ON checkin_log(timestamp);
    CREATE INDEX IF NOT EXISTS idx_partnerships_domain ON partnerships(domain);
    CREATE INDEX IF NOT EXISTS idx_snoozed_items_until ON snoozed_items(snooze_until);
    CREATE INDEX IF NOT EXISTS idx_email_tracking_conv ON email_tracking(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_draft_log_email ON draft_log(email_id);
  `);

  // Seed initial partners (idempotent via INSERT OR IGNORE pattern in upsert)
  const seedPartners = [
    { domain: "salesforce.com", companyName: "Salesforce" },
    { domain: "konicaminolta.com", companyName: "Konica Minolta" },
    { domain: "sdpconference.info", companyName: "SDP Conference" },
  ];
  for (const p of seedPartners) {
    const existing = db
      .prepare(`SELECT id FROM partnerships WHERE domain = ?`)
      .get(p.domain);
    if (!existing) {
      db.prepare(
        `INSERT INTO partnerships (domain, company_name, last_contact, contact_count, status)
         VALUES (?, ?, datetime('now'), 0, 'active')`
      ).run(p.domain, p.companyName);
    }
  }

  log.debug("Migrations complete");
}

// ── Check-in log queries ──────────────────────────────────────────

export function logCheckin(
  decision: Decision,
  urgency: number,
  summary: string,
  sourcesAvailable: string[]
): void {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO checkin_log (decision, urgency, summary, sources_available)
     VALUES (?, ?, ?, ?)`
  ).run(decision, urgency, summary, JSON.stringify(sourcesAvailable));
}

export function getRecentCheckins(limit = 5): CheckinLogEntry[] {
  const db = getDatabase();
  const rows = db
    .prepare(
      `SELECT id, timestamp, decision, urgency, summary, sources_available as sourcesAvailable
       FROM checkin_log ORDER BY timestamp DESC LIMIT ?`
    )
    .all(limit) as CheckinLogEntry[];
  return rows;
}

export function getLastCheckinTimestamp(): string | null {
  const db = getDatabase();
  const row = db
    .prepare(`SELECT timestamp FROM checkin_log ORDER BY timestamp DESC LIMIT 1`)
    .get() as { timestamp: string } | undefined;
  return row?.timestamp ?? null;
}

// ── Partnership queries ───────────────────────────────────────────

export function getPartnershipByDomain(domain: string): PartnershipInfo | null {
  const db = getDatabase();
  const row = db
    .prepare(
      `SELECT id, domain, company_name as companyName, last_contact as lastContact,
              quote_amount as quoteAmount, contact_count as contactCount, status
       FROM partnerships WHERE domain = ?`
    )
    .get(domain) as PartnershipInfo | undefined;
  return row ?? null;
}

export function upsertPartnership(
  domain: string,
  companyName: string,
  quoteAmount?: number
): void {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO partnerships (domain, company_name, last_contact, quote_amount, contact_count)
     VALUES (?, ?, datetime('now'), ?, 1)
     ON CONFLICT(domain) DO UPDATE SET
       last_contact = datetime('now'),
       contact_count = contact_count + 1,
       quote_amount = COALESCE(?, quote_amount)`
  ).run(domain, companyName, quoteAmount ?? null, quoteAmount ?? null);
}

export function getAllPartnerships(): PartnershipInfo[] {
  const db = getDatabase();
  return db
    .prepare(
      `SELECT id, domain, company_name as companyName, last_contact as lastContact,
              quote_amount as quoteAmount, contact_count as contactCount, status
       FROM partnerships WHERE status = 'active' ORDER BY last_contact DESC`
    )
    .all() as PartnershipInfo[];
}

// ── Snooze queries ────────────────────────────────────────────────

export function snoozeItem(
  sourceType: "email" | "task" | "calendar",
  sourceId: string,
  snoozeUntil: string
): void {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO snoozed_items (source_type, source_id, snooze_until)
     VALUES (?, ?, ?)
     ON CONFLICT(source_type, source_id) DO UPDATE SET snooze_until = ?`
  ).run(sourceType, sourceId, snoozeUntil, snoozeUntil);
}

export function isSnoozed(sourceType: string, sourceId: string): boolean {
  const db = getDatabase();
  const row = db
    .prepare(
      `SELECT id FROM snoozed_items
       WHERE source_type = ? AND source_id = ? AND snooze_until > datetime('now')`
    )
    .get(sourceType, sourceId);
  return !!row;
}

export function cleanExpiredSnoozes(): number {
  const db = getDatabase();
  const result = db
    .prepare(`DELETE FROM snoozed_items WHERE snooze_until <= datetime('now')`)
    .run();
  return result.changes;
}

// ── Memory queries ────────────────────────────────────────────────

export function getMemory(key: string): string | null {
  const db = getDatabase();
  const row = db
    .prepare(`SELECT value FROM memory WHERE key = ?`)
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setMemory(key: string, value: string, category = "general"): void {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO memory (key, value, category, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = ?, category = ?, updated_at = datetime('now')`
  ).run(key, value, category, value, category);
}

export function getAllMemory(): MemoryEntry[] {
  const db = getDatabase();
  return db
    .prepare(
      `SELECT id, key, value, category, updated_at as updatedAt
       FROM memory ORDER BY updated_at DESC`
    )
    .all() as MemoryEntry[];
}

// ── Email tracking queries ────────────────────────────────────────

export function trackEmail(conversationId: string): void {
  const db = getDatabase();
  db.prepare(
    `INSERT OR IGNORE INTO email_tracking (conversation_id) VALUES (?)`
  ).run(conversationId);
}

export function markEmailNotified(conversationId: string): void {
  const db = getDatabase();
  db.prepare(
    `UPDATE email_tracking SET last_notified = datetime('now') WHERE conversation_id = ?`
  ).run(conversationId);
}

export function markEmailReplied(conversationId: string): void {
  const db = getDatabase();
  db.prepare(
    `UPDATE email_tracking SET reply_detected = 1 WHERE conversation_id = ?`
  ).run(conversationId);
}

export function getEmailTracking(conversationId: string): EmailTracking | null {
  const db = getDatabase();
  const row = db
    .prepare(
      `SELECT id, conversation_id as conversationId, first_seen as firstSeen,
              last_notified as lastNotified, reply_detected as replyDetected,
              snooze_until as snoozeUntil
       FROM email_tracking WHERE conversation_id = ?`
    )
    .get(conversationId) as EmailTracking | undefined;
  return row ?? null;
}

// ── Domain interaction tracking ──────────────────────────────

export interface DomainInteraction {
  id: number;
  domain: string;
  displayName: string;
  emailCount: number;
  firstSeen: string;
  lastSeen: string;
  suggested: number;
}

/**
 * Record an email interaction from a domain. Increments count and updates
 * display_name to the most recent sender name.
 */
export function trackDomainInteraction(domain: string, displayName: string): void {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO domain_interactions (domain, display_name, email_count, first_seen, last_seen)
     VALUES (?, ?, 1, datetime('now'), datetime('now'))
     ON CONFLICT(domain) DO UPDATE SET
       email_count = email_count + 1,
       display_name = ?,
       last_seen = datetime('now')`
  ).run(domain, displayName, displayName);
}

/**
 * Get domains that have crossed the interaction threshold but haven't been
 * suggested yet and aren't already partners.
 */
export function getUnsuggestedDomains(threshold: number): DomainInteraction[] {
  const db = getDatabase();
  return db
    .prepare(
      `SELECT id, domain, display_name as displayName, email_count as emailCount,
              first_seen as firstSeen, last_seen as lastSeen, suggested
       FROM domain_interactions
       WHERE email_count >= ? AND suggested = 0
         AND domain NOT IN (SELECT domain FROM partnerships WHERE status = 'active')
       ORDER BY email_count DESC`
    )
    .all(threshold) as DomainInteraction[];
}

/**
 * Mark a domain as suggested so we don't keep asking.
 */
export function markDomainSuggested(domain: string): void {
  const db = getDatabase();
  db.prepare(
    `UPDATE domain_interactions SET suggested = 1 WHERE domain = ?`
  ).run(domain);
}

// ── Priority sender queries ──────────────────────────────────

export interface PrioritySender {
  id: number;
  pattern: string;
  label: string;
  addedAt: string;
}

export function addPrioritySender(pattern: string, label: string): void {
  const db = getDatabase();
  db.prepare(
    `INSERT OR IGNORE INTO priority_senders (pattern, label) VALUES (?, ?)`
  ).run(pattern.toLowerCase(), label);
}

export function removePrioritySender(pattern: string): boolean {
  const db = getDatabase();
  const result = db
    .prepare(`DELETE FROM priority_senders WHERE pattern = ?`)
    .run(pattern.toLowerCase());
  return result.changes > 0;
}

export function getAllPrioritySenders(): PrioritySender[] {
  const db = getDatabase();
  return db
    .prepare(
      `SELECT id, pattern, label, added_at as addedAt
       FROM priority_senders ORDER BY added_at DESC`
    )
    .all() as PrioritySender[];
}

// ── Voice profile queries ─────────────────────────────────────

export type StyleMode = "internal_formal" | "external_formal" | "casual";

export interface VoiceProfile {
  id: number;
  styleMode: StyleMode;
  profileData: string; // JSON string of analyzed style traits
  sampleCount: number;
  lastAnalyzed: string;
  updatedAt: string;
}

export function getVoiceProfile(styleMode: StyleMode): VoiceProfile | null {
  const db = getDatabase();
  const row = db
    .prepare(
      `SELECT id, style_mode as styleMode, profile_data as profileData,
              sample_count as sampleCount, last_analyzed as lastAnalyzed,
              updated_at as updatedAt
       FROM voice_profiles WHERE style_mode = ?`
    )
    .get(styleMode) as VoiceProfile | undefined;
  return row ?? null;
}

export function getAllVoiceProfiles(): VoiceProfile[] {
  const db = getDatabase();
  return db
    .prepare(
      `SELECT id, style_mode as styleMode, profile_data as profileData,
              sample_count as sampleCount, last_analyzed as lastAnalyzed,
              updated_at as updatedAt
       FROM voice_profiles ORDER BY style_mode`
    )
    .all() as VoiceProfile[];
}

export function upsertVoiceProfile(
  styleMode: StyleMode,
  profileData: string,
  sampleCount: number
): void {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO voice_profiles (style_mode, profile_data, sample_count, last_analyzed, updated_at)
     VALUES (?, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(style_mode) DO UPDATE SET
       profile_data = ?,
       sample_count = ?,
       last_analyzed = datetime('now'),
       updated_at = datetime('now')`
  ).run(styleMode, profileData, sampleCount, profileData, sampleCount);
}

// ── Draft log queries ────────────────────────────────────────────

export function logDraft(
  emailId: string,
  conversationId: string,
  styleMode: StyleMode,
  draftId?: string
): void {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO draft_log (email_id, conversation_id, style_mode, draft_id)
     VALUES (?, ?, ?, ?)`
  ).run(emailId, conversationId, styleMode, draftId ?? null);
}

export function getDraftCount(): number {
  const db = getDatabase();
  const row = db
    .prepare(`SELECT COUNT(*) as count FROM draft_log`)
    .get() as { count: number };
  return row.count;
}

// ── Call log queries ──────────────────────────────────────────────

export function getCallsToday(): number {
  const db = getDatabase();
  const row = db
    .prepare(
      `SELECT COUNT(*) as count FROM call_log
       WHERE date(timestamp) = date('now')`
    )
    .get() as { count: number };
  return row.count;
}
