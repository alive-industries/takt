#!/usr/bin/env bash
set -euo pipefail

GCP_PROJECT="${GCP_PROJECT:-cost-tracker-490815}"
REGION="${REGION:-europe-west1}"
EXPORT_JOB="${EXPORT_JOB:-takt-export-bigquery}"
SCHEDULER_JOB="${SCHEDULER_JOB:-takt-export-bigquery-hourly}"
SA_EMAIL="${SA_EMAIL:-takt-api@${GCP_PROJECT}.iam.gserviceaccount.com}"
URI="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${GCP_PROJECT}/jobs/${EXPORT_JOB}:run"

if gcloud scheduler jobs describe "${SCHEDULER_JOB}" --location="${REGION}" \
  --project="${GCP_PROJECT}" >/dev/null 2>&1; then
  ACTION=update
else
  ACTION=create
fi

gcloud scheduler jobs "${ACTION}" http "${SCHEDULER_JOB}" \
  --location="${REGION}" \
  --project="${GCP_PROJECT}" \
  --schedule="0 * * * *" \
  --uri="${URI}" \
  --http-method=POST \
  --oauth-service-account-email="${SA_EMAIL}"
