# Heed — Architecture Decision Record (V1)

Status: Draft for sign-off · Format per decision: **Context**, **Decision**, **Alternatives rejected**, **Consequences/risks**. Decisions D-01 to D-14 map one-to-one to the 14 required topics. D-15 to D-17 cover cross-cutting choices. Section 3 lists what is **still unresolved**, and section 2 records which external facts were verified and which still need verification.

Conventions: "Verified" means confirmed by web search on 2026-10-02 (secondary sources unless noted); everything else is flagged for the Phase 0 spikes (section 4). Because vendor terms and quotas change, every number in this file is an assumption with an owner and a re-check date, not a guarantee.

## 1. Decisions

### D-01 Frontend architecture
**Context.** Heed is a Chrome MV3 extension (React, TypeScript, Vite). MV3 service workers are ephemeral; the extension must show data instantly, keep reminding while offline, and must never hold secrets.

**Decision.**
- Surfaces: popup (Today), side panel (Upcoming, Review, history, Why), options page (connections, privacy and data, settings), and a service worker. No content scripts and no Gmail DOM access.
- **Local-first with a single writer.** The service worker owns networking, the outbox, alarms, and notifications; UI pages read the `chrome.storage.local` cache and send commands via messaging. State is rehydrated from storage on every worker wake (no in-memory assumptions).
- Offline: optimistic mutations through an idempotent outbox (UUID idempotency keys, `If-Match` versions); delta sync via a per-user change-sequence cursor.
- Stack: React 18, TypeScript strict, Vite multi-entry build with a typed manifest generator (plain Vite, not CRXJS, to avoid depending on a build plugin with uncertain maintenance; WXT was considered and is the fallback if build config grows past roughly 100 lines), Tailwind CSS (build-time) and Radix primitives for accessibility, React Router (hash) in side panel and options, Zod DTOs shared with the server through `packages/shared`.
- Permissions are minimal: `identity`, `storage`, `alarms`, `notifications`, `sidePanel`; host permission for the API origin only.

**Alternatives rejected.** Content script injected into Gmail (fragile against DOM changes, broad host permissions, harder Web Store review, privacy-hostile). Web app plus thin extension shell (more surface, loses native notifications and badge). In-extension AI/Gmail processing (would need Google tokens in the extension, which violates the core constraint). Redux or TanStack Query in the extension (unneeded; the worker owns fetching).

**Consequences.** Slightly more plumbing (messaging layer, outbox) than a naive extension; in return deterministic offline behavior and a clean security boundary. Side panel requires a recent Chromium; unsupported browsers degrade to popup-only.

### D-02 Backend architecture
**Context.** Single developer, about 10 users, zero-cost target, TypeScript throughout, needs OAuth, sync, jobs, and an AI pipeline.

**Decision.** A **modular monolith** on Node.js (current Active LTS, pinned) with **Fastify**, Zod validation (type-provider), Prisma, pino, Vitest. Modules: `auth`, `integrations`, `sync`, `detection`, `tasks`, `events`, `reminders`, `privacy`, `internal` with enforced boundaries (services only; routes are thin). Pure logic lives in `packages/detection` and `packages/ai` with no I/O so it is exhaustively unit-testable. A Postgres-backed job table with `FOR UPDATE SKIP LOCKED` leases provides background work; there is no separate queue or worker service.

**Alternatives rejected.** NestJS (heavier DI/boilerplate than needed at this size). Express (no first-class schema validation or typing). Hono (excellent, but ecosystem and Prisma/Node ergonomics are better with Fastify here). Microservices (operational cost with no benefit at ten users). Redis/BullMQ (extra paid or limited free infrastructure; Postgres is sufficient). Serverless functions per route (cold starts per function, harder local dev and testing).

**Consequences.** One deployable unit and one DB; scale-out needs care with in-memory rate limits (accepted). The architecture keeps the seams (job interface, provider interfaces, module services) that allow extracting a worker later (D-14).

