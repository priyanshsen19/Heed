# Heed — Data Model (V1, revised in Stage 0)

Status: Draft for sign-off. Revision history: initial version (architecture stage); **Stage 0 revision** adds first-class commitments, dependencies, counterparties (people and organizations), unified events, notifications, usage accounting, API idempotency, a job model that matches the job abstraction, and scale-oriented changes (row-volume control, due-time indexes). The conflicts that drove each change are logged in DECISIONS section 6 (CF-n).

The Prisma schema below is **normative for semantics** (entities, fields, enums, constraints, indexes, encryption, retention). Formatting and minor naming may be refined during implementation without a DECISIONS entry; semantic changes require one.

## 1. Principles

1. **Store derived data, not source data.** No email bodies, no attachments, no calendar descriptions, no recipient lists. For each detected item we keep one verbatim evidence quote (max 300 chars) and minimal source metadata.
2. **Tiered protection.** Credentials and email-derived text are field-level encrypted (AES-256-GCM, application-managed key). Operational fields needed for queries stay plaintext. Provider-level encryption at rest applies to everything.
3. **Every user-owned row carries `userId`** (directly, never only through a parent), has `onDelete: Cascade` from `User`, and is reachable by an index that starts with `userId`. This gives the ownership boundary, efficient user-scoped queries, and efficient deletion, and it makes later hash-partitioning or sharding by `userId` possible without changing the domain API.
4. **Every mutable synced entity has a per-user `seq`**; deletions leave a `Tombstone`.
5. **Idempotency is enforced by the database**, not only by application checks (section 5).
6. **Retention is explicit** for every table (section 8) and enforced by purge jobs. Every table also appears in the machine-readable data inventory (section 10).
7. **No content in operational tables.** `Job`, `SyncRun`, `AiAnalysis`, `AuditLog`, `Notification` (except the user-visible notification text) never contain email or event text.
8. **JSON only where flexibility is genuinely required** (bounded notification payload, bounded job payload of ids, bounded counters). Business state (status, deadlines, relations) is always in typed columns.
9. **No row is written for work that cannot cause a side effect.** Messages dropped by header-only stages are counted in aggregates, not logged row by row (section 6.3); this is what keeps the largest table tractable at scale.

## 2. Encryption and fingerprints

| Item | Method | Key |
|---|---|---|
| Refresh tokens; evidence quote, subject, sender; AI rationale; link rationale; counterparty display name and organization | AES-256-GCM, random 96-bit nonce, AAD = `"{table}.{column}:{userId}"` | `DATA_KEY[keyId]` (32 bytes). Envelope: `version(1) | keyId(1) | nonce(12) | ciphertext | tag(16)` stored as `Bytes`. Rotation = add keyId, re-encrypt lazily and via script |
| Participant and sender matching (`participantHashes`, `emailHash`, `SenderStats.senderKey`) | HMAC-SHA256(lowercased email or domain) | `HMAC_PEPPER` (separate secret) |
| Task / event / suppression fingerprints | HMAC-SHA256(`userId ‖ sourceKey ‖ normalizedTitle ‖ anchorKey`) | `HMAC_PEPPER` |
| Heed session token, connect ticket, heed code | SHA-256 of high-entropy random value | none |

Both keys live in **one** runtime secret (a single JSON secret version) to stay inside the Secret Manager free allowance (DECISIONS D-11); this is a deployment detail, not a data-model change.

Plaintext-by-design (needed for queries, notifications, and the UI, and visible to the user in the extension): task title and notes, due fields, status, event title and times, sender-rule values, notification text, timestamps.

## 3. Prisma schema (validated: `prisma validate` and `prisma format` pass on Prisma CLI 6.19.3)

This block is the exact output of the Stage 0 validation run (syntax, relations, enums, and attribute usage are accepted by the real Prisma CLI; no database was involved). Partial indexes, `CHECK` constraints, and the partial unique index on `AiAnalysis` cannot be expressed in Prisma schema syntax and are specified in the comments next to the models; they are added as raw-SQL migrations in Stage 2.

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")
  directUrl = env("DIRECT_URL")
}

// ───────── enums ─────────
enum UserStatus {
  ACTIVE
  DELETING
}

enum IntegrationProvider {
  GMAIL
  GOOGLE_CALENDAR
}

enum IntegrationStatus {
  CONNECTED
  NEEDS_REAUTH
  ERROR
  DISCONNECTED
}

enum ConsentType {
  GOOGLE_DATA_PROCESSING
  AI_PROCESSING
  SENT_MAIL_COMMITMENTS
  REGION_ATTESTATION
}

enum EventSource {
  CALENDAR_SYNC
  EMAIL_DETECTED
  MANUAL
}

enum EventState {
  ACTIVE
  CANCELLED
  SUGGESTED
  DISMISSED
}

enum RemindMode {
  AUTO
  ALWAYS
  NEVER
}

enum ContextLevel {
  NONE
  CONTEXTUAL
}

enum TaskStatus {
  SUGGESTED
  OPEN
  COMPLETED
  DISMISSED
}

enum TaskKind {
  ACTION
  PREPARATION
  DEADLINE
  COMMITMENT
}

enum TaskDirection {
  REQUESTED_OF_USER
  PROMISED_BY_USER
  SELF
}

enum TaskOrigin {
  AI
  MANUAL
}

