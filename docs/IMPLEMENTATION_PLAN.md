# Heed — Implementation Plan (V1)

Status: Stage 0 deliverable. This plan turns the validated architecture (ARCHITECTURE, DATA_MODEL, API, AI, SECURITY, PRIVACY, DECISIONS, SCALE_MODEL) into ordered, independently verifiable stages. **Nothing is implemented yet.** Stage 1 starts only after the owner answers the confirmations in DECISIONS section 3 that block it (OC-3 for infrastructure; OC-1, OC-2 before Stage 7).

## 0. Rules that apply to every stage

**Definition of done (each stage):** (1) CI is green (lint, typecheck, unit, integration, boundary checks, bundle scan once the extension exists); (2) the stage's acceptance criteria are demonstrated by tests, not by manual claims; (3) every schema change updates the Prisma schema, the raw-SQL migrations, and the data-inventory registry in the same change; (4) every new route has an authorization test and an idempotency/pagination test where applicable; (5) no content in logs (canary test); (6) any deviation from the documents is recorded in DECISIONS in the same change; (7) a short stage note is added to the repository (what was built, what was measured); (8) the stage's work is merged to the feature branch in reviewable commits, never as one large drop.

**Cross-cutting requirements:** modules own their tables and expose services only; Prisma types never cross a module boundary; every external effect is idempotent by a database constraint; no `setInterval` or process timers; no in-memory business state; time via an injected `Clock`; secrets only through `SecretsProvider`; no vendor type leaks past its adapter; free-tier limits live in configuration, never in domain code.

**Proofs of concept** are allowed only to settle a documented assumption (the spikes in DECISIONS section 4), live in `spikes/` outside the workspace packages, and are deleted or rewritten properly before use in production code.

**Stage dependency overview:** 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 12; 3 → 11 (extension shell can start after auth contracts exist); 9 and 10 → 12 → 13 → 14 → 15 → 16. Stages 5 and 4 can overlap after Stage 2 (pure packages need only the shared schemas).

---

## Stage 1: Foundation

- **Objective:** a monorepo that builds, tests, lints, and deploys an empty but production-shaped API and an empty extension shell, with the boundaries enforced from the first commit.
- **Dependencies:** Stage 0 sign-off; OC-3 (Google Cloud billing account) for infrastructure; Spikes D and E (hosting, quotas) started.
- **Files/modules:** root (`pnpm-workspace.yaml`, `.nvmrc`, tsconfig, eslint/prettier configs), `packages/config`, `packages/shared` (empty DTO scaffolding), `apps/api` (Fastify app factory, config parsing with Zod, `SecretsProvider`, `Clock`, request-id middleware, pino logger with redaction, problem+json error mapper, `/healthz`, `/readyz`), `apps/extension` (Vite multi-entry build, typed manifest generator, empty popup/side panel/options/service worker), `infra/` (Dockerfile, Cloud Run, Scheduler and Secret Manager bootstrap scripts, README), `.github/workflows/ci.yml`, `dependabot.yml`, `CODEOWNERS`, `scripts/bundle-scan.ts`, dependency-cruiser config.
- **Tests:** config parsing fails closed on missing or malformed values; redaction canary test; boundary test (extension importing a server package fails CI); bundle scan fixtures (a planted `AIza…` string fails the scan); Docker build smoke test.
- **Acceptance:** `pnpm install && pnpm test && pnpm build` pass from a clean checkout; CI runs the same; the empty API deploys to a staging Cloud Run service and `/readyz` responds; a PR that violates a boundary or leaks a secret pattern into the extension bundle is blocked.
- **Rollback:** revert the PR; infrastructure scripts are idempotent and documented teardown steps are in `infra/README.md`; staging is disposable.
- **Scalability:** stateless process, injected config, no globals; pinned Node; container is horizontally scalable from day one.

> **Stage 1 completion note (2026-10-02).** Implemented and verified except the cloud deployment, which is **blocked on credentials**: the build environment has no usable Google Cloud identity (`gcloud` reports `CREDENTIALS_MISSING`, no project configured). Everything up to the deploy is done and tested: monorepo, strict tooling, boundary enforcement, API foundation, extension shell (loaded and exercised in real Chromium), bundle scan, production container (built and verified non-root, read-only, fail-closed), CI, deploy workflow, and infrastructure files. Exit criterion still open: **run `infra/scripts/bootstrap-staging.sh` with a GCP project, run the staging deploy workflow, and record cold start, latency, and `/healthz`-on-Cloud-Run behavior in docs/DECISIONS.md.** Details, measurements, and deviations: `docs/STAGE_NOTES/STAGE_1.md`.

