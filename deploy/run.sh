#!/bin/bash
# Starts Slack Channel Guard on the VM (run by systemd, see slack-channel-guard.service).
# Tokens are fetched from Secret Manager with the VM's service account at every start
# and handed to the container as environment variables; no token file is written.
set -euo pipefail

# The VM's own project, from the metadata server (override with PROJECT=... if needed).
PROJECT="${PROJECT:-$(curl -fsS -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/project/project-id)}"
IMAGE=slack-channel-guard:local
NAME=slack-channel-guard
CONFIG=/etc/slack-channel-guard/config.env   # non-secret settings (BOT_ADMIN_IDS, DRY_RUN, ...)

fetch() { gcloud secrets versions access latest --secret="$1" --project="$PROJECT" --quiet; }

SLACK_BOT_TOKEN="$(fetch slack-bot-token)"
SLACK_APP_TOKEN="$(fetch slack-app-token)"
export SLACK_BOT_TOKEN SLACK_APP_TOKEN

# Leftover container from an unclean stop.
docker rm -f "$NAME" >/dev/null 2>&1 || true

# "-e NAME" without a value copies it from this script's environment, so the tokens
# never appear on a command line (ps). --rm deletes the container config on stop.
exec docker run --rm --name "$NAME" \
  -e SLACK_BOT_TOKEN -e SLACK_APP_TOKEN \
  --env-file "$CONFIG" \
  -e DATA_FILE=/data/state.json \
  -v slack-channel-guard-data:/data \
  --read-only --tmpfs /tmp \
  --cap-drop ALL --security-opt no-new-privileges --init \
  --memory 256m --cpus 0.5 --pids-limit 100 \
  --log-driver gcplogs \
  "$IMAGE"
