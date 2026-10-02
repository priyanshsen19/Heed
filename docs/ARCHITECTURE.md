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
- **The server decides; channels deliver.** The server plans reminders, evaluates relevance, applies quiet hours, caps, and coalescing, and composes the final notification text. A `NotificationProvider` then delivers it. In V1 the only provider is Chrome: the extension pre-fetches the next 36 hours of ready-to-show notifications, schedules local alarms, and simply displays them. Future providers (web push, email, mobile push) plug in behind the same interface without touching the reminder engine (D-09, D-24).
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
│           ├── modules/                # one folder per module in section 4.2; each owns its tables
│           │   ├── auth/  users/  audit/                    # identity, settings, consents, security events
│           │   ├── integrations/  gmail/  calendar/         # provider-neutral lifecycle + provider adapters
│           │   ├── sync/  detection/  ai/  usage/           # orchestration, funnel orchestration, AI router, accounting
│           │   ├── tasks/  commitments/  events/            # domain services and state machines
│           │   ├── dependencies/  evidence/                 # relationships, "Why" read model
│           │   ├── reminders/  notifications/               # planner + scheduler; composer + providers
│           │   ├── privacy/                                 # export, delete, retention purge
│           │   └── internal/                                # /internal/tick, health
│           ├── jobs/                   # JobQueue port + PostgresJobQueue, runner, handler registry (handlers live in their modules)
│           ├── crypto/                 # AES-256-GCM envelope, HMAC fingerprints, key rotation
│           └── observability/          # pino logger with redaction, request ids, metrics
├── packages/
│   ├── shared/                         # SAFE FOR EXTENSION: zod DTO schemas, enums, API types,
│   │                                   # rule-id → text catalog, data-inventory registry (no business rules)
│   ├── detection/                      # SERVER ONLY: pure deterministic pipeline (no IO):
│   │                                   # header filters, scoring rules (versioned), body cleaning,
│   │                                   # redaction, chrono date candidates, event linker
│   ├── ai/                             # SERVER ONLY: AiProvider interface, GeminiProvider (+ optional second adapter),
│   │                                   # FakeProvider, versioned prompts (extract-v2), output schemas + validators
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

**Thin-client rule.** The extension contains only presentation, a local cache, session state, Chrome integration (notifications, alarms, badge, identity), and lightweight UI state. It contains **no** detection, scheduling, relevance, quiet-hours, notification-cap, deduplication, or deadline logic; those live server-side and arrive as data (ready-to-display notification payloads, computed priorities and deadlines). The only local decision is honoring the user's own pending outbox actions (for example, not showing a notification for a task the user just completed while offline).

MV3 service workers are ephemeral (terminated after about 30 s idle). Therefore:

- The service worker is **stateless between events**; all durable state lives in `chrome.storage.local` and is rehydrated on each wake.
- The service worker is the **single writer** of the local store. UI pages (popup, side panel, options) are read-mostly: they subscribe to `chrome.storage.onChanged` and send commands (`completeTask`, `snooze`, `syncNow`, ...) to the worker via `chrome.runtime.sendMessage`. This removes cross-context write races.
- Wake triggers: `chrome.alarms` (sync heartbeat and reminder alarms), `chrome.runtime.onStartup` and `onInstalled`, `chrome.notifications.onClicked` and `onButtonClicked`, UI messages.

### 3.3 Local store (chrome.storage.local), typed and versioned

| Key | Content |
|---|---|
| `auth` | `{ sessionToken, expiresAt, userId }` (Heed session only) |
| `cache.tasks`, `cache.events`, `cache.notifications` | Mirror of server data the user can see, keyed by id (notifications: next 36 hours, with final text) |
| `sync.cursor` | Server change-sequence cursor for delta sync |
| `outbox` | Ordered queue of pending mutations `{ idempotencyKey, method, path, body, createdAt }` |
| `ui.prefs` | Per-viewer conveniences (selected tab, etc.) |
| `schemaVersion` | For migrations of local shape |

The default storage quota (10 MB) is ample: items are small and the server returns only a 30-day window. On sign-out or "delete my data", the entire local store is cleared.

### 3.4 Sync loop in the extension

1. Heartbeat alarm every 5 minutes, plus popup open (debounced to 1 per 2 minutes), plus manual refresh.
2. Flush `outbox` (in order, with `Idempotency-Key`). A 4xx permanent error drops the entry and surfaces a toast; a network/5xx error keeps it for retry.
3. `GET /v1/sync?cursor=…&limit=…` returns one **bounded page** `{ tasks, events, notifications, tombstones, nextCursor, hasMore, resyncRequired }`; loop while `hasMore`. Apply to cache; if `resyncRequired`, clear cache and refetch from the start.
4. Reconcile **local alarms** from `cache.notifications` (one alarm per `SCHEDULED` notification, diffed against existing alarms, so it is idempotent; cancelled notifications remove their alarms).
5. Update badge from server-provided counts.

