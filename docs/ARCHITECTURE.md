# Heed — Technical Architecture (V1)

Status: Draft for sign-off · Rationale for each choice lives in DECISIONS.md (referenced as D-nn). This document describes *what the system is*; DECISIONS.md explains *why*.

## 1. System overview

```
                         ┌──────────────────────────── Chrome (user's machine) ────────────────────────────┐
                         │  Heed extension (MV3)                                                           │
                         │  ┌────────────┐  ┌─────────┐ ┌────────────┐ ┌──────────┐                       │
                         │  │ Popup (UI) │  │Side pnl │ │Options (UI)│ │ Service  │  chrome.alarms        │
                         │  │ React      │  │ React   │ │ React      │ │ Worker   │  chrome.notifications │
                         │  └─────┬──────┘  └────┬────┘ └─────┬──────┘ │ (single  │  chrome.storage.local │
                         │        └──── runtime messaging ────┴───────▶│ writer)  │                       │
                         │                                              └────┬─────┘                       │
                         └───────────────────────────────────────────────────┼─────────────────────────────┘
                                                                             │ HTTPS, Bearer <Heed session token>
                                                                             │ (the only network peer of the extension)
                         ┌───────────────────────────────────────────────────▼─────────────────────────────┐
                         │  Heed API  (Node.js + TypeScript + Fastify, Google Cloud Run, scale-to-zero)    │
                         │  ┌──────┐┌────────────┐┌───────┐┌──────────┐┌─────────┐┌──────────┐┌─────────┐ │
                         │  │ auth ││integrations││ sync  ││detection ││  tasks/ ││reminders ││ privacy │ │
                         │  │      ││(gmail,cal) ││engine ││pipeline  ││ events  ││ planner  ││ (export,│ │
                         │  └──┬───┘└─────┬──────┘└───┬───┘└────┬─────┘└────┬────┘└────┬─────┘│ delete) │ │
                         │     │          │           │         │           │          │      └─────────┘ │
                         │  ┌──▼──────────▼───────────▼─────────▼───────────▼──────────▼───┐              │
                         │  │ Postgres access (Prisma) · job queue (SKIP LOCKED) · crypto    │              │
                         │  └───────────────────────────┬───────────────────────────────────┘              │
                         └──────────────┬───────────────┼─────────────────┬────────────────┬──────────────┘
                                        │               │                 │                │
                          Google OAuth/ │      Neon     │       Gemini API│     GCP Secret │   Cloud Scheduler
                          Gmail/Calendar│    Postgres   │   (via AiProvider)    Manager    │   (tick every 15 min,
                          REST APIs     │   (free tier) │                 │                │    OIDC-authenticated)
```

Key properties:

- **The extension is a thin, untrusted client.** It holds a revocable Heed session token and cached, user-visible data. It never holds Google tokens of any kind, API keys, client secrets, or database credentials (see SECURITY.md section 3).
- **All Google access and all AI access happen server-side.** The server holds Google refresh tokens (encrypted), calls Gmail and Calendar, runs the deterministic pipeline, calls the AI provider, and plans reminders.
- **Delivery is client-side.** The server plans reminders; the extension schedules and shows them locally and re-evaluates relevance at fire time. This keeps notifications working offline and avoids push infrastructure in V1 (D-09).
- **Stateless compute, durable state in Postgres.** Cloud Run instances hold no state. Cloud Run allocates CPU only during requests, so background work runs inside request handlers with time budgets (D-08, D-12).

## 2. Repository structure

Monorepo, pnpm workspaces, TypeScript project references (D-15).

