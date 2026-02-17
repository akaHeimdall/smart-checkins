import { getUserPath, getGraphClient } from "../graph";
import { createChildLogger } from "../logger";
import type { CalendarEvent } from "../types";

const log = createChildLogger("collector-calendar");

interface GraphCalendarResponse {
  value: Array<{
    id: string;
    subject: string;
    start: { dateTime: string; timeZone: string };
    end: { dateTime: string; timeZone: string };
    isAllDay: boolean;
    location?: { displayName?: string };
  }>;
}

// ── Fetch calendar events for today + next 3 days ─────────────────

export async function fetchCalendarEvents(): Promise<CalendarEvent[]> {
  const now = new Date();
  const endDate = new Date();
  endDate.setDate(endDate.getDate() + 3);

  // calendarView requires start/end as query params (not $filter)
  const userPath = getUserPath();

  try {
    const client = getGraphClient();
    const response = await client
      .api(`${userPath}/calendarView`)
      .query({
        startDateTime: now.toISOString(),
        endDateTime: endDate.toISOString(),
      })
      .select("id,subject,start,end,isAllDay,location")
      .orderby("start/dateTime")
      .top(50)
      .get() as GraphCalendarResponse;

    const events: CalendarEvent[] = response.value.map((evt) => ({
      id: evt.id,
      subject: evt.subject,
      start: evt.start,
      end: evt.end,
      isAllDay: evt.isAllDay,
      location: evt.location?.displayName,
    }));

    log.info({ count: events.length }, "Fetched calendar events");
    return events;
  } catch (error) {
    log.error({ error }, "Failed to fetch calendar events");
    throw error;
  }
}
