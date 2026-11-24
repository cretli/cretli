#!/bin/sh
set -eu

# Container must listen on all interfaces so Docker port publish works.
export CRETLI_BIND="${CRETLI_BIND:-0.0.0.0}"

if [ -z "${CRETLI_SETUP_TOKEN:-}" ]; then
  CRETLI_SETUP_TOKEN="$(node -e "process.stdout.write(require('crypto').randomBytes(16).toString('hex'))")"
  export CRETLI_SETUP_TOKEN
  echo "[cretli] Generated CRETLI_SETUP_TOKEN for first-run LAN/container setup:"
  echo "  ${CRETLI_SETUP_TOKEN}"
  echo "[cretli] Paste this token on https://localhost:3011/login (first run)."
fi

APP_DIR="${CRETLI_APP_DIR:-/app}"
cd "$APP_DIR"
mkdir -p data
if [ -f "$APP_DIR/.env" ]; then
  node --import ./lib/register-boot-env.js --env-file="$APP_DIR/.env" scripts/generate-ssl-cert.js --if-needed
else
  node --import ./lib/register-boot-env.js scripts/generate-ssl-cert.js --if-needed
fi
if [ ! -f public/dist/app/app.bundle.js ] && [ ! -f public/dist/app/index.bundle.js ]; then
  echo "[cretli] Building frontend…"
  npm run build:front:prod
fi

if [ "${CRETLI_DOCKER_SUPERVISOR:-0}" = "1" ]; then
  exec node scripts/cretli-supervisor.mjs
else
  exec npm start
fi
