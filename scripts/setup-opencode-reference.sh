#!/usr/bin/env bash
# Fetch a local, gitignored OpenCode reference tree for harness development.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR_DIR="${ROOT}/.vendor/opencode"
SRC_DIR="${VENDOR_DIR}/src"
SDK_TYPES_SRC="${ROOT}/node_modules/@opencode-ai/sdk/dist/v2/gen/types.gen.d.ts"
SDK_TYPES_DST="${VENDOR_DIR}/sdk-types.d.ts"
OPENAPI_DST="${VENDOR_DIR}/openapi.json"
BRANCH="${OPENCODE_REF_BRANCH:-}"
OPENCODE_PORT="${OPENCODE_REF_PORT:-5031}"

mkdir -p "${VENDOR_DIR}"

if [[ ! -d "${SRC_DIR}/.git" ]]; then
  clone_args=(--depth 1)
  if [[ -n "${BRANCH}" ]]; then
    clone_args+=(--branch "${BRANCH}")
  fi
  git clone "${clone_args[@]}" https://github.com/anomalyco/opencode.git "${SRC_DIR}"
else
  echo "OpenCode source already cloned at ${SRC_DIR}"
fi

if [[ -f "${SDK_TYPES_SRC}" ]]; then
  cp "${SDK_TYPES_SRC}" "${SDK_TYPES_DST}"
  echo "Copied SDK types to ${SDK_TYPES_DST}"
else
  echo "WARN: ${SDK_TYPES_SRC} not found — run npm install first." >&2
fi

if curl -sf "http://127.0.0.1:${OPENCODE_PORT}/doc" -o "${OPENAPI_DST}"; then
  echo "Saved OpenAPI spec to ${OPENAPI_DST}"
else
  echo "WARN: could not fetch OpenAPI from http://127.0.0.1:${OPENCODE_PORT}/doc (start opencode serve first)." >&2
fi

echo "OpenCode reference ready under ${VENDOR_DIR}"