enum DueSource {
  EXTRACTED
  EVENT_ANCHOR
  USER
  NONE
}

enum DueGranularity {
  TIME
  DAY
}

enum DismissReason {
  NOT_RELEVANT
  ALREADY_DONE
  WRONG_DETAILS
  TOO_NOISY
}

enum DependencyRelation {
  BEFORE_EVENT
  AFTER_EVENT
  DURING_EVENT
  BLOCKED_BY
}

enum DependencyStatus {
  ACTIVE
  TARGET_CANCELLED
  TARGET_PURGED
}

enum DependencyOrigin {
  AI
  USER
}

enum EvidenceSource {
  EMAIL
  SENT_EMAIL
  CALENDAR_EVENT
}

enum ReminderKind {
  EVENT_BRIEFING
  TASK_DEADLINE
  TASK_PREPARATION
  TASK_OVERDUE
  DEPENDENCY_BLOCKED
}

enum ReminderStatus {
  PENDING
  MATERIALIZED
  SKIPPED
  CANCELLED
}

enum NotificationChannel {
  CHROME
  WEB_PUSH
  EMAIL
  MOBILE_PUSH
}

enum NotificationStatus {
  SCHEDULED
  SENT
  DELIVERED
  CLICKED
  ACTIONED
  CANCELLED
  EXPIRED
  FAILED
}

enum MessageOutcome {
  DROPPED_CONTENT // stage 3 content score too low or injection pattern
  SUPPRESSED // matched a suppression fingerprint after extraction
  DEFERRED // passed to AI stage but budget/outage; retry pending
  AI_NONE // AI found nothing actionable
  AI_LOW_CONFIDENCE // confidence < 0.50
  EXTRACTED // produced or reinforced a task/event
  FAILED // permanent failure (e.g. message deleted, validation)
}

enum AiOutcome {
  OK
  NONE
  INVALID_OUTPUT
  QUOTA
  TIMEOUT
  ERROR
  DEFERRED
}

enum JobType {
  SYNC_GMAIL
  SYNC_CALENDAR
  ANALYZE_CANDIDATES
  REMINDER_PLAN
  DELIVER_DUE_REMINDERS
  RETENTION_PURGE
  PURGE_USER_DATA
  REVOKE_INTEGRATION
}

enum JobStatus {
  PENDING
  RUNNING
  SUCCEEDED
  FAILED
  CANCELLED
}

enum SenderRuleKind {
  MUTE
  ALWAYS_CONSIDER
}

enum SenderMatchType {
  EMAIL
  DOMAIN
}

enum ReminderLeadProfile {
  STANDARD
  EARLY
  MINIMAL
}

// ───────── identity & control ─────────
model User {
  id                     String              @id @default(uuid()) @db.Uuid
  googleSub              String              @unique
  email                  String
  status                 UserStatus          @default(ACTIVE)
  changeSeq              BigInt              @default(0)
  processingPausedAt     DateTime?
  processingPausedUntil  DateTime?
  pauseSilencesReminders Boolean             @default(false)
  createdAt              DateTime            @default(now())
  updatedAt              DateTime            @updatedAt
  settings               UserSettings?
  consents               Consent[]
  sessions               Session[]
  integrations           Integration[]
  syncRuns               SyncRun[]
  counterparties         Counterparty[]
  events                 Event[]
  tasks                  Task[]
  dependencies           Dependency[]
  evidence               Evidence[]
  feedback               TaskFeedback[]
  suppressions           Suppression[]
  senderRules            SenderRule[]
  senderStats            SenderStats[]
  processedMessages      ProcessedMessage[]
  aiAnalyses             AiAnalysis[]
  aiUsage                AiUsage[]
  reminders              Reminder[]
  notifications          Notification[]
  tombstones             Tombstone[]
  apiIdempotencyKeys     ApiIdempotencyKey[]
  auditLogs              AuditLog[]

  @@index([email])
}

model UserSettings {
  userId               String              @id @db.Uuid
  timezone             String              @default("UTC")
  quietHoursStart      Int                 @default(1260) // minutes from local midnight (21:00)
  quietHoursEnd        Int                 @default(480) // 08:00
  notificationsEnabled Boolean             @default(true)
  dailyNotificationCap Int                 @default(8)
  remindAllEvents      Boolean             @default(false) // true: event reminders even for events with no Heed context
  reminderLeadProfile  ReminderLeadProfile @default(STANDARD)
  backfillDays         Int                 @default(14) // 7 | 14 | 30
  user                 User                @relation(fields: [userId], references: [id], onDelete: Cascade)
}

model Consent {
  id        String      @id @default(uuid()) @db.Uuid
  userId    String      @db.Uuid
  type      ConsentType
  version   String // text version, e.g. "2026-10-02"
  variant   String? // AI_PROCESSING: "FREE_TIER" | "PAID_TIER" (which disclosure the user saw)
  grantedAt DateTime    @default(now())
  revokedAt DateTime?
  user      User        @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId, type, grantedAt])
}

model Session {
  id                String    @id @default(uuid()) @db.Uuid
  userId            String    @db.Uuid
  tokenHash         String    @unique
  deviceLabel       String?
  createdAt         DateTime  @default(now())
  lastUsedAt        DateTime  @default(now())
  idleExpiresAt     DateTime
  absoluteExpiresAt DateTime
  revokedAt         DateTime?
  user              User      @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
  @@index([absoluteExpiresAt])
}

