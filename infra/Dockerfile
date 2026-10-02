# syntax=docker/dockerfile:1.7
#
# Production image for the Heed API (Cloud Run).
#   docker build -f infra/Dockerfile -t heed-api .
#
# Properties (verified by scripts/docker-smoke.sh):
#   - minimal runtime: distroless Node, no shell, no package manager, no source tree, no node_modules
#   - runs as a non-root user (65532)
#   - deterministic: frozen lockfile, base images pinned by digest
#   - no secrets in any layer; secrets are injected at runtime (SecretsProvider)
#   - stateless: writes nothing to disk, so it also runs with a read-only root filesystem
#
# Base image digests are pinned. Dependabot (docker ecosystem, /infra) proposes updates.
ARG NODE_IMAGE=node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
ARG RUNTIME_IMAGE=gcr.io/distroless/nodejs24-debian13:nonroot@sha256:9eeb7f5887d0e239e78264b06f7f11d2e14be534050481803a9e4728fcdd278e

# ---------- build: install, then bundle the API and its workspace packages into one file ----------
FROM ${NODE_IMAGE} AS build
ENV CI=true
# Optional build secret `extra_ca` lets builds behind a TLS-inspecting proxy trust an extra CA bundle.
# It is mounted for one RUN only and never stored in a layer; ordinary builds do not pass it.
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    npm install --global --no-fund --no-audit pnpm@10.28.0
WORKDIR /repo

# Manifests first, so dependency installation is cached until the lockfile changes.
COPY .npmrc package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/extension/package.json apps/extension/
COPY packages/config/package.json packages/config/
COPY packages/shared/package.json packages/shared/
COPY scripts/package.json scripts/
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    pnpm install --frozen-lockfile --filter "@heed/api..."

COPY packages packages
COPY apps/api apps/api
RUN pnpm --filter @heed/api build

# ---------- runtime: only the bundle ----------
FROM ${RUNTIME_IMAGE}
WORKDIR /app
COPY --from=build --chown=65532:65532 /repo/apps/api/dist/main.cjs ./main.cjs

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080
USER 65532:65532
EXPOSE 8080
# The distroless Node image's entrypoint is `node`; the argument is the script to run.
CMD ["main.cjs"]