## Stage 2: Database

- **Objective:** the full DATA_MODEL in PostgreSQL with the idempotency constraints, due-time indexes, encryption, job queue, rate limiter, and data-inventory registry, before any feature uses them.
- **Dependencies:** Stage 1; Neon project and branches (Spike D measuring CU-hours and cold start; decision between Neon and Supabase confirmed).
- **Files/modules:** `apps/api/prisma/schema.prisma` and migrations (including raw SQL: partial indexes, `CHECK` on `Dependency`, partial unique on `AiAnalysis`, partial index on due reminders), `apps/api/src/db` (Prisma client, transaction helper, `changeSeq` allocator, tombstone writer), `crypto` module (AES-256-GCM envelope, key ids, HMAC fingerprints, rotation script), `jobs` module (`JobQueue`, `PostgresJobQueue`, runner, handler registry, lease and retry logic), `RateLimiter` (Postgres counters) and `ApiIdempotencyKey` middleware, `packages/shared/src/data-inventory.ts` with the CI check, audit module scaffold.
- **Tests:** migration applies from empty and from the previous schema; constraint tests (duplicate message, event, task fingerprint, evidence, reminder slot, notification key, job key all rejected or no-op); two concurrent claimers never run the same job; lease expiry recovery; crypto round-trip, tamper detection, AAD binding, key rotation; rate limiter correctness across two simulated instances; `changeSeq` monotonic under concurrency; data-inventory test fails when a model lacks an entry.
- **Acceptance:** all constraints enforced by the database (tests insert duplicates through raw SQL to prove it); job runner executes jobs exactly once under concurrent runners; ciphertext verified in a table dump; Neon CU-hour and cold-start measurements recorded in DECISIONS.
- **Rollback:** migrations are forward-only, expand/contract; revert application code and keep schema (safe by construction); Neon branch snapshot before each merge to staging.
- **Scalability:** `userId`-prefixed indexes; due-time partial indexes; partition-compatible keys documented in SCALE_MODEL 5; queue behind the `JobQueue` port.

## Stage 3: Authentication

- **Objective:** sign-in, Heed sessions, connect tickets, consents, beta allowlist, and the authorization test harness, with no secrets in the extension.
- **Dependencies:** Stage 2; Spikes A (refresh-token persistence, independent revocation) and B (`launchWebAuthFlow`, stable extension id).
- **Files/modules:** `auth` (start/callback/token/logout/sessions, `AuthTransaction`, PKCE on both legs, state, nonce, redirect allowlist, account-mismatch check), `users` (settings, consents including `REGION_ATTESTATION` and `SENT_MAIL_COMMITMENTS`, pause scaffolding), `integrations` (provider-neutral lifecycle, token vault, revoke), `audit`, route registry with auth-class declaration, cross-tenant test harness, `packages/shared` auth DTOs.
- **Tests:** OAuth flow against the fake Google server (happy path, forged state, replayed code, wrong verifier, expired transaction, redirect mismatch, account mismatch, missing refresh token); session expiry and revocation; every route has an authorization test (the route-registry test fails otherwise); cross-tenant 404s; allowlist; rate limits on auth routes across instances.
- **Acceptance:** the extension shell signs in end to end against staging with a real Google test account; Google tokens never appear in any response, log, or bundle; spikes A and B outcomes recorded; unverified "In production" status confirmed to keep refresh tokens beyond 7 days.
- **Rollback:** feature routes are additive; revoke all sessions via the admin script; fall back to the disconnect semantics documented if independent revocation fails Spike A.
- **Scalability:** stateless sessions in the database with hashed tokens; no sticky sessions; the `IntegrationProvider` registry is already provider-neutral.

## Stage 4: Calendar

