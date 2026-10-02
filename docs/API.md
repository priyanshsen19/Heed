# Heed — API Specification (V1)

Status: Draft for sign-off. Transport: HTTPS, JSON, base path `/v1`. Request and response schemas are defined once as Zod schemas in `packages/shared` and used by both server validation and the extension client; this document is the human-readable contract. An OpenAPI document is generated from those schemas in CI and published as a build artifact.

## 1. Conventions

| Topic | Rule |
|---|---|
| Auth | `Authorization: Bearer <heed-session-token>` on all `/v1` routes except `/v1/auth/google/start`, `/v1/auth/google/callback`, `/v1/auth/token`. No cookies are used, so there is no CSRF surface on the JSON API |
| Client identity | `X-Heed-Client: extension/<semver>`. Server may return `426 Upgrade Required` (`code: CLIENT_TOO_OLD`) below `MIN_CLIENT_VERSION` |
| IDs | UUID v4 strings |
| Times | ISO 8601 UTC (`2026-10-07T11:00:00Z`) plus an IANA `timezone` field where local semantics matter |
| Concurrency | Mutable resources carry `version`; `PATCH` and state-change `POST`s require `If-Match: "<version>"`; mismatch returns `409 VERSION_CONFLICT` with the current resource |
| Idempotency | All mutating `POST`/`PATCH`/`DELETE` accept `Idempotency-Key: <uuid>` (the extension outbox always sends one). Server stores key and response for 24 h per user; replays return the original response |
| Pagination | Cursor-based: `?limit=` (default 50, max 100), response `{ items, nextCursor }` |
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
List the user's sessions (device label, created, last used, current flag), revoke one, or revoke all others. `204`/`200`.

## 3. Me, settings, privacy controls

### `GET /v1/me`
```json
{ "user": { "id": "…", "email": "…", "createdAt": "…" },
  "settings": { "timezone": "Europe/London", "quietHoursStart": 1260, "quietHoursEnd": 480,
                "notificationsEnabled": true, "dailyNotificationCap": 8, "backfillDays": 14 },
  "processing": { "paused": false, "pausedUntil": null, "silencesReminders": false },
  "consents": [ { "type": "GOOGLE_DATA_PROCESSING", "version": "2026-10-01", "grantedAt": "…" } ],
  "integrations": [ { "provider": "GMAIL", "status": "CONNECTED", "lastSuccessAt": "…", "lastErrorCode": null } ] }
```

### `PATCH /v1/me/settings`
Partial update of settings (validated ranges: `dailyNotificationCap` 1–30, `backfillDays` ∈ {7,14,30}, valid IANA timezone). Changing quiet hours or timezone enqueues `REMINDER_PLAN`. Response: updated settings.

### `POST /v1/me/consents`
`{ "type": "GOOGLE_DATA_PROCESSING" | "AI_PROCESSING", "version": "…", "granted": true|false }`. Connecting Gmail or Calendar requires a current `GOOGLE_DATA_PROCESSING` consent; extraction requires `AI_PROCESSING`. Revoking `AI_PROCESSING` stops AI calls (the funnel then yields no new tasks and deferred messages are dropped).

### `POST /v1/me/pause` · `POST /v1/me/resume`
Pause body: `{ "duration": "1h" | "1d" | "until_resumed", "silenceReminders": false }`. While paused the server makes no Gmail, Calendar, or AI calls for the user (jobs are skipped) and records `processingPausedAt`. Resume fast-forwards cursors (paused-period mail is skipped; see PRODUCT 6.1). Response: `processing` object.

### `GET /v1/me/export`
Streams `application/json` (attachment) containing: user, settings, consents, integrations (status only, never tokens), tasks, evidence (decrypted for the user), events, reminders, sender rules, suppressions count, audit log. Rate limited to 5/day.

### `DELETE /v1/me/data`
Body: `{ "confirm": "DELETE MY DATA" }`. Erases derived data (DATA_MODEL section 7); integrations remain connected and cursors reset. Response `200`: `{ "receiptId": "…", "counts": { … } }`.

### `DELETE /v1/me`
Body: `{ "confirm": "DELETE MY ACCOUNT" }`. Revokes Google tokens (best effort at Google; stored tokens are deleted regardless), then erases everything. Response `200`: `{ "receiptId": "…" }`. The session token is invalid afterwards.

## 4. Integrations