The 5-minute heartbeat calls only the cheap delta endpoint. It does *not* trigger Gmail/Calendar sync on the server (the server's own tick does that; `POST /v1/sync/now` forces one).

### 3.5 UI

React 18 plus TypeScript, Vite build, Tailwind CSS (build-time) with Radix UI primitives, React Router (hash routing) in side panel and options. Server data is read from the local store via a small `useStore` selector hook (no remote state library needed because the worker owns fetching). UI never renders email HTML; the only email-derived text shown is plain-text evidence quotes and metadata, rendered as text nodes (SECURITY.md XSS section).

## 4. Backend architecture (D-02)

### 4.1 Stack

Node.js (current Active LTS, pinned in `.nvmrc` and Dockerfile) · TypeScript strict · Fastify 5 with `fastify-type-provider-zod` · Zod for all input/output validation · Prisma ORM · Luxon for time zones · chrono-node for date candidates · `@google/genai` behind `AiProvider` · pino logging · Vitest.

### 4.2 Module boundaries

Modular monolith; each module exposes a typed service interface and owns its tables. Cross-module access only via those interfaces. Route handlers are thin (validate, authorize, call service, serialize).

| Module | Responsibility | Owns tables | Depends on (interfaces only) |
|---|---|---|---|
| `auth` | Google OAuth (code flow with PKCE, state, nonce), Heed sessions, connect tickets, session revocation | `Session`, `AuthTransaction` | `users`, `integrations`, `audit` |
| `users` | Account, settings, consents, pause/resume, sender rules | `User`, `UserSettings`, `Consent`, `SenderRule` | `audit` |
| `integrations` | Provider-neutral integration lifecycle (connect, token vault, health, disconnect/revoke) and the `IntegrationProvider` registry | `Integration` | provider adapters |
| `gmail`, `calendar` | **Provider adapters** implementing `IntegrationProvider` (Gmail and Google Calendar REST, retry/backoff, quota handling, normalization into provider-neutral source items). No domain logic | none | (Google HTTP only) |
| `sync` | Cursor management, leases, scheduling (`nextSyncAt`), orchestration of "list changes → hand to detection"; honors pause | `SyncRun` | `integrations`, `detection`, `jobs` |
| `detection` | Deterministic funnel (hard filters, header and content scoring, cleaning, redaction, candidate selection), then AI result validation and persistence orchestration | `ProcessedMessage`, `SenderStats` | `ai`, `tasks`, `events`, `commitments`, `dependencies`, `evidence`, `usage` |
| `ai` | `AiProvider` interface, router (model pool, quota-aware routing, circuit breaker), prompts, output validation | `AiAnalysis` | provider adapters, `usage` |
| `usage` | Usage accounting and budget governance (per-user and per-provider-project), enforcement of `MAX_AI_*` limits | `AiUsage`, `AiProviderUsage` | none |
| `tasks` | Task domain service and state machine (actions, preparations, deadlines), priorities, completion hints | `Task`, `TaskFeedback`, `Suppression` | `dependencies`, `reminders` (via job), `audit` |
| `commitments` | Commitments the user made (sent-mail detection results, `PROMISED_BY_USER` direction), counterparty resolution | `Counterparty` | `tasks`, `evidence` |
| `events` | Event domain service (calendar mirror, email-detected, manual), merge and fingerprinting, context level | `Event` | `dependencies` |
| `dependencies` | Relationships (task→event, task→task), effective-deadline derivation, target-state propagation | `Dependency` | `tasks`, `events` |
| `evidence` | Evidence records and the "Why" read model (decrypt for owner) | `Evidence` | `crypto` |
| `reminders` | **ReminderPlanner** (pure) plus **ReminderScheduler** (due-time materialization) | `Reminder` | `tasks`, `events`, `dependencies`, `notifications` |
| `notifications` | `NotificationComposer` (pure, final text), `NotificationProvider` registry, delivery state machine, acks | `Notification` | provider adapters |
| `privacy` | Export, delete-data, delete-account (`PURGE_USER_DATA`), retention purge, data-inventory enforcement | `DeletionReceipt` | every module's purge hook |
| `audit` | Security and privacy event log | `AuditLog` | none |
| `jobs` | `JobQueue` abstraction and runner (section 4.4) | `Job` | none (handlers register from other modules) |
| `internal` | `/internal/tick`, `/healthz`, `/readyz` | none | `jobs`, `sync`, `reminders` |

Modules own their tables; no module queries another module's tables. Prisma types never cross a module boundary (modules expose domain types and services); this is what lets the storage engine, partitioning, or even a service split change later without changing callers.

### 4.2a Ports (the genuine external boundaries; nothing else is abstracted)

```ts
// Source integrations: Gmail and Calendar today, Outlook later. The domain only ever sees normalized items.
interface IntegrationProvider {
  readonly id: 'GMAIL' | 'GOOGLE_CALENDAR' | string;
  readonly capabilities: { mail?: boolean; calendar?: boolean; sentMail?: boolean };
  authorizeUrl(params): URL; exchangeCode(code, verifier): Promise<ProviderGrant>; revoke(grant): Promise<void>;
  listChanges(grant, cursor: string | null, opts: { limit: number }): Promise<{ items: SourceItemRef[]; nextCursor: string; hasMore: boolean }>;
  fetchHeaders(grant, ref): Promise<SourceHeaders>;          // mail: headers only
  fetchContent(grant, ref): Promise<SourceContent>;          // body transiently, never persisted by the caller
}
interface AiProvider { /* AI.md section 4 */ }
interface NotificationProvider {                              // Chrome today; WebPush/Email/MobilePush later
  readonly channel: NotificationChannel;
  readonly deliveryMode: 'PULL_PREFETCH' | 'PUSH_AT_DUE';    // PULL: client fetches ahead; PUSH: server sends at deliverAt
  readonly lookaheadMs: number;                               // how far ahead notifications are materialized (Chrome: 36 h; push: 0)
  send?(n: Notification, idempotencyKey: string): Promise<{ providerRef?: string }>;   // PUSH_AT_DUE only
  onAck(ack): Promise<void>;
}
interface JobQueue { enqueue; claim; heartbeat; complete; fail; cancel }   // section 4.4
interface Clock { now(): Date }                                // injected everywhere; no hidden time
interface RateLimiter { consume(key, limit, window): Promise<{ allowed: boolean; retryAfterMs?: number }> }   // Postgres-backed in V1
interface SecretsProvider { get(name): Promise<string> }       // GCP Secret Manager / env in dev
```

The database is the only other external boundary and is reached exclusively through each module's repository layer over Prisma and plain PostgreSQL features, so a managed-Postgres change (Neon to Supabase, Cloud SQL, Aurora) touches configuration only. The outbound-email boundary is the future `EMAIL` notification channel (an `EmailNotificationProvider`), not a separate abstraction. Not abstracted on purpose: logging, HTTP framework, validation library, UI framework.

### 4.3 Request pipeline

`request-id → structured logger (redacting) → rate limit → auth (session lookup) → zod validation → handler → zod response serialization → problem+json error mapper`. Every query is scoped by `userId` obtained from the session; IDs from clients are never trusted without a `where: { id, userId }` (see SECURITY.md authorization section).

### 4.4 Job system on scale-to-zero (D-02, D-12)

Cloud Run (request-based billing) gives no CPU between requests, so there is no resident worker. Design:

**Abstraction (domain code depends only on this):**

```ts
type Job = {
  id: string; type: JobType; queue: string; status: JobStatus; priority: number;
  userId?: string; payload: Record<string, unknown>;       // ids only, never content
  idempotencyKey: string;                                    // required; duplicate enqueue returns the existing job
  correlationId: string;
  attempts: number; maxAttempts: number;
  createdAt: Date; scheduledAt: Date; startedAt?: Date; completedAt?: Date;
  error?: { code: string; message: string };                 // sanitized, no content
};
interface JobQueue {
  enqueue(job: NewJob): Promise<Job>;                        // idempotent on idempotencyKey
  claim(opts: { queues: string[]; limit: number; leaseMs: number; workerId: string }): Promise<Job[]>;
  heartbeat(id: string, leaseMs: number): Promise<void>;
  complete(id: string): Promise<void>;
  fail(id: string, err: { code: string; message: string }, opts: { retryAt?: Date }): Promise<void>;
  cancel(id: string): Promise<void>;
}
type JobHandler<P> = (job: Job & { payload: P }, ctx: { clock: Clock; log: Logger }) => Promise<void>;   // registered by modules; queue-agnostic
```

Handlers are registered per `JobType` by their owning module and know nothing about the queue implementation. `PostgresJobQueue` is the V1 implementation. A later `CloudTasksJobQueue` (or SQS, Pub/Sub) implements `enqueue` by creating a task that calls `POST /internal/jobs/run` (OIDC-authenticated) and reuses the same handler registry; `claim` is then unused (push model). Nothing in the domain changes.

**V1 implementation (scale-to-zero, no resident worker, no `setInterval`, no process timers):**

- **Table:** `Job` (DATA_MODEL) with every required field: id, type, status, attempts, createdAt, scheduledAt, startedAt, completedAt, error, idempotency key (plus queue, priority, correlation id, lease).
- **Claim:** `UPDATE … WHERE id IN (SELECT id FROM "Job" WHERE status='PENDING' AND scheduledAt<=now() ORDER BY priority, scheduledAt FOR UPDATE SKIP LOCKED LIMIT n) RETURNING *` with a lease (`lockedUntil = now()+lease`); expired leases are reclaimable (crash safety).
- **Tick:** Cloud Scheduler calls `POST /internal/tick` every 15 minutes (OIDC token from a dedicated service account). The handler never iterates over users; it runs **due-time queries**: (a) enqueue sync jobs for integrations `WHERE status='CONNECTED' AND nextSyncAt <= now() ORDER BY nextSyncAt LIMIT N` (staggered per user by a deterministic jitter so load spreads), each protected by the `syncLeaseUntil` lease; (b) run `DELIVER_DUE_REMINDERS` (section 8.3); (c) drain the deferred-AI candidate queue within the AI budget (priority order); (d) claim and run jobs with concurrency 3 and a 4-minute wall-clock budget; (e) enqueue the daily `RETENTION_PURGE` if due. It returns counters and exits. If the scheduler is later replaced (Cloud Tasks, a resident worker), only the trigger changes.
- **On-demand:** `POST /v1/sync/now` runs that user's sync **inline** with a 20 s budget (Cloud Run gives no CPU after the response). Candidates not processed within the budget stay as deferred-queue entries for the next tick; the response says `{ partial: true }`.
- **Retries:** exponential backoff (1 m, 5 m, 30 m), `maxAttempts` 5, then `FAILED` with a sanitized error code. Poison jobs never block the queue (per-job lease and attempt cap).
- **Idempotency everywhere:** every handler is safe to re-run and every effect is guarded by a database constraint (DATA_MODEL section 5).

Why 15 minutes: Neon's free plan allows 100 CU-hours/month and suspends compute after 5 idle minutes; a 15-minute tick lets the database suspend between runs (about 35% duty cycle, roughly 65 CU-hours/month at 0.25 CU) while a 5-minute tick would keep it permanently awake (about 180 CU-hours) and exhaust the quota (D-03, D-11). Interactive freshness comes from on-demand sync when the extension opens. Because notifications are materialized ahead of time (36-hour lookahead) and delivered by the extension's local alarms, reminder punctuality does **not** depend on tick frequency.

### 4.5 Statelessness rules (horizontal scalability in principle)

- **No business state in process memory.** Tasks, events, reminders, notifications, OAuth transactions, sessions, sync cursors, jobs, preferences, quota counters, provider backoff state, and idempotency records are all in PostgreSQL. Restarting any instance loses nothing.
- **In-memory caches are optimizations only** and must be safe to lose or to be inconsistent across instances: Google access tokens (re-minted on miss), decrypted data keys, the JWKS cache, compiled rule tables, per-request memoization. Any logic whose correctness depends on a cache is a bug.
- **No local timers or local filesystem persistence.** Time-driven work is scheduled through `Job.scheduledAt`, `Integration.nextSyncAt`, and `Reminder.triggerAt` and executed by whoever calls the tick or the job runner; the container filesystem is read-only.
- **No assumption of one process, one worker, or one DB connection:** overlapping runners are made safe by leases and `SKIP LOCKED`; the Prisma connection pool is sized from configuration; the runtime uses the provider's pooled endpoint.
- **Rate limiting** goes through the `RateLimiter` port. V1 uses Postgres counters (`RateLimitCounter`) for authentication, sync, export, and AI-adjacent routes so limits hold across instances; a cheap per-instance prefilter may sit in front as an optimization. (This replaces the earlier note that in-memory limiting was acceptable; see CF-10.)
- **Config is injected** (parsed once at boot from the secrets provider and environment); there are no module-level mutable singletons holding domain state.

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
     │                                            suppressed threads, too old)      → counted in SyncRun, no row, stop
     │                                  STAGE 2  header scoring + calendar correlation
     │                                            (sender is event participant by HMAC match, subject
     │                                            overlaps event title, ICS-style subject patterns)
     │ messages.get format=full  ◀──── only if STAGE 2 score ≥ 1 (cheap signals suggest relevance)
     │────────── body parts ──────────▶ STAGE 3  clean (strip quotes, signatures, links, HTML→text)
     │                                            then content scoring: action lexicon, deadline phrases
     │                                            (chrono), obligation patterns; total score ≥ 3 passes
     │                                  STAGE 4  minimize + redact → ≤ 1,500 chars excerpt
     │                                  STAGE 5  AI extraction (AiProvider via router) with ≤ 5 candidate events;
     │                                            up to 4 same-user items batched per request when a backlog
     │                                            exists; budget governor may defer (priority queue)
     │                                  STAGE 6  validate (schema, verbatim quote, dates, dependency targets,
     │                                            kind/direction/counterparty) + confidence gate (0.80 / 0.50)
     │                                  STAGE 7  persist in one transaction: Task, Dependency rows, Counterparty,
     │                                            Evidence (encrypted), fingerprint, AiAnalysis, ProcessedMessage;
     │                                            bump change seq; enqueue REMINDER_PLAN; body discarded
