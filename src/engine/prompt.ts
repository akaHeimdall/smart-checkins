import type { CollectedContext, EmailMessage, CalendarEvent, TodoTask } from "../types";

// ── System prompt for Claude decision engine ──────────────────────

export const SYSTEM_PROMPT = `You are Smart Check-ins, an AI assistant that monitors a busy professional's Microsoft Outlook email, calendar, and Microsoft To Do tasks. Your job is to evaluate everything happening right now and decide whether the user needs to be notified.

## Your Decision Options

1. **NONE** — Nothing urgent or noteworthy. Don't bother the user.
2. **TEXT** — Something needs attention. Send a Telegram text notification.
3. **CALL** — Something is truly urgent and time-sensitive. Trigger a voice call via ElevenLabs.

## Decision Principles

- **Default to NONE.** Most check-ins should result in no notification. Only escalate when there's a genuine reason.
- **Context is everything.** An email from a known partner about an active deal is more important than a newsletter. A meeting in 15 minutes matters more than one tomorrow.
- **Time-sensitivity drives urgency.** Deadlines today, meetings starting soon, or emails that have been waiting for a reply for days should bump urgency up.
- **Avoid nagging.** If you already notified about something recently (check recentCheckins), don't notify again unless something changed.
- **CALL is rare.** Only use CALL for genuinely critical situations: a meeting starting in <15 minutes that needs prep, a client emergency, a deadline that's about to be missed. Maybe once a week at most.
- **Group related items.** If there are 3 emails from the same thread, mention the thread once rather than listing each email.

## Urgency Scale (1-10)

1-2: Routine, no notification needed
3-4: Mildly interesting, maybe worth a note at the end of the day
5-6: Should be addressed today, warrants a TEXT notification
7-8: Needs attention soon (within a few hours), definitely TEXT
9-10: Urgent/time-critical, consider CALL

## Action Buttons

When you decide TEXT or CALL, suggest relevant action buttons the user can tap in Telegram. Available actions:

- \`snooze_email:{conversationId}\` — Snooze an email thread for 2 hours
- \`snooze_task:{taskId}\` — Snooze a task for 2 hours
- \`mark_read:{emailId}\` — Mark an email as "handled" (won't re-notify)
- \`create_task:{emailId}\` — Create a To Do task from this email (pulls subject + sender into the task title)
- \`snooze_all\` — Snooze everything for 1 hour
- \`force_check\` — Run another check-in immediately

Include 2-4 relevant buttons. Always include at least one snooze option when notifying.
Suggest create_task for emails that require follow-up action — especially opportunity emails, requests, or anything the user should come back to.

## Writing Style for Summaries

- Be concise and direct — this appears on a phone screen
- Lead with the most important item
- Use bullet points with "• " prefix for each key item (max 4 bullets)
- If mentioning calendar events, include the time
- If mentioning emails, include who it's from
- Keep it under 400 characters for TEXT, under 500 for CALL briefings

## Opportunity Screening — CRITICAL

The user is a professional who actively seeks income-generating opportunities. You MUST screen every email for potential opportunities to make money. These include but are not limited to:

- **Speaking engagements** — invitations to speak at conferences, events, panels, workshops, webinars
- **Preaching invitations** — requests to preach, teach, or lead services at other churches or ministries
- **Freelance/contract gigs** — consulting work, project-based offers, contract roles
- **Job offers or recruiter outreach** — new positions, promotions, career opportunities
- **Paid collaborations** — partnerships, sponsorships, paid content creation
- **Honorariums or stipends** — any mention of compensation for appearances or contributions

**Rules for opportunity emails:**
1. NEVER classify an opportunity email as NONE. Always surface it as TEXT at minimum (urgency 5+).
2. If the opportunity has a deadline or time-sensitive element, bump urgency to 7+.
3. In your summary, clearly flag it: "💰 Opportunity: [brief description]"
4. Include the sender and any deadline/date mentioned.
5. When in doubt whether something is an opportunity, err on the side of surfacing it. A false positive is far better than a missed opportunity.

## Writing Style for Reasoning

Your reasoning is shown to the user in Telegram (in italics below the summary). Format it as short bullet points so it's easy to scan on a phone:
- Start each point with "• "
- Keep each point to one short sentence
- Cover: what you looked at, why you made this decision, what you deprioritized
- 3-6 bullet points total`;


// ── Build the user prompt with all collected data ─────────────────

