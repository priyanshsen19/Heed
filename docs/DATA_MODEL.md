# Heed — Data Model (V1)

Status: Draft for sign-off. The Prisma schema below is **normative for semantics** (entities, fields, enums, constraints, indexes, encryption, retention). Formatting and minor naming may be refined during implementation without a DECISIONS entry; semantic changes require one.

## 1. Principles

1. **Store derived data, not source data.** No email bodies, no attachments, no calendar descriptions, no recipient lists. For each detected task we keep one verbatim evidence quote (max 300 chars) and minimal source metadata.
2. **Tiered protection.** Credentials and email-derived text are field-level encrypted (AES-256-GCM, application-managed key). Operational fields needed for queries stay plaintext. Provider-level encryption at rest applies to everything.
3. **Everything is user-scoped and cascade-deletable.** Every table has `userId` (directly or through a parent) with `onDelete: Cascade` from `User`, so "delete account" is one delete and "delete my data" is a defined set of deletes.
4. **Every mutable entity is syncable.** Rows have a per-user monotonically increasing `seq`; deletions leave a `Tombstone`.
5. **Retention is explicit** for every table (section 6) and enforced by a purge job.
6. **No content in operational tables.** `Job`, `SyncRun`, `AiCallLog`, `AuditLog` never contain email or event text.

## 2. Encryption and fingerprints

| Item | Method | Key |
|---|---|---|
| Refresh tokens, evidence quote, source subject, source sender, AI rationale, link rationale | AES-256-GCM, random 96-bit nonce, AAD = `"{table}.{column}:{userId}"` | `DATA_KEY[keyId]` from Secret Manager (32 bytes). Ciphertext envelope: `version(1) | keyId(1) | nonce(12) | ciphertext | tag(16)` stored as `Bytes`. Rotation = add new keyId, re-encrypt lazily on write plus an offline re-encrypt script |
| Participant email matching (`participantHashes`, sender matching) | HMAC-SHA256(lowercased email) | `HMAC_PEPPER` (separate secret) |
| Task fingerprint, suppression fingerprint | HMAC-SHA256(`userId ‖ sourceKey ‖ normalizedTitle ‖ anchorKey`) | `HMAC_PEPPER` |
| Heed session token | SHA-256 of 256-bit random token (high-entropy, so no salt needed) | none |

Plaintext-by-design (needed for queries, notifications, and the UI): task title, notes, due fields, status, event title and times, sender-rule values, timestamps. These are visible to the user in the extension anyway and are protected by provider encryption at rest, access control, and retention.

## 3. Prisma schema (design specification)