```
heed/
├── apps/
│   ├── extension/                      # Chrome MV3 extension (React + Vite)
│   │   ├── manifest.config.ts          # typed manifest generated at build
│   │   ├── vite.config.ts              # multi-entry: popup, sidepanel, options, service worker
│   │   └── src/
│   │       ├── background/             # service worker: sync, outbox, alarms, notifications, auth
│   │       ├── popup/  sidepanel/  options/   # React entry points
│   │       ├── ui/                     # components, hooks, design tokens (Tailwind + Radix)
│   │       └── lib/                    # api-client, storage (typed), messaging, time utils
│   └── api/                            # Backend (Fastify)
│       ├── prisma/ (schema.prisma, migrations/)
│       └── src/
│           ├── server.ts  app.ts  config/        # env parsing (zod), fail-fast
│           ├── modules/
│           │   ├── auth/               # OAuth start/callback, sessions, connect tickets
│           │   ├── integrations/       # token vault, Google clients (gmail, calendar)
│           │   ├── sync/               # gmail-sync, calendar-sync, orchestrator, cursors
│           │   ├── detection/          # orchestration: prefilter → extract → link → persist
│           │   ├── tasks/  events/     # CRUD and state machine
│           │   ├── reminders/          # planner (pure) + persistence
│           │   ├── privacy/            # export, delete data, delete account, retention
│           │   └── internal/           # /internal/tick, health
│           ├── jobs/                   # queue (claim/lease/retry), job handlers, retention purge
│           ├── crypto/                 # AES-256-GCM envelope, HMAC fingerprints, key rotation
│           └── observability/          # pino logger with redaction, request ids, metrics
├── packages/
│   ├── shared/                         # SAFE FOR EXTENSION: zod DTO schemas, enums, API types,
│   │                                   # pure predicates (isReminderStillRelevant), rule-id → text catalog
│   ├── detection/                      # SERVER ONLY: pure deterministic pipeline (no IO):
│   │                                   # header filters, scoring rules (versioned), body cleaning,
│   │                                   # redaction, chrono date candidates, event linker
│   ├── ai/                             # SERVER ONLY: AiProvider interface, GeminiProvider,
│   │                                   # FakeProvider, versioned prompts, output schema + validators
│   ├── eval/                           # SERVER/CI ONLY: labeled synthetic corpus + metrics runner
│   └── config/                         # eslint, tsconfig, prettier, vitest base configs
├── docs/                               # these documents
├── infra/                              # Dockerfile, Cloud Run service YAML, scheduler/secret bootstrap
│                                       # scripts, README for one-time GCP/Neon/Google Cloud Console setup
├── scripts/                            # dev tooling, bundle-secret-scan, fake-google server
└── .github/
    ├── workflows/ (ci.yml, codeql.yml, deploy-api.yml, release-extension.yml, eval.yml)
    ├── dependabot.yml
    └── CODEOWNERS
```

Enforced dependency rules (eslint `no-restricted-imports` plus dependency-cruiser in CI):

| Package | May import | Must not import |
|---|---|---|
| `apps/extension` | `packages/shared` | `apps/api`, `packages/detection`, `packages/ai`, `packages/eval`, any Node-only module |
| `packages/shared` | nothing internal | everything else (no secrets, no IO, browser- and Node-safe) |
| `apps/api` | all `packages/*` | `apps/extension` |
| `packages/detection`, `packages/ai` | `packages/shared` | `apps/*`, Prisma, `process.env` (config injected) |

## 3. Chrome extension architecture (D-01)

### 3.1 Manifest and permissions

- `manifest_version: 3`; service worker as ES module; `action` (popup), `side_panel`, `options_page`.
- **Permissions (complete list):** `identity` (launchWebAuthFlow), `storage`, `alarms`, `notifications`, `sidePanel`.
- **host_permissions:** only the Heed API origin (one for prod, one for staging in staging builds).
- **No** content scripts, no `<all_urls>`, no `tabs`, no `unlimitedStorage`, no `externally_connectable`, no remote code, no `eval`; default MV3 CSP (`script-src 'self'; object-src 'self'`).
- `key` field set in dev/staging builds so the extension ID (and therefore the `chromiumapp.org` OAuth redirect) is stable; the production ID is assigned by the Chrome Web Store (D-04).

### 3.2 Runtime model

MV3 service workers are ephemeral (terminated after about 30 s idle). Therefore:

- The service worker is **stateless between events**; all durable state lives in `chrome.storage.local` and is rehydrated on each wake.
- The service worker is the **single writer** of the local store. UI pages (popup, side panel, options) are read-mostly: they subscribe to `chrome.storage.onChanged` and send commands (`completeTask`, `snooze`, `syncNow`, ...) to the worker via `chrome.runtime.sendMessage`. This removes cross-context write races.
- Wake triggers: `chrome.alarms` (sync heartbeat and reminder alarms), `chrome.runtime.onStartup` and `onInstalled`, `chrome.notifications.onClicked` and `onButtonClicked`, UI messages.

### 3.3 Local store (chrome.storage.local), typed and versioned

| Key | Content |
|---|---|
| `auth` | `{ sessionToken, expiresAt, userId }` (Heed session only) |
| `cache.tasks`, `cache.events`, `cache.reminders` | Mirror of server data the user can see, keyed by id |
| `sync.cursor` | Server change-sequence cursor for delta sync |
| `outbox` | Ordered queue of pending mutations `{ idempotencyKey, method, path, body, createdAt }` |
| `ui.prefs` | Per-viewer conveniences (selected tab, etc.) |
| `schemaVersion` | For migrations of local shape |

The default storage quota (10 MB) is ample: items are small and the server returns only a 30-day window. On sign-out or "delete my data", the entire local store is cleared.