export function buildUserPrompt(context: CollectedContext): string {
  const now = new Date();
  const parts: string[] = [];

  parts.push(`## Current Time\n${now.toLocaleString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short"
  })}`);

  // Recent check-in history (so Claude knows what was already notified)
  if (context.recentCheckins.length > 0) {
    parts.push("\n## Recent Check-in History");
    for (const checkin of context.recentCheckins.slice(0, 5)) {
      parts.push(`- ${checkin.timestamp}: ${checkin.decision} (urgency ${checkin.urgency}) — ${checkin.summary}`);
    }
  }

  // Source status
  parts.push(`\n## Data Sources`);
  parts.push(`Available: ${context.sourcesAvailable.join(", ")}`);
  if (context.sourceErrors.length > 0) {
    parts.push(`Errors: ${context.sourceErrors.join("; ")}`);
  }

  // Emails
  parts.push(`\n## Unread Emails (${context.emails.length})`);
  if (context.emails.length === 0) {
    parts.push("No unread emails.");
  } else {
    for (const email of context.emails) {
      parts.push(formatEmail(email));
    }
  }

  // Calendar
  parts.push(`\n## Calendar Events (${context.calendar.length})`);
  if (context.calendar.length === 0) {
    parts.push("No upcoming events in the next 3 days.");
  } else {
    for (const event of context.calendar) {
      parts.push(formatCalendarEvent(event, now));
    }
  }

  // Tasks
  parts.push(`\n## Open Tasks (${context.tasks.length})`);
  if (context.tasks.length === 0) {
    parts.push("No open tasks.");
  } else {
    for (const task of context.tasks) {
      parts.push(formatTask(task, now));
    }
  }

  // Partnership context
  if (context.partnerships.length > 0) {
    parts.push(`\n## Known Partners/Contacts`);
    for (const p of context.partnerships) {
      parts.push(`- ${p.companyName} (${p.domain}): ${p.contactCount} interactions, last contact ${p.lastContact}, status: ${p.status}${p.quoteAmount ? `, quote: $${p.quoteAmount}` : ""}`);
    }
  }

  // Memory context
  if (context.memory.length > 0) {
    parts.push(`\n## User Context / Memory`);
    for (const m of context.memory) {
      parts.push(`- ${m.key}: ${m.value}`);
    }
  }

  parts.push("\n---\nBased on all of the above, make your decision. Use the evaluate_checkin tool to respond.");

  return parts.join("\n");
}


// ── Formatters for individual data items ──────────────────────────

function formatEmail(email: EmailMessage): string {
  const from = email.from.name || email.from.address;
  const age = getTimeAgo(new Date(email.receivedDateTime));
  let line = `- **${from}** — "${email.subject}" (${age} ago)`;

  if (email.bodyPreview) {
    const preview = email.bodyPreview.slice(0, 150).replace(/\n/g, " ");
    line += `\n  Preview: ${preview}`;
  }

  if (email.hasReply === true) {
    line += "\n  ✅ You already replied to this thread";
  } else if (email.hasReply === false) {
    line += "\n  ⚠️ No reply from you yet";
  }

  if (email.partnershipInfo) {
    line += `\n  🤝 Known partner: ${email.partnershipInfo.companyName} (${email.partnershipInfo.status})`;
  }

  line += `\n  [conversationId: ${email.conversationId}, emailId: ${email.id}]`;

  return line;
}

function formatCalendarEvent(event: CalendarEvent, now: Date): string {
  const start = new Date(event.start.dateTime);
  const minutesUntil = Math.round((start.getTime() - now.getTime()) / 60000);

  let timeStr: string;
  if (event.isAllDay) {
    timeStr = "All day";
  } else if (minutesUntil < 0) {
    timeStr = `Started ${Math.abs(minutesUntil)} min ago`;
  } else if (minutesUntil < 60) {
    timeStr = `Starts in ${minutesUntil} min`;
  } else {
    timeStr = start.toLocaleString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  let line = `- **${event.subject}** — ${timeStr}`;
  if (event.location) {
    line += ` (${event.location})`;
  }
  return line;
}

function formatTask(task: TodoTask, now: Date): string {
  const importance = task.importance === "high" ? "🔴 HIGH" : task.importance === "normal" ? "🟡" : "⚪";
  let line = `- ${importance} **${task.title}** [list: ${task.listName}]`;

  if (task.dueDateTime) {
    const due = new Date(task.dueDateTime);
    const daysUntil = Math.round((due.getTime() - now.getTime()) / 86400000);
    if (daysUntil < 0) {
      line += ` — ⚠️ OVERDUE by ${Math.abs(daysUntil)} day(s)`;
    } else if (daysUntil === 0) {
      line += ` — DUE TODAY`;
    } else if (daysUntil === 1) {
      line += ` — due tomorrow`;
    } else {
      line += ` — due in ${daysUntil} days`;
    }
  }

  line += `\n  [taskId: ${task.id}, listId: ${task.listId}]`;
  return line;
}

function getTimeAgo(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.round(diffMs / 60000);

  if (diffMins < 60) return `${diffMins}m`;
  const diffHours = Math.round(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h`;
  const diffDays = Math.round(diffHours / 24);
  return `${diffDays}d`;
}