### `GET /v1/integrations`
List with `provider`, `status` (`CONNECTED | NEEDS_REAUTH | ERROR | DISCONNECTED`), `connectedAt`, `lastSyncAt`, `lastSuccessAt`, `lastErrorCode`, `grantedScopes`.

### `DELETE /v1/integrations/:provider` (`provider` = `GMAIL` | `GOOGLE_CALENDAR`)
Query: `purge=true|false` (default `true`). Revokes the token at Google (best effort), deletes the stored token, stops syncing, resets cursors, and optionally purges derived data (DATA_MODEL section 7). Response: `{ integration, purged: { tasks, events, messages } }`.

### `POST /v1/sync/now`
Runs an inline sync for the user's connected integrations with a 20 s budget (min 2 min since last sync, else `200` with `{ "skipped": "TOO_SOON" }`). Response: `{ "partial": boolean, "counts": { … }, "nextCursorHint": "…" }`. Fails with `423 PROCESSING_PAUSED` if paused.

## 5. Tasks

`Task` DTO (list form; evidence excluded):
```json
{ "id": "…", "version": 3, "title": "Complete coding assignment", "notes": null,
  "status": "OPEN", "origin": "AI", "confidence": 0.91,
  "due": { "at": "2026-10-07T11:00:00Z", "granularity": "TIME", "source": "EVENT_ANCHOR" },
  "effectiveDueAt": "2026-10-07T11:00:00Z",
  "anchor": { "eventId": "…", "relation": "BEFORE_EVENT", "status": "ACTIVE",
              "title": "Acme Interview", "startAt": "2026-10-07T11:00:00Z" },
  "snoozedUntil": null, "completionSuggested": false,
  "sourceSummary": { "kind": "EMAIL", "receivedAt": "…" },
  "createdAt": "…", "updatedAt": "…" }
```

