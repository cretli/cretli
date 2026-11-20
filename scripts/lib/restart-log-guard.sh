#!/usr/bin/env bash
# Shared restart-log guard.
#
# Kept in its own sourceable file so tests can exercise the decision without
# running the restart launcher. Rotation is allowed only when the listener list
# is empty AND the `lsof` probe itself ran successfully: `lsof` exits 0 when it
# found listeners and 1 when it found none (both mean the tool worked), while
# any other status (>= 2, or 127 when the command is missing) makes the probe
# inconclusive, so the live log must be left alone.

# @param string $1 Listener PID list (empty when the port is free).
# @param number $2 lsof exit status (0 found listeners, 1 found none, other = error).
# @return 0 when renaming the log aside is safe, 1 otherwise.
restart_log_rotation_allowed() {
  local listener_pids="${1:-}"
  local lsof_status="${2:-1}"
  [ -z "${listener_pids}" ] || return 1
  case "${lsof_status}" in
    0|1) return 0 ;;
    *) return 1 ;;
  esac
}

# PIDs of the Cretli server listening on the port — not every process with a
# socket on it. A plain `lsof -ti:PORT` also returns connected clients (an MCP
# client such as Claude Code) and relays that listen on another address (a
# `socat` LAN forwarder), and the restart would kill them too.
#
# @param number $1 Port (default 3011).
# @return lsof exit status (0 found listeners, 1 none, other = probe error);
#   prints one PID per line.
restart_server_listener_pids() {
  local port="${1:-3011}"
  local out rc
  out="$(lsof -nP -a -iTCP:"${port}" -sTCP:LISTEN -Fpc 2>/dev/null)"
  rc=$?
  printf '%s\n' "${out}" | awk '/^p/ { pid = substr($0, 2) } /^c/ { if (substr($0, 2) != "socat") print pid }' | sort -u
  return "${rc}"
}