model AuthTransaction {
  id                 String    @id @default(uuid()) @db.Uuid
  state              String    @unique
  clientChallenge    String
  clientState        String
  extRedirectUri     String
  intent             String
  connectUserId      String?   @db.Uuid
  googleCodeVerifier String
  nonce              String
  heedCodeHash       String?   @unique
  heedCodeUserId     String?   @db.Uuid
  expiresAt          DateTime
  consumedAt         DateTime?
  createdAt          DateTime  @default(now())

  @@index([expiresAt])
}

model Integration {
  id                  String              @id @default(uuid()) @db.Uuid
  userId              String              @db.Uuid
  provider            IntegrationProvider
  status              IntegrationStatus   @default(CONNECTED)
  grantedScopes       String[]
  refreshTokenEnc     Bytes?
  connectedAt         DateTime            @default(now())
  disconnectedAt      DateTime?
  // scheduling (due-time indexed, so the tick never scans all users)
  nextSyncAt          DateTime? // null when DISCONNECTED/NEEDS_REAUTH/paused
  syncIntervalSec     Int                 @default(900)
  syncLeaseUntil      DateTime? // overlap protection: only one sync per integration at a time
  syncLeaseOwner      String?
  lastSyncAt          DateTime?
  lastSuccessAt       DateTime?
  lastErrorCode       String?
  // cursors (persisted, never in memory)
  gmailHistoryId      String?
  gmailBackfilledAt   DateTime?
  calendarSyncToken   String?
  calendarWindowStart DateTime?
  calendarWindowEnd   DateTime?
  calendarFullSyncAt  DateTime?
  user                User                @relation(fields: [userId], references: [id], onDelete: Cascade)
  syncRuns            SyncRun[]
  events              Event[]

  @@unique([userId, provider])
  @@index([status, nextSyncAt]) // tick query: due integrations, oldest first
}

model SyncRun {
  id            String      @id @default(uuid()) @db.Uuid
  userId        String      @db.Uuid
  integrationId String      @db.Uuid
  correlationId String
  trigger       String // TICK | ON_DEMAND | BACKFILL
  startedAt     DateTime    @default(now())
  finishedAt    DateTime?
  status        String // OK | PARTIAL | ERROR
  counts        Json // bounded counters: listed, dropped_hard, dropped_header, fetched_full, deferred, ai_requests, extracted
  errorCode     String?
  user          User        @relation(fields: [userId], references: [id], onDelete: Cascade)
  integration   Integration @relation(fields: [integrationId], references: [id], onDelete: Cascade)

  @@index([userId, startedAt])
  @@index([startedAt])
}

// ───────── people and organizations (context) ─────────
model Counterparty {
  id              String     @id @default(uuid()) @db.Uuid
  userId          String     @db.Uuid
  emailHash       String? // HMAC of lowercased email (matching only)
  domain          String? // plaintext domain, e.g. "acme.com" (non-consumer only)
  displayNameEnc  Bytes?
  organizationEnc Bytes? // e.g. "Acme" (from domain/signature/AI), user-visible context
  lastSeenAt      DateTime   @default(now())
  user            User       @relation(fields: [userId], references: [id], onDelete: Cascade)
  tasks           Task[]
  evidence        Evidence[]
  organizedEvents Event[]    @relation("EventOrganizer")

  @@unique([userId, emailHash])
  @@index([userId, domain])
  @@index([userId, lastSeenAt]) // unreferenced rows are garbage-collected (section 8)
}

// ───────── events (calendar mirror + detected) ─────────
model Event {
  id                      String        @id @default(uuid()) @db.Uuid
  userId                  String        @db.Uuid
  source                  EventSource
  integrationId           String?       @db.Uuid
  providerCalendarId      String?
  providerEventId         String?
  etag                    String?
  fingerprint             String? // EMAIL_DETECTED/MANUAL events
  title                   String
  startAt                 DateTime
  endAt                   DateTime
  allDay                  Boolean       @default(false)
  timezone                String?
  state                   EventState    @default(ACTIVE)
  contextLevel            ContextLevel  @default(NONE)
  remindMode              RemindMode    @default(AUTO)
  organizerIsSelf         Boolean       @default(false)
  organizerCounterpartyId String?       @db.Uuid
  participantHashes       String[]
  participantDomains      String[]
  recurringEventId        String?
  seq                     BigInt
  createdAt               DateTime      @default(now())
  updatedAt               DateTime      @updatedAt
  user                    User          @relation(fields: [userId], references: [id], onDelete: Cascade)
  dependencies            Dependency[]
  evidence                Evidence[]
  reminders               Reminder[]
  integration             Integration?  @relation(fields: [integrationId], references: [id], onDelete: SetNull)
  organizerCounterparty   Counterparty? @relation("EventOrganizer", fields: [organizerCounterpartyId], references: [id], onDelete: SetNull)

  @@unique([userId, source, providerCalendarId, providerEventId]) // CALENDAR_SYNC idempotency (NULLs are distinct, so detected events use the next line)
  @@unique([userId, fingerprint])
  @@index([userId, startAt])
  @@index([userId, state, startAt])
  @@index([userId, seq])
}