- **Objective:** Calendar sync producing `Event` rows idempotently, behind `CalendarProvider`.
- **Dependencies:** Stage 3.
- **Files/modules:** `calendar` (provider adapter: `events.list`, sync tokens, 410 handling, normalization, HMAC participant hashes), `sync` (leases, `nextSyncAt` scheduling, adaptive interval, `SyncRun` on work or error only), `events` (upsert by provider key, etag skip, move/cancel propagation hooks), `jobs` handlers `SYNC_CALENDAR`, the due-time tick query, `scripts/fake-google` extended with Calendar.
- **Tests:** running sync twice and concurrently creates no duplicate events; incremental changes, deletions, cancellations, moved events; 410 triggers full resync; unchanged etag skips work; pause skips all Google calls; `invalid_grant` moves the integration to `NEEDS_REAUTH`; fixtures contain no real data.
- **Acceptance:** a connected test calendar mirrors correctly in staging; a second concurrent tick produces zero duplicate rows; descriptions and attendee emails appear in no table (DB snapshot test).
- **Rollback:** disable the integration with `PROCESSING_ENABLED=false` or per-provider flag; data is derived and re-creatable; purge via the disconnect path.
- **Scalability:** sync is claimed through `Integration (status, nextSyncAt)`; the adapter exposes a push-ready ingestion interface (not implemented).

## Stage 5: Detection (deterministic funnel)

- **Objective:** the complete deterministic pipeline as pure, heavily tested code, plus the evaluation corpus and its deterministic metrics.
- **Dependencies:** Stage 2 (shared schemas); can proceed in parallel with Stage 4 using fixtures.
- **Files/modules:** `packages/detection` (Stage 1 hard drops, Stage 2 header scoring, Stage 3 cleaning and content scoring with chrono-node, `INJECTION_PATTERN`, candidate-event ranking, Stage 4 minimization and redaction, rule catalog and versioning), `packages/eval` (synthetic corpus of at least 200 cases, runner, baselines), `detection` module orchestration skeleton, `SenderStats` personalization hooks.
- **Tests:** table-driven rule tests; redaction completeness (zero PII patterns in excerpts); excerpt caps; recall of positives through Stage 3 at least 95%; leakage of negatives to AI at most 10%; property tests (cleaning never grows text, redaction idempotent); adversarial cases (quoted replies, signatures, injection, huge bodies, unicode).
- **Acceptance:** corpus gates pass in CI with no model; funnel counters match the design targets; every rule has a human-readable explanation string in the shared catalog.
- **Rollback:** rules are versioned (`rules-vN`); pin `RULES_VERSION` to the previous value.
- **Scalability:** pure functions, no I/O, CPU-bound and trivially parallel; the funnel is what bounds AI volume at any user count.

## Stage 6: Gmail

- **Objective:** Gmail synchronization feeding the funnel, idempotently, behind `GmailProvider`.
- **Dependencies:** Stages 4 and 5; Spike E items for Gmail quotas.
- **Files/modules:** `gmail` (adapter: backfill, `history.list`, metadata and full fetch, normalization into source items; sent-mail support gated by consent), `sync` handlers `SYNC_GMAIL`, `detection` wiring (Stages 1–4 live, AI stage routed to `FakeProvider` for now), `ProcessedMessage` claim-by-insert, deferred-candidate queue (`DEFERRED`, priority), message-log retention.
- **Tests:** replaying the same history twice and running two syncs concurrently create no duplicate message rows, tasks, or evidence; history 404 triggers a bounded re-backfill; backfill caps (300 messages, `MAX_EMAILS_ANALYZED_PER_SYNC`); header-stage drops write no rows (counters only); bodies appear in no table, log line, or job payload (canary); pause skips all Gmail calls and resume fast-forwards the cursor; consent gating for sent mail.
- **Acceptance:** against a real Gmail test account in staging, the funnel's counters match expectations on a seeded mailbox; repeated syncs are no-ops; quota errors back off and never lose messages.
- **Rollback:** per-provider flag; cursors can be reset; derived data is purged by the disconnect or delete paths.
- **Scalability:** due-time claims, leases, no per-poll rows, adaptive interval column, push-ready adapter interface.

## Stage 7: AI