```

Full email bodies are fetched only for messages that survive stages 1–2 and are never persisted; only a verbatim evidence quote (at most 300 chars) is stored, encrypted. Detailed rule semantics: AI.md section 3.

### 5.3 Calendar sync

```
Calendar API (events.readonly)       Heed API worker
     │ events.list primary, singleEvents=true, timeMin=now-1d, timeMax=now+30d
     │    first run / daily full resync → nextSyncToken
     │ events.list syncToken=…           [every tick; 410 GONE → full resync]
     │────────── event changes ───────▶ upsert Event (source=CALENDAR_SYNC; title, times, state, participant
     │                                  HMACs + domains; NO description stored); unchanged etag → skip
     │                                  if event moved → recompute effectiveDueAt of dependent tasks,
     │                                    re-plan reminders
     │                                  if cancelled → Dependency.status=TARGET_CANCELLED, cancel reminders
     │                                  if new/changed description passes deterministic filter →
     │                                    same STAGE 3–7 as email (source = CALENDAR_EVENT; analysis is
     │                                    skipped when an AiAnalysis already exists for eventId:etag)
     │                                  after upsert: try linking unlinked OPEN/SUGGESTED tasks and merge any
     │                                    EMAIL_DETECTED event that matches (title tokens, start ±30 min)
