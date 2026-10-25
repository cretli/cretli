#!/bin/bash
# usage: tc-moved.sh <todo8> — accept moved type errors only if the total does not grow; updates docs/typecheck-baseline.json
cd "${CRETLI_ROOT:-$(git rev-parse --show-toplevel)}"; S=$SCRATCH; t=$1
git show HEAD:docs/typecheck-baseline.json > $S/head-baseline.json
node scripts/typecheck-ratchet.mjs --update >/dev/null 2>&1; cp docs/typecheck-baseline.json $S/now-baseline.json
node -e '
const a=require(process.argv[1]).projects, b=require(process.argv[2]).projects, files=new Set(require("fs").readFileSync(process.argv[3],"utf8").split("\n").filter(Boolean)); let ta=0,tb=0; const grew=[];
for (const p of new Set([...Object.keys(a),...Object.keys(b)])) { const fa=a[p]||{}, fb=b[p]||{};
 for (const f of new Set([...Object.keys(fa),...Object.keys(fb)])) { const x=+fa[f]||0, y=+fb[f]||0; ta+=x; tb+=y; if (y>x && !files.has(f)) grew.push(f+" "+x+"->"+y); } }
console.log("total",ta,"->",tb); if (grew.length) console.log("GREW outside leaf:\n"+grew.join("\n")); process.exit(tb>ta||grew.length?1:0);' $S/head-baseline.json $S/now-baseline.json $S/f-$t
r=$?; [ $r != 0 ] && git show HEAD:docs/typecheck-baseline.json > docs/typecheck-baseline.json || { grep -qx docs/typecheck-baseline.json $S/f-$t || echo docs/typecheck-baseline.json >> $S/f-$t; }
exit $r
