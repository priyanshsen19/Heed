# Stage 1 notes: production foundation

Date: 2026-10-02 · Branch: `claude/wonderful-babbage-54noe1` · Authoritative docs: `docs/*` (Stage 0).

## 1. Status in one paragraph

The production foundation is **built and verified locally**: a strict TypeScript monorepo, an enforced module
boundary, a stateless API that fails closed, a Chrome extension that loads in real Chromium with no credentials,
a bundle secret scan, a verified non-root production container, CI, and the infrastructure files. **One Definition
of Done item is blocked and is not claimed:** the deployment to a real Cloud Run staging service, because this
build environment has no usable Google Cloud identity (see section 5). Nothing from later stages was
implemented: no Gmail, Calendar, Gemini, tasks, reminders, database, or authentication.

## 2. Initial assessment (before any change)

| | |
|---|---|
| Existing foundation | The 10 Stage 0 documents only. No code, `package.json`, workspace, TypeScript config, tests, workflows, Docker or infra files. Nothing to preserve or overwrite. |
| Missing | Everything in the Stage 1 scope. |
| Conflicts found | (1) ARCHITECTURE described `packages/config` as tooling configs; the Stage 1 brief defines it as Zod environment validation. The brief wins (D-28). (2) The sandbox has Node 22 but the docs say "current Active LTS"; that is Node 24 on this date, so 24 was installed and pinned. (3) No Google Cloud credentials exist, so the staging deploy cannot be executed here. |
| Files that had to change | `docs/IMPLEMENTATION_PLAN.md`, `docs/DECISIONS.md` (D-28), and small alignments in `API.md`, `ARCHITECTURE.md`, `SECURITY.md`. |

## 3. What was implemented