```prisma
generator client { provider = "prisma-client-js" }
datasource db { provider = "postgresql"; url = env("DATABASE_URL"); directUrl = env("DIRECT_URL") }

// ───────── enums ─────────
enum UserStatus          { ACTIVE DELETING }
enum IntegrationProvider { GMAIL GOOGLE_CALENDAR }
enum IntegrationStatus   { CONNECTED NEEDS_REAUTH ERROR DISCONNECTED }
enum ConsentType         { GOOGLE_DATA_PROCESSING AI_PROCESSING }
enum TaskStatus          { SUGGESTED OPEN COMPLETED DISMISSED }
enum TaskOrigin          { AI MANUAL }
enum DueSource           { EXTRACTED EVENT_ANCHOR USER NONE }
enum DueGranularity      { TIME DAY }
enum AnchorRelation      { BEFORE_EVENT AFTER_EVENT DURING_EVENT }
enum AnchorStatus        { NONE ACTIVE EVENT_CANCELLED EVENT_PURGED }
enum DismissReason       { NOT_RELEVANT ALREADY_DONE WRONG_DETAILS TOO_NOISY }
enum EvidenceSource      { EMAIL CALENDAR_EVENT }
enum EventStatus         { CONFIRMED CANCELLED }
enum ReminderKind        { EVENT_BRIEFING TASK_DEADLINE TASK_OVERDUE }
enum ReminderStatus      { PENDING DELIVERED SKIPPED CANCELLED MISSED }
enum MessageOutcome {
  DROPPED_HARD        // stage 1 header/label rules
  DROPPED_HEADER      // stage 2 score too low (body never fetched)
  DROPPED_CONTENT     // stage 3 content score too low (body fetched, discarded)
  SUPPRESSED          // matched a suppression fingerprint
  DEFERRED            // passed to AI stage but budget/outage; retry pending
  AI_NONE             // AI found nothing actionable
  AI_LOW_CONFIDENCE   // confidence < 0.50
  EXTRACTED           // produced or reinforced a task
  FAILED              // permanent failure (e.g. message deleted, validation)
}
enum JobType   { SYNC_GMAIL SYNC_CALENDAR ANALYZE_MESSAGE REMINDER_PLAN RETENTION_PURGE }
enum JobStatus { PENDING RUNNING SUCCEEDED FAILED }
enum SenderRuleKind  { MUTE ALWAYS_CONSIDER }
enum SenderMatchType { EMAIL DOMAIN }

// ───────── identity & control ─────────
model User {
  id               String     @id @default(uuid()) @db.Uuid
  googleSub        String     @unique              // stable Google account id
  email            String                            // for display and the beta allowlist check
  status           UserStatus @default(ACTIVE)
  changeSeq        BigInt     @default(0)           // per-user sync sequence counter
  processingPausedAt    DateTime?
  processingPausedUntil DateTime?                    // null with pausedAt set = until resumed
  pauseSilencesReminders Boolean @default(false)
  createdAt        DateTime   @default(now())
  updatedAt        DateTime   @updatedAt
  settings         UserSettings?
  consents         Consent[]
  sessions         Session[]
  integrations     Integration[]
  tasks            Task[]
  events           CalendarEvent[]
  reminders        Reminder[]
  senderRules      SenderRule[]
  suppressions     Suppression[]
  messages         ProcessedMessage[]
  tombstones       Tombstone[]
  aiUsage          AiUsage[]
  audit            AuditLog[]
  @@index([email])
}

model UserSettings {
  userId              String  @id @db.Uuid
  timezone            String  @default("UTC")       // IANA
  quietHoursStart     Int     @default(1260)         // minutes from midnight local (21:00)
  quietHoursEnd       Int     @default(480)          // 08:00
  notificationsEnabled Boolean @default(true)
  dailyNotificationCap Int    @default(8)
  backfillDays        Int     @default(14)           // 7 | 14 | 30
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)
}

model Consent {
  id        String      @id @default(uuid()) @db.Uuid
  userId    String      @db.Uuid
  type      ConsentType
  version   String                                   // e.g. "2026-10-01"
  grantedAt DateTime    @default(now())
  revokedAt DateTime?
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@index([userId, type])
}

model Session {
  id         String   @id @default(uuid()) @db.Uuid
  userId     String   @db.Uuid
  tokenHash  String   @unique                         // sha256 hex of opaque token
  deviceLabel String?
  createdAt  DateTime @default(now())
  lastUsedAt DateTime @default(now())
  idleExpiresAt     DateTime                          // sliding 30 days
  absoluteExpiresAt DateTime                          // 90 days
  revokedAt  DateTime?
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@index([userId])
}

model AuthTransaction {                                // short-lived; no userId FK until resolved
  id             String   @id @default(uuid()) @db.Uuid
  state          String   @unique                      // server-side state sent to Google
  clientChallenge String                               // extension PKCE S256 challenge
  clientState    String
  extRedirectUri String                                // validated against allowlist
  intent         String                                // SIGN_IN | CONNECT_GMAIL | CONNECT_CALENDAR
  connectUserId  String?  @db.Uuid                     // set for CONNECT_* from the connect ticket
  googleCodeVerifier String                            // server PKCE verifier for Google leg
  nonce          String
  heedCodeHash   String?  @unique                      // set after callback; single-use
  heedCodeUserId String?  @db.Uuid
  expiresAt      DateTime                              // 10 min (heed code: 60 s after issue)
  consumedAt     DateTime?
  createdAt      DateTime @default(now())
  @@index([expiresAt])
}

model Integration {
  id          String              @id @default(uuid()) @db.Uuid
  userId      String              @db.Uuid
  provider    IntegrationProvider
  status      IntegrationStatus   @default(CONNECTED)
  grantedScopes String[]
  refreshTokenEnc Bytes?                               // AES-GCM envelope; null when DISCONNECTED
  connectedAt DateTime            @default(now())
  disconnectedAt DateTime?
  lastSyncAt  DateTime?
  lastSuccessAt DateTime?
  lastErrorCode String?                                // enum-like code, never provider payloads
  // cursors
  gmailHistoryId     String?
  gmailBackfilledAt  DateTime?
  calendarSyncToken  String?
  calendarWindowStart DateTime?
  calendarWindowEnd   DateTime?
  calendarFullSyncAt  DateTime?
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)
  syncRuns SyncRun[]
  @@unique([userId, provider])
}

model SyncRun {                                        // operational, no content
  id            String   @id @default(uuid()) @db.Uuid
  integrationId String   @db.Uuid
  trigger       String                                 // TICK | ON_DEMAND | BACKFILL
  startedAt     DateTime @default(now())
  finishedAt    DateTime?
  status        String                                 // OK | PARTIAL | ERROR
  counts        Json                                   // {listed, dropped_hard, dropped_header, fetched_full, ai_calls, extracted, ...}
  errorCode     String?
  integration Integration @relation(fields: [integrationId], references: [id], onDelete: Cascade)
  @@index([integrationId, startedAt])
}

// ───────── calendar ─────────
model CalendarEvent {
  id             String      @id @default(uuid()) @db.Uuid
  userId         String      @db.Uuid
  googleCalendarId String
  googleEventId  String
  etag           String?
  title          String                                // plaintext (needed for linking/notifications)
  startAt        DateTime
  endAt          DateTime
  allDay         Boolean     @default(false)
  timezone       String?
  status         EventStatus @default(CONFIRMED)
  organizerIsSelf Boolean    @default(false)
  participantHashes  String[]                          // HMAC of lowercase emails
  participantDomains String[]
  recurringEventId String?
  seq            BigInt
  createdAt      DateTime    @default(now())
  updatedAt      DateTime    @updatedAt
  user  User  @relation(fields: [userId], references: [id], onDelete: Cascade)
  tasks Task[]
  @@unique([userId, googleCalendarId, googleEventId])
  @@index([userId, startAt])
  @@index([userId, seq])
}

// ───────── tasks & evidence ─────────
model Task {
  id          String     @id @default(uuid()) @db.Uuid
  userId      String     @db.Uuid
  title       String                                   // <= 140 chars
  notes       String?                                  // user-authored only
  status      TaskStatus
  origin      TaskOrigin
  confidence  Float?                                   // AI confidence 0..1; null for MANUAL
  // deadline
  dueAt           DateTime?                            // resolved instant (DAY granularity: 23:59 local of that day)
  dueGranularity  DueGranularity?
  dueSource       DueSource  @default(NONE)
  effectiveDueAt  DateTime?                            // = dueAt, or anchor.startAt when dueSource=EVENT_ANCHOR; indexed
  // anchor
  anchorEventId   String?    @db.Uuid
  anchorRelation  AnchorRelation?
  anchorStatus    AnchorStatus @default(NONE)
  anchorSnapshot  Json?                                // {title,startAt} kept if event purged
  // state modifiers
  snoozedUntil    DateTime?
  completedAt     DateTime?
  dismissedAt     DateTime?
  dismissReason   DismissReason?
  completionSuggestedAt DateTime?                      // user replied in thread; UI prompts, never auto-completes
  userEditedFields String[]                            // fields protected from re-detection overwrite
  fingerprint     String                               // HMAC; unique per user
  primaryThreadId String?                              // gmail thread of first evidence (for dedupe matching)
  version         Int        @default(1)               // optimistic concurrency (If-Match)
  seq             BigInt
  createdAt       DateTime   @default(now())
  updatedAt       DateTime   @updatedAt
  user     User           @relation(fields: [userId], references: [id], onDelete: Cascade)
  anchor   CalendarEvent? @relation(fields: [anchorEventId], references: [id], onDelete: SetNull)
  evidence Evidence[]
  feedback TaskFeedback[]
  @@unique([userId, fingerprint])
  @@index([userId, status, effectiveDueAt])
  @@index([userId, seq])
  @@index([userId, primaryThreadId])
  @@index([anchorEventId])
}

model Evidence {                                       // the "why"
  id          String         @id @default(uuid()) @db.Uuid
  taskId      String         @db.Uuid
  source      EvidenceSource
  gmailMessageId  String?
  gmailThreadId   String?
  calendarEventId String?                             // for CALENDAR_EVENT description evidence
  receivedAt  DateTime                                // email date or event updated time
  subjectEnc  Bytes?                                   // encrypted subject (email) or event title
  senderEnc   Bytes?                                   // encrypted "Name <addr>"
  quoteEnc    Bytes                                    // encrypted verbatim quote, <= 300 chars
  rulesFired  String[]                                 // deterministic rule IDs, e.g. ["ACTION_PHRASE","DEADLINE_PHRASE","SENDER_IS_PARTICIPANT"]
  aiRationaleEnc Bytes?                                // one-sentence model rationale
  linkRationaleEnc Bytes?                              // why linked to anchor event
  aiProvider  String?                                  // "gemini"
  aiModel     String?                                  // exact model id used
  promptVersion String?
  llmInputChars Int?                                   // size of redacted excerpt sent, for transparency
  llmCandidateEvents Int?                              // number of event titles sent
  createdAt   DateTime       @default(now())
  task Task @relation(fields: [taskId], references: [id], onDelete: Cascade)
  @@index([taskId])
  @@unique([taskId, gmailMessageId])
}

model TaskFeedback {
  id        String   @id @default(uuid()) @db.Uuid
  taskId    String   @db.Uuid
  useful    Boolean
  note      String?                                    // short, user-typed, optional
  createdAt DateTime @default(now())
  task Task @relation(fields: [taskId], references: [id], onDelete: Cascade)
}

model Suppression {                                    // hash-only; stops resurrection after delete/dismiss
  id          String   @id @default(uuid()) @db.Uuid
  userId      String   @db.Uuid
  fingerprint String
  reason      String                                   // DELETED | DISMISSED
  createdAt   DateTime @default(now())
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@unique([userId, fingerprint])
}

model SenderRule {
  id        String          @id @default(uuid()) @db.Uuid
  userId    String          @db.Uuid
  kind      SenderRuleKind
  matchType SenderMatchType
  value     String                                     // lowercase email or domain; user-visible setting
  createdAt DateTime        @default(now())
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@unique([userId, kind, matchType, value])
}

// ───────── ingestion log (idempotency, no content) ─────────
model ProcessedMessage {
  userId         String         @db.Uuid
  gmailMessageId String
  gmailThreadId  String
  internalDate   DateTime
  outcome        MessageOutcome
  headerScore    Int?
  contentScore   Int?
  rulesFired     String[]
  attempts       Int            @default(0)
  processedAt    DateTime       @default(now())
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@id([userId, gmailMessageId])
  @@index([userId, processedAt])
  @@index([userId, outcome])
}

// ───────── reminders & sync ─────────
model Reminder {
  id          String         @id @default(uuid()) @db.Uuid
  userId      String         @db.Uuid
  kind        ReminderKind
  taskId      String?        @db.Uuid                  // TASK_DEADLINE, TASK_OVERDUE
  eventId     String?        @db.Uuid                  // EVENT_BRIEFING
  slotKey     String                                   // deterministic; unique per user
  fireAt      DateTime
  status      ReminderStatus @default(PENDING)
  policyVersion Int          @default(1)
  deliveredAt DateTime?
  seq         BigInt
  createdAt   DateTime       @default(now())
  updatedAt   DateTime       @updatedAt
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@unique([userId, slotKey])
  @@index([userId, status, fireAt])
  @@index([userId, seq])
}

model Tombstone {
  id         String   @id @default(uuid()) @db.Uuid
  userId     String   @db.Uuid
  entityType String                                    // TASK | EVENT | REMINDER
  entityId   String   @db.Uuid
  seq        BigInt
  deletedAt  DateTime @default(now())
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@index([userId, seq])
}

// ───────── operations ─────────
model Job {
  id         String    @id @default(uuid()) @db.Uuid
  type       JobType
  userId     String?   @db.Uuid                         // no FK: jobs outlive nothing, purged with user explicitly
  payload    Json      @default("{}")                   // ids only, never content
  dedupeKey  String?   @unique
  status     JobStatus @default(PENDING)
  runAt      DateTime  @default(now())
  attempts   Int       @default(0)
  lockedUntil DateTime?
  lastErrorCode String?
  createdAt  DateTime  @default(now())
  updatedAt  DateTime  @updatedAt
  @@index([status, runAt])
  @@index([userId])
}

model AiUsage {                                         // budget governor
  userId   String   @db.Uuid
  day      DateTime @db.Date
  calls    Int      @default(0)
  inputTokens  Int  @default(0)
  outputTokens Int  @default(0)
  rejected Int      @default(0)
  deferred Int      @default(0)
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@id([userId, day])
}

model AiCallLog {                                       // no prompt/response content
  id        String   @id @default(uuid()) @db.Uuid
  userId    String   @db.Uuid
  provider  String
  model     String
  promptVersion String
  latencyMs Int
  inputTokens  Int?
  outputTokens Int?
  outcome   String                                      // OK | INVALID_OUTPUT | QUOTA | TIMEOUT | ERROR
  createdAt DateTime @default(now())
  @@index([userId, createdAt])
}

model AuditLog {                                        // security-relevant events, no content
  id        String   @id @default(uuid()) @db.Uuid
  userId    String   @db.Uuid
  event     String                                      // SIGN_IN | CONNECT | DISCONNECT | PAUSE | RESUME | EXPORT | DELETE_DATA | SESSION_REVOKED | ...
  detail    Json?                                       // provider, counts; never content
  createdAt DateTime @default(now())
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@index([userId, createdAt])
}

model DeletionReceipt {                                 // proves erasure without identifying the user
  id        String   @id @default(uuid()) @db.Uuid
  kind      String                                      // DATA | ACCOUNT
  counts    Json
  createdAt DateTime @default(now())
}
```

