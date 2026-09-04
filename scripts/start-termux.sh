#!/usr/bin/env bash
# Phone-as-server launcher for Termux. Keeps the CPU awake when Termux:API is installed.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

if [[ "${PREFIX:-}" != *com.termux* ]]; then
  echo "[cretli] start:termux is intended for Termux on Android."
fi

if command -v termux-wake-lock >/dev/null 2>&1; then
  termux-wake-lock
  echo "[cretli] CPU wake-lock on. Release with: termux-wake-unlock"
else
  echo "[cretli] Optional: install Termux:API, then pkg install termux-api, so the server stays up in the background."
fi

export CURSOR_RIPGREP_PATH="${CURSOR_RIPGREP_PATH:-./node_modules/.bin/rg}"
export USE_HTTPS="${USE_HTTPS:-1}"
# Phone-as-server uses the production SPA. HMR walks parent dirs and hits
# EACCES on Termux (/data, /) plus a long webpack compile on every start.
export CRETLI_FRONT_HMR="${CRETLI_FRONT_HMR:-0}"
exec bash "${ROOT_DIR}/scripts/start-server-node22.sh"