- **Objective:** the provider-neutral AI boundary with the free-tier Gemini adapter, batching, priority queue, quota-aware routing, accounting, validation, and graceful degradation.
- **Dependencies:** Stage 6; **OC-1** (regions), **OC-2** (free-tier policy tension accepted), optional **OC-4** (second no-training processor); Spike C (live quota, official terms, tokens per item, structured-output reliability, Workers AI quality).
- **Files/modules:** `packages/ai` (`AiProvider`, `FakeProvider`, `GeminiProvider`, optional second adapter, prompts `extract-v2`, output schemas, validators), `ai` module (router over `AI_MODEL_POOL`, circuit breaker, retries, data-use routing by user consent), `usage` module (`AiUsage`, `AiProviderUsage`, `AiAnalysis`, limits `MAX_AI_REQUESTS_PER_USER_DAY`, `MAX_AI_TOKENS_PER_USER_DAY`, `MAX_EMAILS_ANALYZED_PER_SYNC`, `AI_GLOBAL_REQUESTS_PER_DAY`, batching settings), consent variants and region-attestation enforcement, `ANALYZE_CANDIDATES` handler, degradation status in `/v1/me`.
- **Tests:** contract suite run against every adapter; validator rejects non-verbatim quotes, bad dates, unknown refs, cycles, URL-bearing titles, off-schema output, and injection payloads; batching never mixes users or leaks content across items; quota exhaustion test (provider 429 and local caps) proves **Gmail and Calendar sync, deterministic detection, reminder planning, and existing notifications all continue** while candidates queue by priority and the `DELAYED` status appears; two concurrent runners never double-analyze (partial unique index); tier guard refuses to start or to process without acknowledgment, consent variant, and attestation; model-pool routing honors per-model quotas and persisted `blockedUntil`; eval gates (precision, recall, calibration) against FakeProvider replay and an optional real-model run.
- **Acceptance:** the owner's live quota is recorded in DECISIONS; the canonical Acme scenario (S1) yields the task, the dependency, and the counterparty with a verbatim quote; a simulated quota outage leaves every non-AI capability working; no prompt or response content is persisted or logged.
- **Rollback:** `AI_PROVIDER`/`AI_MODEL_POOL` and `PROMPT_VERSION` are configuration; deferred candidates persist and drain later; switching free to paid is a configuration change plus consent re-prompt.
- **Scalability:** all quota state persisted; batching and priority are the capacity levers; adapters swap without domain change (SCALE_MODEL 4).

## Stage 8: Context and relationships

- **Objective:** commitments, dependencies, counterparties, email-detected events, evidence read model, and deterministic personalization.
- **Dependencies:** Stage 7; **OC-5** (sent-mail consent default).
- **Files/modules:** `dependencies` (derive `effectiveDueAt`, propagate event moves/cancellations, cycle checks), `commitments` and `Counterparty` resolution, `events` (detected events, merge into calendar events by title tokens and time), `evidence` (decrypt-for-owner "Why" model, signals from the rule catalog, AI step transparency), `SenderStats` updates and the Stage 2 score hooks, task matching rules (fingerprint, thread, suppression).
- **Tests:** S1–S15 scenarios from PRODUCT end to end with the fake provider and recorded fixtures; duplicate and out-of-order processing yields one task and one dependency; merge of a detected event into a later-synced calendar event; task-task dependency cycles rejected; personalization changes scores deterministically and explainably; counterparty garbage collection.
- **Acceptance:** every detected item has evidence with a verbatim quote, signals, AI step, and link rationale; the dependency drives the deadline; sent-mail commitments appear only with consent.
- **Rollback:** `Dependency` rows and counterparties are derived and rebuildable; feature flags for sent mail and detected events.
- **Scalability:** all lookups by `userId` plus indexed targets; counterparties store hashes plus encrypted display data; no cross-user queries.

## Stage 9: Tasks

- **Objective:** the task and event APIs with the full state machine and user controls.
- **Dependencies:** Stage 8.
- **Files/modules:** `tasks` (state machine, `userEditedFields`, suppression, snooze, completion suggestions, priority derivation, feedback), `events` API (list with cursor, confirm/dismiss, remind mode), paginated list endpoints and the sync feed with `hasMore`, `Idempotency-Key` handling, `If-Match` versioning.
- **Tests:** every transition allowed and illegal; delete leaves a suppression and tombstone; edit protects fields from re-detection; cursor pagination correctness under concurrent writes (no skips or repeats), no OFFSET anywhere (lint rule), maximum limits; sync feed resumability and `resyncRequired`; idempotent replays return the first response; authorization and cross-tenant tests.
- **Acceptance:** all user controls in PRODUCT 6.1 exist at the API level and are covered by tests; no endpoint returns an unbounded collection.
- **Rollback:** additive routes; revert the PR; data semantics unchanged.
- **Scalability:** `userId`-prefixed keyset indexes for every sort; per-user `changeSeq` feed; optimistic concurrency.

## Stage 10: Reminder engine