```

### 5.4 Reminder lifecycle (plan → schedule → notify → ack)

```
Task/Event/Dependency/Settings mutation ─▶ enqueue REMINDER_PLAN(user)
        │
        ▼
ReminderPlanner (pure) ─▶ upsert Reminder rows (PENDING, triggerAt, priority, deterministic slotKey);
                          cancel PENDING reminders no longer planned; cancel SCHEDULED notifications
                          whose reminder changed (new payload generation = new idempotency key)
        │
        ▼  every tick (and after plan changes): DELIVER_DUE_REMINDERS job
ReminderScheduler:  SELECT … FROM Reminder WHERE status='PENDING'
                    AND triggerAt <= now() + provider.lookahead ORDER BY triggerAt, priority
                    LIMIT N FOR UPDATE SKIP LOCKED                       -- indexed due-time query, no user scan
        │  for each: load live entities → relevance check (deterministic) → NotificationComposer (final text)
        │  → gates (notifications enabled, silence-while-paused, daily cap, quiet hours, 10-min coalescing)
        │  → INSERT Notification (idempotencyKey unique) + Reminder.status=MATERIALIZED   -- one transaction
        ▼
NotificationProvider:
   CHROME (PULL_PREFETCH, lookahead 36 h): notification appears in GET /v1/sync → extension schedules a
        chrome.alarm at deliverAt → shows the payload as-is → POST /v1/notifications/ack (DELIVERED/CLICKED/ACTIONED)
   future WEB_PUSH / EMAIL / MOBILE_PUSH (PUSH_AT_DUE, lookahead 0): scheduler calls provider.send(n, idempotencyKey)
        at deliverAt with retry and backoff; provider acks update Notification.status