## 4. Key semantics

### 4.1 Change sequence and delta sync

Every mutation of `Task`, `CalendarEvent`, or `Reminder` runs in a transaction that executes `UPDATE "User" SET "changeSeq" = "changeSeq" + 1 WHERE id = $1 RETURNING "changeSeq"` and writes that value into the row's `seq`. Deletes insert a `Tombstone` with the same sequence. `GET /v1/sync?cursor=N` returns all rows with `seq > N` plus tombstones with `seq > N`. If `N` is older than the oldest retained tombstone (30 days), the server returns `resyncRequired: true`. Per-user serialization on `changeSeq` is acceptable at this scale.

### 4.2 Fingerprints, dedupe, suppression

`fingerprint = HMAC(pepper, userId ‖ sourceKey ‖ normalizedTitle ‖ anchorKey)` where `sourceKey` is the Gmail thread ID (or calendar event ID), `normalizedTitle` is lowercase with stop words removed and tokens sorted, and `anchorKey` is the anchor event ID or the resolved due date.

Matching a new extraction to an existing task, in order:

1. Exact `fingerprint` match: same task; add `Evidence` (unique per `(taskId, gmailMessageId)`) and do not create a duplicate.
2. Same `primaryThreadId` and same anchor (or both null) with title token Jaccard of at least 0.6: treat as the same task (reinforce evidence; update fields not in `userEditedFields`).
3. Matches a `Suppression` fingerprint (or its thread plus anchor variant): record `SUPPRESSED`, create nothing. A materially new ask (different normalized title and no suppression match) creates a new task.

