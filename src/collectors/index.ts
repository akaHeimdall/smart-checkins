import { fetchUnreadEmails } from "./mail";
import { fetchCalendarEvents } from "./calendar";
import { fetchOpenTasks } from "./tasks";
import { getAllPartnerships, getAllMemory, getRecentCheckins } from "../db";
import { createChildLogger } from "../logger";
import type { CollectedContext } from "../types";

const log = createChildLogger("collectors");

// ── Collect all data sources in parallel ──────────────────────────

export async function collectContext(): Promise<CollectedContext> {
  const startTime = Date.now();
  const sourcesAvailable: string[] = [];
  const sourceErrors: string[] = [];

  // Fire all API calls in parallel
  const [emailResult, calendarResult, taskResult] = await Promise.allSettled([
    fetchUnreadEmails(),
    fetchCalendarEvents(),
    fetchOpenTasks(),
  ]);

  // Process email results
  const emails =
    emailResult.status === "fulfilled"
      ? (sourcesAvailable.push("email"), emailResult.value)
      : (sourceErrors.push(`email: ${(emailResult.reason as Error).message}`), []);

  // Process calendar results
  const calendar =
    calendarResult.status === "fulfilled"
      ? (sourcesAvailable.push("calendar"), calendarResult.value)
      : (sourceErrors.push(`calendar: ${(calendarResult.reason as Error).message}`), []);

  // Process task results
  const tasks =
    taskResult.status === "fulfilled"
      ? (sourcesAvailable.push("tasks"), taskResult.value)
      : (sourceErrors.push(`tasks: ${(taskResult.reason as Error).message}`), []);

  // Local data (synchronous — always available)
  const partnerships = getAllPartnerships();
  const memory = getAllMemory();
  const recentCheckins = getRecentCheckins(5);
  sourcesAvailable.push("local_db");

  const elapsed = Date.now() - startTime;
  log.info(
    {
      elapsed,
      emailCount: emails.length,
      calendarCount: calendar.length,
      taskCount: tasks.length,
      sourcesAvailable,
      sourceErrors,
    },
    "Data collection complete"
  );

  return {
    emails,
    calendar,
    tasks,
    partnerships,
    memory,
    recentCheckins,
    collectedAt: new Date().toISOString(),
    sourcesAvailable,
    sourceErrors,
  };
}

export { fetchUnreadEmails, checkSentReply } from "./mail";
export { fetchCalendarEvents } from "./calendar";
export { fetchOpenTasks, fetchTodoLists } from "./tasks";
