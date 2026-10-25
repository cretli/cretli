---
name: cretli-orchestrator-mcp-session-loss
description: As a Cretli parent when the server restarts mid-cycle and every MCP tool returns "MCP session is unknown or no longer active": diagnose via serverInstanceToken, recover read-only evidence from data/*.json and scripts/review-verify.js, never forge the record by writing server state from the shell, and re-arm the wake so the verified gate is recorded rather than lost.
source: auto-skill
extracted_at: '2026-10-07T20:21:42.454Z'
---

# When the MCP bridge dies mid-cycle but the work is already verified

Trigger: you are the Cretli Workspace Watcher parent (or any `delegation_*` parent). Children finish,
you go to record the outcome, and **every** `cretli_bridge` tool answers:

```
MCP session is unknown or no longer active
```

This is not your bug and not the child's. The Cretli **server process restarted**, which invalidated the
session-scoped token your bridge process authenticates with. The cycle's *work* usually survived; only
your ability to **record** it died. Companion: **cretli-multi-harness** (loop contract),
**cretli-orchestrator-resume-foreign-round** (picking up a round across chats).

## 1. Diagnose in one shell call before assuming "MCP is broken"

```bash
ss -ltnp | grep ':3011'
ps -eo pid,etimes,cmd | grep -E 'node .*server\.js|cretli-mcp\.js --bridge' | grep -v grep
curl -sk -m 6 https://127.0.0.1:3011/api/health
```

Read `startedAt` / `serverInstanceToken` from `/api/health` and compare to what you saw earlier in the
cycle. In the observed run (2026-10-07, cycle 291a8808) `server.js` had `etimes=161` — ~2.7 minutes old —
while the old token had been captured hours earlier. A **new** token is the proof: restart, not misuse.
Also confirm a stable server (`200` on three consecutive probes) before concluding; a server that is still
flapping explains a `000` from `curl` and a dead bridge simultaneously.

Note the asymmetry: **reads** you performed *before* the restart are still valid, and child jobs keep
running and completing through the restart. Only your session is gone. Do not re-run finished children.

## 2. Recover the authoritative evidence READ-ONLY from disk

The server persists everything you were about to read through MCP. Reading it is legitimate forensics;
writing it is not (see §3). `data/` is gitignored, so this never touches version control.

```bash
node -e "
const raw=JSON.parse(require('fs').readFileSync('data/delegations.json','utf8'));
const rows=Array.isArray(raw)?raw:(raw.items||raw.delegations||Object.values(raw));
for(const r of rows){ if(WANT_IDS.includes(r.id)) console.log(JSON.stringify({
  id:r.id, status:r.status, taskOutcome:r.task_outcome,
  reportVerdict:r.reportVerdict,                       // <-- the SERVER's parsed verdict
  reportChars:String(r.report||'').length })); }"
```

Useful files: `delegations.json`, `delegation-mailbox.json`, `delegation-workflows.json`,
`delegation-ratings.jsonl`, `todos.json`, `chats.json`.

Two traps this clears up that MCP text output does not:

- **Trust `reportVerdict`, not your own regex over the report body.** A child's report can contain the
  `TASK:/VERDICT:` terminator **twice** (a re-delivered reply concatenated onto the original), which the
  loop contract says is `conflict`. Here the persisted `reportVerdict` was `"PASS"`, `status=completed`,
  and the mailbox row held `["VERDICT: PASS","VERDICT: PASS"]` — identical content, so a benign
  duplication artifact, **not** a conflict. Read the store, then judge; never let a regex you wrote over
  a truncated preview flip a real verdict.
- **`task_outcome:"unspecified"` can sit next to `reportVerdict:"PASS"`** on the same row. Do not read the
  weaker field as the verdict.

## 3. Replace `delegation_verify` by running the host catalog directly

The reviewer-PASS gate needs hard test evidence, and `delegation_verify` is only a wrapper around
`scripts/review-verify.js`. You can run it yourself and get the same exit code:

```bash
for id in kernel-chat-run-adapter recovery-store recovery-contract recovery-lifecycle \
          chat-run-accept sdk-chat-run-adapter; do
  printf "%-24s" "$id"; node scripts/review-verify.js "$id" >/tmp/rv.txt 2>&1
  echo "exit=$? $(grep -E '^# (pass|fail)' /tmp/rv.txt | tr '\n' ' ')"
done
```

Pair it with a fingerprint check so the evidence is provably about the *current* tree — recompute
`git rev-parse --short HEAD` plus a sha1 of `git status --porcelain` and confirm it still equals the
`material_revision` your reviews covered. If the fingerprint moved you must re-verify before recording.

But **do not read drift as damage.** On a workspace with many autopilot cycles sharing one dirty tree the
fingerprint moves constantly from *other* leaves, and a moved hash says nothing about yours. In the observed
run it moved three times (`8b3b0797` → `77be16e2` → `44f557f0`) with the leaf untouched each time. Attribute
before you panic:

```bash
ls -l --time-style=+%m-%d_%H:%M <each leaf-owned file>   # did MY files change, or only foreign ones?
grep -c "<sharedHelperSymbol>" lib/chat-run-service.js lib/chat-run/kernel-adapter.js   # wiring intact?
```

Then **re-run the suites anyway** — that, not the hash comparison, is what actually re-establishes the gate.
Expect the worst reading of a moved hash (the first time, this parent correctly suspected its own code had
been altered at 21:33 mtimes, and it had not: the hash was aggregating unrelated browser/scout/skill edits).

## 4. Do NOT forge the record

The tempting workaround is writing `todos.json` status, appending to the store, or otherwise hand-patching
server state from the shell. **Refuse it.** Marking a leaf `done` by editing files fabricates the audit
trail instead of creating it, bypasses the CAS/`expected_updated_at` discipline, and the next watcher tick
can overwrite it anyway. Same rule as never writing `plan.approvedAt`: the record must come from the
system that owns it.

So the correct end state when only the bridge is down is:

- the leaf stays **`doing`** (honest: not yet recorded as closed),
- the cycle is **not** reported `success` — but equally, do **not** report `blocked`/`failure` as if the
  *work* failed. The gate was met; the write did not happen. Say precisely that, and keep the cycle alive
  so it can still be recorded.

## 5. Re-arm the wake with the full gate baked in

A wake prompt is the only thing that survives this turn, so make it self-sufficient — it must let a future
turn record the result without redoing four rounds of work:

- every **job id verbatim** (`delegation_list` prints full UUIDs; never complete a truncated id — this
  parent confabulated tails several times in one cycle, and a wake prompt propagates a bad id);
- the exact `cycle_id`/`report_id`, `todo_id`, `material` fingerprint, and a per-finding closure table;
- each review's server-parsed verdict and which catalog ids passed, with exit codes;
- the retry order once MCP answers: `todo_show` (fresh `expected_updated_at`) → `todo_update done` →
  `workflow_update` under a **new** idempotency key → `workspace_memory_add` → watcher `report success`;
- and the explicit prohibition: do not write `data/*.json` from the shell as a substitute.

Re-check the bridge cheaply (`delegation_list` with a tiny limit) rather than assuming it stays dead —
`loop_wakeup` is session-only, so keep re-arming until the result is either recorded or genuinely
unrecoverable.

### Knowing when "unrecoverable" is actually reached

Re-arming forever is its own failure mode: it burns the workspace's per-day cycle budget on a session that
cannot come back. The decisive test is whether the **current** `serverInstanceToken` is the one your session
was minted against:

```bash
curl -sk -m 6 https://127.0.0.1:3011/api/health | head -c 130   # compare to your last-known token
```

In the observed run the server restarted **twice** mid-cycle (`fec63f55` → `cbdb8bd4`), and the failure
became decisive on the fifth wake: the server was still stably serving `cbdb8bd4` — no third restart, not
flapping — yet the session was still refused. That combination (stable current instance + continued
rejection) means the loss is **permanent for this chat**, not a race. Stop re-arming, label the last wake
explicitly as the last, and exit the loop. Two restarts in one cycle also predicts more, so keep each wake's
gate fully self-contained rather than assuming continuity.

### The durable loop state is the real recovery asset

Everything the parent recorded via `delegation_workflow_update` **survived both restarts**, because the
server persists it. Read it back before giving up on handoff — this is what lets a fresh watcher cycle record
the leaf without redoing four rounds:

```bash
node -e "
const raw=JSON.parse(require('fs').readFileSync('data/delegation-workflows.json','utf8'));
const arr=Array.isArray(raw)?raw:(raw.items||raw.workflows||Object.values(raw));
for(const w of arr) if(w.leafId==='<leaf>') console.log(JSON.stringify(
  {role:w.role,round:w.round+'/'+(w.maxRounds??4),verdict:w.lastVerdict,
   reviewer:w.lastReviewer,material:w.materialRevision,stop:w.stopReason||null}));"
```

Practical consequence: persist `role`/`round`/`last_verdict`/reviewer job ids/`material_revision` after
**every** report, not only at the end — that habit is what made this cycle recoverable when the session died
mid-recording. Hand the next parent a handover block in the wake (mode, round, implementer, reviewer,
material, open findings, fix-in-flight, stop reason, next role) plus a pointer to this row, and note in it
that the todo is `doing` because the **write** failed, so nobody misreports a verified leaf as `failure`.