### 4.3 Deadline resolution

| `dueSource` | Meaning | `effectiveDueAt` |
|---|---|---|
| `EXTRACTED` | AI-extracted absolute date/time (validated) | `dueAt` |
| `EVENT_ANCHOR` | Relative to a linked event with `BEFORE_EVENT` | `anchor.startAt` |
| `USER` | User-set in the UI | `dueAt` |
| `NONE` | No deadline | null |

`AFTER_EVENT` anchors use `anchor.endAt` (as `effectiveDueAt` for ordering) and `DURING_EVENT` uses `anchor.startAt`. When an event changes, a service recomputes `effectiveDueAt` for linked tasks with `dueSource = EVENT_ANCHOR` and enqueues `REMINDER_PLAN`. When an anchor event is cancelled, `anchorStatus = EVENT_CANCELLED`; when it is purged, `anchorSnapshot` is kept and `anchorStatus = EVENT_PURGED`.

### 4.4 State transitions (enforced in the tasks service)

| From | Allowed to | Side effects |
|---|---|---|
| `SUGGESTED` | `OPEN` (confirm), `DISMISSED`, delete | confirm: plan reminders. dismiss: suppression plus cancel reminders |
| `OPEN` | `COMPLETED`, `DISMISSED`, delete | cancel reminders; dismiss writes suppression |
| `COMPLETED` | `OPEN` (reopen), delete | reopen re-plans reminders |
| `DISMISSED` | `OPEN` (reopen), delete | reopen removes the suppression for this fingerprint |

