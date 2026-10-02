# Heed — Scale Model (capacity variables and migration path)

Status: Stage 0 deliverable. Purpose: identify the variables that will determine cost and load from one user to about 1,000,000 registered users, name the likely bottleneck at each stage, and document the migration path **without building any future infrastructure now**. This is a capacity model, not a cloud bill: every figure is an **illustrative estimate derived from stated variables**, and the variables themselves are assumptions to be replaced by measurement during the beta (the observability in ARCHITECTURE 15 emits exactly the counters needed).

Rule: **scale the boundaries, not the infrastructure** (DECISIONS D-14, D-27). Today: one API, one database, one scheduler-triggered job runner, one extension. Each infrastructure replacement below happens behind an existing port (`JobQueue`, `IntegrationProvider`, `NotificationProvider`, `AiProvider` pool, module repositories, `RateLimiter`) and changes no domain model, API contract, authentication model, reminder model, or extension architecture.

## 1. Variables

### 1.1 Per-user variables (V = value used in the tables; "est." = assumption to measure)

| Symbol | Variable | V | Notes |
|---|---|---|---|
| `E` | Emails received per user per day | 75 (est.) | Varies by 10x between users |
| `Fb` | Fraction of inbox mail whose body is fetched (survives Stages 1–2) | 25% (est.) | Header-only drops are counted, not stored |
| `Cm` | AI candidates per user per day, from inbox (`E × 3%`) | 2.25 | Stage 3 pass rate; design target at most 10% |
| `Cs` | Sent-mail commitment candidates per day (opt-in) | 0.5 (est.) | Zero when not opted in |
| `Cc` | Calendar-description candidates per day | 0.25 (est.) | Only changed, passing descriptions |
| `C` | **AI candidates per user per day** | **3.0** | `Cm + Cs + Cc` |
| `k` | Provider requests per candidate | 1.0 unbatched; 0.25–0.3 batched | Batching up to 4 items per request when a backlog exists |
| `Tin`, `Tout` | Tokens per item, in and out | 1,100 / 200 (est.) | Compact prompt, 1,500-char excerpt, at most 5 event titles |
| `Ev` | Calendar events held per user | 60 (est.) | 30-day window plus 14-day tail |
| `Tk` | Tasks held per user (open plus 90-day done) | 120 (est.) | |
| `Rm` | Reminders held per user | 150 (est.) | About 3 per task with an event or deadline |
| `N` | Notifications per user per day | 2 (cap 8) | |
| `P` | Syncs per integration per day | 96 (15-minute polling) | Reducible by adaptive intervals or push |
| `H` | Extension delta-feed calls per user per day | 288 (5-minute heartbeat) | Reducible by server-provided poll hints and push wake-up |
| `Rt` | Retention periods | Tasks done 90 d; message log 30 d; notifications 14 d; sync runs 7 d | DATA_MODEL section 8 |

### 1.2 System-level variables

`U` registered users (`Ua` active fraction); AI provider quota (requests per minute and per day, tokens per minute) and price; Gmail API quota units per minute and per day and per-method cost (`ug` for `messages.get`, `uh` for `history.list`); Calendar API queries per day; database size and write rate; API requests per second and peak factor; Cloud Run instance-hours; notification volume per channel.

## 2. Derived formulas

| Quantity | Formula | Per user per day (V) |
|---|---|---|
| AI requests per day | `U × C × k` | 3.0 unbatched; about 0.9 batched |
| AI tokens per day | `U × C × (Tin + Tout)` | about 3,900 |
| AI monthly cost (paid) | `U × C × 30 × (Tin × pin + Tout × pout)` with `pin`, `pout` the per-token prices | 0 in free-tier mode; see section 4 for the shape |
| Gmail quota units per day | `U × (P × uh + Fetched × ug)`, `Fetched ≈ E × (1 + Fb)` (a metadata get for every new message, plus a full get for the fraction `Fb` that survives Stages 1–2) | with `uh = 2`, `ug` = 5 to 20 (sources conflict): about 670 to 2,070 |
| Calendar queries per day | `U × P` | 96 |
| Delta-feed requests per day | `U × H` | 288 |
| Rows held | `U ×` rows per user, below | about 1,900 |
| Notifications per day | `U × N` | 2 |
| Due reminders per day | `U × (Rm / Tk × tasks activated per day)` ≈ `U × 3` | 3 |

