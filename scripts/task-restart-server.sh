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

  # shellcheck source=lib/restart-log-guard.sh
  . "${WORKSPACE_DIR}/scripts/lib/restart-log-guard.sh"

  {
    echo "[launcher] start $(date)"
    if [ -n "${OLD_PID}" ]; then
      echo "[launcher] kill OLD_PID: ${OLD_PID}"
      kill ${OLD_PID} 2>/dev/null || true
      # Give the synchronous OpenCode phase (SIGTERM + bounded escalation to
      # SIGKILL, at most ~2.8 s worst case with a booting child) time to finish
      # before the hard kill. Keep this >= the OpenCode escalation budget.
      sleep 5
    fi

    if lsof -ti:3011 >/dev/null 2>&1; then
      P2="$(lsof -ti:3011 2>/dev/null | tr "\n" " " | sed "s/[[:space:]]*$//")"
      echo "[launcher] force kill PID: ${P2}"
      kill -9 ${P2} 2>/dev/null || true
      sleep 1
    fi

    # Rename the old log aside only after no listener remains AND the lsof
    # probe ran successfully; a failed probe is inconclusive, so a surviving
    # writer keeps its open file and the runtime cap bounds it instead.
    LSOF_LISTENERS="$(lsof -ti:3011 2>/dev/null)"
    LSOF_STATUS=$?
    if restart_log_rotation_allowed "${LSOF_LISTENERS}" "${LSOF_STATUS}"; then
      node "${WORKSPACE_DIR}/scripts/rotate-log.js" "${LOG_FILE}"
    else
      echo "[launcher] log rotation skipped (lsof listeners=[${LSOF_LISTENERS}] rc=${LSOF_STATUS})"
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
  export CRETLI_SERVER_LOG_FILE="${LOG_FILE}"
  USE_HTTPS=1 npm start >> "${LOG_FILE}" 2>&1
' >/dev/null 2>&1 &

LAUNCHER_PID="$!"
echo "Launcher PID: ${LAUNCHER_PID}" | tee -a "${LOG_FILE}"
echo "Log file: ${LOG_FILE}" | tee -a "${LOG_FILE}"