```

## 6. Gmail synchronization strategy (D-05)

| Aspect | Design |
|---|---|
| Scope | `gmail.readonly` only (restricted scope; read-only; no modify/send) |
| Backfill | On connect: `messages.list` with `labelIds=INBOX`, `q=newer_than:{backfillDays}d -category:promotions -category:social -category:forums`; default 14 days (user may choose 7/14/30); hard cap 300 messages; newest first. `historyId` captured from `users.getProfile` *before* listing so no gap exists |
| Incremental | `users.history.list(startHistoryId, historyTypes=messageAdded, labelId=INBOX)`, paginated, then store the new `historyId` in the same transaction as the last persisted message. SENT-label additions are read for completion suggestions and, with the `SENT_MAIL_COMMITMENTS` consent, as commitment candidates |
| Cursor loss | History 404 (expired or invalid): bounded re-backfill (same window) and a fresh `historyId` |
| Triggers | The 15-minute tick runs the due-time query `Integration WHERE status='CONNECTED' AND nextSyncAt <= now()` (staggered jitter; never a scan of all users); on-demand at popup open (server enforces at least 2 min between syncs per user); manual "Sync now" |
| Idempotency | A sync lease (`Integration.syncLeaseUntil`) allows one runner per integration; `ProcessedMessage(userId, gmailMessageId)` is claimed with `INSERT … ON CONFLICT DO NOTHING` before analysis and exists only for messages whose body was fetched or that are deferred; header-stage drops are re-evaluable and counted only (DATA_MODEL 6.3). Running a sync twice creates nothing twice |
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
| Moves/cancellations | Recompute dependent tasks' `effectiveDueAt` and reminders; cancelled events set `Dependency.status = TARGET_CANCELLED` (tasks are flagged, never deleted) |
| Retention | Events purged 14 days after end (dependencies become `TARGET_PURGED`) |
| Idempotency | Upsert by `(userId, source, providerCalendarId, providerEventId)`; `etag` unchanged means skipped; `syncLeaseUntil` lease as for Gmail |
| Push (not V1) | `events.watch` deferred (D-14) |

## 8. Reminder architecture (D-08, D-24)

### 8.1 Principles

1. The **reminder engine says "reminder X is due"**; it never knows how it is delivered. Delivery is a `NotificationProvider` concern (section 9).
2. Reminders are **plans** (rows with `triggerAt`) computed deterministically from task, event, dependency, and settings state. **No AI at reminder time.** The plan is queryable by due time, so no component ever scans all tasks or all users.
3. Relevance is **evaluated again when a reminder is materialized**, from live state, so a completed or dismissed item silences itself; later changes cancel or regenerate any not-yet-delivered notification.
4. Reminders are **contextual**: every notification carries who asked (counterparty role/name, organization), where it came from (source), and what it depends on (event, prerequisite), composed deterministically from stored, validated fields.
5. Items attached to one event are **bundled into one event briefing** per slot, not one notification per task.
6. The calendar already reminds about plain events, so Heed's *event reminders* are the **enriched** kind: an event gets one when Heed holds context for it (outstanding tasks, dependencies, commitments, or linked evidence), when the user pins it (`remindMode = ALWAYS`), or for all events if the user turns on `remindAllEvents`. `remindMode = NEVER` silences an event's briefing (its tasks keep their own deadline reminders).

### 8.2 Planner (pure function, versioned `policyVersion = 2`)

Inputs: a task or an event with its dependencies, effective deadline `D` (task `effectiveDueAt`, or event start), granularity (`TIME` or `DAY`; all-day events are `DAY`), user settings (timezone, quiet hours, lead profile, `remindAllEvents`), and `now`. Output: a set of slots `{ kind, subject, triggerAt, priority, slotKey }`.

Lead offsets by `reminderLeadProfile`: `STANDARD` = `D−24h`, `D−3h`; `EARLY` = `D−48h`, `D−24h`, `D−3h`; `MINIMAL` = `D−3h`.

| Kind | Produced for | Slots |
|---|---|---|
| `EVENT_BRIEFING` | An `ACTIVE` future event that qualifies (outstanding `OPEN`, unsnoozed tasks depend on it via `BEFORE_EVENT`/`DURING_EVENT`, or contextual/pinned/`remindAllEvents`) | Lead offsets from event start (`DAY` events: 09:00 local the day before and the day of). If any outstanding item is a `PREPARATION` task and the event starts before 12:00 local, a slot at **18:00 local the evening before** is added (replacing a lead slot that would fall in quiet hours). Carries all outstanding items and unmet prerequisites |
| `TASK_DEADLINE` | Tasks with their **own** deadline (`dueSource` `EXTRACTED` or `USER`) of kind `ACTION`, `DEADLINE`, or `COMMITMENT` | Lead offsets from `D` (`DAY` granularity: 09:00 local the day before and the day of) |
| `TASK_PREPARATION` | `PREPARATION` tasks **without** an event anchor (for example "read the brief before Thursday") | 18:00 local the evening before `D` and `D−90min` (if within waking hours). Anchored preparation tasks are carried by their event's briefing instead |
| `DEPENDENCY_BLOCKED` | A task with an `OPEN` `BLOCKED_BY` prerequisite and a deadline | Replaces that task's `TASK_DEADLINE` slots while the prerequisite is open; the notification names the prerequisite ("X is due tomorrow; its prerequisite Y is still open") |
| `TASK_OVERDUE` | `OPEN` tasks past `D` | One slot at `D+2h`, once |

Common rules:
- **Detection-urgent:** if an item is first planned when `D−now < 24h`, one immediate slot at `now+2min` (subject to quiet hours).
- Drop slots at or before `now` (except detection-urgent).
- **Quiet hours clamp:** a slot inside quiet hours moves backward to quiet-hours start if that is after `now`, otherwise forward to quiet-hours end if that is before `D`; otherwise it is dropped.
- **Snooze:** while `snoozedUntil > now`, the task's slots are suppressed; one slot at `snoozedUntil` (clamped) is added.
- **Bundling:** a task whose deadline comes from an event dependency never gets its own `TASK_DEADLINE` slots; it is carried by the event briefing. A task whose own explicit deadline is earlier than the event gets both (distinct subjects, distinct slot keys).
- **Priority:** 0 (within 3 h or overdue) to 3, derived from `D−triggerAt` and the task priority; used only for ordering and caps.
- `slotKey = hash(policyVersion, kind, subjectId, offsetLabel)`; reconciliation upserts by `(userId, slotKey)` and cancels slots no longer produced, so planning twice creates nothing twice.
- Table-driven and property tests (idempotent, monotonic, never inside quiet hours, never later than `D+2h`, bundling never duplicates a task, all kinds covered).

### 8.3 ReminderScheduler (due-time materialization)

Runs as the `DELIVER_DUE_REMINDERS` job from the tick (and after plan changes). For each registered provider it executes the indexed due-time query shown in section 5.4 with `lookahead = provider.lookaheadMs`, in bounded batches with `FOR UPDATE SKIP LOCKED` (safe with many concurrent workers). For each reminder, in one transaction:

1. **Relevance** (deterministic, server-side, from live state): subject exists; task `OPEN` and not snoozed beyond `triggerAt`, or event `ACTIVE` and (at least one outstanding item or qualifying context); user not paused with `pauseSilencesReminders`. If not relevant, mark `SKIPPED`.
2. **Compose** with `NotificationComposer` (pure): title, body (at most 200 characters, plain text), up to three actions, an in-extension `deepLink`. Example for the canonical scenario:
   > **Heed:** Your Acme interview is tomorrow at 11:00 AM. The coding assignment mentioned by the recruiter (Jane, Acme) is still incomplete.

   Counterparty role and name come from validated, user-visible fields; when absent the template falls back to the sender's display name or "an email". Batch cases name the prerequisite or list the first items and a count; the full list and the source link are one click away in the side panel.
3. **Gates:** notifications enabled; daily cap (default 8, counted per user-local day over `Notification` rows); **coalescing:** reminders for the same user whose `deliverAt` falls within 10 minutes become one digest notification (the primary reminder is the highest-priority one, the others are marked `MATERIALIZED` and named in the body).
4. **Insert** the `Notification` with `idempotencyKey = hash(reminderId, channel, payloadGeneration)` using `ON CONFLICT DO NOTHING`, then set the reminder `MATERIALIZED`. A retried scheduler run therefore cannot create a second notification.

A delivered or `CLICKED`/`ACTIONED` notification is terminal. If the underlying task, event, dependency, or settings change before delivery, `REMINDER_PLAN` cancels the `SCHEDULED` notification (delta feed removes it from the extension's alarms) and the next planning pass materializes a fresh one with a new payload generation.

## 9. Notification architecture (D-09, D-24)

**Boundary:** the reminder engine produces `Notification` rows for channels; each `NotificationProvider` knows only how to deliver one. The engine has no reference to Chrome, push services, or email.

| Provider | Mode | Lookahead | How it delivers | Status |
|---|---|---|---|---|
| `ChromeNotificationProvider` | `PULL_PREFETCH` | 36 hours | The extension receives notifications through `GET /v1/sync`, sets a local `chrome.alarm` per `SCHEDULED` notification (rebuilt idempotently after each sync and on `onStartup`, since alarms may not survive restarts), and at `deliverAt` shows the payload with `chrome.notifications`. Actions *Done* and *Snooze 1h* go through the outbox; click opens the side panel at `deepLink`. Acks (`DELIVERED`, `CLICKED`, `ACTIONED`) are batched to `POST /v1/notifications/ack` | V1 |
| `WebPushNotificationProvider` | `PUSH_AT_DUE` | 0 | Server sends at `deliverAt` (VAPID), retries with backoff, idempotency key per send | Future; no engine change |
| `EmailNotificationProvider` | `PUSH_AT_DUE` | 0 | Server sends a digest email | Future |
| `MobilePushProvider` | `PUSH_AT_DUE` | 0 | FCM/APNs | Future |

Chrome-specific behavior (all presentation or platform integration, no business rules): badge text from server-provided counts (overdue, due within 24 hours, unreviewed suggestions); a notification whose subject the user already acted on in the local outbox is not shown; if Chrome was closed at `deliverAt`, on next start the extension shows **one** catch-up notification ("You missed N reminders while Chrome was closed") for payloads that came due in the last 6 hours and acks them, while a server sweeper marks anything older `EXPIRED`, which the popup lists as "Missed". Known limitation: no delivery while Chrome is closed (documented; push channels are the future remedy, D-14).

Limits (enforced server-side at materialization): daily cap, quiet hours (in the planner), coalescing window, one `Notification` per `(reminder, channel, generation)`.

## 10. Authentication architecture (D-04)

- **Identity:** Google OIDC (`openid email profile`), the stable `sub` is the account key.
- **Integrations:** separate incremental consents for `calendar.events.readonly` and `gmail.readonly`, each with `access_type=offline`, `prompt=consent`, PKCE, `state`, `nonce`, and exact redirect URI registered on a **Web application** OAuth client (secret on server only).
- **Per-integration grants:** each connect flow requests only its own scope without `include_granted_scopes`, producing an independent refresh token per integration so each can be disconnected and revoked separately. The revocation independence assumption must be verified in the Phase 0 spike (DECISIONS unresolved #3).
- **Heed session:** opaque 256-bit random token, only its SHA-256 stored; sliding 30-day idle expiry, 90-day absolute; per-device label; revocable individually or all-at-once; the token is Heed-API-scoped and carries no Google capability.
- **Authorization:** every row has `userId`; services accept `userId` from the session only.
- Details and threat analysis: SECURITY.md.

## 11. AI architecture (summary; D-07, full detail in AI.md)

`detection` calls the `ai` module's router, which picks a provider/model from the configured pool and calls `AiProvider.extract()` with a provider-neutral, optionally batched request. `GeminiProvider` renders it to the Gemini structured-output API; `FakeProvider` powers tests; other providers can join the pool without domain changes. Output is Zod-validated and then verified deterministically (verbatim quote, resolvable dates, dependency targets) regardless of provider. The `usage` module enforces `MAX_AI_REQUESTS_PER_USER_DAY`, `MAX_AI_TOKENS_PER_USER_DAY`, `MAX_EMAILS_ANALYZED_PER_SYNC`, and the project-level quota headroom from persisted counters, and the system **degrades by queueing candidates (priority order) and continuing everything else**, never by disabling features or dropping data silently. The data-use posture is explicit: free-tier mode requires acknowledgment, the `FREE_TIER` consent variant, and a region attestation; switching to a paid tier is a configuration change (D-07, D-18).

## 12. Deployment architecture (D-12)

| Component | Where | Notes |
|---|---|---|
| API (and tick handler) | Google Cloud Run (`min-instances=0`, `max-instances=2`, request-based CPU, 512 MiB, 1 vCPU) | Region near Neon region; container from `infra/Dockerfile` (multi-stage, distroless or slim, non-root) |
| Database | Neon Postgres (free), pooled connection for runtime, direct connection for migrations | Branch per environment; only plain Postgres features, so it is portable (Supabase fallback) |
| Scheduler | Cloud Scheduler job (1 of the free jobs) to `POST /internal/tick` with OIDC | |
| Secrets | GCP Secret Manager: **one** JSON secret (`heed-runtime-config`) holding the Google client secret, AI API keys, database URL, data keys, and pepper, read once per instance start (stays inside the free 6 active versions and 10,000 access operations per month; separate secrets would exceed both) | Never in repo, image, or extension. Migrations use a separate CI-only direct DB URL held as a GitHub environment secret |
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
| Extension unit and component | Vitest, Testing Library, chrome API mock | Outbox replay and idempotency, paged sync and resync, alarm reconciliation from server notifications, catch-up presentation, honoring pending local outbox actions, UI states; plus a boundary test that the extension contains no scheduling or relevance logic |
| Extension E2E | Playwright (Chromium, persistent context, `--load-extension`) against local API plus fake-google | Onboarding, connect flow with fake Google, detection appears, notification fired (via `chrome.notifications` test hooks), snooze/complete/dismiss/delete, pause, disconnect, delete data |
| Bundle scan | Script in CI | Built `dist/` must not match: `AIza[0-9A-Za-z_-]{35}`, `GOCSPX-`, `client_secret`, `postgres(ql)?://`, `-----BEGIN`, `1//[0-9A-Za-z_-]{20,}` (refresh-token shape), and must not contain strings from the server env schema |
| Security | CodeQL, `pnpm audit`/OSV, gitleaks, ZAP baseline against staging (manual before beta) | Known-vulnerability and secret regressions |
| Migrations | CI applies all migrations from empty and from the previous release schema; drift check | Safe deploys |
| Load/limits | k6 smoke (manual) | The 10-user profile stays within Cloud Run, Neon, and Gemini free limits |
| Coverage | Thresholds: planner, detection, crypto, auth at 90% or higher; overall 80% or higher | Regression guard (thresholds enforced, not aspirational) |