// ───────── tasks (actions, preparations, deadlines, commitments) ─────────
model Task {
  id                    String          @id @default(uuid()) @db.Uuid
  userId                String          @db.Uuid
  title                 String // <= 140 chars
  notes                 String?
  status                TaskStatus
  kind                  TaskKind        @default(ACTION)
  direction             TaskDirection   @default(REQUESTED_OF_USER)
  origin                TaskOrigin
  confidence            Float?
  priority              Int             @default(2) // 0 urgent .. 3 low; derived deterministically from effectiveDueAt
  counterpartyId        String?         @db.Uuid
  counterpartyRole      String? // validated short label from extraction, e.g. "recruiter" (<= 40 chars)
  // deadline
  dueAt                 DateTime?
  dueGranularity        DueGranularity?
  dueSource             DueSource       @default(NONE)
  effectiveDueAt        DateTime? // maintained by service from dueAt or the BEFORE_EVENT target event start
  // state modifiers
  snoozedUntil          DateTime?
  completedAt           DateTime?
  dismissedAt           DateTime?
  dismissReason         DismissReason?
  completionSuggestedAt DateTime?
  userEditedFields      String[]
  fingerprint           String
  primaryThreadId       String?
  version               Int             @default(1)
  seq                   BigInt
  createdAt             DateTime        @default(now())
  updatedAt             DateTime        @updatedAt
  user                  User            @relation(fields: [userId], references: [id], onDelete: Cascade)
  counterparty          Counterparty?   @relation(fields: [counterpartyId], references: [id], onDelete: SetNull)
  dependenciesFrom      Dependency[]    @relation("DependencyFrom")
  dependenciesTo        Dependency[]    @relation("DependencyTo")
  evidence              Evidence[]
  feedback              TaskFeedback[]
  reminders             Reminder[]

  @@unique([userId, fingerprint])
  @@index([userId, status, effectiveDueAt])
  @@index([userId, status, priority, effectiveDueAt])
  @@index([userId, seq])
  @@index([userId, primaryThreadId])
  @@index([userId, completedAt])
  @@index([userId, dismissedAt])
}

model Dependency {
  id               String             @id @default(uuid()) @db.Uuid
  userId           String             @db.Uuid
  fromTaskId       String             @db.Uuid // the dependent task
  toEventId        String?            @db.Uuid // exactly one of toEventId/toTaskId is set (CHECK constraint)
  toTaskId         String?            @db.Uuid
  targetKey        String // "E:<id>" | "T:<id>" (makes uniqueness well-defined)
  relation         DependencyRelation
  status           DependencyStatus   @default(ACTIVE)
  origin           DependencyOrigin
  confidence       Float?
  linkRationaleEnc Bytes?
  createdAt        DateTime           @default(now())
  user             User               @relation(fields: [userId], references: [id], onDelete: Cascade)
  fromTask         Task               @relation("DependencyFrom", fields: [fromTaskId], references: [id], onDelete: Cascade)
  toTask           Task?              @relation("DependencyTo", fields: [toTaskId], references: [id], onDelete: Cascade)
  toEvent          Event?             @relation(fields: [toEventId], references: [id], onDelete: Cascade)
  // FKs: fromTaskId, toTaskId -> Task (cascade); toEventId -> Event (cascade). CHECK ((toEventId IS NULL) <> (toTaskId IS NULL)).

  @@unique([fromTaskId, targetKey, relation])
  @@index([userId, toEventId])
  @@index([userId, toTaskId])
  @@index([userId, fromTaskId])
}

model Evidence {
  id                 String         @id @default(uuid()) @db.Uuid
  userId             String         @db.Uuid
  taskId             String?        @db.Uuid
  eventId            String?        @db.Uuid // evidence may also justify a detected event
  source             EvidenceSource
  gmailMessageId     String?
  gmailThreadId      String?
  calendarEventId    String?
  counterpartyId     String?        @db.Uuid
  receivedAt         DateTime
  subjectEnc         Bytes?
  senderEnc          Bytes?
  quoteEnc           Bytes // verbatim, <= 300 chars
  rulesFired         String[]
  aiRationaleEnc     Bytes?
  linkRationaleEnc   Bytes?
  analysisId         String?        @db.Uuid // AiAnalysis that produced it (provenance)
  llmInputChars      Int?
  llmCandidateEvents Int?
  createdAt          DateTime       @default(now())
  user               User           @relation(fields: [userId], references: [id], onDelete: Cascade)
  task               Task?          @relation(fields: [taskId], references: [id], onDelete: Cascade)
  event              Event?         @relation(fields: [eventId], references: [id], onDelete: Cascade)
  counterparty       Counterparty?  @relation(fields: [counterpartyId], references: [id], onDelete: SetNull)
  analysis           AiAnalysis?    @relation(fields: [analysisId], references: [id], onDelete: SetNull)

  @@unique([taskId, gmailMessageId]) // evidence idempotency
  @@index([userId, taskId])
  @@index([userId, eventId])
  @@index([userId, createdAt])
}

model TaskFeedback {
  id        String   @id @default(uuid()) @db.Uuid
  userId    String   @db.Uuid
  taskId    String   @db.Uuid
  useful    Boolean
  note      String?
  createdAt DateTime @default(now())
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  task      Task     @relation(fields: [taskId], references: [id], onDelete: Cascade)

  @@index([userId, taskId])
}

model Suppression {
  id          String   @id @default(uuid()) @db.Uuid
  userId      String   @db.Uuid
  fingerprint String
  reason      String // DELETED | DISMISSED
  createdAt   DateTime @default(now())
  user        User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([userId, fingerprint])
  @@index([userId, createdAt])
}