### D-03 Database choice
**Context.** Relational data with strong consistency needs (task state machine, change-sequence sync, deletion guarantees), Prisma required, free tier required.

**Decision.** **PostgreSQL on Neon (free plan)**, accessed via Prisma with the pooled endpoint at runtime and the direct endpoint for migrations. Use only portable Postgres features so the provider can be swapped (Supabase free Postgres is the documented fallback; the schema, migrations, and queries are plain Postgres). Verified free-plan facts: 100 CU-hours/month per project, 0.5 GB storage, compute autosuspends after 5 idle minutes, 6-hour restore window (1 GB cap), 10 branches. Branches serve as `staging` and ephemeral test databases.

**Design consequence for compute hours.** A 5-minute tick would keep compute permanently awake (about 180 CU-hours/month at 0.25 CU) and exhaust the quota; a **15-minute tick** lets it suspend between runs (roughly 35% duty, about 65 CU-hours). This is measured in Phase 0 and monitored afterwards; if the quota is at risk, reduce tick frequency to 30 minutes or move to Supabase.

**Alternatives rejected.** Supabase free (viable fallback: always-on compute, but projects pause after a week of inactivity and its bundled auth/storage would tempt lock-in). SQLite/Turso (not what was specified; weaker fit for Prisma migrations and concurrent job claiming). Firestore (not relational, weak for sync-sequence and deletion semantics). Self-hosted Postgres on a free VM (operational burden and security risk).

**Consequences.** Cold DB wake-ups add about 1 s to the first query; 6-hour recovery window means we do **not** rely on provider backups (derived data is reconstructible from Gmail/Calendar, and users are told). Prisma client size and cold start on Cloud Run must be measured; the spike evaluates the Rust-free client with a driver adapter if available.

### D-04 Authentication architecture
**Context.** The extension cannot hold secrets; Gmail/Calendar need offline access (refresh tokens); users must be able to connect and disconnect each integration separately.

