#!/bin/bash
# usage: integx.sh <todo8> <excluded-path>... — apply leaf patch to the working tree minus excluded paths; writes f-<todo8>
cd "${CRETLI_ROOT:-$(git rev-parse --show-toplevel)}"; S=$SCRATCH; t=$1; shift
P=$(ls -t data/worktree-results/$t*/*.patch | head -1); ex=""; for e in "$@"; do ex="$ex --exclude=$e"; done
[ -n "$(git status --porcelain)" ] && { echo "DIRTY"; exit 2; }
export GIT_INDEX_FILE=$S/ix-pre.index; rm -f $GIT_INDEX_FILE; git read-tree HEAD
git apply --cached --3way $ex $P >/dev/null 2>&1; rc=$?; u=$(git ls-files -u | awk '{print $4}' | sort -u | tr '\n' ' '); unset GIT_INDEX_FILE
[ -n "$u" ] && { echo "CONFLICTS $u"; exit 3; }
[ "$rc" != 0 ] && { echo "CONFLICTS (apply failed in temp index)"; exit 3; }
git apply --3way $ex $P 2>&1 | grep -vE "cleanly|Falling|Checking" | head -3
git ls-files -u | grep -q . && { echo "CONFLICTS"; exit 3; }
git status --porcelain | awk '{print $2}' > $S/f-$t; git reset -q; echo "applied files=$(wc -l < $S/f-$t)"
