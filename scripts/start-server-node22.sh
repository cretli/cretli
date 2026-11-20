#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

CURRENT_NODE_VERSION=""
CURRENT_NODE_MAJOR=0
CURRENT_NODE_MINOR=0
# Minimum Node: engines.node in package.json (>=22.18). From 22.18 Node strips
# TypeScript types natively, so the server loads .ts modules without a build step.
MIN_NODE_MAJOR=22
MIN_NODE_MINOR=18
if command -v node >/dev/null 2>&1; then
  CURRENT_NODE_VERSION="$(node -v || true)"
  # node -e + stdout.write, not node -p: -p colourises numbers when FORCE_COLOR is
  # set (Playwright webServer), and an ANSI-wrapped "22" breaks the [[ -gt ]] test.
  CURRENT_NODE_MAJOR="$(node -e "process.stdout.write(String(Number(process.versions.node.split('.')[0])))" 2>/dev/null || echo 0)"
  CURRENT_NODE_MINOR="$(node -e "process.stdout.write(String(Number(process.versions.node.split('.')[1])))" 2>/dev/null || echo 0)"
fi

# Test hook: CRETLI_NODE_VERSION_OVERRIDE=<major.minor[.patch]> substitutes the detected version.
if [[ -n "${CRETLI_NODE_VERSION_OVERRIDE:-}" ]]; then
  CURRENT_NODE_VERSION="v${CRETLI_NODE_VERSION_OVERRIDE#v}"
  IFS=. read -r CURRENT_NODE_MAJOR CURRENT_NODE_MINOR _ <<<"${CURRENT_NODE_VERSION#v}"
  CURRENT_NODE_MAJOR="${CURRENT_NODE_MAJOR:-0}"
  CURRENT_NODE_MINOR="${CURRENT_NODE_MINOR:-0}"
fi

# Fail fast on an unsupported Node: the storage runtime gate (lib/storage/runtime-check.js)
# would reject it anyway, and silently switching runtimes hides the problem.
if ! { [[ "${CURRENT_NODE_MAJOR}" -gt "${MIN_NODE_MAJOR}" ]] \
  || { [[ "${CURRENT_NODE_MAJOR}" -eq "${MIN_NODE_MAJOR}" ]] && [[ "${CURRENT_NODE_MINOR}" -ge "${MIN_NODE_MINOR}" ]]; }; }; then
  echo "[cretli] Node.js ${CURRENT_NODE_VERSION:-not found} detected; Cretli needs >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}. Install a newer Node and retry." >&2
  exit 1
fi

# The icon font subset is a build artifact (gitignored); the dev server bundles
# it, so generate it once when it is missing. Rebuilds go through npm run build:front.
if [[ ! -f "${ROOT_DIR}/app_front/css/generated/mdi-subset.css" ]]; then
  node "${ROOT_DIR}/scripts/build-mdi-subset.mjs" \
    || echo "[cretli] Could not generate the icon subset — run: npm run build:mdi-subset"
fi

# Process env wins over .env; missing USE_HTTPS becomes 1 in lib/register-boot-env.js.
# Do not default USE_HTTPS here — that would hide USE_HTTPS=0 from .env.
NODE_ARGS=(--import ./lib/register-boot-env.js)
if [[ -f "${ROOT_DIR}/.env" ]]; then
  NODE_ARGS+=("--env-file=${ROOT_DIR}/.env")
fi

node "${NODE_ARGS[@]}" "${ROOT_DIR}/scripts/generate-ssl-cert.js" --if-needed \
  || { echo "[cretli] TLS certificate generation failed. Install openssl or set USE_HTTPS=0 for HTTP."; exit 1; }

exec node "${NODE_ARGS[@]}" server.js