**Decision.**
- **Server-side OAuth 2.0 authorization-code flow with PKCE** using a Google **Web application** client. The extension opens `launchWebAuthFlow` to the Heed API's `/v1/auth/google/start`; the API redirects to Google, handles the callback, exchanges the code with the client secret, verifies the ID token, stores the refresh token **encrypted**, then returns a **single-use, 60-second, PKCE-bound `heed_code`** to the extension's `chromiumapp.org` redirect. The extension exchanges it (with its code verifier) for a **Heed session token**.
- Redirect URI validation is an exact allowlist of extension IDs. Dev and staging extension builds pin the ID via the manifest `key`; production uses the Web Store ID.
- **Separate consent flows per integration** (identity, Calendar, Gmail) with least scopes (`openid email profile`, `calendar.events.readonly`, `gmail.readonly`) and no `include_granted_scopes`, so each can be revoked independently (to be verified; unresolved #3). Connecting requires a connect-ticket bound to the signed-in user, and the callback must return the same Google `sub` (account-mismatch protection).
- **Heed session:** opaque 256-bit token, only its SHA-256 stored, 30-day sliding idle and 90-day absolute expiry, revocable per device.
- Google OAuth publishing status: **In production (unverified)**, because Testing mode expires refresh tokens after 7 days (verified) and caps test users at 100. The unverified app warning and the 100-user cap are accepted for the beta; a server-side email allowlist (`BETA_ALLOWED_EMAILS`) enforces the cap far below 100.

**Alternatives rejected.** `chrome.identity.getAuthToken` (puts Google access tokens in the extension and cannot do offline refresh). Public-client PKCE entirely in the extension (refresh token would live in the extension). Firebase/Supabase Auth (adds a vendor and still needs Google provider tokens server-side). Cookie sessions with a hosted web app (more surface, CSRF concerns, no benefit for an extension).

**Consequences.** One long-lived credential exists in the extension (the Heed session token). It is Heed-scoped, revocable, never grants Google access, and is treated as sensitive; this is my interpretation of "no refresh tokens in the extension" (Google refresh tokens and anything that can mint Google access). If you read the requirement more strictly, see unresolved #4 for a stricter but worse-UX variant.

### D-05 Gmail synchronization strategy
**Context.** Privacy-first; the mailbox is large; most mail is irrelevant; free quotas; no resident worker.

**Decision.** Server-side **polling with incremental history**: `gmail.readonly`; initial bounded backfill (default 14 days, max 30, cap 300 messages) with the `historyId` captured before listing; then `history.list(messageAdded, labelId=INBOX)` every 15-minute tick plus on-demand sync when the extension opens (at least 2 minutes apart). Headers first (`format=metadata`), body fetched only for messages that pass Stage 1 (hard drops) and Stage 2 (header score at least 1); idempotency through `ProcessedMessage`; Gmail category labels and bulk headers filter promotions and newsletters before any body fetch. `invalid_grant` leads to `NEEDS_REAUTH`. Expired history (404) leads to a bounded re-backfill. Pause skips the paused window (cursor fast-forward). SENT messages produce completion *suggestions* only.

**Alternatives rejected.** Gmail push (`users.watch` plus Pub/Sub plus webhook plus 7-day watch renewal): near real-time but adds infrastructure, renewal failure modes, and a public webhook; deferred to V2 (D-14). `gmail.metadata` scope (no body access and no `q` search; insufficient to extract tasks). Scraping Gmail's DOM from a content script (fragile, privacy-hostile). Full-mailbox scan on connect (privacy and quota cost, unnecessary). Storing bodies for reprocessing (violates minimization; deferred messages are re-fetched instead).

**Consequences.** Latency is bounded by the 15-minute tick unless the extension is open; the server transiently reads bodies of non-bulk mail that passes header checks (disclosed in PRIVACY). `gmail.readonly` is a restricted scope: fine for 100 or fewer users unverified, and the gating item for growth (D-14).

### D-06 Calendar synchronization strategy
**Decision.** `calendar.events.readonly`; primary calendar only; `events.list` with `singleEvents=true` over `now−1d … now+30d`; **sync tokens** for incremental changes each tick; daily full resync (rolls the window, drops expired events); HTTP 410 leads to full resync. Store minimal fields (title, times, status, HMAC participant hashes and domains) and never the description or attendee emails; descriptions are read transiently for detection. Event moves recompute linked tasks' deadlines and reminders; cancellations flag tasks.

**Alternatives rejected.** `events.watch` channels (webhook plus renewal; deferred). Re-pulling everything each time (wasteful). Storing attendee emails or descriptions (not needed; hashes plus domains suffice for matching). Multi-calendar in V1 (scope and noise; unresolved #6).

**Consequences.** Participant matching uses HMAC hashes, so we can say "the sender is invited" without storing addresses. Recurring-event expansion is delegated to Google (`singleEvents`). Only 30 days ahead is visible, which suits reminder horizons.

### D-07 AI architecture
**Context.** Gemini initially, provider replaceable, cheap, privacy-first, explainable.

**Decision.**
- **Deterministic funnel before AI** (AI.md section 3): hard drops, header scoring with calendar correlation, content cleaning and scoring, injection pattern drop, then minimization and redaction to a 1,500-character excerpt plus at most 5 candidate event titles. Expected to send about 3% of inbox mail to the model.
- **`AiProvider` interface** with a provider-neutral request/result, versioned provider-neutral prompts, typed failures, and a router that adds budget governance, retries, a circuit breaker, and logging. `GeminiProvider` uses structured JSON output at temperature 0; `FakeProvider` powers tests; provenance (`provider`, `model`, `promptVersion`) is stored per evidence row as strings so switching providers needs no migration.
- **Model verifies nothing; code verifies everything:** the quote must be a verbatim substring of the redacted excerpt, dates are validated and cross-checked against chrono, event references must come from the candidate list, titles may not contain URLs, confidence gates decide `OPEN` (at least 0.80), `SUGGESTED` (0.50–0.79), or discard.
- **Budget governor:** 25 calls/user/day, 200/day global, 3 concurrent, RPM token bucket; deferral rather than silent loss.
- **Data-use tier guard:** the server refuses to enable Gmail processing in production unless the Gemini API is on the **paid tier** (whose published terms say prompts and responses are not used to improve Google's products), or the owner explicitly sets `AI_FREE_TIER_ACKNOWLEDGED=true`, which switches the consent copy (PRIVACY section 4). Verified: on the **free** tier, prompts and outputs can be used to improve Google's products.
- Models are configuration. As of mid-2026, secondary sources report Gemini 3.5 Flash-Lite and 3.6 Flash as generally available with roughly $0.30 and $1.50 per million input tokens and $2.50 and $7.50 per million output tokens; exact IDs and prices are pinned in the Phase 0 spike.

**Alternatives rejected.** Send every email to the LLM (privacy violation, cost, rate limits). Rules-only (cannot resolve "before the interview" or implicit relations; kept as the funnel, not the extractor). On-device model such as Chrome's built-in Gemini Nano (would require email content and tokens inside the extension, violating the secrets constraint; capability also limited). Embedding or classifier models (training data and ops burden without clear gain at this scale). Free-tier Gemini for mail content (training on user prompts; conflicts with Limited Use; see unresolved #1). Letting the model schedule reminders or call tools (unbounded behavior and injection risk).

**Consequences.** Real cost is **not zero** on the paid tier (estimated roughly $0.50–$2.50/month typical, about $5 worst case at the global cap); this is the only deliberate deviation from "approximately zero" and is an explicit owner decision (#1). English-centric lexicons limit recall (documented).

### D-08 Reminder architecture
**Context.** The product promise is reminders "when it actually matters", with context, quietly.

**Decision.** **Server-planned, client-evaluated.** A pure, versioned planner computes deterministic reminder slots from task and event state (24 h and 3 h before a deadline; day-before and day-of at 09:00 for date-only deadlines; immediate if first detected within 24 h; one overdue nudge; quiet-hours clamp; snooze handling; event briefings bundling all outstanding linked tasks into one reminder; slot keys make planning idempotent). Content is composed **at delivery time** from live local state with deterministic templates, so completed tasks silence themselves and no AI runs at reminder time. Tasks anchored to an event are reminded through that event's briefing. Re-planning is triggered by task edits, event changes, settings changes, and snooze changes through the `REMINDER_PLAN` job.

**Alternatives rejected.** Server pushes a pre-rendered message at fire time (needs push infrastructure and goes stale). Client-only planning (duplicates logic, harder to test and version). LLM-written reminders (cost, latency, inconsistency, offline failure). One reminder per task (spams when several tasks hang off one event).

**Consequences.** Reminder quality is testable with table-driven and property tests; policy changes ship as `policyVersion` bumps. Reminders depend on the client being alive (D-09).

### D-09 Notification architecture
**Decision.** `chrome.notifications` plus the `chrome.action` badge, scheduled **locally** with `chrome.alarms` (one per pending reminder in the next 7 days, rebuilt idempotently after each sync and on browser startup since alarms may not survive restarts). Actions *Done* and *Snooze 1h* go through the outbox. Gates at fire time: relevance predicate, notifications enabled, pause flags, quiet hours, daily cap (default 8), 10-minute coalescing. Missed reminders (browser closed) produce one catch-up digest on next launch for the last 6 hours; older ones show as "Missed" in the popup. Delivery acknowledgements are batched to the server.

**Alternatives rejected for V1.** Web Push (VAPID) from the service worker (free, but adds subscription storage and push delivery plumbing, and only helps if Chrome is running anyway on most desktops). Email fallback (needs an email provider and adds a new data flow; promising post-beta). Native/desktop or mobile apps (out of scope).

**Consequences.** No notifications while Chrome is closed: clearly disclosed in onboarding; the main product limitation for the beta (unresolved #9).

### D-10 Security model
**Decision.** Thin untrusted client, trusted server (SECURITY.md). Google tokens, API keys, client secret, DB credentials, encryption keys exist only server-side (Secret Manager); the extension holds only a revocable Heed session token; CI enforces this with architecture rules and a **forbidden-pattern bundle scan**. Field-level AES-256-GCM encryption (key separate from DB) for refresh tokens and email-derived text; HMAC fingerprints and participant hashes with a separate pepper; every query user-scoped; cross-tenant tests per route; Zod validation; least-privilege IAM with Workload Identity Federation (no long-lived cloud keys); log redaction with canary tests; beta allowlist; kill switch; documented incident runbooks; Limited Use compliance.

**Alternatives rejected.** Plain DB encryption at rest only (a DB leak would expose tokens). Cloud KMS envelope encryption in V1 (better audit and no key in env, but more setup; recommended for V2, see SECURITY section 7). Storing Google tokens in the extension (violates the brief). Row-level security in Postgres (valuable defense in depth, deferred: adds Prisma friction; the route-registry and authz test suite is the V1 control).

**Consequences.** A runtime compromise could decrypt tokens; mitigations are least privilege, small blast radius, and the revoke-all runbook. Accepted residual risks are listed in SECURITY section 16.

### D-11 Free-tier strategy
**Decision.** Every component must have a free tier or near-zero cost, a **hard usage cap or alert**, and a documented degradation path. Stay under about 50% of any free quota at beta scale.

| Component | Free allowance (assumption, see section 2) | Usage at 10 users | Guard |
|---|---|---|---|
| Cloud Run (request-based CPU) | 180k vCPU-s, 360k GiB-s, 2M requests/month (verified) | Well under: ticks plus a few hundred requests/day | `max-instances=2`; billing budget alert $1 |
| Cloud Scheduler | 3 free jobs per billing account (to verify) | 1 job | |
| Secret Manager | Small free tier (to verify) | About 8 secrets | |
| Artifact Registry | About 0.5 GB free (to verify) | One slim image | Prune old images |
| Cloud Logging / Monitoring | Free allotments (to verify) | Low volume | 30-day retention |
| Neon Postgres | 100 CU-h, 0.5 GB, 6 h PITR (verified) | About 65 CU-h with 15-min tick; MBs of data | CU-hour alert; tick backoff; Supabase fallback |
| Gemini API | Free tier exists but trains on data (verified) → **paid tier recommended** | About $0.50–$2.50/month typical | Per-user and global call caps; GCP budget alert $5 |
| GitHub Actions | Free minutes (to verify for private repos) | CI plus occasional deploys | Cache; path filters |
| Chrome Web Store | One-time $5 developer fee (to verify) | One-time | Fallback: load-unpacked |
| Domain / hosting for privacy page | Not required for the beta (GitHub Pages or API static route) | | Needed only for Google verification (D-14) |

**Expected recurring cost:** about $1–3/month (Gemini paid tier) plus a one-time $5 store fee. **Needs a billing account with a card on file** for Google Cloud (free-tier usage is not billed, but the account must exist; see unresolved #2). If the owner insists on literally $0, the only way is the free-tier Gemini variant with its privacy cost (#1) and a non-GCP host (unresolved #2).

**Alternatives rejected.** Render/Fly/Railway free or trial tiers (spin-down or trial expiry, free databases that expire). Cloudflare Workers (generous and card-free, but the free CPU limit of about 10 ms per request cannot run Gmail parsing and detection, and Node compatibility with Prisma is awkward). Vercel Hobby functions (non-commercial terms, short timeouts).

### D-12 Deployment strategy
**Decision.** Single Docker image on **Cloud Run** (min 0, max 2 instances, 512 MiB, 1 vCPU, request-based CPU); **Cloud Scheduler** hits `/internal/tick` every 15 minutes with OIDC; Neon for Postgres; Secret Manager for secrets; Cloud Logging and an uptime check on `/healthz`. Environments: local, CI, staging, prod (staging and prod are separate Cloud Run services, Neon branches, and Google OAuth clients). GitHub Actions deploys through Workload Identity Federation; migrations are expand/contract, applied before traffic shift; smoke test then automatic rollback to the previous revision on failure. Extension released as a CI-built zip; uploaded manually to the Chrome Web Store as **Unlisted** in V1 (pinned `key` builds for load-unpacked fallback). Infrastructure is documented as scripts and a README in `infra/` (Terraform deferred; ten-user scale does not justify it).

**Alternatives rejected.** Always-on VM (free VMs are tiny and insecure to operate). Kubernetes (absurd at this scale). Running the tick inside GitHub Actions cron only (jitter up to many minutes, can be delayed or disabled on inactive repos; kept only as a documented backup trigger).

**Consequences.** Request-based CPU means no work after a response, so on-demand sync is inline with a 20 s budget and the rest waits for the tick. Cold starts are about 1–2 s.

### D-13 Data retention strategy
**Decision.** Minimize at ingest, then expire by default: bodies never stored; evidence at most 300 characters (encrypted) lives with its task; completed and dismissed tasks 90 days; events 14 days after end; message log 45 days; suppressions 365 days; reminders 14 days; tombstones 30 days; audit 90 days; operational logs 30 days; sessions 7 days after expiry; unreviewed suggestions auto-dismiss after 14 days. A daily `RETENTION_PURGE` job enforces the schedule (DATA_MODEL section 6). User-initiated delete is immediate and hard; delete-data and delete-account follow defined cascades (DATA_MODEL section 7). No custom backups; provider PITR window (6 h) is disclosed. A counts-only `DeletionReceipt` proves erasure without identifiers.

**Alternatives rejected.** Soft-delete everywhere (retains data users asked us to delete). Indefinite retention for analytics (no analytics need in V1). Long audit retention (privacy cost without benefit at this scale).

**Consequences.** Re-detection after purge needs a new inbound message (acceptable). The 45-day message log must exceed the 30-day maximum backfill (it does).

### D-14 Future scalability strategy
**Context.** V1 serves about 10 users. The question is where the design bends and where it breaks.

**Decision (staged path, no premature building).**

| Stage | Users | Changes |
|---|---|---|
| V1 beta | about 10 | As specified |
| Early access | up to 100 (Google's unverified cap) | Same architecture; paid Neon tier if CU-hours bind; Gmail push for latency; tune budgets |
| Public | 100+ | **Gate: Google OAuth verification including the annual third-party security assessment (CASA) for the restricted Gmail scope**; reported self-serve cost is roughly $540–$1,000 per year plus weeks of lead time (secondary sources; verify), plus a verified domain, privacy policy, demo video, and security documentation. Also: resident worker (Cloud Run min-instance or small VM) replacing tick polling, Pub/Sub watch for Gmail and `events.watch` for Calendar, pgbouncer and a paid Postgres tier, paid Gemini with higher quotas (and Vertex AI as an alternative), Web Push and an email fallback for reminders, Postgres-backed rate limiting or a managed edge, Postgres RLS, Cloud KMS envelope encryption, token rotation for sessions, Terraform, SLOs and on-call |
| Later | any | Additional sources behind a `SourceConnector` interface (Outlook, iCloud), multi-calendar, attachments (carefully), non-English lexicons, mobile companion |

**What already scales:** stateless API, user-scoped data model with per-user change sequence, idempotent jobs with leases, provider abstractions (AI, source connectors via module seams), deterministic planner, versioned rules/prompts/policies, eval harness.

**What does not scale yet (known):** per-user serialization on `changeSeq` (fine until a user has extreme write rates), in-memory rate limiting, tick-based polling, free-tier quotas, single region, single operator.

**Consequence.** The binding constraint on growth is compliance (restricted-scope verification and its recurring cost), not compute; this should be weighed before any decision to open the beta beyond 100 users.

### D-15 Repository and tooling
Monorepo with pnpm workspaces; packages `shared`, `detection`, `ai`, `eval`, `config`; apps `extension` and `api`; enforced dependency boundaries (eslint plus dependency-cruiser). TypeScript strict with project references; ESLint and Prettier; Vitest everywhere; Node version pinned in `.nvmrc`. Turborepo and Nx deferred (pnpm scripts and CI caching suffice).

### D-16 Testing approach
Layered tests with deterministic clocks and no real network in CI: unit and property tests for pure logic, a synthetic detection corpus with stage-level metrics gating CI, contract tests for AI providers, integration tests against Postgres with a fake Google server, a mandatory authz suite, privacy-invariant tests (no bodies stored, no content in logs, ciphertext at rest), extension component and worker tests, Playwright E2E with the real extension loaded in Chromium, a built-bundle secret scan, and coverage thresholds (details: ARCHITECTURE section 14). Real Gemini is only used in an optional, manually triggered eval workflow.

### D-17 Time handling
All instants are stored as UTC `timestamptz`; user-facing and deadline semantics use the user's IANA timezone (Luxon on the server, `Intl` in the extension). Date-only deadlines (`DueGranularity.DAY`) resolve to end of day local time and drive day-based reminder slots. The planner and chrono parsing receive an injected clock and timezone, and DST edge cases are covered in the corpus and planner tests.

## 2. External facts and assumptions to verify

**Verified on 2026-10-02 (web search; mostly secondary sources, to be re-read from official pages in Phase 0):**
- Gemini API free tier: prompts and outputs can be used to improve Google products; paid tier: they are not (the basis for the tier guard).
- Google OAuth "Testing" status: refresh tokens expire after 7 days, 100 test users; "In production" removes the 7-day expiry; unverified apps are capped at 100 users.
- Neon free plan: 100 CU-hours per project, 0.5 GB, autosuspend after 5 minutes, 6-hour restore window, 10 branches.
- Cloud Run request-based free tier: 180,000 vCPU-seconds, 360,000 GiB-seconds, 2 million requests per month (most regions).
- Gmail restricted scopes (`gmail.readonly`) require an annual third-party security assessment (CASA) before production use beyond the unverified cap; reported self-serve cost about $540–$1,000/year.
- Gemini model line as of July 2026 (reported): 3.6 Flash and 3.5 Flash-Lite generally available with the prices quoted in D-07; free-tier limits reported in the range of 5–15 requests/minute and 100–1,000 requests/day depending on model.

**Not yet verified (must be checked before relying on them):**
- Cloud Scheduler free job count; Secret Manager, Artifact Registry, Cloud Logging free allotments.
- Chrome Web Store developer fee and unlisted-listing review requirements and timing; whether a privacy-policy URL is mandatory at submission.
- GitHub Actions free minutes for the chosen repo visibility.
- Exact Gemini paid-tier data-handling terms (retention for abuse monitoring) and exact model IDs.
- Independent revocation of separately granted Google refresh tokens (unresolved #3).
- Whether an unverified production-status app with restricted scopes shows any additional consent limits or token lifetimes in practice.
- Prisma cold-start and image-size behavior on Cloud Run with the Rust-free client.

## 3. Unresolved decisions (need an owner decision or spike result)

| # | Decision | Options | Recommendation | Blocks |
|---|---|---|---|---|
| 1 | **Gemini data tier for mail-derived content** | (a) Paid tier, about $0.50–$2.50/month typical, no training under published terms. (b) Free tier with explicit user disclosure; zero cost; Google may train on and humans may review excerpts; conflicts with Gmail Limited Use | **(a).** Privacy-first and Limited-Use-compatible; the cost is small and capped. If (b) is chosen, PRIVACY Variant B and the override flag apply | AI.md/PRIVACY finalization; beta launch |
| 2 | **Hosting needs a Google Cloud billing account (card)** | Cloud Run (recommended: fast cold starts, OIDC scheduler, secrets) vs. a card-free host with long cold starts (spin-down) | Cloud Run with budget alerts and `max-instances=2` | Deploy setup |
| 3 | **Independent per-integration revocation** | Separate grants (planned); fallback: one grant, disconnect = delete token and instruct manual revoke | Verify in Phase 0 spike A; adapt `disconnect` accordingly | Auth module |
| 4 | **Session credential in the extension** | (a) Opaque revocable Heed session token in `chrome.storage.local` (planned). (b) Hold it only in `chrome.storage.session` (memory), forcing Google sign-in on each browser launch | **(a)**, because (b) badly hurts a reminder product; confirm this reading of "no refresh tokens" | Auth module |
| 5 | **Beta distribution** | Chrome Web Store unlisted ($5; review lead time; needs privacy policy URL) vs. load-unpacked with pinned key (free, friction) | Unlisted; load-unpacked as fallback | Release workflow |
| 6 | **Calendar scope** | Primary only (V1) vs. user-selectable calendars | Primary only; selection after beta feedback | Calendar sync |
| 7 | **Public privacy-policy hosting / domain** | GitHub Pages or API static route (free) vs. custom domain (about $10/year) | Free hosting for beta; a custom domain only when pursuing verification | Store listing, consent screen |
| 8 | **Neon vs. Supabase** | Neon (planned) vs. Supabase free | Neon; re-decide after Phase 0 CU-hour measurement | DB setup |
| 9 | **Reminders when Chrome is closed** | Accept (V1) vs. add email fallback | Accept and disclose; evaluate email fallback after beta feedback | Beta expectations |
| 10 | **Data controller identity and contact** | Individual vs. entity; contact address for privacy requests | Needed for the policy text; owner to supply | Privacy policy |
| 11 | **User geography and cross-border transfers** | EU/UK users vs. US-only beta | Confirm beta user locations; review transfer mechanisms if EU/UK | Privacy policy |
| 12 | **Non-English support** | Out of V1 | Revisit after the English funnel is tuned | Product roadmap |

## 4. Phase 0 spikes (before implementation proper; each has a written outcome in this file)

| Spike | Question | Done when |
|---|---|---|
| A: OAuth | Do refresh tokens for an unverified, In-production app persist? Do separate Calendar and Gmail grants revoke independently? Does `prompt=consent` reliably return refresh tokens? | Findings recorded; unresolved #3 closed |
| B: Extension auth | `launchWebAuthFlow` redirect to `chromiumapp.org` with the pinned dev `key`; behavior on the Web Store ID; side panel support on target Chrome versions | Working prototype; unresolved #5 informed |
| C: Gemini | Exact model IDs and prices; structured output reliability on the synthetic corpus; paid-tier terms read from official docs; tokens per call | Cost model confirmed; unresolved #1 closed |
| D: Hosting | Neon CU-hours with a 15-minute tick and Cloud Run cold-start measurements; Prisma image size and cold start; scheduler OIDC to Cloud Run | Measured numbers recorded; unresolved #8 closed |
| E: Quotas | Verify "not yet verified" items in section 2 | Table updated with source links and dates |

## 5. Implementation sequencing (informative, not started)

0 Spikes A–E → 1 Foundation (monorepo, CI, config, DB, crypto, auth, sessions, route registry and authz harness) → 2 Calendar sync and events → 3 Detection funnel with FakeProvider and the eval corpus → 4 Gmail sync plus Gemini adapter → 5 Tasks and state machine, reminder planner, delta sync → 6 Extension surfaces, outbox, alarms, notifications → 7 Privacy controls (pause, disconnect, export, delete), retention purge → 8 Hardening (security gates, E2E, staging soak with synthetic data) → 9 Beta launch checklist.