Rows per user (est.): `ProcessedMessage` about 570 (`E × Fb ≈ 19/day × 30 d`), `SyncRun` about 350, `Reminder` about 150, `Evidence` about 150, `Tk` 120, `Dependency` about 100, `AiAnalysis` about 90 (`C × 30`), `Event` about 60, `Counterparty` about 30, `Notification` about 28, `SenderStats`, `Suppression`, `Tombstone`, `AuditLog` about 110 together, `AiUsage` about 180. **Total about 1,900 rows, about 1 MB per user including indexes** (assumes about 200 bytes per row and roughly 2x for indexes).

## 3. Stage table

Columns: bottleneck, then pressure on the database, AI, synchronization, notifications, and API, then the architectural change required. "Free-tier limit" references are from DECISIONS section 2 (secondary sources, to be replaced by measurement).

| Stage | Users | Likely bottleneck | Database pressure | AI pressure | Sync pressure | Notification pressure | API pressure | Required architectural change |
|---|---|---|---|---|---|---|---|---|
| **Current** | 1 | The free AI quota's **requests per day** (if the working model is a 20/day class), and Neon CU-hours | About 2 k rows (about 1 MB); ticks wake compute | About 3 requests/day (1–3 batched); backfill burst of about 40 candidates | 96 × 2 polls/day, about 670–2,070 Gmail units/day | About 2 notifications/day | About 300 heartbeat calls/day | **None.** Build everything in the plan on the free stack |
| **Beta** | 5–10 | **Free AI project quota** shared by all users (persisted caps, batching, priority queue handle it); Neon CU-hours (about 65/100 with a 15-minute tick) | About 19 k rows (about 10 MB) | About 30 candidates/day, about 8–12 batched requests/day; initial backfill about 420 candidates (about 105 batched requests, one day at 500/day, several days at 20/day) | About 1,900 syncs/day; one tick well inside its 4-minute budget | About 20/day | About 3 k calls/day | None. Tune caps from `AiUsage`; watch CU-hours and the deferred-queue age |
| **Early product** | 100 | **Compliance**: unverified-app cap of 100 users (secondary source F7); free AI mode must have ended (D-18) | About 190 k rows (about 100 MB, approaching Neon's 0.5 GB around 500–600 users) | About 300 candidates/day; free quotas insufficient or non-compliant → no-training paid pool | About 19 k syncs/day; a tick handles about 200 syncs in about a minute | About 200/day | About 29 k heartbeat calls/day (0.33 rps) | Google verification and CASA before exceeding 100; **paid AI pool**; paid Neon plan when storage or CU-hours bind; paid Cloud Run once past 2 M requests/month (about 230 users at 288 calls/day) |
| **Growth** | 10,000 | **Job runner throughput** (tick cannot finish 20 k syncs per 15 minutes at concurrency 3; it fails near 500–1,000 users) and the **Calendar API query quota** if the default per-project quota is about 1 M/day (recalled, not verified: 10 k users × 96 = 960 k/day); API heartbeat load | About 19 M rows (about 10 GB); about 10 writes/s average (about 85 rows/user/day); read-heavy delta feed | About 30 k candidates/day (about 10 k batched requests); paid tier comfortable | About 1.9 M syncs/day; Gmail 6.7–21 M units/day (within a reported 80 M/day cap, unverified) | About 20 k/day | About 2.9 M heartbeat calls/day (33 rps avg, about 100 peak) | `JobQueue` to Cloud Tasks with a worker pool; **adaptive polling** (idle users 15 → 60 min) and Calendar push (`events.watch`) plus Gmail push (`users.watch` via Pub/Sub) with polling as repair; server-provided poll hints to reduce heartbeat; paid managed Postgres with pooling; a second API instance class; Chrome push or a web-push channel to reduce client polling |
| **Large** | 100,000 | **Gmail API quota** (66–207 M units/day versus a reported 80 M/day cap, unverified) and the delta-feed read load; ProcessedMessage and SyncRun volume | About 190 M rows (about 100 GB); about 100 writes/s average (peaks about 3x); delta-feed reads about 330 rps | About 300 k candidates/day (about 100 k batched requests, about 1.2/s) on paid models | Push-driven; polling only for repair; **quota increase from Google** and format=metadata minimization | About 200 k/day (2/s): web push and email channels live | About 330 rps average heartbeat if unchanged; **read replicas** for sync reads; response caching by cursor | Time-partition large tables; read replicas; Pub/Sub ingestion workers; request a Gmail/Calendar quota increase; per-region deployment planning; autoscaled API fleet behind a load balancer |
| **Target** | 1,000,000 | **Database size and write rate** (about 1.9 B rows, about 1 TB with indexes), **Gmail and Calendar quotas**, heartbeat read load, annual compliance cost | About 1,000 writes/s average (about 85 rows/user/day, peaks about 3x) and about 3.3 k delta-feed reads/s at a 5-minute heartbeat | About 3 M candidates/day (about 35/s unbatched, about 10/s batched); cost dominated by `U × C × tokens`; distilled or cheaper models, batch APIs, caching | Push-only ingestion; repair polling at low rate; sync workers autoscaled; Gmail 0.7–2.1 B units/day needs negotiated quota | About 2 M/day (23/s): dedicated notification workers and provider quotas | About 3.3 k heartbeats/s unless the poll hint and push wake-up cut it by 5–10x | **Shard by `userId`** (hash to N Postgres clusters, with a `userId → shard` map; module repositories are already `userId`-scoped), regional residency, dedicated worker fleets per job type, columnar cold storage for audit and analytics, SLOs and on-call, security assessments renewed annually |

Notes: the extension heartbeat (`H = 288`) is the largest single request source at scale, so the API reserves a **poll hint** (`pollAfterSeconds` in the sync response, adaptive per user activity) and a push wake-up path; both are additive and need no contract break.

## 4. AI cost shape (no bill, only the structure)

`Monthly AI cost ≈ U × C × 30 × k × ((Tin × pin) + (Tout × pout))`. Levers, in order of effect: (1) the funnel pass rate (`C`), the strongest lever; (2) batching and caching (`k`, fewer repeated analyses); (3) model choice and price per token (`pin`, `pout`), including cheaper or distilled models for the easy 80% and a stronger model only for hard cases; (4) prompt and excerpt size (`Tin`); (5) provider batch/async APIs when latency allows. In free-tier mode all of this is capacity management; in paid mode it is also cost control.

## 5. Tables that can become large: partition, archive, TTL, cheaper storage

Each path below leaves the **domain API unchanged** because modules expose services, not tables, and every query is `userId`-scoped.

| Table | Growth driver | Retention (now) | Partitioning | Archive / TTL | Cheaper storage |
|---|---|---|---|---|---|
| `ProcessedMessage` | `U × Fb × E × retention` (about 0.57 B rows at 1M users) | 30 days | Range by `internalDate` (month). The primary key becomes `(userId, gmailMessageId, internalDate)`, which stays globally unique because `internalDate` is a property of the message | Drop whole partitions after 30 days (no row-by-row deletes) | Not needed; short-lived |
| `Evidence` | tasks × evidence per task | Lives with its task (90 days after done) | Hash by `userId` only if measured necessary (`userId` is in every key and index) | Delete with the owning task; partition-level deletion after account purges | Encrypted columns keep size per row bounded (quote at most 300 chars) |
| `AiAnalysis` | `U × C` per day | 30 days | Range by `createdAt` (month) | Drop partitions; keep daily aggregates in `AiUsage` | Aggregated metrics to columnar storage; raw rows dropped |
| `AuditLog` | security events | 90 days | Range by `createdAt` | Drop partitions; ship to cold object storage for longer security retention if required | Parquet in object storage, queryable on demand |
| `Notification` | `U × N` per day | 14 days | Range by `deliverAt` (key `(id, deliverAt)`; the idempotency key stays unique because `deliverAt` is derived deterministically from the reminder) | Drop partitions | Not needed |
| `Reminder` | tasks × slots | Non-pending 14 days; pending is small | Pending set stays small and indexed (`WHERE status='PENDING'`); history range-partitioned by `triggerAt` | Drop partitions | Not needed |
| `SyncRun` | polls with work | 7 days | Range by `startedAt` (week) | Drop partitions; aggregate hourly counters | Aggregates to metrics store |
| `Tombstone`, `ApiIdempotencyKey`, `RateLimitCounter` | churn | 30 d / 24 h / 1 d | Range by time | Drop partitions | Move rate limiting to Redis or an edge limiter when contention appears |
| `Job` | jobs per day | 7 / 30 days | Range by `createdAt`; queue claims use the small `PENDING` partial index | Drop partitions | Replaced by a managed queue for dispatch; the table becomes an audit trail |

## 6. Decision triggers (measured, not assumed)

Infrastructure is added only when a metric crosses a threshold, and each step has a documented migration:

| Metric (from ARCHITECTURE 15) | Threshold | Action |
|---|---|---|
| Tick wall time or due-sync backlog (`now - min(nextSyncAt)`) | Above 70% of the 4-minute budget or backlog above 2 intervals | Increase concurrency; then `CloudTasksJobQueue` and a worker pool |
| Neon CU-hours or storage | Above 70% of the plan | Reduce tick frequency; move to a paid or alternative Postgres (portable schema) |
| AI deferred-queue oldest age | Above 24 hours for live (non-backfill) candidates | Add pool entries (paid or no-training), tune batching, reduce `Tin` |
| AI requests per day versus pool quota | Above 60% | Add pool capacity before quota exhaustion |
| API p95 latency or CPU | p95 above 500 ms or CPU above 60% | Add instances (stateless), then read replicas for sync reads |
| Gmail/Calendar quota usage | Above 50% of any per-minute or per-day quota | Adaptive polling, then push; request a quota increase |
| Notification delivery latency or Chrome-only reach complaints | Beta feedback | Add `WebPushNotificationProvider` or `EmailNotificationProvider` |
| Largest-table row count | Above 100 M rows | Time partitioning for that table |
| Per-user hot row (`changeSeq`) wait time | Any sustained lock wait | Batch writes per user transaction (not expected) |
| Total rows or write rate | Above one primary's comfortable range (around 1 TB or 1 k writes/s) | Hash-shard by `userId` |

## 7. Migration path summary (what is replaced, in order)

1. **Beta to 100 users:** no code change; configuration, a paid AI pool, verification and assessment, a paid database plan if needed.
2. **100 to 1,000:** replace the tick-only runner with `CloudTasksJobQueue` (or equivalent) and a small worker pool; adaptive polling; poll hints.
3. **1,000 to 10,000:** Gmail and Calendar push (`IntegrationProvider` capability, ingestion endpoint, watch renewal job), web-push and email notification providers, connection pooling, read replica for sync reads.
4. **10,000 to 100,000:** time-partition the large tables (section 5), quota increases, multi-instance autoscaling behind a load balancer, dedicated notification workers, columnar cold storage for audit.
5. **100,000 to 1,000,000:** shard by `userId`, regional deployments and residency, per-job-type worker fleets, cheaper or distilled AI models and batch APIs, formal SLOs and on-call, annual security assessments.

At no step is the domain model, the API contract, the authentication model, the integration or AI abstraction, the reminder and notification model, or the extension architecture rewritten. That is the invariant the Stage 0 boundaries exist to protect, and each stage of IMPLEMENTATION_PLAN lists its scalability consideration against it.