Illegal transitions return `409`. All mutations take `If-Match: <version>` and bump `version`.

## 5. What the extension cache holds

A *subset* of the server schema as DTOs from `packages/shared`: tasks (without evidence ciphertext; evidence is fetched on demand when the Why panel opens), events (title, times, status, linked task counts), pending reminders (next 7 days), settings summary. No participant hashes, no fingerprints, no tokens other than the Heed session token.

## 6. Retention (enforced by the daily `RETENTION_PURGE` job)

| Data | Retention | Basis |
|---|---|---|
| `Task` `OPEN`/`SUGGESTED` | Until user acts; `SUGGESTED` auto-dismissed after 14 days unreviewed (no suppression written; they can re-detect only if a new message arrives) | Product |
| `Task` `COMPLETED`/`DISMISSED` | 90 days after status change, then hard-deleted (with evidence) | Allows undo/reopen |
| `Evidence` | Lives with its task | Explainability |
| `CalendarEvent` | 14 days after `endAt` | Linking context |
| `ProcessedMessage` | 45 days from `processedAt` (backfill max is 30) | Idempotency window |
| `Suppression` | 365 days, or until cleared by the user | Prevent resurrection |
| `Reminder` | Delivered/skipped/cancelled/missed: 14 days | Debugging and acks |
| `Tombstone` | 30 days | Delta-sync correctness |
| `SyncRun` | 30 days | Ops |
| `AiCallLog` | 30 days | Ops and cost audit |
| `AiUsage` | 90 days | Budget analytics |
| `AuditLog` | 90 days | Security review |
| `Session` | 7 days after expiry or revocation | Cleanup |
| `AuthTransaction` | 1 day | Cleanup |
| `Job` | Succeeded 7 days, failed 30 days | Ops |
| `DeletionReceipt` | 365 days, no user identifiers | Demonstrate erasure |
| Google refresh token | Until disconnect/revocation/account deletion | Functionality |