- **Objective:** the planner, scheduler, composer, and `Notification` model, entirely server-side and channel-agnostic.
- **Dependencies:** Stage 9.
- **Files/modules:** `reminders` (pure `ReminderPlanner` `policyVersion = 2`, `ReminderScheduler` due-time query with `SKIP LOCKED`, relevance re-check), `notifications` (pure `NotificationComposer`, state machine, ack handling, daily caps, coalescing, expiry sweeper), `jobs` handlers `REMINDER_PLAN` and `DELIVER_DUE_REMINDERS`, the `NotificationProvider` interface and a test provider.
- **Tests:** table-driven and property tests for the planner (all five kinds, lead profiles, quiet hours, snooze, DST, all-day events, bundling never duplicates a task, idempotent, monotonic, never inside quiet hours); scheduler tests (running twice or concurrently creates one notification per reminder/channel/generation; a completed task skips; an edited task regenerates with a new generation; daily cap and coalescing); composer golden tests including the canonical text "The coding assignment mentioned by the recruiter … is still incomplete"; the due-time query uses the partial index (EXPLAIN assertion).
- **Acceptance:** with synthetic data the engine produces the expected reminders for S1, S2, S3, S7, S9, S13; replaying scheduling creates no duplicates; the engine has no import of any Chrome or channel-specific code (boundary test).
- **Rollback:** `policyVersion` and planner flags; cancel pending reminders and replan; the `Notification` table is rebuildable from plans.
- **Scalability:** never scans all tasks or users; partial index on pending reminders; scheduler batches with `SKIP LOCKED` so more workers can run in parallel later.

## Stage 11: Chrome extension

- **Objective:** the thin client: sign-in, cache, outbox, sync loop, and the popup, side panel, and options UIs.
- **Dependencies:** Stage 3 for auth, Stage 9 for APIs (UI work can start earlier against API contracts), Spike B outcome.
- **Files/modules:** `apps/extension/src/background` (auth, sync loop with paging and `pollAfterSeconds`, outbox, messaging), `lib` (typed storage, API client, time utilities), `popup`, `sidepanel` (Upcoming, Review, history, Why panel), `options` (connections, settings, privacy and data placeholders), `ui` (Tailwind and Radix components), `packages/shared` DTOs only.
- **Tests:** component and worker tests with a chrome API mock (outbox replay and idempotency, cache reconciliation, resync, paging); accessibility checks; the bundle scan and boundary checks on every build; Playwright smoke with the extension loaded against local API plus fake Google.
- **Acceptance:** onboarding, connect, list, edit, complete, dismiss, snooze, delete, and the Why panel work against staging; the extension contains no business rules (review checklist plus boundary tests); offline mutations replay once.
- **Rollback:** the Web Store keeps the previous version; `MIN_CLIENT_VERSION` can force upgrades; the cache is rebuildable from the server.
- **Scalability:** the extension only pages and caches; poll hints and push wake-up (future) reduce load without client logic changes.

## Stage 12: Notifications

- **Objective:** the Chrome channel end to end, including acknowledgements and catch-up.
- **Dependencies:** Stages 10 and 11.
- **Files/modules:** `ChromeNotificationProvider` (`PULL_PREFETCH`, 36-hour lookahead), extension alarm reconciliation, `chrome.notifications` display and actions, badge from server counts, `POST /v1/notifications/ack`, catch-up on startup, server `EXPIRED` sweeper, notification permission onboarding.
- **Tests:** alarm reconciliation is idempotent and rebuilds after a simulated browser restart; cancelled notifications remove alarms; actions flow through the outbox and idempotently complete or snooze; a closed-browser scenario produces exactly one catch-up notification and server `EXPIRED` for older ones; ack replays are no-ops; E2E with the real extension showing a notification for S1.
- **Acceptance:** the canonical scenario produces the contextual Tuesday notification with source and context; no duplicate notifications under retries; the reminder engine remained free of Chrome references (boundary test).
- **Rollback:** disable the provider (notifications stop, plans remain); revert the extension release.
- **Scalability:** adding web push or email means a new `NotificationProvider` with `PUSH_AT_DUE`, with no engine or API contract change.

## Stage 13: Privacy