Determinism rules: injected `Clock`, seeded randomness, no real network in unit or integration tests, no real Google or Gemini calls in CI except the optional gated eval workflow.

## 15. Observability and operations

- **Logging:** pino JSON with a redaction list (authorization header, tokens, `evidence*`, `subject`, `from`, `body`); request IDs; per-user IDs as opaque UUIDs only; no email addresses in logs (a hashed form for debugging if needed).
- **Correlation:** every request gets a `requestId` (accepted from `X-Request-Id` when well-formed, else generated); it is copied into every `Job.correlationId`, `SyncRun.correlationId`, and every log line, so a user action, the jobs it caused, the sync, and the AI analysis can be followed end to end. Trace context uses W3C `traceparent` so an OpenTelemetry backend can be added later without code changes.
- **Metrics (vendor-neutral names, emitted as structured log events in V1 and as OpenTelemetry metrics later):** `http.server.duration` (by route and status), `sync.duration`, `sync.messages{stage=listed|dropped_hard|dropped_header|fetched|deferred|ai|extracted}`, `gmail.api.errors{code}`, `calendar.api.errors{code}`, `ai.requests{provider,model,outcome}`, `ai.tokens{direction}`, `ai.queue.depth`, `ai.queue.oldest_age`, `reminder.planned`, `reminder.materialized`, `notification.delivered{channel}`, `notification.failed{channel}`, `job.duration{type}`, `job.failures{type}`, `db.errors`, `db.pool.wait`, `neon.wakeups`. All carry only enumerated labels (no user ids, no content).
- **Never logged (enforced by redaction list, lint rule, and canary tests):** email bodies, subjects, senders, quotes, OAuth tokens, refresh tokens, API keys, session tokens, passwords, any private message content.
- **Alerts (free):** uptime check on `/healthz`; Cloud Monitoring alert on error-rate and on tick not seen for over 45 minutes; budget alert at $1 on the GCP billing account.
- **Operational endpoints:** `GET /healthz` (liveness, no dependencies), `GET /readyz` (DB reachable, config loaded).
- **Extension diagnostics:** local ring-buffer log (no content), "Copy diagnostics" button in Options; no third-party telemetry in V1.
- **Runbooks** (in `infra/README.md`): rotate encryption key, rotate Google client secret, revoke all sessions, restore from Neon PITR (6-hour window), handle Gemini quota exhaustion, kill-switch (`PROCESSING_ENABLED=false` env flag stops all Google and AI calls).

