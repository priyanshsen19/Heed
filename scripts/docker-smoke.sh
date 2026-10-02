#!/usr/bin/env bash
# Docker build smoke test: builds the production image and proves its key properties.
# Usage: bash scripts/docker-smoke.sh   (from the repository root; needs docker, curl, openssl)
set -euo pipefail

IMAGE="${IMAGE:-heed-api:smoke}"
NAME="heed-api-smoke-$$"
PORT="${SMOKE_PORT:-18090}"
# CI uses the default bridge network. Some sandboxes have no bridge: set HEED_DOCKER_NETWORK=host there.
NETWORK="${HEED_DOCKER_NETWORK:-}"
# Optional extra CA bundle for builds behind a TLS-inspecting proxy (passed as a BuildKit secret).
EXTRA_CA="${HEED_BUILD_EXTRA_CA:-}"
fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "== build"
build_start=$(date +%s)
docker build ${NETWORK:+--network="$NETWORK"} ${EXTRA_CA:+--secret id=extra_ca,src="$EXTRA_CA"} -f infra/Dockerfile -t "$IMAGE" .
echo "build seconds: $(( $(date +%s) - build_start ))"

echo "== image size"
docker image inspect "$IMAGE" --format 'size bytes: {{.Size}}'

echo "== runs as a non-root user"
user="$(docker image inspect "$IMAGE" --format '{{.Config.User}}')"
[ -n "$user" ] || fail "image has no USER (would run as root)"
case "$user" in root|0|0:*|root:*) fail "image user is root: $user";; esac
uid="$(docker run --rm --entrypoint /nodejs/bin/node "$IMAGE" -e 'process.stdout.write(String(process.getuid()))')"
[ "$uid" != "0" ] || fail "process uid is 0"
echo "configured user: $user, process uid: $uid"

echo "== runtime contains only the bundle (no source, no node_modules, no .env)"
listing="$(docker run --rm --entrypoint /nodejs/bin/node "$IMAGE" -e 'process.stdout.write(require("fs").readdirSync("/app").join(","))')"
[ "$listing" = "main.cjs" ] || fail "unexpected files in /app: $listing"

echo "== no secrets or server variable values baked into image metadata or layers"
meta="$(docker image inspect "$IMAGE" --format '{{json .Config.Env}} {{json .Config.Cmd}}')$(docker history --no-trunc --format '{{.CreatedBy}}' "$IMAGE")"
for needle in GEMINI_API_KEY GOOGLE_CLIENT_SECRET DATABASE_URL HMAC_PEPPER DATA_KEYS HEED_RUNTIME_SECRETS PRIVATE KEY; do
  if printf '%s' "$meta" | grep -q "$needle"; then fail "image metadata mentions $needle"; fi
done

echo "== fails closed without configuration"
if docker run --rm --name "$NAME-bare" ${NETWORK:+--network "$NETWORK"} "$IMAGE" >/tmp/heed-bare.out 2>&1; then fail "container started with no configuration"; fi
grep -q "startup failed" /tmp/heed-bare.out || fail "no safe startup failure line"
if grep -qE '^\s+at ' /tmp/heed-bare.out; then fail "stack trace leaked on startup failure"; fi

echo "== runs with a read-only filesystem, no capabilities, no privilege escalation (statelessness)"
secrets="{\"DATA_KEYS\":{\"1\":\"$(openssl rand -base64 32)\"},\"ACTIVE_DATA_KEY_ID\":\"1\",\"HMAC_PEPPER\":\"$(openssl rand -base64 32)\"}"
run_start=$(date +%s%N)
if [ "$NETWORK" = "host" ]; then
  net_args=(--network host -e "PORT=$PORT")
else
  net_args=(-p "127.0.0.1:$PORT:8080")
fi
docker run -d --name "$NAME" --read-only --cap-drop ALL --security-opt no-new-privileges \
  "${net_args[@]}" \
  -e HEED_ENV=local -e LOG_LEVEL=info \
  -e "HEED_RUNTIME_SECRETS_JSON=$secrets" \
  "$IMAGE" >/dev/null
for _ in $(seq 1 100); do
  if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then break; fi
  sleep 0.1
done
curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null || { docker logs "$NAME" >&2; fail "/healthz never became available"; }
echo "container start to first healthy response (ms): $(( ($(date +%s%N) - run_start) / 1000000 ))"

[ "$(curl -fsS "http://127.0.0.1:$PORT/healthz")" = '{"status":"ok"}' ] || fail "unexpected /healthz body"
[ "$(curl -fsS "http://127.0.0.1:$PORT/readyz")" = '{"status":"ready"}' ] || fail "unexpected /readyz body"
code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/nope")"
[ "$code" = "404" ] || fail "expected 404 for unknown route, got $code"
curl -sD - -o /dev/null "http://127.0.0.1:$PORT/healthz" | grep -qi '^x-request-id:' || fail "no request id header"

echo "== process inside the container is non-root"
docker top "$NAME" -eo user,pid,args | tee /tmp/heed-top.out
if awk 'NR>1 {print $1}' /tmp/heed-top.out | grep -qx root; then fail "container process runs as root"; fi

echo "== logs are structured JSON and contain no secrets"
docker logs "$NAME" 2>&1 | while IFS= read -r line; do
  printf '%s' "$line" | python3 -c 'import json,sys; json.loads(sys.stdin.read())' || fail "non-JSON log line: $line"
done
if docker logs "$NAME" 2>&1 | grep -qE "$(printf '%s' "$secrets" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["HMAC_PEPPER"])')"; then fail "secret appeared in logs"; fi

echo "== graceful shutdown"
docker stop -t 10 "$NAME" >/dev/null
exit_code="$(docker inspect "$NAME" --format '{{.State.ExitCode}}')"
[ "$exit_code" = "0" ] || fail "expected exit code 0 on SIGTERM, got $exit_code"

echo "SMOKE OK"
