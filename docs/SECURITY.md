# Heed — Security Model (V1)

Status: Draft for sign-off. Owner: principal engineer. Applies to the extension, API, database, CI/CD, and operations. Privacy commitments live in PRIVACY.md; AI-specific abuse controls in AI.md section 8; rationale in DECISIONS D-10.

## 1. Security objectives

1. Compromise of the **extension package, a user's browser profile, or a stolen Heed session token** must never expose Google tokens, API keys, secrets, or other users' data.
2. Compromise of the **database alone** must not expose Google refresh tokens or email-derived text (field-level encryption with a key held outside the database).
3. A **malicious email** must not be able to cause any action, exfiltrate data, or silently corrupt a user's task list (AI.md section 8).
4. Every user can **revoke access and erase data** and can verify what Heed holds.
5. Secrets never appear in the repository, container images, client bundles, logs, or CI output.

Out of scope for V1: nation-state adversaries, a fully compromised user device (malware running as the user), and a compromised Google account.

## 2. Assets and trust boundaries

| Asset | Sensitivity | Where |
|---|---|---|
| Google refresh tokens | Critical | Postgres (AES-GCM encrypted), server memory briefly |
| Google access tokens | High | Server memory only (cached, at most 55 min) |
| Encryption key (`DATA_KEY`) and HMAC pepper | Critical | Secret Manager, server memory |
| Google OAuth client secret | Critical | Secret Manager |
| Gemini API key | High | Secret Manager |
| DB credentials | Critical | Secret Manager |
| Email-derived text (quotes, subjects, senders) | High | Postgres (encrypted columns); transient server memory; transient redacted excerpt to AI provider |
| Tasks, events (titles, times) | Medium | Postgres plaintext columns; extension local cache |
| Heed session token | High | Extension `chrome.storage.local`; SHA-256 hash in Postgres |

```
 ┌────────────────────┐   TB1: TLS + bearer session   ┌─────────────────────────────┐  TB3: TLS, OAuth tokens   ┌───────────────┐
 │ Extension (UNTRUSTED│──────────────────────────────▶│ Heed API (TRUSTED, holds    │──────────────────────────▶│ Google APIs   │
 │ client; local cache │◀──────────────────────────────│ secrets)                    │◀──────────────────────────│ (Gmail, Cal)  │
 │ + session token)    │                               │                             │   TB4: TLS, API key,      ├───────────────┤
 └────────────────────┘                                │                             │   minimized excerpt       │ Gemini API    │
        ▲                                              │                             │──────────────────────────▶│ (subprocessor)│
   TB0: user's device                                  └──────┬──────────────┬───────┘                           └───────────────┘
   (browser profile,                                   TB2: TLS + creds│              │ GCP IAM
    other extensions, web pages)                                ┌──────▼──────┐ ┌─────▼────────┐
                                                                │ Neon Postgres│ │Secret Manager│
                                                                └─────────────┘ └──────────────┘
 Scheduler ──(TB5: OIDC ID token)──▶ /internal/tick
```

Boundary rules: TB1 carries only Heed-scoped credentials and user-visible data. Nothing that grants Google, AI, or database access ever crosses TB1. TB0 is treated as hostile: web pages cannot reach the extension (no content scripts, no `externally_connectable`).

## 3. Secrets inventory and the extension invariant

| Secret | Lives in | Never in |
|---|---|---|
| `GOOGLE_CLIENT_ID` (public identifier) | Server config; may appear in the OAuth URL | n/a (not secret) |
| `GOOGLE_CLIENT_SECRET` | Secret Manager | Extension, repo, image layers, logs |
| `GEMINI_API_KEY` | Secret Manager | Extension, repo, logs |
| `DATABASE_URL`, `DIRECT_URL` | Secret Manager | Extension, repo, logs |
| `DATA_KEY_<id>`, `HMAC_PEPPER` | Secret Manager | Extension, DB, repo, logs |
| Google refresh/access tokens | DB (encrypted refresh), server memory | Extension (any form), logs, API responses, export file |
| `SCHEDULER_SA_EMAIL`, `SERVICE_URL` (OIDC audience) | Server config | n/a (identifiers) |
| `BETA_ALLOWED_EMAILS` | Server config | Extension |