## 16. Failure modes and degradation

| Failure | Behavior |
|---|---|
| AI quota exhausted or provider unavailable | Graceful degradation, not shutdown: Gmail and Calendar sync, deterministic detection, deduplication, reminder planning, materialization, and delivery all continue; new AI candidates are queued by priority (`DEFERRED`, retried up to `AI_DEFER_TTL_HOURS`) and the UI says "Heed is still monitoring your calendar and inbox. New AI analysis will resume when processing capacity is available." |
| Gmail `invalid_grant` | Integration `NEEDS_REAUTH`; sync stopped; UI banner with Reconnect; existing items remain |
| Calendar 410 | Full resync |
| Neon cold start | First request pays about 1 s; tick and clients tolerate (timeouts 10 s, retries) |
| Cloud Run cold start | About 1–2 s; extension shows cached data immediately |
| Tick missed | Next on-demand sync or tick catches up (cursor-based, so no data loss) |
| Extension offline | Outbox queues; alarms still fire from the local cache |
| Neon monthly compute exhausted | DB suspends until next month: documented risk; mitigation is the 15-minute tick and monitoring of CU-hours; fallback to Supabase (portable schema) |
| Bad deploy | Cloud Run traffic rollback to previous revision (automated on smoke-test failure) |

## 17. Scalability path (D-14, summary)

V1 is sized for one to ten users on free tiers. The architecture scales toward 1,000,000 users by **replacing infrastructure components behind existing boundaries, not by rewriting domain logic**: the tick becomes a queue-driven worker fleet (`JobQueue` implementation swap), polling becomes Gmail/Calendar push (an `IntegrationProvider` capability), Chrome-only delivery gains push and email (`NotificationProvider` implementations), the AI pool moves to paid, higher-quota models, and PostgreSQL gains pooling, read replicas, and partitioning behind the module repositories. Capacity variables, per-stage bottlenecks, and the migration path are in **SCALE_MODEL.md**; the gating item for more than 100 users is **Google restricted-scope verification (CASA assessment)**, not infrastructure.
