#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

CURRENT_NODE_VERSION=""
CURRENT_NODE_MAJOR=0
if command -v node >/dev/null 2>&1; then
  CURRENT_NODE_VERSION="$(node -v || true)"
  CURRENT_NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || echo 0)"
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

if [[ "${CURRENT_NODE_MAJOR}" -ge 22 ]]; then
  exec node "${NODE_ARGS[@]}" server.js
fi

echo "[cretli] Node.js ${CURRENT_NODE_VERSION:-not found} detected. Starting server with Node 22 via npx."
mkdir -p "${ROOT_DIR}/data/npm-cache"
export NPM_CONFIG_CACHE="${ROOT_DIR}/data/npm-cache"
exec npx -y node@22 "${NODE_ARGS[@]}" server.js