**Enforced invariant ("the extension must never contain…"):**
1. *Architectural:* the only extension network peer is the Heed API; the extension has no code path that calls Google or Gemini; Google tokens never cross TB1.
2. *Static:* eslint `no-restricted-imports` plus dependency-cruiser forbid `apps/extension` from importing server packages; the server config schema (the list of env var names) is a separate module the extension cannot import.
3. *Build-time scan (CI gate):* the built `dist/` is scanned for secret shapes (`AIza…`, `GOCSPX-`, `client_secret`, `postgres://`, PEM headers, refresh-token shape `1//…`) and for every env-var name defined in the server config schema; any hit fails the build and the release workflow.
4. *Review:* `apps/extension/manifest.config.ts` and `vite.config.ts` are CODEOWNERS-protected; only `VITE_`-prefixed public variables may be embedded, and the only ones defined are `VITE_API_BASE_URL` and `VITE_ENV`.

The Heed session token the extension *does* hold is a Heed-scoped, revocable, opaque credential (section 6), not a Google token and not a bearer of any Google capability. Even so it is treated as sensitive. (It is functionally a long-lived session credential; the requirement "no refresh tokens in the extension" is read as "no Google refresh tokens or anything that can mint Google access". See DECISIONS D-04 and unresolved #4.)

## 4. Threat model (STRIDE-oriented)

| # | Threat | Vector | Mitigations |
|---|---|---|---|
| T1 | Secret exposure via extension package | Unzipping the `.crx`; DevTools | Invariant in section 3; no secrets exist client-side |
| T2 | Session token theft from the browser profile | Malware, shared machine, malicious other extension (cannot read our storage) | Opaque token, server-side revocation, idle (30 d) and absolute (90 d) expiry, device list with "revoke others", sign-out clears storage, no Google capability in token, rate limits |
| T3 | OAuth CSRF / code injection | Forged callback | Server-side `state` bound to `AuthTransaction`, PKCE on both legs, `nonce` in ID token, single-use transactions with 10 min TTL |
| T4 | Open redirect / token leakage via redirect | Manipulated `ext_redirect` | Exact-match allowlist of `https://<extension-id>.chromiumapp.org/…`; no wildcard; any mismatch renders an error page (never redirects) |
| T5 | Authorization code interception (heed_code) | Observing redirect URL | Code is single-use, 60 s, stored hashed, and bound to the extension's PKCE verifier (which never leaves the extension) |
| T6 | Account confusion on connect | Connecting someone else's Google account to my Heed user | Connect requires a connect-ticket (60 s, single use, bound to the session user); the callback verifies `sub` equals the signed-in Heed user's `googleSub` for `CONNECT_*` (mismatch: `OAUTH_ACCOUNT_MISMATCH`) |
| T7 | IDOR / cross-tenant access | Guessing UUIDs | `userId` from the session in every query; 404 for foreign resources; mandatory authz tests per route; route-registry check |
| T8 | Injection (SQL, command) | Inputs | Prisma parameterization only (raw SQL only for the fixed `FOR UPDATE SKIP LOCKED` and `changeSeq` statements, parameterized); Zod validation; no shell exec; no dynamic `require` |
| T9 | XSS in extension UI | Malicious email text rendered | React escaping; no `dangerouslySetInnerHTML` (lint-banned); only plain-text quotes rendered as text nodes; MV3 CSP without `unsafe-inline`/`eval`; no HTML ever persisted |
| T10 | Prompt injection | Crafted email | AI.md section 8 |
| T11 | SSRF | Server fetching attacker URLs | The server fetches only fixed hosts (Google endpoints, Gemini); no URL from user or email is ever fetched; email URLs are redacted before AI |
| T12 | DB-only compromise (leaked connection string, backup) | Credential leak | Refresh tokens and email-derived text are AES-GCM encrypted with a key that exists only in Secret Manager and runtime memory; AAD binds ciphertext to table, column, and user |
| T13 | Runtime compromise (RCE in API) | Dependency or code bug | Least-privilege service account, minimal container, non-root, read-only FS, dependency scanning, no secrets beyond what the service needs, rapid secret rotation runbook, small user base. Residual: attacker with runtime can decrypt tokens; mitigated by instant revoke-all-tokens runbook (section 14) and Google's per-grant revocation |
| T14 | Extension supply chain (malicious update) | Compromised developer account or dependency | Web Store developer account with hardware-key 2FA; GitHub 2FA and branch protection; lockfile with integrity hashes; Dependabot; actions pinned by SHA; CI-built artifacts only; release provenance noted in checksums; minimal dependency policy for the extension |
| T15 | CI/CD compromise | Malicious PR / leaked token | Workload Identity Federation (no long-lived cloud keys); `permissions:` least privilege; no secrets exposed to fork PRs (`pull_request` not `pull_request_target`); environments with required reviewers for prod deploy; secret scanning and push protection |
| T16 | Log leakage | Verbose logs | pino redaction list; log canary tests; no bodies/subjects/addresses/tokens ever passed to the logger by convention and lint rule; 30-day log retention |
| T17 | Denial of service / cost abuse | Flooding API, forcing AI use | Rate limits; per-user and global AI budgets; Cloud Run `max-instances=2`; budget alert; beta allowlist; kill switch |
| T18 | Replay of mutations | Re-sent requests | Idempotency keys; `If-Match` versions; state-machine validation |
| T19 | Reminder spoofing | Fake notifications | Reminders carry only IDs; text is composed locally from authenticated, cached data |
| T20 | Insecure deletion / data remanence | Backups, caches | Deletion semantics (DATA_MODEL 7); local store cleared on sign-out; provider PITR window (6 h) disclosed |
| T21 | Scheduler endpoint abuse | Calling `/internal/tick` | OIDC token verification (issuer, audience, SA email, expiry); idempotent and budget-bounded work; not CORS-enabled |
| T22 | Phishing via the OAuth consent | Lookalike Heed | Fixed redirect allowlist; distinct consent screen; documented beta distribution channel |

## 5. OAuth security details

- Client type: **Web application** (client secret held server-side). Authorized redirect URIs: exactly the API's `/v1/auth/google/callback` for each environment.
- Requests: `response_type=code`, `code_challenge_method=S256`, `state`, `nonce`, `access_type=offline`, `prompt=consent` on connect flows, `login_hint` when known, **least scopes per intent** (API.md section 2). No `include_granted_scopes` (independent grants).
- Code exchange only on the server; ID token verified (JWKS signature, `iss`, `aud`, `exp`, `nonce`, `email_verified=true`).
- Publishing status: **In production, unverified** (not "Testing", because Testing mode expires refresh tokens after 7 days). Consequences: the unverified-app warning screen, and a hard cap of 100 users, which the beta allowlist enforces well below. Moving beyond the beta requires Google verification, including a third-party security assessment for the restricted Gmail scope (DECISIONS D-14).
- Refresh handling: access tokens are minted on demand and cached in memory; on `invalid_grant` the integration moves to `NEEDS_REAUTH` and the stored token is deleted; tokens are never returned by any API.
- Disconnect: call Google's revoke endpoint for the stored token (best effort), delete the ciphertext, reset cursors. Whether revoking one integration's token affects another's is verified in the Phase 0 spike; if it does, disconnect falls back to "delete our stored token and ask the user to remove access at their Google Account permissions page" (DECISIONS unresolved #3).

## 6. Heed session security

- Token: 32 random bytes from a CSPRNG, base64url; only `SHA-256(token)` stored; constant-time comparison via hash lookup on a unique index.
- Lifetime: 30-day sliding idle expiry (updated at most once per hour to limit writes), 90-day absolute expiry; revocable per session, all others, or all.
- Storage in the extension: `chrome.storage.local` only (not `localStorage`, not page-accessible). Not logged. Cleared on logout, on `401 SESSION_EXPIRED`, and on delete-account.
- Transport: `Authorization` header over TLS only; never placed in URLs. The only credential ever in a URL is the single-use, 60 s, PKCE-bound `heed_code`.
- Rotation: not in V1 (revocation plus expiry suffice at this scale); token rotation on refresh is a V2 hardening item.
- Authorization: stateless handlers; user context loaded from the session row on every request (no cached authorization).

## 7. Cryptography and key management

| Topic | Design |
|---|---|
| Field encryption | AES-256-GCM via Node `crypto`, 96-bit random nonce per encryption, AAD = `"{table}.{column}:{userId}"`, envelope `version|keyId|nonce|ciphertext|tag` |
| Keys | 32-byte keys generated offline (`openssl rand`), stored in Secret Manager as `DATA_KEY_1`, `DATA_KEY_2`, …; `ACTIVE_DATA_KEY_ID` env selects the writer; all known IDs can read |
| Rotation | Add key N+1, set active, run re-encrypt script (idempotent, batch), then retire N. Runbook in `infra/README.md`. Recommended every 12 months or after any suspected exposure |
| HMAC pepper | `HMAC_PEPPER` (32 bytes), separate secret, used for participant email hashes and fingerprints. Rotation requires recomputing hashes (one-time migration job) |
| Randomness | `crypto.randomBytes` only |
| Passwords | None exist (Google sign-in only) |
| TLS | Managed by Cloud Run (TLS 1.2+) and Neon (`sslmode=require`) |
| Future | Cloud KMS envelope encryption (wrapping data keys) is a V2 option: it adds per-use audit logs and no key material in env |

## 8. Chrome extension hardening

- Minimal permissions (ARCHITECTURE 3.1); host permission limited to the API origin; no content scripts; no remote code; MV3 default CSP.
- No `eval`, `new Function`, dynamic script injection; build has no inline scripts.
- Messaging: `runtime.onMessage` handlers verify `sender.id === chrome.runtime.id` and validate payloads with the shared Zod schemas. No `externally_connectable` (no messages from web pages or other extensions).
- `chrome.identity.launchWebAuthFlow` with `interactive: true` only; the redirect URL is checked against the expected `chromiumapp.org` URL and `state` before using the code.
- Notification content is composed from local authenticated data, never from raw email HTML.
- Local data minimization: no evidence ciphertext, hashes, or fingerprints are cached; evidence is fetched on demand and held in memory while the Why panel is open.
- Update hygiene: Web Store auto-update; the extension reads `MIN_CLIENT_VERSION` responses to prompt users to update.
- Distribution: Chrome Web Store *unlisted* listing with a clear privacy policy and accurate permission justifications (reviewed against the Web Store "Limited Use" requirements).

## 9. API and backend hardening

- **Authz:** every query scoped by session `userId`; foreign IDs return 404; route-registry test enforces an auth class and an authz test per route.
- **Validation:** Zod on all inputs, strict objects; body limit 64 KB; strict content-type; response serialization by schema (no accidental field leaks such as `refreshTokenEnc`, `tokenHash`, `fingerprint`, `participantHashes`, which are excluded in a single serialization layer and covered by a test).
- **Rate limiting:** per-IP for unauthenticated routes and per-user for authenticated ones (API.md section 11). In-memory counters are acceptable with `max-instances=2` (a documented approximation); Postgres-backed counters are the upgrade path.
- **HTTP hardening:** HSTS; `X-Content-Type-Options: nosniff`; error HTML pages (OAuth failures) are static with CSP `default-src 'none'`; `Cache-Control: no-store` on auth and data responses; no wildcard CORS; no stack traces in responses.
- **Dependencies:** minimal; `pnpm audit`/OSV scan in CI; Dependabot; lockfile with integrity; Node base image pinned by digest and rebuilt weekly.
- **Container:** multi-stage build, non-root user, no shell in the final image where feasible, read-only root FS, only the port exposed.
- **Config:** env parsed by Zod at boot; missing or malformed required config aborts startup (fail closed). The AI data-tier guard (AI.md section 5) is part of this.
- **IAM (least privilege):**
  - *Runtime SA:* `secretmanager.secretAccessor` on the specific secrets only; no project-wide roles.
  - *Scheduler SA:* `run.invoker` on the service only.
  - *Deploy identity (GitHub OIDC via WIF):* deploy to Cloud Run and act as the runtime SA, restricted to this repository and the `main`/tag refs; prod deploys use a GitHub Environment with required reviewers.
  - No user-managed service account keys exist anywhere.
- **Network:** Cloud Run ingress is public (the extension must reach it); abuse controls are application-level. Neon allows only TLS connections; credentials are rotated via the runbook.

## 10. Data protection

- Minimization first: bodies never persisted; evidence at most 300 chars; descriptions and attendee lists never persisted.
- Encryption: field-level for tokens and email-derived text; provider-level at rest for everything; TLS in transit everywhere.
- Backups: no custom backups in V1; Neon PITR (6 h window on the free plan). Deleted data can persist in provider history for up to that window.
- Logs: no content (section 4, T16); `AuditLog` records security events without content; retention per DATA_MODEL section 6.
- Exports contain decrypted evidence only for the authenticated owner and exclude tokens, hashes, and fingerprints.

## 11. Compliance posture: Google API Services User Data Policy (Limited Use)

Gmail restricted-scope data is handled to comply with the Limited Use requirements:

1. **Use only to provide user-facing features** (detecting and reminding about tasks). No advertising, no data brokering, no creditworthiness or similar uses.
2. **No transfer to third parties** except as necessary to provide those features (the AI provider as a subprocessor receiving a redacted excerpt), for security/abuse, or legal compliance.
3. **No human reading** of user data except with the user's explicit consent for specific messages, for security investigation, or legal requirement. Developers have no admin UI to read evidence; database access is break-glass only and logged.
4. **No use to develop, improve, or train generalized AI/ML models.** This is why the AI provider must be on terms that prohibit training on submitted data (the paid-tier guard, AI.md section 5). Heed itself performs no training or fine-tuning.
5. **Disclosure:** the privacy policy and in-product consent describe exactly the above (PRIVACY.md).

Chrome Web Store User Data Policy: single-purpose extension, limited-use certification in the listing, accurate permission justifications, privacy policy link.

## 12. Logging and monitoring

- Structured JSON logs with request ID, route, status, latency, opaque user ID; **never** subject, sender, body, quote, tokens, auth header.
- Alerts: error-rate spike, tick missing for 45 minutes, repeated auth failures from one IP, AI budget exhaustion, Neon compute nearing monthly limit, billing budget at $1.
- Audit events: sign-in, connect, disconnect, pause/resume, export, delete data, session revoke.
- Break-glass DB access: via Neon console with the owner's account (2FA); each use recorded in an operations log (`docs/` changelog or private issue) and disclosed to affected users if it touches their data.

## 13. Secure development lifecycle

- PR review required; CODEOWNERS on security-critical paths (`modules/auth`, `crypto`, `docs/SECURITY.md`, manifest and Vite config).
- CI gates: lint, typecheck, unit and integration tests, authz suite, privacy-invariant tests, bundle scan, CodeQL, gitleaks, dependency audit.
- Pre-beta checklist (section 15) must be fully checked and recorded in the repo.
- Threat model review whenever a new integration, permission, endpoint class, or AI capability is added.
- Security issues: `SECURITY.md` at the repo root (short, generated from this document) directs reports to a private channel.

## 14. Incident response (beta scale)

| Scenario | Immediate actions |
|---|---|
| Suspected token-store exposure | Set `PROCESSING_ENABLED=false`; rotate `DATA_KEY` and `HMAC_PEPPER`; revoke all Google tokens for all users by running the `revoke-all` admin script (users must reconnect); rotate Google client secret; revoke all sessions; notify users |
| Leaked secret in repo/CI | Rotate immediately, purge from history if feasible, review audit logs, notify if user data could have been affected |
| Malicious extension release | Pull the Web Store listing, publish a clean version, invalidate all sessions server-side, notify users |
| Bug exposing another user's data | Kill switch, patch, determine scope from request logs (IDs only), notify affected users |
| Gemini key abuse or leak | Rotate key, review billing, tighten caps |

Target: notify affected beta users within 72 hours of confirming a breach affecting their data. A short post-incident note is added to the repo.

## 15. Pre-beta security release gates (all required)

- [ ] Bundle scan passes on the production build; manual unzip review of the store package.
- [ ] Authz suite covers every route; cross-tenant tests pass.
- [ ] OAuth: state, PKCE, nonce, redirect allowlist, ticket and account-mismatch tests pass; redirect allowlist contains only the production and staging extension IDs.
- [ ] Encrypted columns verified as ciphertext in a staging DB dump; key rotation drill done once.
- [ ] Log canary test passes; manual review of a staging log sample.
- [ ] Disconnect and delete flows verified end to end (including Google revocation and a "no rows remain" query for a deleted user).
- [ ] AI tier guard verified (`AI_DATA_TIER=paid` in prod, or free-tier override consciously accepted and consent text switched).
- [ ] Phase 0 spikes complete: independent revoke semantics; unverified-app production refresh-token behavior; `launchWebAuthFlow` on the target Chrome versions.
- [ ] Secrets scanning and push protection on; branch protection on `main`; 2FA on GitHub, GCP, Neon, Web Store.
- [ ] ZAP baseline run against staging with no high findings.
- [ ] Incident runbooks dry-run (kill switch, revoke-all, secret rotation).

## 16. Residual risks (accepted for V1)

| Risk | Why accepted | Revisit when |
|---|---|---|
| Session token is long-lived in extension storage | Revocable and Heed-scoped; needed for UX (no re-login every browser restart) | Rotation on refresh in V2 |
| Runtime compromise can decrypt tokens | Single-operator beta, ten users, instant revoke-all runbook | KMS envelope, separate token-service in V2 |
| In-memory rate limits per instance | `max-instances=2`; low traffic | More users |
| Unverified Google app warning and the 100-user cap | Beta scope; allowlist enforced | Verification and security assessment before wider launch |
| Provider-retained history up to 6 h after deletion | Free-plan limit; disclosed | Paid DB plan |
| Gemini retains data per its abuse-monitoring terms | Vendor terms; disclosed; minimized and redacted input | Alternative provider or Vertex AI with stricter terms |
