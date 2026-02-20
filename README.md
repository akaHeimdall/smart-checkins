# Smart Check-ins

An AI-powered assistant that monitors your Microsoft Outlook email, calendar, and To Do tasks on a schedule, uses Claude AI to evaluate what matters, and delivers smart notifications through Telegram — so you only get interrupted when it counts.

## How It Works

Smart Check-ins runs a 5-stage pipeline every 30 minutes:

1. **Collect** — Fetches unread emails (last 7 days), calendar events (next 3 days), and open To Do tasks from Microsoft Graph API, plus partnership history and user memory from a local SQLite database.
2. **Enrich** — Looks up known partners by email domain, checks if you've already replied to threads, and attaches context to each email.
3. **Gate** — Checks cooldown timers, quiet hours (22:00–07:00), focus hours (07:00–10:00), and weekend rules. If gating blocks the cycle, it exits early without calling Claude.
4. **Decide** — Sends all collected context to Claude (Sonnet), which evaluates urgency and returns a structured decision: NONE (no notification), TEXT (Telegram message), or CALL (voice call via ElevenLabs, future).
5. **Act** — Sends the decision to Telegram with inline action buttons. All decisions (including NONE) are sent so you can always see the reasoning.

## Features

- **Opportunity screening (direct + indirect)** — Screens every email for both direct opportunities (speaking invitations, job offers, freelance gigs, paid collaborations) flagged with 💰, and indirect leads (conference announcements, call-for-speakers, networking events, grant cycles) flagged with 🔍. All opportunities auto-include a "Create Task" button for instant follow-up tracking.
- **Priority senders** — Manage priority email domains and addresses via Telegram (`/priority`). Emails from priority senders are always surfaced (urgency 5+, never NONE) and flagged with 🏢. Stored in SQLite and dynamically loaded into Claude's prompt each cycle.
- **Task creation from emails** — Claude suggests a "📝 Create Task" button on actionable emails. Tapping it creates a high-priority task in your default Microsoft To Do list with the subject and sender.
- **Inline action buttons** — Snooze emails/tasks for 2 hours, mark emails as handled, snooze everything for 1 hour, or force an immediate check-in — all from Telegram.
- **Smart gating** — Respects quiet hours, focus hours, a 2-hour cooldown between notifications, and reduced weekend mode. Startup and `/force` commands bypass gating.
- **Partnership memory** — Tracks repeat contacts by email domain so Claude can prioritize emails from known partners.
- **Bullet-point reasoning** — Every notification includes Claude's reasoning as scannable bullet points, so you always know why you were (or weren't) notified.
- **YAML quote-stripping** — Automatically strips wrapping quotes from environment variables, preventing issues with Docker Compose YAML editors that double-quote values.

## Architecture

```
src/
├── index.ts                    Entry point, startup/shutdown
├── config.ts                   Zod-validated environment config + quote-stripping
├── logger.ts                   Pino structured JSON logging
├── scheduler.ts                Cron orchestration, 5-stage pipeline
├── types/index.ts              All TypeScript interfaces
│
├── collectors/
│   ├── index.ts                Parallel collection orchestrator
│   ├── mail.ts                 Unread emails + reply detection
│   ├── calendar.ts             3-day calendar view
│   └── tasks.ts                To Do tasks + create task from email
│
├── enrichment/index.ts         Partnership lookup, reply status
├── gating/index.ts             Cooldown, quiet/focus hours, weekends
│
├── engine/
│   ├── index.ts                Claude API integration (tool_use)
│   └── prompt.ts               Dynamic system prompt + context builder
│
├── graph/
│   ├── auth.ts                 MSAL token acquisition (delegated + client creds)
│   ├── client.ts               Microsoft Graph SDK initialization
│   └── index.ts                Module exports
│
├── bot/
│   ├── index.ts                Telegram bot commands + callback handlers
│   ├── messages.ts             Markdown formatters for notifications
│   └── callback-store.ts       ID shortening + email metadata cache
│
└── db/index.ts                 SQLite schema, CRUD operations

scripts/
└── auth-setup.ts               One-time OAuth2 flow to get refresh token

.github/workflows/
└── docker-publish.yml          Auto-build + push to GHCR on every push to main
```

## Prerequisites

- **Node.js 20+**
- **Microsoft 365 account** with Outlook email, calendar, and To Do
- **Azure Entra (Azure AD) app registration** with delegated permissions
- **Anthropic API key** for Claude
- **Telegram bot** created via @BotFather

## Setup

### 1. Clone the repo

```bash
git clone https://github.com/akaHeimdall/smart-checkins.git
cd smart-checkins
npm install
```

### 2. Create an Entra app registration

In the Azure Portal:

1. Go to **App registrations** → **New registration**
2. Name it (e.g., "Smart Check-ins")
3. Set redirect URI: **Web** → `http://localhost:3847/callback`
4. Under **Certificates & secrets**, create a new client secret. Copy the **Value** (not the ID).
5. Under **API permissions**, add these Microsoft Graph **delegated** permissions:
   - `Mail.Read`
   - `Calendars.Read`
   - `Tasks.ReadWrite`
   - `User.Read`
