#!/usr/bin/env bash
# Cretli self-update: fetch + reset --hard + npm + rebuild + production front build.
# Invoked only by lib/self-update.js. Does not accept client-supplied paths.
set -euo pipefail

ROOT="${CRETLI_PROJECT_ROOT:-}"
REMOTE="${CRETLI_UPDATE_REMOTE:-origin}"
BRANCH="${CRETLI_UPDATE_BRANCH:-master}"

if [[ -z "${ROOT}" || ! -d "${ROOT}" ]]; then
  echo "Missing CRETLI_PROJECT_ROOT" >&2
  exit 1
fi

if [[ ! "${REMOTE}" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "Invalid update remote" >&2
  exit 1
fi

if [[ ! "${BRANCH}" =~ ^[A-Za-z0-9._/-]+$ ]]; then
  echo "Invalid update branch" >&2
  exit 1
fi

cd "${ROOT}"
git() {
  command git -c "safe.directory=${ROOT}" "$@"
}

phase() {
  echo "::phase::${1}"
}

phase fetch
git fetch "${REMOTE}" "${BRANCH}"

phase reset
git reset --hard "${REMOTE}/${BRANCH}"

phase npm
npm install

phase rebuild
npm rebuild node-pty

phase build
npm run build:front:prod

phase done