## 7. Deletion semantics

| Operation | Deletes | Keeps |
|---|---|---|
| Delete task | `Task` (cascades `Evidence`, `TaskFeedback`), pending `Reminder`s; writes `Suppression` and `Tombstone` | `ProcessedMessage` row (no content) |
| Disconnect integration (purge = true, default) | Token (and revoke at Google), `Integration` cursors reset, tasks whose evidence is only from that source (all evidence rows from that source), `ProcessedMessage` (Gmail) or `CalendarEvent` rows (Calendar), related reminders | Account, settings, other-source data |
| Disconnect integration (purge = false) | Token (revoked), cursors | Tasks, flagged "source disconnected" |
| Delete my data | `Task`, `Evidence`, `TaskFeedback`, `CalendarEvent`, `ProcessedMessage`, `Reminder`, `Tombstone`, `Suppression`, `SenderRule`, `AiUsage`, `AiCallLog`, pending `Job`s; cursors reset | `User`, `UserSettings`, `Consent`, `Session`, `Integration` (still connected) |
| Delete account | Everything above plus `Integration` (token revoked first), `Session`, `Consent`, `AuditLog`, `User` | `DeletionReceipt` (counts only) |

Deletes run in a single transaction per user, preceded by a lease on the user (status `DELETING`) so sync jobs skip them. Backups: Neon point-in-time restore keeps a 6-hour history window on the free plan; erased data may persist in provider history for up to that window (disclosed in PRIVACY.md).

## 8. Indexing and sizing notes

Per user per month at typical volume (about 1.5 k emails, about 5% pass stage 2): about 75 candidate messages leave `ProcessedMessage` rows for all 1.5 k (about 200 B each, about 0.3 MB), plus tasks and evidence (about 2 KB each, tens per month). With 10 users this is far below Neon's 0.5 GB limit even with 45-day retention. Dominant indexes: `Task(userId, status, effectiveDueAt)` for "Today" queries, `*(userId, seq)` for delta sync, `ProcessedMessage` primary key for idempotency.

## 9. Migration policy

- Prisma Migrate, forward-only, reviewed in PR.
- **Expand/contract**: a deploy's migrations must be compatible with both the previous and the new application version (add nullable column, backfill, switch, then drop in a later release).
- Applied by CI/CD with the direct (non-pooled) connection before the new revision receives traffic.
- Destructive migrations require a `docs/DECISIONS.md` note and a Neon branch backup.