6. Click **Grant admin consent** for your organization.

### 3. Create a Telegram bot

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow the prompts
3. Copy the bot token
4. Send a message to your bot, then visit `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` to find your chat ID

### 4. Configure environment variables

```bash
cp .env.example .env
```

Fill in your `.env`:

```
AZURE_TENANT_ID=your-tenant-id
AZURE_CLIENT_ID=your-client-id
AZURE_CLIENT_SECRET=your-client-secret-value
ANTHROPIC_API_KEY=sk-ant-your-key
TELEGRAM_BOT_TOKEN=your-bot-token
TELEGRAM_CHAT_ID=your-chat-id
TZ=America/New_York
```

### 5. Run the auth setup

This one-time script opens your browser for Microsoft sign-in and retrieves a refresh token:

```bash
npx tsx scripts/auth-setup.ts
```

After signing in, copy the refresh token and add it to your `.env`:

```
AZURE_REFRESH_TOKEN=the-long-refresh-token
```

**Important:** The refresh token is tied to the client secret that was active when you ran auth-setup. If you rotate the client secret, you must re-run auth-setup to get a new matching refresh token.

### 6. Run the app

**Development (with hot reload):**
```bash
npm run dev
```

**Production:**
```bash
npm run build
npm start
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AZURE_TENANT_ID` | Yes | — | Entra tenant ID |
| `AZURE_CLIENT_ID` | Yes | — | App registration client ID |
| `AZURE_CLIENT_SECRET` | Yes* | — | Client secret value (not the ID) |
| `AZURE_REFRESH_TOKEN` | Yes* | — | From auth-setup.ts (delegated flow) |
| `GRAPH_USER_ID` | No | — | Required only for client credentials flow |
| `ANTHROPIC_API_KEY` | Yes | — | Claude API key |
| `TELEGRAM_BOT_TOKEN` | Yes | — | From @BotFather |
| `TELEGRAM_CHAT_ID` | Yes | — | Your Telegram chat ID |
| `DATABASE_PATH` | No | `./data/checkins.db` | SQLite database location |
| `LOG_LEVEL` | No | `info` | debug, info, warn, error |
| `TZ` | No | `America/New_York` | Timezone for gating rules |
| `CRON_SCHEDULE` | No | `*/30 * * * *` | How often to run check-ins |
| `ELEVENLABS_API_KEY` | No | — | For voice calls (Phase 3) |
| `ELEVENLABS_VOICE_ID` | No | — | For voice calls (Phase 3) |
| `ELEVENLABS_PHONE_NUMBER` | No | — | For voice calls (Phase 3) |

*Either `AZURE_CLIENT_SECRET` + `AZURE_REFRESH_TOKEN` (delegated flow) or `AZURE_CLIENT_SECRET` + `GRAPH_USER_ID` (client credentials flow) is required.

## Docker Deployment

The app auto-builds a Docker image on every push to `main` via GitHub Actions and publishes it to GitHub Container Registry.

### Deploy to a VPS

```bash
# Clone the repo
git clone https://github.com/akaHeimdall/smart-checkins.git
cd smart-checkins

# Create .env with your credentials
nano .env

# Build and run
docker compose up -d --build
```

### Deploy via Docker project manager (e.g., Hostinger)

If your hosting provider has a Docker Compose UI, paste the following YAML and add your environment variables through their `environment` block:

```yaml
services:
  smart-checkins:
    image: ghcr.io/akaheimdall/smart-checkins:latest
    container_name: smart-checkins
    restart: always
    volumes:
      - checkins-data:/app/data
    environment:
      - NODE_ENV=production
      - DATABASE_PATH=/app/data/checkins.db
      - AZURE_TENANT_ID=your-value
      - AZURE_CLIENT_ID=your-value
      - AZURE_CLIENT_SECRET=your-value
      - AZURE_REFRESH_TOKEN=your-value
      - ANTHROPIC_API_KEY=your-value
      - TELEGRAM_BOT_TOKEN=your-value
      - TELEGRAM_CHAT_ID=your-value
      - TZ=America/New_York
      - LOG_LEVEL=info
      - CRON_SCHEDULE=*/30 * * * *
    healthcheck:
      test: ["CMD", "node", "-e", "process.exit(0)"]
      interval: 60s
      timeout: 10s
      retries: 3
      start_period: 30s
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

volumes:
  checkins-data:
    driver: local
```

**Note:** Do not wrap environment values in double quotes in the YAML — the app includes automatic quote-stripping, but it's best to keep values unquoted to avoid ambiguity.

### Useful Docker commands

