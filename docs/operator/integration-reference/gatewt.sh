#!/bin/bash
# usage: gatewt.sh <todo8> — gates for a leaf already applied to the working tree (f-<todo8> lists files)
cd "${CRETLI_ROOT:-$(git rev-parse --show-toplevel)}"; S=$SCRATCH; t=$1; L=$S/t-$t.log
mods=$(grep -E '^(lib|app_front|scripts|harnesses)/.*\.(js|ts|mjs)$' $S/f-$t | grep -vE 'i18n/|app_front/api\.js' | xargs -rn1 basename | sed -E 's/\.(js|ts|mjs)$//' | sort -u | paste -sd'|')
T=$( (grep -E '^tests/.*\.test\.js$' $S/f-$t; [ -n "$mods" ] && grep -lE "/($mods)\.(js|ts|mjs)['\"]" tests/*.test.js; echo tests/front-size-ratchet.test.js; echo tests/architecture-acceptance.test.js; echo tests/i18n-harness-packs.test.js) | sort -u)
echo "tests: $(echo "$T" | grep -c .)"
for x in $T; do [ -f "$x" ] || continue; r=$(timeout 300 node $x >$L 2>&1; echo $?); [ "$r" != 0 ] && { echo "FAIL $x"; grep -E "^not ok|Error:" $L | head -2; }; done
npm run -s typecheck 2>&1 | grep -E -- "->|strict files must have"
npx eslint $(grep -E '\.(js|ts|mjs)$' $S/f-$t | while read f; do [ -f "$f" ] && echo $f; done) 2>&1 | grep -E " error "
echo "GATES-DONE $t"