**Root.** pnpm workspace; Node 24.21 pinned; strict TypeScript base (`noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `verbatimModuleSyntax`, ...); ESLint flat config that enforces architecture
(no `any`, no `process.env` outside `main.ts`, no `setInterval`, no raw `Date`, no module-level mutable state, no
test doubles in production code); Prettier; dependency-cruiser boundary rules; `.gitignore`/`.dockerignore`;
README with the allowed dependency directions.

**`packages/shared`** (browser-safe, zod only): `Clock`/`SystemClock` (and `FakeClock` under `/testing`),
problem+json contract and error codes, cursor-pagination contract (no OFFSET), sync-feed scaffold, request-id
rules, health contracts, public configuration schema (`VITE_API_BASE_URL`, `VITE_ENV`).

**`packages/config`** (server-only): fail-closed `loadServerConfig` (rejects wildcard CORS, requires explicit
chrome-extension origins, `SERVICE_URL` and `SCHEDULER_SA_EMAIL` outside local/test; never echoes values),
runtime-secret schema (single JSON document), `SecretsProvider` + `JsonSecretsProvider`, random secret generator.

**`apps/api`**: `buildApp`/`createApp`/`startServer` separated; `GET /healthz` (no dependencies) and
`GET /readyz` (constant body, draining-aware); problem+json errors with no stack/SQL/path leakage; request-id
generate/propagate/validate; two-layer log scrubbing; CORS (exact origins, no `*`, no credentials); security
headers; `RateLimiter` port (fails closed, guard test); OIDC-verified `POST /internal/tick` (authenticated no-op:
no handlers yet); `main.ts` as the single environment reader with graceful SIGTERM drain; esbuild bundle.

**`apps/extension`**: typed manifest generator (`storage` + `sidePanel` only, host permission = API origin only,
no content scripts/externally_connectable/web_accessible_resources, strict CSP); module service worker that
registers listeners synchronously, uses no `setInterval`, and validates messages; typed storage guard (exact Heed
session-token format; Google tokens cannot be stored); API client (versioned paths only, Bearer, no cookies, no
redirects, typed problem errors); alarm dispatcher (inert until the `alarms` permission is added); popup, side
panel and options page with real loading, empty and error states and no fake data; build that fails closed on bad
public configuration.

**`scripts`**: `bundle-scan.ts` (+ fixtures), `docker-smoke.sh`, `gen-local-secrets.ts`, boundary tests,
repository policy tests.

**`infra`**: production `Dockerfile` (distroless Node 24, uid 65532, digests pinned), Cloud Run service YAML
(min 0 / max 2, request-based CPU, runtime secret injected), idempotent bootstrap script (APIs, Artifact Registry,
service accounts, one runtime secret, least-privilege IAM, Workload Identity Federation), scheduler-job script.

**CI/CD**: `ci.yml` (all required gates, no secrets, read-only token), manual `deploy-api-staging.yml`
(Workload Identity Federation, inert until configured), Dependabot (npm, Actions, Docker), CODEOWNERS.

## 4. Tests

| Suite | Tests | Passed | Failed | Skipped |
|---|---|---|---|---|
| `@heed/config` | 20 | 20 | 0 | 0 |
| `@heed/shared` | 17 | 17 | 0 | 0 |
| `@heed/api` | 125 | 125 | 0 | 0 |
| `@heed/extension` (unit, component, real builds) | 67 | 67 | 0 | 0 |
| `@heed/scripts` (bundle scan 20, boundaries 12, repository policy 20) | 52 | 52 | 0 | 0 |
| **Unit/integration total** | **281** | **281** | **0** | **0** |
| Extension in real Chromium 141 (`pnpm --filter @heed/extension test:e2e`) | 11 | 11 | 0 | 0 |
| Docker smoke (`scripts/docker-smoke.sh`, ~12 assertions) | 1 script | pass | 0 | 0 |

Also green: Prettier check, ESLint, `tsc` strict for all five workspaces, dependency-cruiser (111 modules, 245
dependencies, 0 violations).

**Tests that prove the key properties:** log canary (fails when the scrubber is disabled; proven by mutation);
config tests (missing, malformed, valid; wildcard CORS rejected in every environment); API tests (health, readiness,
error format, request id, CORS allowed/disallowed/missing/preflight, security headers, OIDC rejection matrix incl.
`alg:none` and HS256 forgery, statelessness across 10 instances and two real servers, process-level fail-closed);
extension tests (manifest permissions, CSP, storage guard, service-worker bootstrap, UI states, build contents);
boundary tests (extension importing API/config/Node built-ins/server libraries, server importing extension, shared
not a leaf, cycles, test doubles in production); bundle scan (committed safe fixture passes; every secret rule
fails on a runtime-assembled planted secret; server variable names fail); repository policy tests (verified by
mutation: unpinned action, secret in CI, root container, missing CODEOWNERS entry).

**Defects found by the tests during this stage** (all fixed): preflight to `/internal/*` was answered by the CORS
scope's wildcard `OPTIONS` route; the extension's own token guard contained a secret-prefix literal that the
bundle scan rightly flagged; the documented `pnpm dev:api` command had its arguments in the wrong order; a JWT-shaped
test string would trip a secret scanner; several lint findings (React effect pattern, unnecessary assertions).

## 5. Deployment: BLOCKED (exact blocker)

I could not deploy to staging. Evidence: `gcloud projects list` fails with `UNAUTHENTICATED ... CREDENTIALS_MISSING`
(the only credential is a placeholder `CLOUDSDK_AUTH_ACCESS_TOKEN`), `gcloud config get-value project` is unset, and
`gcloud auth list` shows no accounts. I did not look for another way to obtain credentials. Creating cloud
resources also needs a project and billing account that you designate.

**Not done, and therefore not claimed:** staging URL, HTTPS health/readiness against Cloud Run, Cloud Run cold-start
and latency measurements, memory/CPU behavior on Cloud Run, runtime-secret injection test on the platform, the
Cloud Scheduler job.

**Prepared so that it is a few commands:** `infra/scripts/bootstrap-staging.sh`, `infra/cloudrun/service.staging.yaml`,
`.github/workflows/deploy-api-staging.yml`, `infra/scripts/create-tick-job.sh`, `infra/README.md`.

**To finish this item (owner action):** provide a GCP project with billing (OC-3), run the bootstrap script, set the
printed GitHub environment variables, and run the "Deploy API (staging)" workflow (or give me a project and a
credential path and I will do it). The deploy workflow smoke-tests `/healthz` and `/readyz` over HTTPS and prints
latency.

## 6. Measurements (LOCAL, from the built image; not Cloud Run)

| Metric | Value | Notes |
|---|---|---|
| Image size | 156,773,016 bytes (about 149.5 MiB) | distroless Node 24 base (about 146 MB) + 2.2 MB bundle |
| Bundle | 2,309,700 bytes | fastify, pino, zod, jose, workspace packages |
| `docker run` to first healthy `/healthz` | about 1.0 to 1.3 s | includes container creation on this machine; **not** a Cloud Run cold start |
| Memory | 36.5 MiB idle; 50.3 MiB after 600 requests | Cloud Run limit is 512 MiB; 256 MiB would suffice (not changed yet) |
| CPU | 0.00% idle; 0.03% after load | |
| Latency (loopback, 300 sequential requests each) | `/healthz` p50 0.7 ms, p95 1.3 ms, p99 1.8 ms; `/readyz` p50 0.7 ms, p95 1.1 ms, p99 1.6 ms | not representative of network or Cloud Run |
| Docker build | about 45 s from cold cache | with an extra-CA build secret in this sandbox |

These do not change any architectural assumption in DECISIONS (the 512 MiB and request-based-CPU choices are
comfortably within limits). Cloud Run cold start and p95 must still be measured on first deploy.

## 7. Security checks

| Check | Result |
|---|---|
| Extension bundle scan (real build) | OK: 11 files, 19 variable names and 8 secret patterns checked, 0 findings; scanner proven to fail on planted secrets and on an empty/missing bundle |
| Dependency boundaries | OK: 0 violations across 111 modules; 12 fixture tests prove violations fail (exit code as CI sees it) |
| Log canary | OK: 3 tests; fails with a named leak when the scrubber is disabled |
| Repository secret-shape scan | 0 matches over all 141 non-ignored files (one JWT-shaped test string was found and rewritten); `.secrets.local.json` is untracked and ignored. **No dedicated scanner (gitleaks) or GitHub secret scanning is wired in yet** (Stage 14) |
| Extension manifest | `storage`, `sidePanel`; host permission = API origin only; no content scripts, externally_connectable, web_accessible_resources; CSP without unsafe-eval/unsafe-inline; verified both in code and by Chrome loading it |
| Extension from a hostile web page | unreachable (`chrome.runtime.sendMessage` is not exposed to a normal web page) |
| Container | non-root (65532), read-only root FS, all capabilities dropped, no-new-privileges, no secrets in metadata or history, only `main.cjs` in `/app` |

## 8. Known issues and limits

1. **Staging not deployed** (section 5). `/healthz` reachability through Cloud Run's front end is unverified.
2. **GitHub Actions has not run.** I cannot execute Actions here. The workflow files are parsed and policy-checked
   locally, and every step they run was run locally (the Docker job needed `HEED_DOCKER_NETWORK=host` and a CA build
   secret in this sandbox only). Expect to fix small CI-environment differences on the first real run.
3. Actions are pinned to the commit SHAs that the `v4`/`v2` tags pointed at on 2026-10-02 (fetched from the real tag
   refs); Dependabot will propose newer majors.
4. The extension has no icons (Chrome shows its default) and no pinned `key`, so its id changes per load path.
   A stable id is needed for the staging CORS origin and OAuth redirect (Stage 3, spike B).
5. `RateLimiter` has no implementation (by design until Stage 2); no route uses it yet.
6. `/readyz` currently checks only the runtime secrets; the database check arrives in Stage 2.
7. The API bundle is 2.2 MB (esbuild warns); acceptable, and it is the whole runtime.
8. No Tailwind/Radix yet (deferred to Stage 11); the UI uses a small CSS file.
9. Dependency versions are current as of today and newer than I could verify from memory (TypeScript 6.0.x because of
   typescript-eslint's range; Vite 8; Zod 4; Vitest 5; ESLint 10); they all pass, but expect churn.

## 9. Deviations from the documents (none hidden)

| Deviation | Reason |
|---|---|
| `packages/config` = runtime configuration, not tooling configs | Stage 1 brief; recorded in D-28 and ARCHITECTURE |
| Extension requests only `storage` and `sidePanel` (ARCHITECTURE lists five permissions) | minimum permissions; `identity`, `alarms`, `notifications` arrive with the stages that use them |
| Runtime secrets via an env-provided JSON document, not a Secret Manager client | Cloud Run injects the secret at start; no extra dependency; same single-secret design as D-11 |
| `POST /internal/tick` exists (guarded no-op) | the brief asked for the trust path to be provable; it runs no handlers |
| Three additive error codes in API.md | transport-level errors (405, 413, 415) had no documented code |
| Tailwind and Radix deferred | no UI beyond empty states yet |
| Stage 1 secret schema requires only data keys and pepper | other secrets belong to later stages and are optional until then |
| Staging deployment not performed | no credentials (section 5) |

## 10. Next stage

**Stage 2: Database** (docs/IMPLEMENTATION_PLAN.md). Not started; waiting for approval. Before or alongside it, the
staging deployment above should be completed so that Stage 2's database readiness check and Neon measurements are
exercised against the real platform.
