#!/usr/bin/env bash
set -euo pipefail

export EXPORT_JOB="${ITERATIONS_JOB:-takt-sync-iterations}"
export SCHEDULER_JOB="${SCHEDULER_JOB:-${EXPORT_JOB}-hourly}"
bash "$(dirname "$0")/schedule_export.sh"
