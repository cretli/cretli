#!/usr/bin/env bash

set -u

WORKSPACE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_FILE="${WORKSPACE_DIR}/data/task-restart-server.log"

mkdir -p "${WORKSPACE_DIR}/data"

OLD_PID="$(lsof -ti:3011 2>/dev/null | tr '\n' ' ' | sed 's/[[:space:]]*$//')"

{
  echo "=== [$(date '+%Y-%m-%d %H:%M:%S')] Restart task begin ==="
  echo "PWD: ${WORKSPACE_DIR}"
  if [ -n "${OLD_PID}" ]; then
    echo "OLD_PID: ${OLD_PID}"
  else
    echo "OLD_PID: (none)"
  fi
  echo "Starting launcher (nohup)..."
} | tee -a "${LOG_FILE}"

export WORKSPACE_DIR
export LOG_FILE
export OLD_PID

nohup bash -lc '
  set -u

  {
    echo "[launcher] start $(date)"
    if [ -n "${OLD_PID}" ]; then
      echo "[launcher] kill OLD_PID: ${OLD_PID}"
      kill ${OLD_PID} 2>/dev/null || true
      sleep 2
    fi

    if lsof -ti:3011 >/dev/null 2>&1; then
      P2="$(lsof -ti:3011 2>/dev/null | tr "\n" " " | sed "s/[[:space:]]*$//")"
      echo "[launcher] force kill PID: ${P2}"
      kill -9 ${P2} 2>/dev/null || true
      sleep 1
    fi

    echo "[launcher] listeners before start:"
    lsof -nP -iTCP:3011 -sTCP:LISTEN 2>/dev/null || echo "(none)"
    echo "[launcher] start npm start (USE_HTTPS=1)"
  } >> "${LOG_FILE}" 2>&1

  cd "${WORKSPACE_DIR}"
  SDK_ENV="${WORKSPACE_DIR}/.cretli-sdk.env"
  if [ -f "${SDK_ENV}" ]; then
    echo "[launcher] CURSOR_API_KEY source: ${SDK_ENV}" >> "${LOG_FILE}" 2>&1
    set -a
    # shellcheck source=/dev/null
    . "${SDK_ENV}"
    set +a
  fi
  USE_HTTPS=1 npm start >> "${LOG_FILE}" 2>&1
' >/dev/null 2>&1 &

LAUNCHER_PID="$!"
echo "Launcher PID: ${LAUNCHER_PID}" | tee -a "${LOG_FILE}"
echo "Log file: ${LOG_FILE}" | tee -a "${LOG_FILE}"