model SenderRule {
  id        String          @id @default(uuid()) @db.Uuid
  userId    String          @db.Uuid
  kind      SenderRuleKind
  matchType SenderMatchType
  value     String
  createdAt DateTime        @default(now())
  user      User            @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([userId, kind, matchType, value])
}

model SenderStats {
  userId         String          @db.Uuid
  senderKey      String // HMAC(email) or HMAC(domain)
  matchType      SenderMatchType
  confirmedCount Int             @default(0)
  completedCount Int             @default(0)
  dismissedCount Int             @default(0)
  updatedAt      DateTime        @updatedAt
  user           User            @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@id([userId, senderKey])
  @@index([userId, updatedAt])
}

// ───────── ingestion log and AI accounting ─────────
model ProcessedMessage {
  userId         String         @db.Uuid
  gmailMessageId String
  gmailThreadId  String
  internalDate   DateTime
  isSent         Boolean        @default(false)
  outcome        MessageOutcome
  headerScore    Int?
  contentScore   Int?
  rulesVersion   String
  rulesFired     String[]
  priority       Int            @default(2) // candidate priority for deferred queue (0 highest)
  attempts       Int            @default(0)
  processedAt    DateTime       @default(now())
  user           User           @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@id([userId, gmailMessageId])
  @@index([userId, processedAt])
  @@index([outcome, priority, processedAt]) // deferred-candidate queue drain
}

model AiAnalysis {
  id                    String     @id @default(uuid()) @db.Uuid
  userId                String     @db.Uuid
  sourceKey             String // gmailMessageId, or eventId:etag
  operation             String // EXTRACT
  provider              String
  model                 String
  promptVersion         String
  rulesVersion          String
  batchId               String? // items sharing one provider request
  batchSize             Int        @default(1)
  inputChars            Int
  candidateEvents       Int
  estimatedInputTokens  Int?
  estimatedOutputTokens Int?
  latencyMs             Int?
  outcome               AiOutcome
  tasksProposed         Int        @default(0)
  tasksAccepted         Int        @default(0)
  createdAt             DateTime   @default(now())
  user                  User       @relation(fields: [userId], references: [id], onDelete: Cascade)
  evidence              Evidence[]
  // partial unique index (raw SQL migration): UNIQUE (userId, sourceKey, operation, promptVersion, rulesVersion) WHERE outcome IN ('OK','NONE')
  // => a successfully analyzed source is never sent to the AI twice for the same prompt/rules version

  @@index([userId, createdAt])
  @@index([createdAt])
}

model AiUsage {
  userId                String   @db.Uuid
  day                   DateTime @db.Date
  provider              String
  model                 String
  operation             String
  requests              Int      @default(0)
  requestsOk            Int      @default(0)
  requestsQuota         Int      @default(0)
  requestsError         Int      @default(0)
  requestsInvalid       Int      @default(0)
  candidatesAnalyzed    Int      @default(0)
  estimatedInputTokens  Int      @default(0)
  estimatedOutputTokens Int      @default(0)
  user                  User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@id([userId, day, provider, model, operation])
}

model AiProviderUsage {
  provider        String
  model           String
  day             DateTime  @db.Date
  requests        Int       @default(0)
  estimatedTokens Int       @default(0)
  blockedUntil    DateTime? // set after a provider 429: cross-instance backoff, persisted

  @@id([provider, model, day])
}

// ───────── reminders and notifications ─────────
model Reminder {
  id            String         @id @default(uuid()) @db.Uuid
  userId        String         @db.Uuid
  kind          ReminderKind
  taskId        String?        @db.Uuid
  eventId       String?        @db.Uuid
  slotKey       String
  triggerAt     DateTime
  priority      Int            @default(2)
  status        ReminderStatus @default(PENDING)
  policyVersion Int            @default(2)
  seq           BigInt
  createdAt     DateTime       @default(now())
  updatedAt     DateTime       @updatedAt
  user          User           @relation(fields: [userId], references: [id], onDelete: Cascade)
  task          Task?          @relation(fields: [taskId], references: [id], onDelete: Cascade)
  event         Event?         @relation(fields: [eventId], references: [id], onDelete: Cascade)
  notifications Notification[]
  // raw SQL migration: CREATE INDEX reminder_due_idx ON "Reminder" (triggerAt, priority) WHERE status = 'PENDING';
  // the scheduler query is: WHERE status='PENDING' AND triggerAt <= now()+lookahead ORDER BY triggerAt, priority LIMIT N FOR UPDATE SKIP LOCKED

  @@unique([userId, slotKey]) // planning idempotency
  @@index([userId, status, triggerAt])
  @@index([userId, seq])
}

model Notification {
  id             String              @id @default(uuid()) @db.Uuid
  userId         String              @db.Uuid
  reminderId     String?             @db.Uuid
  channel        NotificationChannel
  status         NotificationStatus  @default(SCHEDULED)
  idempotencyKey String              @unique // hash(reminderId, channel, payloadGeneration)
  deliverAt      DateTime
  title          String
  body           String
  actions        Json // bounded: [{id,label}] (<= 3)
  deepLink       String // in-extension route, never an external URL
  attempts       Int                 @default(0)
  sentAt         DateTime?
  deliveredAt    DateTime?
  clickedAt      DateTime?
  lastErrorCode  String?
  providerRef    String?
  seq            BigInt
  createdAt      DateTime            @default(now())
  user           User                @relation(fields: [userId], references: [id], onDelete: Cascade)
  reminder       Reminder?           @relation(fields: [reminderId], references: [id], onDelete: Cascade)

  @@index([userId, status, deliverAt])
  @@index([userId, seq])
  @@index([channel, status, deliverAt]) // push-style channels drain by due time
}