| Endpoint | Purpose |
|---|---|
| `GET /v1/tasks?status=&anchorEventId=&dueBefore=&cursor=&limit=` | List (default: `OPEN`+`SUGGESTED`) |
| `GET /v1/tasks/:id` | Detail **including `evidence[]`** (see below) |
| `POST /v1/tasks` | Create manual task: `{ title, notes?, due?: { at, granularity }, anchor?: { eventId, relation } }` → `origin=MANUAL`, `status=OPEN` |
| `PATCH /v1/tasks/:id` | Edit `title`, `notes`, `due` (`null` clears), `anchor` (`null` unlinks). Requires `If-Match`. Adds edited names to `userEditedFields`; re-plans reminders |
| `POST /v1/tasks/:id/confirm` | `SUGGESTED` to `OPEN` |
| `POST /v1/tasks/:id/complete` | to `COMPLETED` |
| `POST /v1/tasks/:id/reopen` | `COMPLETED`/`DISMISSED` to `OPEN` |
| `POST /v1/tasks/:id/dismiss` | `{ reason?: DismissReason, muteSender?: boolean }`; writes suppression; optional sender rule |
| `POST /v1/tasks/:id/snooze` | `{ until: ISO }` or `{ preset: "1h" | "3h" | "tomorrow_9" | "next_monday_9" }` (presets computed in the user's timezone); `until` must be in the future and within 90 days. `POST /v1/tasks/:id/unsnooze` clears it |
| `DELETE /v1/tasks/:id` | Hard delete plus suppression; `204` |
| `POST /v1/tasks/:id/feedback` | `{ useful: boolean, note?: string(≤280) }` |

All state-change endpoints return the updated `Task`. Illegal transitions: `409 INVALID_TRANSITION`.

### Task detail: evidence (the "Why" payload)
```json
{ "task": { … },
  "evidence": [ {
    "id": "…", "source": "EMAIL",
    "receivedAt": "…", "subject": "Acme interview details", "sender": "Jane Doe <jane@acme.com>",
    "gmailLink": "https://mail.google.com/mail/u/0/#all/<threadId>",
    "quote": "Please complete the coding assignment before the interview.",
    "signals": [ { "ruleId": "ACTION_PHRASE", "text": "Contains an action phrase: “Please complete”" },
                 { "ruleId": "DEADLINE_PHRASE", "text": "Contains a deadline phrase: “before the interview”" },
                 { "ruleId": "SENDER_IS_PARTICIPANT", "text": "Sender is on the invite list of “Acme Interview”" } ],
    "ai": { "used": true, "provider": "gemini", "model": "…", "rationale": "The recruiter asks for the assignment to be done before the interview.",
            "inputChars": 740, "candidateEvents": 3, "confidenceLabel": "HIGH" },
    "link": { "rationale": "Mentions “interview” and the sender is an invitee of the Acme event." } } ] }
```
`signals[].text` is rendered server-side from the rule catalog (localizable later) so the extension never needs rule semantics. `gmailLink` is a deep link the browser opens in the user's own Gmail session; Heed never fetches it.

## 6. Events

`GET /v1/events?from=&to=` returns events (default next 14 days) with `openTaskCount` and `linkedTasks[]` (task DTO summaries). `GET /v1/events/:id` returns one event with all its linked tasks. Events are read-only through the API (they mirror Google Calendar).

## 7. Sync (extension delta feed)

### `GET /v1/sync?cursor=<seq>`
```json
{ "nextCursor": "1284",
  "resyncRequired": false,
  "tasks":     { "upserts": [Task…], "deletedIds": ["…"] },
  "events":    { "upserts": [Event…], "deletedIds": ["…"] },
  "reminders": { "upserts": [Reminder…], "deletedIds": ["…"] },
  "me": { "settings": { … }, "processing": { … }, "integrations": [ … ] },
  "serverTime": "…" }
```
- Omitted/`0` cursor returns a full snapshot (tasks: all non-retired; events: next 30 days; reminders: `PENDING` in next 7 days).
- `resyncRequired: true` if the cursor predates retained tombstones; the client discards its cache and calls without a cursor.
- `Reminder` DTO: `{ id, kind, taskId?, eventId?, fireAt, status, policyVersion }`. The content text is composed client-side from cached task/event data using shared templates.

### `POST /v1/reminders/ack`
`{ "acks": [ { "id": "…", "status": "DELIVERED" | "SKIPPED" | "MISSED", "at": "…" } ] }` (max 100). Idempotent per reminder (first terminal status wins). Response `204`.

## 8. Sender rules

`GET /v1/sender-rules` · `POST /v1/sender-rules` `{ kind: "MUTE"|"ALWAYS_CONSIDER", matchType: "EMAIL"|"DOMAIN", value }` · `DELETE /v1/sender-rules/:id`. Muting removes nothing retroactively but stops future processing of that sender at stage 1. `ALWAYS_CONSIDER` bypasses the stage-1 bulk-sender drop (not spam/trash).

## 9. Suppressions

`GET /v1/suppressions/count` · `DELETE /v1/suppressions` (clears all; allows previously deleted/dismissed items to be re-detected).

## 10. Internal and operational endpoints (not part of the public contract)

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /internal/tick` | Google-signed OIDC ID token from the scheduler service account; verified `aud` = service URL and `email` = scheduler SA; otherwise `401`. Not CORS-enabled | Enqueue due syncs, run jobs within budget, run due purge. Response: summary counts only |
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

`VALIDATION_FAILED` 400 · `UNAUTHENTICATED` 401 · `SESSION_EXPIRED` 401 · `NOT_FOUND` 404 · `VERSION_CONFLICT` 409 · `INVALID_TRANSITION` 409 · `CLIENT_TOO_OLD` 426 · `PROCESSING_PAUSED` 423 · `RATE_LIMITED` 429 · `NOT_ON_BETA_LIST` 403 · `CONSENT_REQUIRED` 403 · `INTEGRATION_NOT_CONNECTED` 409 · `INTEGRATION_NEEDS_REAUTH` 409 · `OAUTH_STATE_INVALID` 400 · `OAUTH_ACCOUNT_MISMATCH` 400 · `OAUTH_NO_REFRESH_TOKEN` 400 · `OAUTH_REDIRECT_NOT_ALLOWED` 400 · `OAUTH_CODE_INVALID` 400 · `IDEMPOTENCY_KEY_REUSED` 422 · `INTERNAL` 500 · `UPSTREAM_UNAVAILABLE` 502.

## 13. Authorization matrix

| Route group | Requirement | Scoping |
|---|---|---|
| `/v1/auth/google/*`, `/v1/auth/token` | none (state/PKCE/ticket validated) | n/a |
| `/v1/*` (others) | valid, unexpired, unrevoked session | Every query includes `userId` from session |
| `/internal/*` | scheduler OIDC identity | n/a |

A route-registry test fails the build if a route is registered without declaring its auth class and an authorization test.
