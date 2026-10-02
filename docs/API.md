# Heed — API Specification (V1)

Status: Draft for sign-off. Transport: HTTPS, JSON, base path `/v1`. Request and response schemas are defined once as Zod schemas in `packages/shared` and used by both server validation and the extension client; this document is the human-readable contract. An OpenAPI document is generated from those schemas in CI and published as a build artifact.

## 1. Conventions

| Topic | Rule |
|---|---|
| Auth | `Authorization: Bearer <heed-session-token>` on all `/v1` routes except `/v1/auth/google/start`, `/v1/auth/google/callback`, `/v1/auth/token`. No cookies are used, so there is no CSRF surface on the JSON API |
| Request ids | Every response carries `X-Request-ID`. A caller-supplied `X-Request-ID` is propagated only if it is 8–64 characters of `A-Za-z0-9._-`; otherwise a UUID is generated. The id appears in every log line and in every error body (`requestId`). It is a correlation aid only and never authenticates anything *(Stage 1)* |
| Client identity | `X-Heed-Client: extension/<semver>`. Server may return `426 Upgrade Required` (`code: CLIENT_TOO_OLD`) below `MIN_CLIENT_VERSION` |
| IDs | UUID v4 strings |
| Times | ISO 8601 UTC (`2026-10-07T11:00:00Z`) plus an IANA `timezone` field where local semantics matter |
| Concurrency | Mutable resources carry `version`; `PATCH` and state-change `POST`s require `If-Match: "<version>"`; mismatch returns `409 VERSION_CONFLICT` with the current resource |
| Idempotency | All mutating `POST`/`PATCH`/`DELETE` accept `Idempotency-Key: <uuid>` (the extension outbox always sends one). Server stores key and response for 24 h per user; replays return the original response |
| Pagination | **Every list endpoint is cursor-paginated; no endpoint returns an unbounded collection and none uses OFFSET.** Request `?limit=` (default 50, max 100; the sync feed max 200) and `?cursor=` (opaque, HMAC-signed keyset token over the endpoint's sort key plus id; a malformed or tampered cursor is `400 CURSOR_INVALID`). Response `{ items, nextCursor }` (`nextCursor` null on the last page). Sort orders are fixed per endpoint and backed by `userId`-prefixed indexes: tasks `(effectiveDueAt NULLS LAST, id)`, events `(startAt, id)`, reminders `(triggerAt, id)`, notifications `(deliverAt, id)`, sessions and sender rules `(createdAt, id)`. There is deliberately no "get all my data" endpoint; export is a paged stream (below) |
| Errors | RFC 9457 `application/problem+json`: `{ type, title, status, code, detail?, requestId, errors? }`. `code` values are stable (section 12). Never includes email content or tokens |
| Unknown resource vs forbidden | Another user's resource returns `404`, never `403`, to avoid existence leaks |
| Rate limits | Per-IP (unauthenticated routes) and per-user; `429` with `Retry-After`. Defaults in section 11 |
| Validation | Strict Zod schemas; unknown fields rejected (`400 VALIDATION_FAILED`) |
| CORS | Allowed origin: `chrome-extension://<allowlisted-id>` only; no credentials mode needed |
| Compatibility | Additive changes only within `/v1` (new optional fields, new endpoints). Breaking changes create `/v2` and a `MIN_CLIENT_VERSION` bump |

## 2. Authentication endpoints

### `POST /v1/auth/connect-ticket` (authenticated)
Creates a single-use ticket that lets the browser-based OAuth flow attach a new integration to the current user without cookies or headers.

Request: `{ "intent": "CONNECT_GMAIL" | "CONNECT_CALENDAR" }` · Response `200`: `{ "ticket": "<opaque>", "expiresAt": "…" }` (TTL 60 s, single use, bound to the session's user).

### `GET /v1/auth/google/start` (unauthenticated, browser navigation)
Query: `intent` (`SIGN_IN` | `CONNECT_GMAIL` | `CONNECT_CALENDAR`), `challenge` (base64url S256 PKCE challenge, 43 chars), `state` (client state, 16–128 chars), `ext_redirect` (must exactly equal `https://<allowlisted-extension-id>.chromiumapp.org/<path>`), `ticket` (required for `CONNECT_*`).

Behavior: validates all parameters (reject otherwise with a plain error page and no redirect to unvalidated URIs), creates an `AuthTransaction`, and `302`s to Google's authorization endpoint with: Heed's own `state`, server-side PKCE (`code_challenge` S256), `nonce`, `access_type=offline`, `prompt=consent` (for `CONNECT_*` and first sign-in), `response_type=code`, and only the scopes of the intent:

| Intent | Scopes |
|---|---|
| `SIGN_IN` | `openid email profile` |
| `CONNECT_CALENDAR` | `https://www.googleapis.com/auth/calendar.events.readonly` |
| `CONNECT_GMAIL` | `https://www.googleapis.com/auth/gmail.readonly` |

`CONNECT_*` flows do not set `include_granted_scopes` (independent grants; see ARCHITECTURE section 10).

### `GET /v1/auth/google/callback` (unauthenticated, from Google)
Validates `state` against `AuthTransaction` (single use, unexpired), exchanges `code` with `client_secret` and the server PKCE verifier, verifies the ID token (signature via Google JWKS, `iss`, `aud`, `exp`, `nonce`, `email_verified`), enforces the **beta allowlist** (see section 11 and DECISIONS), for `CONNECT_*` verifies the Google `sub` equals the signed-in user's `googleSub` (else `OAUTH_ACCOUNT_MISMATCH`), upserts `User`/`Integration` (refresh token stored encrypted; if Google does not return a refresh token on a connect flow, the flow fails with `OAUTH_NO_REFRESH_TOKEN` and the UI explains how to retry), mints a single-use `heed_code` (random 256-bit, stored hashed, valid 60 s), and `302`s to `ext_redirect?code=<heed_code>&state=<client_state>`. On error, redirects to `ext_redirect?error=<code>&state=…` (error codes only, no details).

### `POST /v1/auth/token` (unauthenticated)
Request: `{ "code": "<heed_code>", "codeVerifier": "<43–128 chars>" }`. Verifies `base64url(sha256(codeVerifier)) == clientChallenge`, single-use consume. Response `200`:
```json
{ "sessionToken": "<opaque 43+ chars>", "idleExpiresAt": "…", "absoluteExpiresAt": "…",
  "user": { "id": "…", "email": "…" } }
```

### `POST /v1/auth/logout` (authenticated)
Revokes the current session. `204`.

### `GET /v1/auth/sessions` · `DELETE /v1/auth/sessions/:id` · `DELETE /v1/auth/sessions`
List the user's sessions (paginated by `(createdAt, id)`; device label, created, last used, current flag), revoke one, or revoke all others. `204`/`200`.

## 3. Me, settings, privacy controls

### `GET /v1/me`
```json
{ "user": { "id": "…", "email": "…", "createdAt": "…" },
  "settings": { "timezone": "Europe/London", "quietHoursStart": 1260, "quietHoursEnd": 480,
                "notificationsEnabled": true, "dailyNotificationCap": 8, "backfillDays": 14,
                "remindAllEvents": false, "reminderLeadProfile": "STANDARD" },
  "processing": { "paused": false, "pausedUntil": null, "silencesReminders": false,
                  "ai": { "status": "NORMAL" | "DELAYED" | "PAUSED" | "DISABLED", "backlog": 0, "oldestQueuedAt": null,
                          "message": null } },
  "consents": [ { "type": "GOOGLE_DATA_PROCESSING", "version": "2026-10-01", "grantedAt": "…" } ],
  "integrations": [ { "provider": "GMAIL", "status": "CONNECTED", "lastSuccessAt": "…", "lastErrorCode": null } ] }
```

### `PATCH /v1/me/settings`
Partial update of settings (validated ranges: `dailyNotificationCap` 1–30, `backfillDays` ∈ {7,14,30}, valid IANA timezone). Changing quiet hours or timezone enqueues `REMINDER_PLAN`. Response: updated settings.

### `POST /v1/me/consents`
`{ "type": "GOOGLE_DATA_PROCESSING" | "AI_PROCESSING" | "SENT_MAIL_COMMITMENTS" | "REGION_ATTESTATION", "version": "…", "variant"?: "FREE_TIER" | "PAID_TIER", "granted": true|false }`. Connecting Gmail or Calendar requires a current `GOOGLE_DATA_PROCESSING` consent; extraction requires `AI_PROCESSING` whose `variant` matches the server's configured data tier (a mismatch is `409 CONSENT_VARIANT_STALE`, which forces re-consent when the tier changes); in free-tier mode `REGION_ATTESTATION` is also required; reading sent mail for commitments requires `SENT_MAIL_COMMITMENTS`. Revoking `AI_PROCESSING` stops AI calls (existing items keep working; deferred candidates are dropped); revoking `SENT_MAIL_COMMITMENTS` stops sent-mail processing. `GET /v1/me/consents` is a short, bounded list (one current entry per type).

### `POST /v1/me/pause` · `POST /v1/me/resume`
Pause body: `{ "duration": "1h" | "1d" | "until_resumed", "silenceReminders": false }`. While paused the server makes no Gmail, Calendar, or AI calls for the user (jobs are skipped) and records `processingPausedAt`. Resume fast-forwards cursors (paused-period mail is skipped; see PRODUCT 6.1). Response: `processing` object.

### `GET /v1/me/export`
Streams `application/x-ndjson` (attachment), one JSON object per line with a `type` field, produced by **keyset-paging each table by `userId`** (bounded memory, no OFFSET, no unbounded response buffer): user, settings, consents, integrations (status only, never tokens), tasks, dependencies, evidence (decrypted for the owner), events, counterparties, reminders, notifications, sender rules, suppressions count, audit log. The record types and fields are generated from the data-inventory registry (DATA_MODEL section 10), so the export cannot omit a table. Rate limited to 5/day. At larger scale this becomes an asynchronous export job returning a short-lived signed download link, with the same record format.

### `DELETE /v1/me/data`
Body: `{ "confirm": "DELETE MY DATA" }`. Enqueues the resumable `PURGE_USER_DATA` job (DATA_MODEL section 9) and, for current data sizes, runs it to completion before responding; integrations remain connected and cursors reset. Response `200`: `{ "receiptId": "…", "counts": { … } }`.

### `DELETE /v1/me`
Body: `{ "confirm": "DELETE MY ACCOUNT" }`. Revokes Google tokens (best effort at Google; stored tokens are deleted regardless), then erases everything. Response `200`: `{ "receiptId": "…" }`. The session token is invalid afterwards.

## 4. Integrations

### `GET /v1/integrations`
List with `provider`, `status` (`CONNECTED | NEEDS_REAUTH | ERROR | DISCONNECTED`), `connectedAt`, `lastSyncAt`, `lastSuccessAt`, `lastErrorCode`, `grantedScopes`.

### `DELETE /v1/integrations/:provider` (`provider` = `GMAIL` | `GOOGLE_CALENDAR`)
Query: `purge=true|false` (default `true`). Revokes the token at Google (best effort), deletes the stored token, stops syncing, resets cursors, and optionally purges derived data (DATA_MODEL section 9). Response: `{ integration, purged: { tasks, events, messages } }`.

### `POST /v1/sync/now`
Runs an inline sync for the user's connected integrations with a 20 s budget (min 2 min since last sync, else `200` with `{ "skipped": "TOO_SOON" }`). Response: `{ "partial": boolean, "counts": { … }, "nextCursorHint": "…" }`. Fails with `423 PROCESSING_PAUSED` if paused.

## 5. Tasks

`Task` DTO (list form; evidence excluded). A task is an action, preparation, deadline, or commitment; its relationships are `dependencies`:
```json
{ "id": "…", "version": 3, "title": "Complete coding assignment", "notes": null,
  "status": "OPEN", "kind": "ACTION", "direction": "REQUESTED_OF_USER", "origin": "AI", "confidence": 0.91,
  "priority": 1,
  "counterparty": { "id": "…", "role": "recruiter", "name": "Jane Doe", "organization": "Acme" },
  "due": { "at": "2026-10-07T11:00:00Z", "granularity": "TIME", "source": "EVENT_ANCHOR" },
  "effectiveDueAt": "2026-10-07T11:00:00Z",
  "dependencies": [ { "id": "…", "relation": "BEFORE_EVENT", "status": "ACTIVE",
                      "target": { "type": "EVENT", "id": "…", "title": "Acme Interview", "startAt": "2026-10-07T11:00:00Z" } } ],
  "blockedBy": [],
  "snoozedUntil": null, "completionSuggested": false,
  "sourceSummary": { "kind": "EMAIL", "receivedAt": "…" },
  "createdAt": "…", "updatedAt": "…" }
```

| Endpoint | Purpose |
|---|---|
| `GET /v1/tasks?status=&kind=&direction=&eventId=&dueBefore=&cursor=&limit=` | Paginated list (default: `OPEN`+`SUGGESTED`), sorted by `(effectiveDueAt NULLS LAST, id)` |
| `GET /v1/tasks/:id` | Detail **including `evidence[]`** (see below) |
| `POST /v1/tasks` | Create manual task: `{ title, notes?, kind?, due?: { at, granularity }, dependencies?: [{ target: { type: "EVENT"\|"TASK", id }, relation }] }` → `origin=MANUAL`, `status=OPEN` |
| `PATCH /v1/tasks/:id` | Edit `title`, `notes`, `kind`, `due` (`null` clears), `dependencies` (full replacement list; empty unlinks). Requires `If-Match`. Adds edited names to `userEditedFields`; re-plans reminders |
| `POST /v1/tasks/:id/confirm` | `SUGGESTED` to `OPEN` |
| `POST /v1/tasks/:id/complete` | to `COMPLETED` |
| `POST /v1/tasks/:id/reopen` | `COMPLETED`/`DISMISSED` to `OPEN` |
| `POST /v1/tasks/:id/dismiss` | `{ reason?: DismissReason, muteSender?: boolean }`; writes suppression; optional sender rule |
| `POST /v1/tasks/:id/snooze` | `{ until: ISO }` or `{ preset: "1h" \| "3h" \| "tomorrow_9" \| "next_monday_9" }` (presets computed in the user's timezone); `until` must be in the future and within 90 days. `POST /v1/tasks/:id/unsnooze` clears it |
| `DELETE /v1/tasks/:id` | Hard delete plus suppression; `204` |
| `POST /v1/tasks/:id/feedback` | `{ useful: boolean, note?: string(≤280) }` |

All state-change endpoints return the updated `Task`. Illegal transitions: `409 INVALID_TRANSITION`. Every mutating call is idempotent under `Idempotency-Key` (section 1).

### Task detail: evidence (the "Why" payload)
```json
{ "task": { … },
  "evidence": [ {
    "id": "…", "source": "EMAIL",
    "receivedAt": "…", "subject": "Acme interview details", "sender": "Jane Doe <jane@acme.com>",
    "counterparty": { "role": "recruiter", "name": "Jane Doe", "organization": "Acme" },
    "gmailLink": "https://mail.google.com/mail/u/0/#all/<threadId>",
    "quote": "Please complete the coding assignment before the interview.",
    "signals": [ { "ruleId": "ACTION_PHRASE", "text": "Contains an action phrase: “Please complete”" },
                 { "ruleId": "DEADLINE_PHRASE", "text": "Contains a deadline phrase: “before the interview”" },
                 { "ruleId": "SENDER_IS_PARTICIPANT", "text": "Sender is on the invite list of “Acme Interview”" } ],
    "ai": { "used": true, "provider": "gemini", "model": "…", "rationale": "The recruiter asks for the assignment to be done before the interview.",
            "inputChars": 740, "candidateEvents": 3, "batched": false, "confidenceLabel": "HIGH" },
    "link": { "rationale": "Mentions “interview” and the sender is an invitee of the Acme event." } } ] }
```
`signals[].text` is rendered server-side from the rule catalog (localizable later) so the extension never needs rule semantics. `gmailLink` is a deep link the browser opens in the user's own Gmail session; Heed never fetches it. The list of evidence for one task is small and bounded (at most 20 rows, newest first); older evidence beyond the cap is summarized by count.

## 6. Events

`Event` DTO: `{ id, source: "CALENDAR_SYNC"|"EMAIL_DETECTED"|"MANUAL", title, startAt, endAt, allDay, state, contextLevel, remindMode, counterparty?, openTaskCount, version }`.

| Endpoint | Purpose |
|---|---|
| `GET /v1/events?from=&to=&state=&cursor=&limit=` | Paginated, sorted by `(startAt, id)`; default window next 14 days; `to - from` at most 60 days |
| `GET /v1/events/:id` | One event with its dependent tasks (bounded to 50, cursor on `GET /v1/tasks?eventId=`) |
| `POST /v1/events` | Create a manual event (`source = MANUAL`) |
| `PATCH /v1/events/:id` | `remindMode` (any event) and, for `MANUAL`/`EMAIL_DETECTED` events, title and times. `CALENDAR_SYNC` events mirror Google Calendar and are otherwise read-only; Heed never writes to Google Calendar |
| `POST /v1/events/:id/confirm` · `POST /v1/events/:id/dismiss` | For `EMAIL_DETECTED` events in state `SUGGESTED` |
| `DELETE /v1/events/:id` | `MANUAL`/`EMAIL_DETECTED` only; `CALENDAR_SYNC` events cannot be deleted through Heed |

## 7. Reminders, notifications, and the sync feed

### `GET /v1/reminders?status=&from=&to=&cursor=&limit=`
Read-only, paginated by `(triggerAt, id)`. Shows what Heed plans to remind the user about and when (`{ id, kind, taskId?, eventId?, triggerAt, priority, status }`), so the UI can answer "when will Heed remind me?". Reminders are *plans*; they are not the delivery unit.

### `GET /v1/notifications?status=&cursor=&limit=`
Paginated by `(deliverAt, id)`. `Notification` DTO: `{ id, channel, status, deliverAt, title, body, actions: [{ id, label }], deepLink, payloadGeneration }`. The extension normally receives these through the sync feed; this endpoint exists for history ("Missed") and diagnostics.

### `POST /v1/notifications/ack`
`{ "acks": [ { "id": "…", "status": "DELIVERED" | "CLICKED" | "ACTIONED" | "EXPIRED", "action"?: "DONE" | "SNOOZE_1H", "at": "…" } ] }` (max 100). Idempotent per notification (a terminal state is never overwritten by an earlier-ranked one; replays are no-ops). `ACTIONED` with an `action` is applied through the same task operations as the corresponding task endpoints. Response `204`.

### `GET /v1/sync?cursor=<seq>&limit=<n>`
The extension's delta feed; **always one bounded page** (limit default 100, max 200):
```json
{ "nextCursor": "1284",
  "hasMore": true,
  "resyncRequired": false,
  "tasks":         { "upserts": [Task…], "deletedIds": ["…"] },
  "events":        { "upserts": [Event…], "deletedIds": ["…"] },
  "notifications": { "upserts": [Notification…], "deletedIds": ["…"] },
  "me": { "settings": { … }, "processing": { … }, "integrations": [ … ], "badge": { "overdue": 0, "dueSoon": 2, "toReview": 1 } },
  "pollAfterSeconds": 300,
  "serverTime": "…" }
```
- `pollAfterSeconds` is a server-provided hint for the extension's next heartbeat (default 300; the server lengthens it for idle users and shortens it around due notifications). It is a scale lever that needs no contract change; the extension treats it as a suggestion within 60 to 1,800 seconds.
- Changes are returned in `seq` order, so a client that stops after any page can resume exactly from `nextCursor`; the client loops while `hasMore`.
- Omitted/`0` cursor starts a full snapshot, also paged: tasks (non-retired), events (next 30 days), notifications (`SCHEDULED`/`SENT` within the 36-hour lookahead).
- `resyncRequired: true` if the cursor predates retained tombstones; the client discards its cache and restarts without a cursor.
- `Notification` payloads contain the **final text** composed server-side; the extension performs no composition, relevance, quiet-hours, or cap logic (ARCHITECTURE 3.2, 9).
- `me.badge` counts are computed server-side.

## 8. Sender rules

`GET /v1/sender-rules?cursor=&limit=` (paginated by `(createdAt, id)`) · `POST /v1/sender-rules` `{ kind: "MUTE"|"ALWAYS_CONSIDER", matchType: "EMAIL"|"DOMAIN", value }` · `DELETE /v1/sender-rules/:id`. Muting removes nothing retroactively but stops future processing of that sender at stage 1. `ALWAYS_CONSIDER` bypasses the stage-1 bulk-sender drop (not spam/trash).

## 9. Suppressions

`GET /v1/suppressions/count` · `DELETE /v1/suppressions` (clears all; allows previously deleted/dismissed items to be re-detected).

## 10. Internal and operational endpoints (not part of the public contract)

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /internal/tick` | Google-signed OIDC ID token from the scheduler service account; verified signature (Google JWKS), `iss`, `aud` = service URL, expiry, `email` = scheduler SA and `email_verified`; otherwise a generic `401`. Not CORS-enabled (preflights get `404`). The endpoint does not exist when no verifier is configured | Enqueue due syncs, run jobs within budget, run due purge. Stage 1 response: `{ status: "ok", handlersRun: n, processing: "enabled"\|"disabled" }`; `processing=false` (kill switch) runs no handlers |
| `GET /healthz` | none | Liveness (process up). Constant response |
| `GET /readyz` | none | DB reachable and config valid. Constant response with no details |

## 11. Limits and the beta allowlist

| Limit | Default |
|---|---|
| Unauthenticated routes (`/auth/*`) | 20 req/min/IP |
| Authenticated routes | 120 req/min/user; `sync/now` 6/hour/user; `export` 5/day |
| Request body | 64 KB maximum (the API accepts no uploads) |
| Title ≤ 140 chars; notes ≤ 2,000 chars; feedback note ≤ 280 | Enforced by Zod |
| Beta allowlist | `BETA_ALLOWED_EMAILS` (env, comma-separated, case-insensitive). Sign-in by an email not on the list fails with `NOT_ON_BETA_LIST`; this also enforces the Google 100-user cap safely. The list is configuration, not data in the extension |

## 12. Error codes (stable)

`VALIDATION_FAILED` 400 · `CURSOR_INVALID` 400 · `METHOD_NOT_ALLOWED` 405 · `PAYLOAD_TOO_LARGE` 413 · `UNSUPPORTED_MEDIA_TYPE` 415 · `CONSENT_VARIANT_STALE` 409 · `UNAUTHENTICATED` 401 · `SESSION_EXPIRED` 401 · `NOT_FOUND` 404 · `VERSION_CONFLICT` 409 · `INVALID_TRANSITION` 409 · `CLIENT_TOO_OLD` 426 · `PROCESSING_PAUSED` 423 · `RATE_LIMITED` 429 · `NOT_ON_BETA_LIST` 403 · `CONSENT_REQUIRED` 403 · `INTEGRATION_NOT_CONNECTED` 409 · `INTEGRATION_NEEDS_REAUTH` 409 · `OAUTH_STATE_INVALID` 400 · `OAUTH_ACCOUNT_MISMATCH` 400 · `OAUTH_NO_REFRESH_TOKEN` 400 · `OAUTH_REDIRECT_NOT_ALLOWED` 400 · `OAUTH_CODE_INVALID` 400 · `IDEMPOTENCY_KEY_REUSED` 422 · `INTERNAL` 500 · `UPSTREAM_UNAVAILABLE` 502.

## 13. Authorization matrix

| Route group | Requirement | Scoping |
|---|---|---|
| `/v1/auth/google/*`, `/v1/auth/token` | none (state/PKCE/ticket validated) | n/a |
| `/v1/*` (others) | valid, unexpired, unrevoked session | Every query includes `userId` from session |
| `/internal/*` | scheduler OIDC identity | n/a |

A route-registry test fails the build if a route is registered without declaring its auth class and an authorization test.
