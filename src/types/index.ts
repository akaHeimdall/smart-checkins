// ── Core decision types ───────────────────────────────────────────

export type Decision = "NONE" | "TEXT" | "CALL";

export interface DecisionResult {
  decision: Decision;
  urgency: number; // 1-10
  summary: string;
  reasoning: string;
  actionButtons: string[];
  spokenBriefing?: string; // Only for CALL decisions
}

// ── Data collection types ─────────────────────────────────────────

export interface EmailMessage {
  id: string;
  conversationId: string;
  subject: string;
  from: {
    name: string;
    address: string;
  };
  receivedDateTime: string;
  bodyPreview: string;
  isRead: boolean;
  hasReply?: boolean; // Enriched after checking sent folder
  partnershipInfo?: PartnershipInfo; // Enriched from local DB
}

export interface CalendarEvent {
  id: string;
  subject: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  isAllDay: boolean;
  location?: string;
}

export interface TodoTask {
  id: string;
  listId: string;
  listName: string;
  title: string;
  dueDateTime?: string;
  importance: "low" | "normal" | "high";
  status: string;
}

export interface TodoList {
  id: string;
  displayName: string;
}

// ── Enrichment types ──────────────────────────────────────────────

export interface PartnershipInfo {
  id: number;
  domain: string;
  companyName: string;
  lastContact: string;
  quoteAmount?: number;
  contactCount: number;
  status: string;
}

export interface MemoryEntry {
  id: number;
  key: string;
  value: string;
  category: string;
  updatedAt: string;
}

export interface CheckinLogEntry {
  id: number;
  timestamp: string;
  decision: Decision;
  urgency: number;
  summary: string;
  sourcesAvailable: string;
}

// ── Collected context (input to decision engine) ──────────────────

export interface CollectedContext {
  emails: EmailMessage[];
  calendar: CalendarEvent[];
  tasks: TodoTask[];
  partnerships: PartnershipInfo[];
  memory: MemoryEntry[];
  recentCheckins: CheckinLogEntry[];
  collectedAt: string;
  sourcesAvailable: string[]; // Which sources succeeded
  sourceErrors: string[]; // Which sources failed and why
}

// ── Gating types ──────────────────────────────────────────────────

export type GatingResult =
  | { status: "PROCEED" }
  | { status: "BLOCKED"; reason: string };

export interface GatingConfig {
  cooldownMinutes: number;
  urgencyOverrideThreshold: number; // Urgency >= this bypasses cooldown
  quietHours: { start: string; end: string }; // e.g., "22:00", "07:00"
  focusHours: { start: string; end: string }; // e.g., "07:00", "10:00"
  pickupTimes: string[]; // e.g., ["15:15"]
  pickupReminderMinutes: number; // How many minutes before pickup to remind
  weekendMode: "quiet" | "reduced" | "normal";
  weekendUrgencyThreshold: number; // Minimum urgency to notify on weekends
}

// ── Snoozed item types ────────────────────────────────────────────

export interface SnoozedItem {
  id: number;
  sourceType: "email" | "task" | "calendar";
  sourceId: string;
  snoozeUntil: string;
  createdAt: string;
}

// ── Email tracking for deduplication ──────────────────────────────

export interface EmailTracking {
  id: number;
  conversationId: string;
  firstSeen: string;
  lastNotified?: string;
  replyDetected: boolean;
  snoozeUntil?: string;
}

// ── Pipeline stage result ─────────────────────────────────────────

export interface CycleResult {
  cycleId: string;
  startedAt: string;
  completedAt: string;
  gatingResult: GatingResult;
  context?: CollectedContext;
  decision?: DecisionResult;
  actionTaken?: string;
}
