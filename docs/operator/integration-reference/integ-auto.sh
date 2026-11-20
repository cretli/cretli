#!/bin/bash
# usage: integ-auto.sh <todo8> "<msg>" — apply (minus size baseline), gate, tighten baseline, commit; stash on any problem
cd "${CRETLI_ROOT:-$(git rev-parse --show-toplevel)}"; S=$SCRATCH; t=$1
out=$(bash $S/integx.sh $t tests/fixtures/front-size-baseline.json docs/typecheck-baseline.json 2>&1); echo "$out" | tail -2
echo "$out" | grep -q "^DIRTY" && { echo "STOP $t (working tree has someone else's changes; nothing touched)"; exit 1; }
echo "$out" | grep -q "^applied" || { [ -n "$(git status --porcelain)" ] && git stash push -q -u -m "operator: $t apply failed"; echo "STOP $t (apply)"; exit 1; }
g=$(bash $S/gatewt.sh $t 2>&1)
fails=$(echo "$g" | sed -n 's/^FAIL //p')
if [ -n "$fails" ]; then
  git stash push -q -u -m "operator: $t baseline check"; base=""
  for x in $fails; do [ -f "$x" ] && { timeout 300 node $x >/dev/null 2>&1 || base="$base $x"; }; done
  git stash pop -q
  for x in $base; do g=$(echo "$g" | awk -v x="FAIL $x" 'BEGIN{skip=0} $0==x{skip=2;next} skip>0 && /^(not ok|.*Error:)/{skip--;next} {skip=0;print}'); echo "baseline (fails on HEAD too): $x"; done
fi
if echo "$g" | grep -q -- "->"; then bash $S/tc-moved.sh $t && g=$(echo "$g" | grep -v -- "->"); fi
bad=$(echo "$g" | grep -vE '^(tests: |GATES-DONE)')
if [ -n "$bad" ]; then echo "$bad" | head -8; git stash push -q -u -m "operator: $t needs look"; echo "STOP $t (gates)"; exit 1; fi
node scripts/front-size-baseline.js --write >/dev/null; grep -qx tests/fixtures/front-size-baseline.json $S/f-$t || echo tests/fixtures/front-size-baseline.json >> $S/f-$t
bash $S/commit-int.sh $t "$2"
