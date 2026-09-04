#!/usr/bin/env bash
# Start Cretli with an optional CURSOR_API_KEY for @cursor/sdk.
# Key: environment variable or .cretli-sdk.env in the project root (do not commit).
# Legacy: .cursor-remote-sdk.env is still loaded if the Cretli file is missing.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ENV_FILE="${ROOT}/.cretli-sdk.env"
LEGACY_ENV_FILE="${ROOT}/.cursor-remote-sdk.env"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  set +a
  echo "[cretli] Loaded key from: $ENV_FILE"
elif [[ -f "$LEGACY_ENV_FILE" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$LEGACY_ENV_FILE"
  set +a
  echo "[cretli] Loaded key from legacy file: $LEGACY_ENV_FILE"
elif [[ -z "${CURSOR_API_KEY:-}" ]]; then
  echo "[cretli] WARNING: CURSOR_API_KEY is missing — SDK chats will be unavailable."
  echo "  Create: $ENV_FILE (template: .cretli-sdk.env.example)"
  echo "  or: export CURSOR_API_KEY='…' before starting."
fi

export USE_HTTPS="${USE_HTTPS:-1}"
export CRETLI_BIND="${CRETLI_BIND:-${CURSOR_REMOTE_BIND:-127.0.0.1}}"
exec npm start