### 3.4 Sync loop in the extension

1. Heartbeat alarm every 5 minutes, plus popup open (debounced to 1 per 2 minutes), plus manual refresh.
2. Flush `outbox` (in order, with `Idempotency-Key`). A 4xx permanent error drops the entry and surfaces a toast; a network/5xx error keeps it for retry.
3. `GET /v1/sync?cursor=…` returns `{ changes, tombstones, nextCursor, resyncRequired }`. Apply to cache; if `resyncRequired`, clear cache and refetch full.
4. Recompute **local reminder alarms** from `cache.reminders` (diff against existing alarms, so it is idempotent).
5. Update badge.

The 5-minute heartbeat calls only the cheap delta endpoint. It does *not* trigger Gmail/Calendar sync on the server (the server's own tick does that; `POST /v1/sync/now` forces one).

### 3.5 UI

React 18 plus TypeScript, Vite build, Tailwind CSS (build-time) with Radix UI primitives, React Router (hash routing) in side panel and options. Server data is read from the local store via a small `useStore` selector hook (no remote state library needed because the worker owns fetching). UI never renders email HTML; the only email-derived text shown is plain-text evidence quotes and metadata, rendered as text nodes (SECURITY.md XSS section).

## 4. Backend architecture (D-02)

### 4.1 Stack

Node.js (current Active LTS, pinned in `.nvmrc` and Dockerfile) · TypeScript strict · Fastify 5 with `fastify-type-provider-zod` · Zod for all input/output validation · Prisma ORM · Luxon for time zones · chrono-node for date candidates · `@google/genai` behind `AiProvider` · pino logging · Vitest.

### 4.2 Module boundaries

Modular monolith; each module exposes a typed service interface and owns its tables. Cross-module access only via those interfaces. Route handlers are thin (validate, authorize, call service, serialize).

| Module | Responsibility |
|---|---|
| `auth` | Google OAuth (code flow with PKCE, state, nonce), Heed sessions, connect tickets, session listing/revocation |
| `integrations` | Per-provider credential vault (encrypted refresh tokens), access-token minting with in-memory cache, Gmail/Calendar API clients with retry/backoff, revoke on disconnect |
| `sync` | Orchestration and cursor management for Gmail and Calendar; writes `SyncRun` records; honors pause |
| `detection` | Runs the pipeline per message/event description; persists tasks, evidence, and the message log |
| `tasks`, `events` | Domain services and state machine; each mutation bumps the user's change sequence and enqueues reminder re-planning |
| `reminders` | Pure planner (`planReminders(task, event, settings, now) → slots`) plus reconciliation (upsert and cancel) |
| `privacy` | Export, delete-data, delete-account, retention purge |
| `internal` | `/internal/tick`, `/healthz`, `/readyz` |

### 4.3 Request pipeline

`request-id → structured logger (redacting) → rate limit → auth (session lookup) → zod validation → handler → zod response serialization → problem+json error mapper`. Every query is scoped by `userId` obtained from the session; IDs from clients are never trusted without a `where: { id, userId }` (see SECURITY.md authorization section).

### 4.4 Job system on scale-to-zero (D-02, D-12)

Cloud Run (request-based billing) gives no CPU between requests, so there is no resident worker. Design:

- `Job` table in Postgres: `type`, `userId`, `payload` (ids only, never content), `runAt`, `attempts`, `lockedUntil`, `status`, `dedupeKey` (unique).
- **Claim:** `UPDATE … WHERE id IN (SELECT id FROM "Job" WHERE status='PENDING' AND runAt<=now() ORDER BY runAt FOR UPDATE SKIP LOCKED LIMIT n) RETURNING *` with a lease (`lockedUntil = now()+lease`); expired leases are reclaimable (crash safety).
- **Tick:** Cloud Scheduler calls `POST /internal/tick` every 15 minutes (OIDC token from a dedicated service account, verified by audience and email). The handler (a) enqueues due `SYNC_GMAIL`/`SYNC_CALENDAR` jobs for each connected, non-paused user, (b) claims and runs jobs with concurrency 3 and a wall-clock budget of 4 minutes, (c) runs retention purge if the daily purge job is due. It returns a summary and exits.
- **On-demand:** `POST /v1/sync/now` runs that user's sync **inline** with a 20 s budget. Messages not processed within the budget stay as `ANALYZE_MESSAGE` jobs for the next tick. The response says `{ partial: true }` so the UI can show "still analyzing".
- **Retries:** exponential backoff (1 m, 5 m, 30 m), 5 attempts, then `FAILED` with an error code (never message content).
- **Idempotency everywhere:** handlers are safe to re-run (message log keyed by `(userId, gmailMessageId)`; task fingerprints; reminder upserts by deterministic slot key).

Why 15 minutes: Neon's free plan allows 100 CU-hours/month and suspends compute after 5 idle minutes; a 15-minute tick lets the database suspend between runs (about 35% duty cycle, roughly 65 CU-hours/month at 0.25 CU) while a 5-minute tick would keep it permanently awake (about 180 CU-hours) and exhaust the quota (D-03, D-11). Interactive freshness comes from on-demand sync when the extension opens.

## 5. Data flows

### 5.1 Sign-in and connect (PKCE browser flow; no secrets in the extension)

```
Extension SW                       Heed API                         Google
    │ gen verifier/challenge, state     │                               │
    │ (connect only: POST /v1/auth/connect-ticket  → ticket, 60 s)      │
    │ launchWebAuthFlow(                │                               │
    │   API/v1/auth/google/start?challenge&state&intent&ticket&ext_redirect)│
    │──────────────────────────────────▶│ validate ext_redirect (exact      │
    │                                   │ allowlist of extension IDs),      │
    │                                   │ create AuthTransaction (10 min),  │
    │                                   │ own PKCE+state+nonce for Google   │
    │◀────────────── 302 ───────────────│───────── authorize ──────────────▶│
    │                         user consents                                 │
    │                                   │◀── /callback?code&state ──────────│
    │                                   │ exchange code (client_secret +    │
    │                                   │ PKCE verifier), verify id_token,  │
    │                                   │ upsert User/Integration, store    │
    │                                   │ encrypted refresh token,          │
    │                                   │ mint one-time heed_code (60 s,    │
    │                                   │ bound to client challenge)        │
    │◀── 302 https://<extid>.chromiumapp.org/cb?code=heed_code&state ──│
    │ POST /v1/auth/token {code, code_verifier}                         │
    │──────────────────────────────────▶│ verify S256(verifier)==challenge, │
    │◀── { sessionToken, expiresAt, user }── single-use consume          │
```

Google refresh and access tokens never leave the server. The extension receives only a Heed session token.

### 5.2 Gmail sync and detection (the privacy funnel)

```
Gmail API (readonly)                 Heed API worker
     │ messages.list (INBOX, newer_than window, no promos/social/forums)  [backfill]
     │ history.list  (startHistoryId, labelId=INBOX, messageAdded)        [incremental]
     │────────── message ids ─────────▶ dedupe vs ProcessedMessage (userId, gmailMessageId)
     │ messages.get format=metadata (From, To, Subject, Date, List-*, Precedence,
     │                               Auto-Submitted, labelIds, threadId)
     │────────── headers only ────────▶ STAGE 1  hard drops   (spam/trash/drafts, promos/social/forums,
     │                                            bulk senders with List-Unsubscribe, muted senders,
     │                                            suppressed threads, too old)      → log outcome, stop
     │                                  STAGE 2  header scoring + calendar correlation
     │                                            (sender is event participant by HMAC match, subject
     │                                            overlaps event title, ICS-style subject patterns)
     │ messages.get format=full  ◀──── only if STAGE 2 score ≥ 1 (cheap signals suggest relevance)
     │────────── body parts ──────────▶ STAGE 3  clean (strip quotes, signatures, links, HTML→text)
     │                                            then content scoring: action lexicon, deadline phrases
     │                                            (chrono), obligation patterns; total score ≥ 3 passes
     │                                  STAGE 4  minimize + redact → ≤ 1,500 chars excerpt
     │                                  STAGE 5  AI extraction (AiProvider) with ≤ 5 candidate events
     │                                            budget governor may defer
     │                                  STAGE 6  validate (schema, verbatim quote, dates, event ref)
     │                                            confidence gate (0.80 / 0.50)
     │                                  STAGE 7  persist Task + Evidence (encrypted) + fingerprint;
     │                                            write ProcessedMessage; bump change seq;
     │                                            plan reminders;  body is discarded from memory
```

Full email bodies are fetched only for messages that survive stages 1–2 and are never persisted; only a verbatim evidence quote (at most 300 chars) is stored, encrypted. Detailed rule semantics: AI.md section 3.

### 5.3 Calendar sync

```
Calendar API (events.readonly)       Heed API worker
     │ events.list primary, singleEvents=true, timeMin=now-1d, timeMax=now+30d
     │    first run / daily full resync → nextSyncToken
     │ events.list syncToken=…           [every tick; 410 GONE → full resync]
     │────────── event changes ───────▶ upsert CalendarEvent (title, times, status, participant HMACs
     │                                  + domains; NO description stored)
     │                                  if event moved → recompute effectiveDueAt of linked tasks,
     │                                    re-plan reminders
     │                                  if cancelled → flag linked tasks, cancel reminders
     │                                  if new/changed description passes deterministic filter →
     │                                    same STAGE 3–7 as email (source = CALENDAR_EVENT)
     │                                  after upsert: try linking unlinked OPEN/SUGGESTED tasks
```

### 5.4 Reminder lifecycle

```
Task/Event mutation ─▶ enqueue REMINDER_PLAN(user) ─▶ planner (pure) ─▶ upsert Reminder rows
                                                                       (deterministic slotKey)
Extension GET /v1/sync ◀── pending reminders for next 7 days ─────────┘
Extension: chrome.alarms per reminder ─▶ fire:
   isReminderStillRelevant(localState)? ── no ─▶ mark SKIPPED (ack queued)
                                         └ yes ─▶ build text from live local state ─▶ notify
                                                   (quiet hours, daily cap, coalescing applied)
                                                   ─▶ ack DELIVERED (queued, batch POST /v1/reminders/ack)
```

## 6. Gmail synchronization strategy (D-05)

| Aspect | Design |
|---|---|
| Scope | `gmail.readonly` only (restricted scope; read-only; no modify/send) |
| Backfill | On connect: `messages.list` with `labelIds=INBOX`, `q=newer_than:{backfillDays}d -category:promotions -category:social -category:forums`; default 14 days (user may choose 7/14/30); hard cap 300 messages; newest first. `historyId` captured from `users.getProfile` *before* listing so no gap exists |
| Incremental | `users.history.list(startHistoryId, historyTypes=messageAdded, labelId=INBOX)`, paginated, then store the new `historyId`. SENT-label additions are also read to power completion suggestions |
| Cursor loss | History 404 (expired or invalid): bounded re-backfill (same window) and a fresh `historyId` |
| Triggers | Tick every 15 min per connected, unpaused user; on-demand at popup open (server enforces at least 2 min between syncs per user); manual "Sync now" |
| Idempotency | `ProcessedMessage(userId, gmailMessageId)` records outcome, score, fired rule IDs; no subject/sender/body for dropped messages |
| Threads | Only newly added messages are analyzed (quoted text stripped). Task fingerprint includes `threadId` so replies do not duplicate tasks |
| Completion hint | If the user's own SENT message appears in a thread with an OPEN task, set `completionSuggestedAt` (UI prompt). Never auto-complete |
| Pause | No Gmail calls. On resume, `historyId` fast-forwards to current (paused period skipped) |
| Quotas and errors | Exponential backoff on 429/403 `rateLimitExceeded`/5xx with jitter; `invalid_grant` marks integration `NEEDS_REAUTH` and stops syncing it; per-sync API-call cap |
| Push (not V1) | `users.watch` plus Pub/Sub plus 7-day watch renewal is the V2 path to near-real-time (D-14) |

## 7. Calendar synchronization strategy (D-06)

| Aspect | Design |
|---|---|
| Scope | `calendar.events.readonly` (sensitive scope) |
| Calendars | Primary only in V1 |
| Window | `now-1d … now+30d`, `singleEvents=true` (recurring expanded) |
| Incremental | `syncToken` per integration; a daily full resync refreshes the window and removes events that fell out of it; HTTP 410 triggers full resync |
| Stored | Title, start/end/all-day/timezone, status, organizer-is-self flag, `participantHashes` (HMAC-SHA256 of lowercase emails, keyed with a server pepper), `participantDomains`, Google event ID/etag. Not stored: description, location, attendee names or emails, conference links |
| Description use | Description text is read transiently for detection (same pipeline) and discarded |
| Moves/cancellations | Recompute linked tasks' `effectiveDueAt` and reminders; cancelled events flag tasks (`anchorStatus = CANCELLED`) |
| Retention | Events purged 14 days after end (tasks keep an `anchorSnapshot` with title and start) |
| Push (not V1) | `events.watch` deferred (D-14) |

## 8. Reminder architecture (D-08/D-09)

### 8.1 Principles

1. Reminders are **plans** (rows) computed deterministically from task and event state; no AI at reminder time.
2. Content is built at **delivery time** from live state, so a completed task silences itself.
3. Calendar already reminds about events, so Heed reminds only when something is **outstanding** (or for standalone tasks with deadlines).
4. Tasks anchored to an event are **bundled into one event briefing** per slot.

### 8.2 Planner (pure function, versioned `policyVersion=1`)

Inputs: item (task or event with outstanding linked tasks), deadline `D` (task `effectiveDueAt` or event start), granularity (`TIME` or `DAY`), user settings (timezone, quiet hours), `now`.

- **TIME deadlines:** candidate slots `D−24h` and `D−3h`.
- **DAY deadlines** (date-only, e.g. "by Friday"): slots at 09:00 local on the day before and 09:00 local on the day of.
- **Detection-urgent:** if the item is first planned when `D−now < 24h`, one immediate slot at `now+2min` (subject to quiet hours).
- **Overdue nudge:** one slot at `D+2h` for tasks (not briefings), at most once.
- Drop slots at or before `now`, except the detection-urgent slot.
- **Quiet hours clamp:** a slot inside quiet hours moves **backward** to quiet-hours start if that is after `now`, otherwise **forward** to quiet-hours end if that is before `D`; otherwise it is dropped.
- **Snooze:** while `snoozedUntil > now`, task slots are suppressed; one slot at `snoozedUntil` (subject to clamp) is added.
- **Briefing bundling:** all `OPEN`, unsnoozed tasks with `dueSource = EVENT_ANCHOR` and the same event produce one `EVENT_BRIEFING` reminder per slot attached to the event. Tasks with their own explicit earlier deadline get their own `TASK_DEADLINE` reminders.
- Each slot has a deterministic `slotKey = hash(kind, subjectId, offsetLabel)`; reconciliation upserts by `(userId, slotKey)` and cancels slots no longer produced.
- Fully unit-testable (table-driven plus property tests: monotonic, idempotent, never inside quiet hours, never after `D+2h`).

### 8.3 Delivery rules (extension)

At fire time, the extension runs the shared predicate `isReminderStillRelevant(reminder, cache, now)`: subject exists, status `OPEN`, not snoozed beyond `now`, and for briefings at least 1 outstanding linked task. It then applies the global gates: notifications enabled, processing/notification pause flags, daily cap, and coalescing (reminders within 10 minutes are merged). Text templates are deterministic and live in `packages/shared` (so the server preview and extension agree), for example:

> "Your **Acme Interview** is tomorrow at 11:00 AM. 1 thing is still open: Complete coding assignment."

Missed reminders (alarms lost because Chrome was closed): on `onStartup`/wake, reminders with `fireAt` in the last 6 hours still relevant and not delivered are merged into one catch-up notification; older ones are marked `MISSED` and shown in the popup.

## 9. Notification architecture (D-09)

- Channel: `chrome.notifications` (basic and list templates) plus `chrome.action` badge. No server push, no email, in V1.
- Scheduling: one `chrome.alarms` alarm per pending reminder in the next 7 days, named `rem:{id}`, rebuilt idempotently after each sync and on `onStartup` (alarms may be cleared on browser restart).
- Notification actions: **Done** (outbox `complete`) and **Snooze 1h** (outbox `snooze`); body click opens side panel to the item.
- Badge: count of overdue, due within 24h, and unreviewed suggestions.
- Limits: daily cap (default 8), quiet hours, per-reminder single delivery (ack by `reminderId`), coalescing window 10 minutes.
- Known limitation: no delivery when Chrome is closed (catch-up on next launch). Mitigations considered for later: Web Push via VAPID (free) or email fallback (D-14).

## 10. Authentication architecture (D-04)

- **Identity:** Google OIDC (`openid email profile`), the stable `sub` is the account key.
- **Integrations:** separate incremental consents for `calendar.events.readonly` and `gmail.readonly`, each with `access_type=offline`, `prompt=consent`, PKCE, `state`, `nonce`, and exact redirect URI registered on a **Web application** OAuth client (secret on server only).
- **Per-integration grants:** each connect flow requests only its own scope without `include_granted_scopes`, producing an independent refresh token per integration so each can be disconnected and revoked separately. The revocation independence assumption must be verified in the Phase 0 spike (DECISIONS unresolved #3).
- **Heed session:** opaque 256-bit random token, only its SHA-256 stored; sliding 30-day idle expiry, 90-day absolute; per-device label; revocable individually or all-at-once; the token is Heed-API-scoped and carries no Google capability.
- **Authorization:** every row has `userId`; services accept `userId` from the session only.
- Details and threat analysis: SECURITY.md.

## 11. AI architecture (summary; D-07, full detail in AI.md)

`detection` calls `AiProvider.extract()` with a provider-neutral request. `GeminiProvider` renders it to the Gemini structured-output API; `FakeProvider` powers tests. Output is Zod-validated and then verified deterministically (verbatim quote, resolvable dates, candidate-event membership) regardless of provider. A budget governor enforces per-user (25/day) and global (200/day) call caps and degrades by deferring, never by dropping data silently. Gmail-derived content is sent only to a Gemini tier whose terms prohibit training on it (D-07; unresolved #1).

## 12. Deployment architecture (D-12)

| Component | Where | Notes |
|---|---|---|
| API (and tick handler) | Google Cloud Run (`min-instances=0`, `max-instances=2`, request-based CPU, 512 MiB, 1 vCPU) | Region near Neon region; container from `infra/Dockerfile` (multi-stage, distroless or slim, non-root) |
| Database | Neon Postgres (free), pooled connection for runtime, direct connection for migrations | Branch per environment; only plain Postgres features, so it is portable (Supabase fallback) |
| Scheduler | Cloud Scheduler job (1 of the free jobs) to `POST /internal/tick` with OIDC | |
| Secrets | GCP Secret Manager mounted as env at deploy time | Never in repo, image, or extension |
| Image registry | Artifact Registry (stay within free storage, prune old images) | |
| Logs/monitoring | Cloud Logging plus Error Reporting plus an uptime check on `/healthz` | |
| Extension | Chrome Web Store, *Unlisted* (one-time $5 developer fee, the only unavoidable cost) | Fallback: load-unpacked zip with a pinned `key` |
| CI/CD | GitHub Actions; deploy via Workload Identity Federation (no long-lived GCP keys) | |

### Environments

| Env | API | DB | Google OAuth client | Extension build |
|---|---|---|---|---|
| local | `localhost:8787` | docker-compose Postgres | dev client (localhost redirect) or fake-google server | dev (`key` pinned) |
| ci | in-process | service-container Postgres / Testcontainers | fake-google | test build |
| staging | Cloud Run service `heed-api-staging` | Neon branch `staging` | staging client | staging (pinned `key`) |
| prod | Cloud Run service `heed-api` | Neon branch `main` | prod client ("In production", unverified, under 100 users) | store build |

`VITE_API_BASE_URL` and the extension ID allowlist are public configuration, not secrets.

## 13. CI/CD (GitHub Actions)

| Workflow | Trigger | Jobs |
|---|---|---|
| `ci.yml` | PR and push | install (frozen lockfile, pnpm cache) → lint, typecheck, format-check → unit tests (all packages) → API integration tests (Postgres service container, fake-google) → build extension and **forbidden-pattern bundle scan** → extension component and worker tests → Playwright E2E (extension loaded into Chromium against local API) → dependency-cruiser boundary check → `prisma migrate diff` drift check → gitleaks |
| `codeql.yml` | PR and weekly | CodeQL JavaScript/TypeScript |
| `eval.yml` | Manual and weekly | Detection quality eval against FakeProvider (deterministic stage metrics) in CI; optional real-Gemini run with repo secret, report as artifact. Gate: precision and recall must not regress by more than 2 points |
| `deploy-api.yml` | Push to `main` (to staging), tag `api-v*` (to prod) | Build image → push → `prisma migrate deploy` against target (expand/contract migrations only) → deploy Cloud Run (WIF) → smoke test `/readyz` plus a synthetic authenticated call → automatic rollback to previous revision on failure |
| `release-extension.yml` | Tag `ext-v*` | Build, zip, attach artifact and checksums; manual upload to the Chrome Web Store in V1 (Web Store API publishing deferred) |

Repository hygiene: Actions pinned by commit SHA, least-privilege `permissions:`, Dependabot (npm and Actions), required status checks on `main`, secret scanning and push protection enabled, CODEOWNERS on `docs/SECURITY.md`, `apps/api/src/modules/auth`, `crypto/`.

## 14. Testing strategy ("production-quality")

| Layer | Tooling | What it proves |
|---|---|---|
| Unit | Vitest | Pure logic: scoring rules, redaction, chrono date handling, linker, reminder planner (table-driven plus property-based with fast-check), crypto round-trips and key rotation, state machine transitions |
| Detection corpus | Vitest over `packages/eval` fixtures | Deterministic funnel behavior on a labeled synthetic corpus (S1–S10 plus adversarial cases): which messages are dropped or passed, which rules fired |
| AI contract | `FakeProvider` plus recorded-response fixtures | Validator rejects: non-verbatim quotes, past or absurd dates, unknown event refs, schema violations, injection payloads. Provider swap does not change pipeline behavior (same suite runs over every provider adapter with its fixtures) |
| API integration | Vitest plus Testcontainers or CI Postgres plus fake-google (msw or a local HTTP fake of Google OAuth, Gmail, and Calendar) | Full flows: OAuth callback, backfill, history incremental, 404 history reset, 410 calendar resync, `invalid_grant` handling, pause semantics, delete-data completeness, retention purge |
| Authorization | Dedicated suite | Cross-tenant tests: user A's token on every user B resource returns 404 (not 403, to avoid existence leaks); every route has an authz test (enforced by a route-registry test that fails if a route lacks one) |
| Privacy invariants | Tests plus CI scans | No bodies persisted (DB snapshot assertions after pipeline runs); logs contain no email content or tokens (log-capture test with canary strings); encrypted columns are ciphertext at rest |
| Extension unit and component | Vitest, Testing Library, chrome API mock | Outbox replay and idempotency, alarm reconciliation, catch-up logic, `isReminderStillRelevant`, UI states |
| Extension E2E | Playwright (Chromium, persistent context, `--load-extension`) against local API plus fake-google | Onboarding, connect flow with fake Google, detection appears, notification fired (via `chrome.notifications` test hooks), snooze/complete/dismiss/delete, pause, disconnect, delete data |
| Bundle scan | Script in CI | Built `dist/` must not match: `AIza[0-9A-Za-z_-]{35}`, `GOCSPX-`, `client_secret`, `postgres(ql)?://`, `-----BEGIN`, `1//[0-9A-Za-z_-]{20,}` (refresh-token shape), and must not contain strings from the server env schema |
| Security | CodeQL, `pnpm audit`/OSV, gitleaks, ZAP baseline against staging (manual before beta) | Known-vulnerability and secret regressions |
| Migrations | CI applies all migrations from empty and from the previous release schema; drift check | Safe deploys |
| Load/limits | k6 smoke (manual) | The 10-user profile stays within Cloud Run, Neon, and Gemini free limits |
| Coverage | Thresholds: planner, detection, crypto, auth at 90% or higher; overall 80% or higher | Regression guard (thresholds enforced, not aspirational) |

Determinism rules: injected `Clock`, seeded randomness, no real network in unit or integration tests, no real Google or Gemini calls in CI except the optional gated eval workflow.

## 15. Observability and operations

- **Logging:** pino JSON with a redaction list (authorization header, tokens, `evidence*`, `subject`, `from`, `body`); request IDs; per-user IDs as opaque UUIDs only; no email addresses in logs (a hashed form for debugging if needed).
- **Metrics (log-based):** sync duration/outcome, messages per funnel stage, AI calls/latency/rejections/deferrals, reminder planning counts, error rates, Neon wake-ups per day.
- **Alerts (free):** uptime check on `/healthz`; Cloud Monitoring alert on error-rate and on tick not seen for over 45 minutes; budget alert at $1 on the GCP billing account.
- **Operational endpoints:** `GET /healthz` (liveness, no dependencies), `GET /readyz` (DB reachable, config loaded).
- **Extension diagnostics:** local ring-buffer log (no content), "Copy diagnostics" button in Options; no third-party telemetry in V1.
- **Runbooks** (in `infra/README.md`): rotate encryption key, rotate Google client secret, revoke all sessions, restore from Neon PITR (6-hour window), handle Gemini quota exhaustion, kill-switch (`PROCESSING_ENABLED=false` env flag stops all Google and AI calls).

## 16. Failure modes and degradation

| Failure | Behavior |
|---|---|
| Gemini unavailable/quota | Candidate messages become `DEFERRED` jobs, retried for up to 48 h, then `AI_UNAVAILABLE`; calendar and existing reminders unaffected; UI shows "AI paused, will retry" |
| Gmail `invalid_grant` | Integration `NEEDS_REAUTH`; sync stopped; UI banner with Reconnect; existing items remain |
| Calendar 410 | Full resync |
| Neon cold start | First request pays about 1 s; tick and clients tolerate (timeouts 10 s, retries) |
| Cloud Run cold start | About 1–2 s; extension shows cached data immediately |
| Tick missed | Next on-demand sync or tick catches up (cursor-based, so no data loss) |
| Extension offline | Outbox queues; alarms still fire from the local cache |
| Neon monthly compute exhausted | DB suspends until next month: documented risk; mitigation is the 15-minute tick and monitoring of CU-hours; fallback to Supabase (portable schema) |
| Bad deploy | Cloud Run traffic rollback to previous revision (automated on smoke-test failure) |

## 17. Scalability path (D-14, summary)

V1 is sized for about 10 users (hundreds of calls per day). The same architecture scales to hundreds with: Gmail push via Pub/Sub, a resident worker (Cloud Run min-instance or a small VM) replacing tick polling, paid Neon/Postgres tier plus pgbouncer, paid Gemini tier, and Web Push. The gating item for more than 100 users is **Google restricted-scope verification (CASA assessment)**, not infrastructure.
