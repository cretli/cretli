#!/usr/bin/env bash
set -euo pipefail

VENV_PATH="data/zai-sdk-venv"

if [[ -n "${ZAI_PYTHON_BIN:-}" ]]; then
  "$ZAI_PYTHON_BIN" -m pip install --disable-pip-version-check --upgrade zai-sdk
  exit 0
fi

PYTHON_BIN="${PYTHON_BIN:-python3}"
"$PYTHON_BIN" -m venv "$VENV_PATH"
"$VENV_PATH/bin/python" -m pip install --disable-pip-version-check --upgrade zai-sdk
