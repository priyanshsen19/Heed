#!/usr/bin/env bash
# Creates (or updates) the Cloud Scheduler job that calls POST /internal/tick with a Google-signed OIDC
# token. The tick endpoint verifies issuer, audience, expiry, and that the identity is exactly the
# scheduler service account (apps/api/src/ports/oidc.ts); it is never publicly usable.
#
# Stage 1: the endpoint is an authenticated no-op (no handlers yet). The job can be created now to prove
# the trust path, or later when real handlers exist. Free tier: 3 jobs per billing account; this uses 1.
#
# Required: PROJECT_ID, REGION, SERVICE_URL. Optional: SCHEDULE (default every 15 minutes).
set -euo pipefail
: "${PROJECT_ID:?set PROJECT_ID}" "${REGION:?set REGION}" "${SERVICE_URL:?set SERVICE_URL}"
SCHEDULE="${SCHEDULE:-*/15 * * * *}"
JOB="heed-tick-staging"
SA="heed-scheduler@${PROJECT_ID}.iam.gserviceaccount.com"
gc() { gcloud --project "$PROJECT_ID" --quiet "$@"; }

# The scheduler service account may invoke the service (platform-level) ...
gc run services add-iam-policy-binding heed-api-staging --region "$REGION" \
  --member "serviceAccount:$SA" --role roles/run.invoker >/dev/null

args=(--location "$REGION" --schedule "$SCHEDULE" --time-zone "Etc/UTC"
  --uri "${SERVICE_URL}/internal/tick" --http-method POST
  --oidc-service-account-email "$SA" --oidc-token-audience "$SERVICE_URL"
  --attempt-deadline 300s --max-retry-attempts 1)
if gc scheduler jobs describe "$JOB" --location "$REGION" >/dev/null 2>&1; then
  gc scheduler jobs update http "$JOB" "${args[@]}"
else
  gc scheduler jobs create http "$JOB" "${args[@]}"
fi
echo "Scheduler job $JOB ready: $SCHEDULE -> ${SERVICE_URL}/internal/tick"
