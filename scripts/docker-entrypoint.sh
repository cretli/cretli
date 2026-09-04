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

cd /app
mkdir -p data
if [ ! -f data/key.pem ] || [ ! -f data/cert.pem ]; then
  echo "[cretli] Generating self-signed TLS cert in data/…"
  node scripts/generate-ssl-cert.js || true
fi
if [ ! -f public/dist/app/app.bundle.js ] && [ ! -f public/dist/app/index.bundle.js ]; then
  echo "[cretli] Building frontend…"
  npm run build:front:prod
fi

exec npm start
