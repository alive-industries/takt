#!/usr/bin/env bash
# One-shot provisioning for Takt Cloud Run deploy.
# Idempotent: safe to re-run. All API enablement, IAM bindings,
# Artifact Registry repo, runtime SA, and Secret Manager secret.
#
# Required env:
#   GCP_PROJECT        (default: cost-tracker-490815)
#   REGION             (default: europe-west1)
#   AR_REPO            (default: takt)
#   SA_NAME            (default: takt-api)
#   API_KEY_SECRET     (default: takt-api-key)
#   BQ_DATASET         (default: takt)
#
# After this completes once, kick off a deploy via Cloud Build:
#   gcloud builds submit --config=server/cloudbuild.yaml .

set -euo pipefail

GCP_PROJECT="${GCP_PROJECT:-cost-tracker-490815}"
REGION="${REGION:-europe-west1}"
AR_REPO="${AR_REPO:-takt}"
SA_NAME="${SA_NAME:-takt-api}"
SA_EMAIL="${SA_NAME}@${GCP_PROJECT}.iam.gserviceaccount.com"
API_KEY_SECRET="${API_KEY_SECRET:-takt-api-key}"
BQ_DATASET="${BQ_DATASET:-takt}"

echo ">> Project: ${GCP_PROJECT}, Region: ${REGION}"
gcloud config set project "${GCP_PROJECT}" >/dev/null

echo ">> Enabling required APIs"
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  bigquery.googleapis.com \
  iam.googleapis.com \
  --project="${GCP_PROJECT}"

echo ">> Ensuring Artifact Registry repo: ${AR_REPO} (${REGION})"
if ! gcloud artifacts repositories describe "${AR_REPO}" \
  --location="${REGION}" --project="${GCP_PROJECT}" >/dev/null 2>&1; then
  gcloud artifacts repositories create "${AR_REPO}" \
    --location="${REGION}" \
    --repository-format=docker \
    --description="Takt API container images" \
    --project="${GCP_PROJECT}"
else
  echo "   repo already exists"
fi

echo ">> Ensuring runtime service account: ${SA_EMAIL}"
if ! gcloud iam service-accounts describe "${SA_EMAIL}" \
  --project="${GCP_PROJECT}" >/dev/null 2>&1; then
  gcloud iam service-accounts create "${SA_NAME}" \
    --display-name="Takt API runtime" \
    --project="${GCP_PROJECT}"
else
  echo "   SA already exists"
fi

echo ">> Waiting for SA to propagate"
for i in 1 2 3 4 5 6 7 8 9 10; do
  if gcloud iam service-accounts describe "${SA_EMAIL}" \
       --project="${GCP_PROJECT}" >/dev/null 2>&1 && \
     gcloud projects add-iam-policy-binding "${GCP_PROJECT}" \
       --member="serviceAccount:${SA_EMAIL}" \
       --role="roles/bigquery.jobUser" \
       --condition=None --quiet >/dev/null 2>&1; then
    echo "   SA usable after attempt $i"
    break
  fi
  sleep 3
done
# Data editor on the takt dataset only — least-privilege.
# Use bq update to apply dataset-level ACL.
TMP_ACL="$(mktemp)"
bq show --format=prettyjson --project_id="${GCP_PROJECT}" \
  "${GCP_PROJECT}:${BQ_DATASET}" > "${TMP_ACL}"
python3 - <<PY
import json, sys
path = "${TMP_ACL}"
sa = "${SA_EMAIL}"
with open(path) as f:
    meta = json.load(f)
access = meta.get("access", [])
existing = {(a.get("role"), a.get("userByEmail")) for a in access}
target = ("WRITER", sa)
if target not in existing:
    access.append({"role": "WRITER", "userByEmail": sa})
    meta["access"] = access
    with open(path, "w") as f:
        json.dump(meta, f, indent=2)
    print("ACL updated")
else:
    print("ACL already grants WRITER")
PY
bq update --source "${TMP_ACL}" "${GCP_PROJECT}:${BQ_DATASET}" >/dev/null
rm -f "${TMP_ACL}"

echo ">> Ensuring Secret Manager secret: ${API_KEY_SECRET}"
if ! gcloud secrets describe "${API_KEY_SECRET}" \
  --project="${GCP_PROJECT}" >/dev/null 2>&1; then
  gcloud secrets create "${API_KEY_SECRET}" \
    --replication-policy="automatic" \
    --project="${GCP_PROJECT}"
  echo
  echo "   IMPORTANT: secret has no value yet."
  echo "   Generate one and add it as a version:"
  echo
  echo "     KEY=\$(openssl rand -hex 32); printf '%s' \"\$KEY\" | gcloud secrets versions add ${API_KEY_SECRET} --data-file=-"
  echo "     # Note: use printf (not echo) to avoid a trailing newline in the secret."
  echo
else
  echo "   secret already exists"
fi

echo ">> Granting runtime SA access to the secret"
gcloud secrets add-iam-policy-binding "${API_KEY_SECRET}" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/secretmanager.secretAccessor" \
  --project="${GCP_PROJECT}" >/dev/null

echo ">> Granting Cloud Build SA permission to deploy"
PROJECT_NUMBER="$(gcloud projects describe "${GCP_PROJECT}" --format='value(projectNumber)')"
CLOUD_BUILD_SA="${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com"
# Cloud Run admin (deploy services)
gcloud projects add-iam-policy-binding "${GCP_PROJECT}" \
  --member="serviceAccount:${CLOUD_BUILD_SA}" \
  --role="roles/run.admin" \
  --condition=None \
  --quiet >/dev/null
# Service Account User (so Cloud Build can act-as the runtime SA)
gcloud iam service-accounts add-iam-policy-binding "${SA_EMAIL}" \
  --member="serviceAccount:${CLOUD_BUILD_SA}" \
  --role="roles/iam.serviceAccountUser" \
  --project="${GCP_PROJECT}" >/dev/null

echo
echo ">> Done. Next steps:"
echo "   1. (If not done) seed an API key into the secret (use printf, not echo):"
echo "        KEY=\$(openssl rand -hex 32); printf '%s' \"\$KEY\" | gcloud secrets versions add ${API_KEY_SECRET} --data-file=-"
echo "   2. Deploy:"
echo "        gcloud builds submit --config=server/cloudbuild.yaml ."
echo "   3. Configure the extension with the deployed URL + the same key."
