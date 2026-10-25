#!/bin/bash
# usage: commit-int.sh <todoId8> "<message>" — commits the leaf's files from the working tree on top of the CURRENT HEAD
cd "${CRETLI_ROOT:-$(git rev-parse --show-toplevel)}"; S=$SCRATCH; OP=$S/op.sh; t=$1
export GIT_INDEX_FILE=$S/cm-$t.index; rm -f $GIT_INDEX_FILE; git read-tree HEAD
for f in $(cat $S/f-$t); do if [ -e "$f" ]; then git add -- "$f"; else git rm -q --cached --ignore-unmatch -- "$f"; fi; done
T=$(git write-tree); C=$(printf '%s\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n' "$2" | git commit-tree $T -p HEAD -F -); git update-ref HEAD $C; unset GIT_INDEX_FILE
git reset -q -- $(cat $S/f-$t); git log --oneline -1
U=$(bash $OP todo_show "{\"todo_id\":\"$t\"}" | sed -n 's/.*updated: //p'); sleep 1; bash $OP todo_integration "{\"todo_id\":\"$t\",\"action\":\"confirm\",\"expected_updated_at\":\"$U\",\"proof\":{\"simple\":true}}" | head -c 300; echo