model Tombstone {
  id         String   @id @default(uuid()) @db.Uuid
  userId     String   @db.Uuid
  entityType String // TASK | EVENT | REMINDER | NOTIFICATION
  entityId   String   @db.Uuid
  seq        BigInt
  deletedAt  DateTime @default(now())
  user       User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId, seq])
  @@index([deletedAt])
}

// ───────── operations ─────────
model Job {
  id             String    @id @default(uuid()) @db.Uuid
  type           JobType
  queue          String    @default("default")
  status         JobStatus @default(PENDING)
  priority       Int       @default(2)
  userId         String?   @db.Uuid
  payload        Json      @default("{}") // ids only, <= 4 KB, never content
  idempotencyKey String    @unique // required: duplicate enqueue returns the existing job
  correlationId  String // propagated from the originating request/tick
  attempts       Int       @default(0)
  maxAttempts    Int       @default(5)
  createdAt      DateTime  @default(now())
  scheduledAt    DateTime  @default(now())
  startedAt      DateTime?
  completedAt    DateTime?
  lockedUntil    DateTime?
  lockedBy       String?
  errorCode      String?
  errorMessage   String? // sanitized, <= 200 chars, no content

  @@index([status, scheduledAt, priority])
  @@index([userId, status])
  @@index([completedAt])
}

model ApiIdempotencyKey {
  userId       String   @db.Uuid
  key          String
  requestHash  String
  responseCode Int
  responseBody Json? // bounded, <= 16 KB
  createdAt    DateTime @default(now())
  expiresAt    DateTime
  user         User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@id([userId, key])
  @@index([expiresAt])
}

model RateLimitCounter {
  key         String
  windowStart DateTime
  count       Int      @default(0)

  @@id([key, windowStart])
  @@index([windowStart])
}

model AuditLog {
  id        String   @id @default(uuid()) @db.Uuid
  userId    String   @db.Uuid
  event     String
  detail    Json? // bounded: provider, counts; never content
  createdAt DateTime @default(now())
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId, createdAt])
  @@index([createdAt])
}

