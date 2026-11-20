#!/bin/bash
# waits until at most $1 active cycles (max $2 min), restarts the server, then clears blocked backoff of the given todo ids
OP=$SCRATCH/op.sh; max=$1; mins=$2; shift 2
for i in $(seq 1 $mins); do
  n=$(bash $OP operator_watcher_status '{}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).active_cycles.length)}catch{console.log(99)}})')
  [ "$n" -le "$max" ] && break; sleep 60
done
echo "$(date -u +%T) active=$n -> restart"; cd "${CRETLI_ROOT:-$(git rev-parse --show-toplevel)}" && bash scripts/task-restart-server.sh | tail -1
for i in $(seq 1 20); do sleep 3; c=$(curl -sk -m 3 -o /dev/null -w '%{http_code}' https://127.0.0.1:3011/login); [ "$c" = 200 ] && break; done; echo "login $c"; sleep 10
ids=$(printf '"%s",' "$@"); bash $OP operator_watcher_reset "{\"todo_ids\":[${ids%,}],\"confirm\":true,\"reason\":\"Codex orchestrators blocked on cooldown misread; prompt fixed in f1b6383c\"}" | head -c 80; echo
