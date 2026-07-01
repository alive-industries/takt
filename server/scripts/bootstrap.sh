#!/usr/bin/env bash
# Bootstrap the Takt BigQuery dataset and tables.
# Idempotent: safe to re-run.
#
# Required env:
#   GCP_PROJECT     (default: cost-tracker-490815)
#   BQ_DATASET      (default: takt)
#   BQ_LOCATION     (default: EU — match your billing_export dataset)
#   ADMIN_LOGIN     (required: GitHub login of the first admin)
#   ADMIN_USER_ID   (optional: numeric GitHub user id; resolved later if blank)

set -euo pipefail

GCP_PROJECT="${GCP_PROJECT:-cost-tracker-490815}"
BQ_DATASET="${BQ_DATASET:-takt}"
BQ_LOCATION="${BQ_LOCATION:-EU}"
ADMIN_LOGIN="${ADMIN_LOGIN:?ADMIN_LOGIN env var is required}"
ADMIN_USER_ID="${ADMIN_USER_ID:-NULL}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCHEMA_FILE="${SCRIPT_DIR}/../../infra/bigquery/schema.sql"

echo ">> Ensuring dataset ${GCP_PROJECT}:${BQ_DATASET} exists in ${BQ_LOCATION}"
if ! bq --project_id="${GCP_PROJECT}" show --dataset "${GCP_PROJECT}:${BQ_DATASET}" >/dev/null 2>&1; then
  bq --project_id="${GCP_PROJECT}" --location="${BQ_LOCATION}" mk \
    --dataset \
    --description="Takt time-tracker data" \
    "${GCP_PROJECT}:${BQ_DATASET}"
else
  echo "   dataset already exists"
fi

echo ">> Applying schema to ${GCP_PROJECT}.${BQ_DATASET}"
# schema.sql uses the placeholder __TAKT_DS__ for <project>.<dataset> so the
# same DDL can target prod (takt) or a test dataset (takt_test). Substitute
# it here so the schema lands in the dataset named by BQ_DATASET.
sed "s/__TAKT_DS__/${GCP_PROJECT}.${BQ_DATASET}/g" "${SCHEMA_FILE}" \
  | bq --project_id="${GCP_PROJECT}" --location="${BQ_LOCATION}" query \
      --use_legacy_sql=false

echo ">> Seeding first admin: ${ADMIN_LOGIN}"
bq --project_id="${GCP_PROJECT}" --location="${BQ_LOCATION}" query \
  --use_legacy_sql=false <<SQL
MERGE \`${GCP_PROJECT}.${BQ_DATASET}.members\` T
USING (SELECT '${ADMIN_LOGIN}' AS github_login) S
ON T.github_login = S.github_login
WHEN NOT MATCHED THEN INSERT
  (github_login, github_user_id, role, status, source, added_by, added_at, updated_at)
VALUES
  ('${ADMIN_LOGIN}', ${ADMIN_USER_ID}, 'admin', 'active', 'manual',
   'bootstrap', CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP());
SQL

echo ">> Done."
