#!/bin/bash
# usage: bounce.sh <todo8> "<problem>" — append a fix note with the patch path, reject integration -> ready
cd "${CRETLI_ROOT:-$(git rev-parse --show-toplevel)}"; S=$SCRATCH; OP=$S/op.sh; t=$1
P=$(ls -t data/worktree-results/$t*/*.patch | head -1)
printf '## Integracja %s (operator): zwrot do poprawki\nReview PASS, ale integracja nie przeszła: %s\nPoprzedni patch: `%s` — przenieś te zmiany na aktualny master (bez docs/typecheck-baseline.json i tests/fixtures/front-size-baseline.json; nie podnoś ich), popraw powyższe, sprawdź dotknięte testy i typecheck, potem nowe independent review.\n' "$(date +%F)" "$2" "$P" > $S/notes/$t
python3 -I $S/body.py $t $S/notes/$t | head -c 50; echo
for attempt in 1 2 3; do
  sleep 1; U=$(bash $OP todo_show "{\"todo_id\":\"$t\"}" | sed -n 's/.*updated: //p')
  r=$(bash $OP todo_integration "$(jq -nc --arg t $t --arg u "$U" --arg r "Operator: $2" '{todo_id:$t,action:"reject",expected_updated_at:$u,reason:$r}')")
  echo "$r" | grep -q "reject ok" && { echo "rejected $t"; break; }
  echo "retry $attempt: $(echo "$r" | head -c 80)"
done