```bash
docker compose logs -f              # Tail logs
docker compose restart              # Restart after pulling updates
docker compose down && docker compose up -d --build  # Full rebuild
docker compose ps                   # Check health status
```

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/help` | Show all available commands |
| `/start` | Welcome message (same as /help) |
| `/status` | System health: uptime, DB size, last cycle, data sources |
| `/force` | Run an immediate check-in (bypasses gating cooldown) |
| `/pause` | Pause all notifications |
| `/resume` | Resume notifications |
| `/priority` | List all priority senders |
| `/priority add <email\|@domain> - Label` | Add a priority sender |
| `/priority remove <email\|@domain>` | Remove a priority sender |

## Inline Action Buttons

When Claude decides to notify you, the Telegram message includes tappable buttons:

| Button | Action |
|--------|--------|
| ⏰ Snooze Email (2hr) | Suppress re-notification for this email thread |
| ⏰ Snooze Task (2hr) | Suppress re-notification for this task |
| ✅ Mark Handled | Mark email as handled so it won't trigger again |
| 📝 Create Task | Create a To Do task from this email (subject + sender) |
| ⏰ Snooze All (1hr) | Suppress all notifications for 1 hour |
| ⚡ Check Again | Trigger an immediate check-in cycle |

## Gating Rules

The gating engine prevents unnecessary notifications:

| Rule | Default | Behavior |
|------|---------|----------|
| **Cooldown** | 120 minutes | Won't notify again within 2 hours of the last check-in |
| **Quiet hours** | 22:00 – 07:00 | Absolute block, no notifications |
| **Focus hours** | 07:00 – 10:00 | Absolute block, no notifications |
| **Weekend mode** | Reduced | Allows notifications but raises the urgency threshold to 7+ |
| **Urgency override** | 9+ | Reserved for future use (CALL-level urgency) |

Gating is bypassed on app startup and when using the `/force` command.

## Decision Engine

Claude evaluates all collected context and returns a structured decision using tool_use:

**Decision types:**
- **NONE** — Nothing actionable. Sent silently to Telegram (no sound/vibration) so you can review the reasoning.
- **TEXT** — Something needs attention. Sent as a normal Telegram message with action buttons.
- **CALL** — Truly urgent and time-critical. Will trigger a voice call via ElevenLabs (not yet implemented).

**Urgency scale (1–10):**
- 1–2: Routine, no notification
- 3–4: Mildly interesting
- 5–6: Should be addressed today (TEXT)
- 7–8: Needs attention within hours (TEXT)
- 9–10: Urgent/time-critical (CALL)

**Opportunity screening:** The engine screens every email for two tiers of opportunities:
- **Direct opportunities (💰)** — Speaking engagements, preaching invitations, freelance gigs, job offers, paid collaborations, honorariums. Always surfaced as TEXT with urgency 5+.
- **Indirect leads (🔍)** — Conference announcements, call-for-speakers, networking events, grant cycles, training programs, industry meetups, and relevant events buried in newsletters. Flagged with a suggested next action (attend, submit proposal, reach out, etc.).

All opportunity emails automatically include a "📝 Create Task" button so you can instantly track the follow-up in Microsoft To Do.

**Priority senders:** Emails from domains or addresses configured via `/priority` are always surfaced (urgency 5+, never NONE) and flagged with 🏢. Priority senders are stored in SQLite and dynamically loaded into Claude's system prompt each cycle.

## Database

SQLite with WAL mode and foreign keys enabled. The database is auto-created on first run at the path specified by `DATABASE_PATH`.

**Tables:**

| Table | Purpose |
|-------|---------|
| `checkin_log` | History of all decisions (timestamp, decision, urgency, summary) |
| `partnerships` | Known contacts by email domain (company, last contact, quote amount) |
| `snoozed_items` | Temporarily snoozed emails/tasks with expiry timestamps |
| `memory` | Key-value store for user context and preferences |
| `email_tracking` | Tracks when emails were first seen, last notified, and reply status |
| `priority_senders` | Priority email domains/addresses managed via /priority command |
| `call_log` | Voice call history (Phase 3) |

## Updating

When code changes are pushed to `main`, GitHub Actions automatically builds a new Docker image. To pick up updates:

**On a VPS:**
```bash
cd smart-checkins
git pull
docker compose down && docker compose up -d --build
```

**On Hostinger (or similar Docker UI):**
Redeploy the project — it will pull the latest `ghcr.io/akaheimdall/smart-checkins:latest` image.

## Re-authenticating

If you change API permissions (e.g., adding `Mail.Send`) or if your refresh token expires, re-run the auth setup:

```bash
npx tsx scripts/auth-setup.ts
```

Then update the `AZURE_REFRESH_TOKEN` in your `.env` or hosting environment and restart/redeploy.

**Important:** The refresh token is tied to the client secret. If you rotate the client secret in Azure, you must also re-run auth-setup and update both `AZURE_CLIENT_SECRET` and `AZURE_REFRESH_TOKEN` in your deployment.

## Tech Stack

- **Runtime:** Node.js 20, TypeScript (strict mode)
- **AI:** Claude Sonnet via Anthropic SDK (tool_use for structured output)
- **Microsoft:** Graph API via MSAL + Graph SDK (delegated auth with ConfidentialClientApplication)
- **Telegram:** grammy bot framework
- **Database:** SQLite via better-sqlite3 (WAL mode)
- **Scheduling:** node-cron
- **Logging:** Pino (structured JSON)
- **Validation:** Zod
- **CI/CD:** GitHub Actions → GitHub Container Registry
- **Deployment:** Docker (multi-stage alpine build, non-root user)