model DeletionReceipt {
  id        String   @id @default(uuid()) @db.Uuid
  kind      String
  counts    Json
  createdAt DateTime @default(now())
}
```

## 4. Key semantics

### 4.1 Change sequence and delta sync

Every mutation of `Task`, `Event`, `Dependency` (via its task), `Reminder`, or `Notification` runs in a transaction that executes `UPDATE "User" SET "changeSeq" = "changeSeq" + 1 WHERE id = $1 RETURNING "changeSeq"` and writes that value into the row's `seq`. Deletes insert a `Tombstone`. The delta feed returns rows with `seq > cursor` in `seq` order, **paged** (limit at most 200, `hasMore`), plus tombstones. If the cursor is older than the oldest retained tombstone (30 days), the server returns `resyncRequired`. Per-user serialization on `changeSeq` is acceptable at any foreseeable per-user write rate.

### 4.2 Fingerprints, dedupe, suppression

`fingerprint = HMAC(pepper, userId ‖ sourceKey ‖ normalizedTitle ‖ anchorKey)`; `sourceKey` is the Gmail thread ID (or event ID), `normalizedTitle` lowercased with stop words removed and tokens sorted, `anchorKey` the target event/task id or the resolved due date. Matching a new extraction to existing state, in order:

1. Exact `fingerprint` match: same task; add `Evidence` (unique per `(taskId, gmailMessageId)`); no duplicate.
2. Same `primaryThreadId` and same dependency target (or none) with title token Jaccard at least 0.6: same task; reinforce evidence; update only fields not in `userEditedFields`.
3. Matches a `Suppression` fingerprint: record `SUPPRESSED`, create nothing. A materially new ask creates a new task.

Detected events dedupe the same way on `Event.fingerprint` and also against calendar events: a detected event whose title tokens and start time (within 30 minutes) match an existing `CALENDAR_SYNC` event is **merged into it as evidence**, never created as a duplicate.

### 4.3 Deadlines, dependencies, effective due time

| `dueSource` | Meaning | `effectiveDueAt` |
|---|---|---|
| `EXTRACTED` | AI-extracted absolute date/time (validated) | `dueAt` |
| `EVENT_ANCHOR` | A `BEFORE_EVENT` dependency exists | `target event.startAt` (earliest if several) |
| `USER` | User-set | `dueAt` |
| `NONE` | No deadline | null |

`AFTER_EVENT` orders by the event's `endAt`; `DURING_EVENT` by `startAt`; `BLOCKED_BY` task dependencies create no deadline by themselves: they make the dependent task's reminders carry the unmet prerequisite. A service recomputes `effectiveDueAt`, `priority`, and `contextLevel` when events, dependencies, or tasks change, and enqueues `REMINDER_PLAN`. `Dependency.status` becomes `TARGET_CANCELLED` or `TARGET_PURGED` when the target event is cancelled or purged (the dependent task is never deleted by that).

`priority` (0 to 3) is deterministic: 0 when `effectiveDueAt` is within 3 hours or overdue, 1 within 24 hours, 2 within 7 days or undated, 3 later.

### 4.4 State transitions (enforced in the tasks service)

| From | Allowed to | Side effects |
|---|---|---|
| `SUGGESTED` | `OPEN` (confirm), `DISMISSED`, delete | confirm: plan reminders; dismiss: suppression plus `SenderStats.dismissedCount++` and cancel reminders |
| `OPEN` | `COMPLETED`, `DISMISSED`, delete | cancel reminders and cancel `SCHEDULED` notifications; dismiss writes suppression |
| `COMPLETED` | `OPEN` (reopen), delete | reopen re-plans; `SenderStats.completedCount++` on completion |
| `DISMISSED` | `OPEN` (reopen), delete | reopen removes the suppression |

Events detected from email use `EventState`: `SUGGESTED` to `ACTIVE` (confirm) or `DISMISSED`. Heed never writes events to Google Calendar. Illegal transitions return `409`. Mutations take `If-Match: <version>` (tasks) and bump `version`.

### 4.5 Reminder, notification, and delivery state

`Reminder.status`: `PENDING` (planned) → `MATERIALIZED` (one `Notification` per enabled channel was created) | `SKIPPED` (no longer relevant when evaluated) | `CANCELLED` (plan removed or superseded by re-planning). Delivery state lives only on `Notification`: `SCHEDULED` → `SENT` (handed to the channel) → `DELIVERED` (client acknowledged display) → `CLICKED` | `ACTIONED` (done/snooze action), or `CANCELLED` (underlying reminder cancelled before delivery), `EXPIRED` (not delivered within its validity window; surfaced as "Missed"), `FAILED` (provider error, retried up to `maxAttempts`).

### 4.6 Personalization (deterministic)

`SenderStats` feeds the Stage-2 header score: `+1` when `confirmedCount + completedCount >= 2` and `dismissedCount = 0`; `-2` when `dismissedCount >= 3` and no confirmations (recomputed on each change, decayed by `updatedAt` older than 90 days). Combined with explicit `SenderRule`s, per-user quiet hours, caps, lead profile, and per-event `remindMode`, this is Heed's personalization layer. It is reproducible, explainable ("you dismissed this sender 3 times"), cheap, and needs no model.

## 5. Idempotency map (database-enforced)

| Operation | Guard |
|---|---|
| Gmail sync repeated or overlapping | `Integration.syncLeaseUntil` conditional update (one runner); history cursor advanced in the same transaction as the last persisted message; `ProcessedMessage` primary key `(userId, gmailMessageId)` claimed with `INSERT … ON CONFLICT DO NOTHING RETURNING` before analysis |
| Calendar sync repeated | `Event` unique `(userId, source, providerCalendarId, providerEventId)`; upsert by that key; `etag` comparison skips unchanged events |
| AI analysis repeated (retries, two runners) | `AiAnalysis` partial unique index on successful outcomes: a source is analyzed at most once per prompt/rules version |
| Task creation | `Task` unique `(userId, fingerprint)`; `Evidence` unique `(taskId, gmailMessageId)` |
| Event detection from email | `Event` unique `(userId, fingerprint)` plus merge-into-calendar-event rule |
| Reminder planning | `Reminder` unique `(userId, slotKey)`; planner output is upserted/cancelled, never appended |
| Notification materialization and retries | `Notification.idempotencyKey` unique; provider `send` receives the key so providers that support idempotency de-duplicate |
| Job enqueue | `Job.idempotencyKey` unique; enqueue returns the existing job on conflict |
| API retries from the extension outbox | `ApiIdempotencyKey (userId, key)` stores the first response (24 h); same key plus different request hash is `422 IDEMPOTENCY_KEY_REUSED` |
| Deletions and purges | Deletes are naturally idempotent; `PURGE_USER_DATA` is resumable by batch cursor |

## 6. Volume, indexes, and scale notes

### 6.1 Index principles

Every query path starts with `userId`. Due-time paths are indexed for scanning without per-user loops: `Integration (status, nextSyncAt)` (due syncs), `Reminder (triggerAt, priority) WHERE status='PENDING'` (due reminders), `Notification (channel, status, deliverAt)` (push-style delivery), `Job (status, scheduledAt, priority)` (job claim), `ProcessedMessage (outcome, priority, processedAt)` (deferred AI queue). Time-based retention paths have a standalone time index (`createdAt`, `startedAt`, `deletedAt`, `completedAt`, `expiresAt`) so purge jobs delete in bounded batches without scans.

### 6.2 Tables expected to grow large

`ProcessedMessage`, `Evidence`, `AiAnalysis`, `AuditLog`, `Notification`, `Reminder`, `SyncRun` (and `Tombstone`, `ApiIdempotencyKey`, `RateLimitCounter` as short-lived tables). Per table: expected driver, retention, future partitioning key, archival/TTL path, and the statement that the domain API does not change are in SCALE_MODEL section 5. In short: time-based retention tables partition by month and expire by dropping partitions; user-owned core tables (`Task`, `Evidence`, `Event`) hash-partition by `userId` only if measured necessary, which works because `userId` is in every key and index.

### 6.3 Row-volume control (a design rule, not an optimization)

The funnel drops most mail on headers alone (Stages 1–2). Those drops cause no side effect and are deterministic, so **no row is written for them**; they are counted in `SyncRun.counts`. A repeated or replayed sync re-evaluates them identically and creates nothing, so idempotency holds. `ProcessedMessage` therefore has rows only for messages whose body was fetched (about a quarter of inbox mail) or that were deferred. `SyncRun` is written only when a sync listed at least one message, changed state, or failed; the "nothing new" 15-minute poll updates only `Integration.lastSyncAt` and `nextSyncAt`.

## 7. What the extension cache holds

A *subset* of the server schema as DTOs from `packages/shared`: tasks (with their dependency summaries), events (title, times, state, context level), pending notifications (next 36 hours), settings summary. No participant hashes, fingerprints, evidence ciphertext, or tokens other than the Heed session token. Evidence is fetched on demand for the "Why" panel and held in memory only while it is open.

## 8. Retention (enforced by the daily `RETENTION_PURGE` job in bounded batches)

| Data | Retention | Basis |
|---|---|---|
| `Task` `OPEN`/`SUGGESTED` | Until user acts; `SUGGESTED` auto-dismissed after 14 days (no suppression written) | Product |
| `Task` `COMPLETED`/`DISMISSED` | 90 days after status change, then hard-deleted with evidence and dependencies | Undo/reopen |
| `Evidence`, `Dependency` | Live with their task/event | Explainability |
| `Event` | 14 days after `endAt` (detected events likewise); tasks keep dependency status `TARGET_PURGED` | Linking context |
| `Counterparty` | Deleted 30 days after the last referencing row disappears | Minimal people data |
| `ProcessedMessage` | 30 days from `processedAt` (equals the maximum backfill window) | Idempotency window |
| `AiAnalysis` | 30 days | Ops, cost audit |
| `SyncRun` | 7 days (written only when a sync did work or failed) | Ops |
| `AiUsage`, `AiProviderUsage` | 90 days | Budget analytics |
| `Suppression` | 365 days or until cleared | Prevent resurrection |
| `SenderStats` | 365 since `updatedAt` | Personalization |
| `Reminder` | `MATERIALIZED`/`SKIPPED`/`CANCELLED`: 14 days | Debugging |
| `Notification` | 14 days after `deliverAt` | Debugging, acks |
| `Tombstone` | 30 days | Delta-sync correctness |
| `AuditLog` | 90 days | Security review |
| `Session` | 7 days after expiry/revocation | Cleanup |
| `AuthTransaction`, `ApiIdempotencyKey`, `RateLimitCounter` | 1 day / 24 hours / 1 day | Cleanup |
| `Job` | Succeeded 7 days, failed/cancelled 30 days | Ops |
| `DeletionReceipt` | 365 days, no identifiers | Prove erasure |
| Google refresh token | Until disconnect/revocation/account deletion | Functionality |

## 9. Deletion semantics

| Operation | Deletes | Keeps |
|---|---|---|
| Delete task | `Task` (cascades `Evidence`, `Dependency` rows from/to it, `TaskFeedback`), its `Reminder`s, `SCHEDULED` `Notification`s; writes `Suppression` and `Tombstone` | `ProcessedMessage` row (no content) |
| Disconnect integration (purge, default) | Token (revoked at Google), cursors reset, items whose only evidence is from that source, that source's `ProcessedMessage`/`Event` rows, related reminders and notifications | Account, settings, other-source data |
| Disconnect integration (keep) | Token (revoked), cursors | Items, flagged "source disconnected" |
| Delete my data | All derived tables (tasks, dependencies, evidence, events, counterparties, message log, analyses, usage, reminders, notifications, suppressions, sender rules and stats, tombstones, pending jobs); cursors reset | `User`, `UserSettings`, `Consent`, `Session`, `Integration` (still connected) |
| Delete account | Everything above plus `Integration` (token revoked first), `Session`, `Consent`, `AuditLog`, `ApiIdempotencyKey`, `User` | `DeletionReceipt` (counts only) |

Deletion runs as the resumable `PURGE_USER_DATA` job in bounded batches per table (all keyed by `userId`), after the user is set to `DELETING` so sync jobs skip them. For today's data volumes it completes in one run; the same job scales to large users and to partitioned or sharded storage. Backups: Neon point-in-time restore keeps a 6-hour window on the free plan; erased data may persist in provider history up to that window (disclosed in PRIVACY).

## 10. Data inventory registry (privacy by construction)

`packages/shared/src/data-inventory.ts` is a typed registry with one entry per table and per encrypted or sensitive column group: `purpose`, `legalBasis` (consent type), `storage` (table and encryption tier), `retention` (matches section 8), `accessors` (which modules may read it; no human access except break-glass), and `deletionPath` (which deletion operation removes it). A CI test fails if a Prisma model has no registry entry, if a registry retention disagrees with the purge job configuration, or if a registry `deletionPath` does not clear the table in the delete-data integration test. The user-facing "what Heed stores" page and the export file are generated from this registry, so documentation, behavior, and UI cannot drift apart.

## 11. Migration policy

- Prisma Migrate, forward-only, reviewed in PR; raw SQL migrations for partial indexes, CHECK constraints, and the partial unique indexes noted above.
- **Expand/contract**: each deploy's migrations are compatible with the previous and next application versions.
- Applied by CI/CD with the direct (non-pooled) connection before traffic shifts.
- Destructive migrations require a DECISIONS note and a Neon branch backup.
