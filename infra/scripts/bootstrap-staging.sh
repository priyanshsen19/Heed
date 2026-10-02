#!/usr/bin/env bash
# One-time, idempotent bootstrap of the STAGING Google Cloud project for the Heed API.
#
# NOT run by CI and NOT run automatically. A human with permission to administer the project runs it
# once. It never prints secret values and never writes secrets to disk beyond a mode-0600 temp file that
# is shredded on exit.
#
# Required environment:
#   PROJECT_ID    staging GCP project (billing account attached: Cloud Run and Scheduler require one)
#   REGION        e.g. europe-west1 (keep close to the database region)
#   GITHUB_REPO   owner/name that may deploy, e.g. priyanshsen19/Heed
# Optional:
#   AR_REPO       Artifact Registry repository name (default: heed)
set -euo pipefail

: "${PROJECT_ID:?set PROJECT_ID}" "${REGION:?set REGION}" "${GITHUB_REPO:?set GITHUB_REPO}"
AR_REPO="${AR_REPO:-heed}"
RUNTIME_SA="heed-api-runtime"
SCHEDULER_SA="heed-scheduler"
DEPLOY_SA="heed-deployer"
SECRET="heed-runtime-config"
POOL="github-pool"
PROVIDER="github-provider"
gc() { gcloud --project "$PROJECT_ID" --quiet "$@"; }

echo "Enabling APIs"
gc services enable run.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com \
  cloudscheduler.googleapis.com iamcredentials.googleapis.com iam.googleapis.com sts.googleapis.com

echo "Creating Artifact Registry repository (idempotent)"
gc artifacts repositories describe "$AR_REPO" --location "$REGION" >/dev/null 2>&1 || \
  gc artifacts repositories create "$AR_REPO" --repository-format docker --location "$REGION" \
    --description "Heed API images (staging)"

echo "Creating service accounts (idempotent): runtime, scheduler, deployer"
for sa in "$RUNTIME_SA" "$SCHEDULER_SA" "$DEPLOY_SA"; do
  gc iam service-accounts describe "$sa@$PROJECT_ID.iam.gserviceaccount.com" >/dev/null 2>&1 || \
    gc iam service-accounts create "$sa" --display-name "$sa"
done

echo "Creating the single runtime secret (idempotent). Values are random and are NOT printed."
if ! gc secrets describe "$SECRET" >/dev/null 2>&1; then
  tmp="$(mktemp)"; chmod 600 "$tmp"; trap 'shred -u "$tmp" 2>/dev/null || rm -f "$tmp"' EXIT
  printf '{"DATA_KEYS":{"1":"%s"},"ACTIVE_DATA_KEY_ID":"1","HMAC_PEPPER":"%s"}' \
    "$(openssl rand -base64 32)" "$(openssl rand -base64 32)" > "$tmp"
  gc secrets create "$SECRET" --replication-policy automatic --data-file "$tmp"
fi

echo "Granting least-privilege access"
# runtime: read exactly one secret
gc secrets add-iam-policy-binding "$SECRET" \
  --member "serviceAccount:$RUNTIME_SA@$PROJECT_ID.iam.gserviceaccount.com" --role roles/secretmanager.secretAccessor >/dev/null
# deployer: push images, deploy the service, and act as the runtime service account (nothing project-wide)
gc artifacts repositories add-iam-policy-binding "$AR_REPO" --location "$REGION" \
  --member "serviceAccount:$DEPLOY_SA@$PROJECT_ID.iam.gserviceaccount.com" --role roles/artifactregistry.writer >/dev/null
gc projects add-iam-policy-binding "$PROJECT_ID" \
  --member "serviceAccount:$DEPLOY_SA@$PROJECT_ID.iam.gserviceaccount.com" --role roles/run.developer --condition=None >/dev/null
gc iam service-accounts add-iam-policy-binding "$RUNTIME_SA@$PROJECT_ID.iam.gserviceaccount.com" \
  --member "serviceAccount:$DEPLOY_SA@$PROJECT_ID.iam.gserviceaccount.com" --role roles/iam.serviceAccountUser >/dev/null

echo "Workload Identity Federation for GitHub Actions (no long-lived keys exist anywhere)"
gc iam workload-identity-pools describe "$POOL" --location global >/dev/null 2>&1 || \
  gc iam workload-identity-pools create "$POOL" --location global --display-name "GitHub Actions"
gc iam workload-identity-pools providers describe "$PROVIDER" --location global --workload-identity-pool "$POOL" >/dev/null 2>&1 || \
  gc iam workload-identity-pools providers create-oidc "$PROVIDER" --location global --workload-identity-pool "$POOL" \
    --issuer-uri "https://token.actions.githubusercontent.com" \
    --attribute-mapping "google.subject=assertion.sub,attribute.repository=assertion.repository" \
    --attribute-condition "assertion.repository == '$GITHUB_REPO'"
PROJECT_NUMBER="$(gc projects describe "$PROJECT_ID" --format 'value(projectNumber)')"
gc iam service-accounts add-iam-policy-binding "$DEPLOY_SA@$PROJECT_ID.iam.gserviceaccount.com" \
  --member "principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL/attribute.repository/$GITHUB_REPO" \
  --role roles/iam.workloadIdentityUser >/dev/null

cat <<MSG

Bootstrap complete. Set these GitHub *environment variables* (not secrets) on the 'staging' environment:
  GCP_PROJECT_ID                  $PROJECT_ID
  GCP_REGION                      $REGION
  GCP_WORKLOAD_IDENTITY_PROVIDER  projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL/providers/$PROVIDER
  GCP_DEPLOY_SERVICE_ACCOUNT      $DEPLOY_SA@$PROJECT_ID.iam.gserviceaccount.com
  EXTENSION_ORIGIN                chrome-extension://<32-letter staging extension id>
After the first deploy, create the scheduler job (infra/scripts/create-tick-job.sh) and a billing budget alert.
MSG
