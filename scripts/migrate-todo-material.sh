#!/usr/bin/env bash
# One-off runbook: phase 0b externalization of todo leafMaterial.
# Run from a plain terminal OUTSIDE Cretli (stopping the server kills every chat and agent).
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="${HOME}/cretli-backup-todos-${STAMP}"

echo "== 1/6 dry run (writes nothing)"
node scripts/externalize-todo-material.js --data-dir data

read -r -p "Stop the Cretli server and migrate? [y/N] " ans
[ "${ans}" = "y" ] || { echo "aborted"; exit 1; }

echo "== 2/6 stopping cretli.service"
sudo systemctl stop cretli.service

echo "== 3/6 backing up data/todos -> ${BACKUP}"
mkdir -p "${BACKUP}"
cp -a data/todos "${BACKUP}/todos"
[ -d data/todo-material ] && cp -a data/todo-material "${BACKUP}/todo-material"

echo "== 4/6 migrating"
if ! node scripts/externalize-todo-material.js --data-dir data --apply --confirm-backup "${BACKUP}"; then
  echo "MIGRATION FAILED - server left stopped. Backup: ${BACKUP}" >&2
  exit 1
fi

echo "== 5/6 enabling CRETLI_TODO_MATERIAL_EXTERNAL=1 in .env"
if grep -q '^CRETLI_TODO_MATERIAL_EXTERNAL=' .env; then
  sed -i 's/^CRETLI_TODO_MATERIAL_EXTERNAL=.*/CRETLI_TODO_MATERIAL_EXTERNAL=1/' .env
else
  printf '\nCRETLI_TODO_MATERIAL_EXTERNAL=1\n' >> .env
fi

echo "== 6/6 starting cretli.service"
sudo systemctl start cretli.service
echo "Done. Backup: ${BACKUP}"
echo "Rollback: stop server, node scripts/externalize-todo-material.js --data-dir data --apply --inline-back --confirm-backup <fresh backup>, set flag to 0, start."