- **Objective:** every privacy control in PRODUCT 6.1 and PRIVACY, verified.
- **Dependencies:** Stages 9, 12.
- **Files/modules:** `privacy` (export as keyset-paged NDJSON, `PURGE_USER_DATA` resumable job, disconnect with purge or keep, retention purge job, `DeletionReceipt`), pause/resume with cursor fast-forward and silence option, consent management UI and API, "what Heed stores" page generated from the data-inventory registry, `REGION_ATTESTATION` and consent variants UI.
- **Tests:** create data in every table, then delete data and delete account and assert zero rows (generated from the registry); export covers every registry entry; disconnect revokes at the fake Google and deletes tokens; pause produces zero provider calls; retention purge deletes in bounded batches and honors every retention in the registry; consent withdrawal stops the relevant processing immediately; the purge job resumes after a simulated crash.
- **Acceptance:** each row of PRIVACY section 11 passes; the registry, purge configuration, and documentation agree (CI check).
- **Rollback:** purge jobs are idempotent; retention windows are configuration; export is read-only.
- **Scalability:** batched, `userId`-keyed deletes work unchanged on partitioned or sharded storage.

## Stage 14: Security hardening

- **Objective:** close SECURITY section 15 before any other human uses the system.
- **Dependencies:** Stages 3–13.
- **Files/modules:** IAM review and least privilege, Workload Identity Federation for deploys, secret rotation and key-rotation drill, HTTP hardening, log canary suite, dependency and action pinning, CodeQL, gitleaks, ZAP baseline against staging, route-registry audit, incident runbooks and the revoke-all script, kill switch drills.
- **Tests:** every item of the pre-beta checklist has an automated or recorded manual check; the cross-tenant suite is exhaustive; a rotated key re-encrypts successfully; the kill switch stops all Google and AI calls; the tier guard fails closed in every misconfiguration.
- **Acceptance:** the checklist in SECURITY section 15 is fully checked and recorded in the repository; no high findings from ZAP or CodeQL.
- **Rollback:** configuration-level; secrets can be rotated back; nothing in this stage changes domain behavior.
- **Scalability:** controls are stateless and instance-independent (Postgres-backed limits, token hashing, per-request authorization).

## Stage 15: Testing and quality

- **Objective:** consolidate production-grade verification beyond per-stage tests.
- **Dependencies:** Stages 1–14.
- **Files/modules:** Playwright E2E suite over the full flow (S1–S15), concurrency and duplicate-run tests across sync, AI, reminders, and notifications, quota-exhaustion degradation test at system level, a synthetic-data soak in staging for at least seven days (fake mail and calendar generator, simulated clock acceleration), k6 smoke for the 10-user profile, coverage thresholds, flaky-test policy.
- **Tests:** the suite itself; soak assertions (no duplicate rows, no job pileups, deferred queue drains, Neon CU-hours projection under 70%, AI requests under 60% of pool quota).
- **Acceptance:** all gates green for seven consecutive days of soak; measured resource use is recorded in DECISIONS and SCALE_MODEL variables are updated with measured values.
- **Rollback:** tests are non-destructive; staging data is disposable.
- **Scalability:** the measurements replace the estimated variables in SCALE_MODEL, which is how later stages are justified.

## Stage 16: Beta

- **Objective:** dogfood with the owner's real account, then 5–10 invited users, with explicit success and stop criteria.
- **Dependencies:** Stages 1–15; OC-1 and OC-2 confirmed in writing; privacy policy page published; Chrome Web Store unlisted listing (or load-unpacked fallback); runbooks rehearsed.
- **Files/modules:** release workflow, store listing and permission justifications, onboarding copy and consent texts (matching the configured variant), monitoring dashboards and alerts, feedback loop (aggregates only), beta allowlist.
- **Tests:** a production smoke test and synthetic check after each deploy; a go/no-go checklist covering SECURITY section 15, PRIVACY section 11, free-tier quota headroom, and rollback rehearsal.
- **Acceptance:** week 1, the owner alone (single-user limits); week 2 onward, up to 10 invited users inside all caps; metrics from PRODUCT section 8 tracked; zero privacy incidents; stop criteria defined (any secret exposure, any cross-tenant leak, repeated duplicate notifications, quota exhaustion that degrades beyond "delayed").
- **Rollback:** kill switch, per-integration disable, previous Cloud Run revision, previous Web Store version, revoke-all sessions and tokens; communicate through the allowlist emails.
- **Scalability:** the beta is the measurement source for every variable in SCALE_MODEL; thresholds in SCALE_MODEL section 6 decide when to leave the free stack.
