# Heed

Heed understands what you need to do across your email and calendar, connects each action to the events and
deadlines it depends on, and reminds you when the reminder is actually useful.

This repository is at **Stage 1: production foundation** (see `docs/IMPLEMENTATION_PLAN.md`). It contains an
empty-but-production-shaped API and Chrome extension. There are no Gmail, Calendar, AI, task, or reminder
features yet, and nothing fakes them.

Authoritative design: `docs/` (start with `ARCHITECTURE.md`, `DECISIONS.md`, `SECURITY.md`).

## Layout

```
apps/api          Fastify API (stateless; one process entry point: src/main.ts)
apps/extension    Chrome Manifest V3 extension (React, Vite): a thin client with no secrets
packages/shared   Browser-safe contracts: Zod DTOs, error/pagination/sync contracts, Clock, public config
packages/config   SERVER-ONLY: fail-closed env config, runtime-secret schema, SecretsProvider
scripts           Operational tooling: extension bundle secret scan, Docker smoke test, boundary tests
infra             Dockerfile, Cloud Run service definition, one-time bootstrap scripts
docs              Architecture, security, privacy, data model, API, decisions, stage notes
```

### Allowed dependency directions (enforced in CI by dependency-cruiser)

```
apps/extension  -> packages/shared                         (+ npm: react, react-dom, zod)
apps/api        -> packages/shared, packages/config
packages/config -> packages/shared                         (never reachable from the extension)
packages/shared -> nothing internal                        (zod only; no Node built-ins)
```

The extension must never import API code, server configuration, database code, secrets, or provider code;
server code must never import the extension. `pnpm check:boundaries` and `pnpm test:boundaries` enforce this.

## Requirements

Node.js **24.21.x** (`.nvmrc`) and pnpm **10.28** (`packageManager`). Docker is needed only for the container smoke test.

## Everyday commands

```bash
pnpm install                 # frozen-lockfile in CI
pnpm lint && pnpm typecheck  # strict TypeScript, strict ESLint (no any, no process.env, no setInterval, no raw Date)
pnpm test                    # all unit tests (config, shared, api, extension, scripts)
pnpm build                   # API bundle + extension (needs VITE_API_BASE_URL and VITE_ENV, see below)
pnpm check                   # everything above plus boundaries and the bundle scan
```

### Run the API locally

```bash
pnpm --filter @heed/scripts gen:local-secrets          # writes .secrets.local.json (random, mode 0600, gitignored)
cp apps/api/.env.example apps/api/.env.local            # then edit if needed
pnpm dev:api                                            # http://localhost:8787
curl localhost:8787/healthz && curl localhost:8787/readyz
```

### Build and load the extension

```bash
VITE_API_BASE_URL=http://localhost:8787 VITE_ENV=local pnpm build:extension
# Chrome -> chrome://extensions -> Developer mode -> Load unpacked -> apps/extension/dist
pnpm scan:bundle            # fails if anything resembling a secret is in the bundle
pnpm --filter @heed/extension test:e2e   # loads the build in real Chromium (needs a Chromium install)
```

The extension build **fails closed** if `VITE_API_BASE_URL` or `VITE_ENV` is missing or unsafe. Only
`VITE_`-prefixed (public) variables are ever read.

### Container

```bash
bash scripts/docker-smoke.sh   # builds infra/Dockerfile and verifies non-root, read-only FS, fail-closed, no secrets
```

## Rules this repository enforces by code (not by convention)

- No secrets in the extension: typed storage guard, boundary rules, and a bundle scan in CI.
- No `process.env` outside `apps/api/src/main.ts`; configuration and secrets come through `loadServerConfig` and `SecretsProvider`.
- No process-local timers, module-level mutable state, or raw clocks in application code; time is an injected `Clock`.
- No process-local rate limiter: `RateLimiter` is a port that must be database-backed (a guard test fails otherwise).
- Logs are structured and scrubbed of email content, addresses, and tokens (log canary test).
- Every GitHub Action is pinned to a commit SHA; workflows have least-privilege permissions (policy tests).
