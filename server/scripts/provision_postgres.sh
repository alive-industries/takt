#!/usr/bin/env bash
set -euo pipefail

GCP_PROJECT="${GCP_PROJECT:-cost-tracker-490815}"
REGION="${REGION:-europe-west1}"
DB_INSTANCE="${DB_INSTANCE:-takt-db}"
DB_NAME="${DB_NAME:-takt}"
DB_USER="${DB_USER:-takt_api}"
DB_PASSWORD="${DB_PASSWORD:?DB_PASSWORD env var is required}"

if ! gcloud sql instances describe "${DB_INSTANCE}" --project="${GCP_PROJECT}" >/dev/null 2>&1; then
  gcloud sql instances create "${DB_INSTANCE}" \
    --project="${GCP_PROJECT}" \
    --region="${REGION}" \
    --database-version=POSTGRES_16 \
    --tier=db-custom-1-3840 \
    --availability-type=REGIONAL \
    --storage-type=SSD \
    --storage-size=10 \
    --storage-auto-increase
fi

if ! gcloud sql databases describe "${DB_NAME}" --instance="${DB_INSTANCE}" \
  --project="${GCP_PROJECT}" >/dev/null 2>&1; then
  gcloud sql databases create "${DB_NAME}" --instance="${DB_INSTANCE}" \
    --project="${GCP_PROJECT}"
fi

if ! gcloud sql users list --instance="${DB_INSTANCE}" --project="${GCP_PROJECT}" \
  --filter="name=${DB_USER}" --format="value(name)" | grep -qx "${DB_USER}"; then
  gcloud sql users create "${DB_USER}" --instance="${DB_INSTANCE}" \
    --project="${GCP_PROJECT}" --password="${DB_PASSWORD}"
fi

CONNECTION_NAME="$(gcloud sql instances describe "${DB_INSTANCE}" \
  --project="${GCP_PROJECT}" --format='value(connectionName)')"
echo "Create a Secret Manager version containing:"
echo "postgresql+psycopg://${DB_USER}:<url-encoded-password>@/${DB_NAME}?host=/cloudsql/${CONNECTION_NAME}"
