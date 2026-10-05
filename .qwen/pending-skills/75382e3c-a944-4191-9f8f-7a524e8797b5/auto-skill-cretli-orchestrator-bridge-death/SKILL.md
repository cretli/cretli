---
name: cretli-orchestrator-bridge-death
description: When the cretli_bridge MCP session dies mid-cycle during a Workspace Watcher orchestrator run ("MCP session is unknown or no longer active"), diagnose a server restart by correlating ps lstart/ss port data with failure onset, stop retrying after ~2 bounded waits, never self-implement or forge a REST/CLI report workaround, and turn the final chat message into the durable handoff (cause, stale/real verdict, code anchors) for the next cycle.
source: auto-skill
extracted_at: '2026-10-05T11:01:21.158Z'
---

# Surviving a dead cretli_bridge session mid-cycle (parent/orchestrator)

Trigger: you are the Workspace Watcher orchestrator (or any long Cretli chat) and calls via
`cretli_bridge` builtin-cretli tools (`todo_show`, `workspace_watcher_show`, `model_pick`,
`delegation_start`, `todo_update`, `workspace_watcher_update`, `chat_show`, `delegation_list`)
suddenly ALL start failing with:

```
MCP session is unknown or no longer active
```

possibly degrading further to `Tool "…" not found on MCP server "cretli_bridge"` (transport fully
detached). The first calls of the cycle worked — this is a **mid-cycle death**, not bad args.

Companion skills: **cretli-orchestrator-stale-finding** (the normal parent path: verify finding →
delegate → review PASS → close) and **cretli-delegation-implement** (child-side "report BLOCKED
when the session is dead"). This file is the *parent-side* operational playbook for when the bridge
dies and even the cycle report is unreachable.

## Root-cause pattern (confirmed 2026-10-05, cycle 7e92cbbc)

The Cretli main server restarted while the cycle ran. Sessions are registered server-side; after a
restart the old session ids are unknown forever and the client cannot re-mint them within the same
chat run. Evidence shape:

- cycle started 10:54:31Z, first `workspace_watcher_show` + `todo_show` OK;
- every subsequent call failed from ~10:55:14Z onward;
- `ps -eo pid,lstart,etime,cmd` showed `node … --env-file=.env server.js` with **lstart exactly at
  the failure onset** (12:55:14 local = 10:55:14Z at UTC+2 — remember ps prints *local* time while
  watcher snapshots are UTC).

## Diagnose (cheap, in order — cap the total effort)

1. **Confirm it's session death, not a per-tool glitch**: retry one cheap read that worked minutes
   ago (`todo_show` of the cycle's todo). If it also fails → all tools dead.
2. **Two bounded waits max**: `sleep 25` / `sleep 60`, then retry reads. Shell gotcha: a standalone
   `sleep` is BLOCKED unless the trailing comment matches the exact form
   `# intentional-sleep: <reason>` — a free-form comment like `# intentional pause: …` does not
   pass.
3. **Correlate once with process/port facts** (read-only, survives bridge death):
   ```bash
   ps -eo pid,lstart,etime,cmd | grep -E "server\.js|cretli-mcp\.js --bridge" | grep -v grep
   ss -tlnp | grep node
   ```
   If a `server.js` start time ≈ your first failing call, you have your cause. Do NOT keep
   retrying the bridge after that — the session is unrecoverable for this run.
4. **Check for a failure storm before concluding your cycle was unlucky**: the watcher snapshot's
   `previous_cycles` list (if you got it before dying) — many failures across *different* todos
   within minutes means the same restart killed several orchestrator chats. Repeating the loop
   harder doesn't help; server stability does.

## Hard decisions when the loop can't run

- **Do NOT implement the work yourself.** The orchestrator does not implement; delegating is the
  whole point, and the tree here carries a large concurrent human edit set (~160 dirty paths on
  `next/2026-09-28`) that you must not fight over.
- **Do NOT forge the missing calls.** No hitting the server's internal REST/CLI (`scripts/cretli-mcp.js`,
  `node scripts/chat-cli.js`) with a fabricated chat/cycle id to post the `workspace_watcher_update`
  "report" or `todo_update` anyway — a dead report path means the report is *not durable*, and a
  spoofed one is worse than none. The watcher's own readback will mark the cycle failed and
  re-queue the todo; that is the designed behavior.
- **Do NOT touch the todo status.** Leave it `doing` (the claim already set it). Never mark done
  without review PASS — obviously impossible here.
- **Do NOT start children** by any other transport (Cursor Task etc.).

## Make the final chat message the durable artifact

Chat history persists server-side (a restart doesn't lose stored events), so write an end-of-cycle
summary a *fresh* next-cycle orchestrator can use. Include:

1. **Cause + timestamps** (cycle id, server pid/lstart, failure onset, retry policy used).
2. **The bridge-free verification you already did** — did the finding/instrumentation actually
   exist in the tree? (grep/read/git status). E.g. confirmed "requested counters are NOT yet in
   the tree → next cycle really needs an implement child" (or the opposite: stale → skip child).
3. **Concrete code anchors for the next cycle**: file + function + approx line numbers, the
   existing mechanism to reuse, the test file + `npm run <script>` to prove it. Verified anchors
   cost you only local tools and save the successor a full re-discovery pass.
4. **What is inherently manual** (e.g. a "run the app, 3–5 chats, measure 60 s" scenario cannot be
   executed headlessly in a cycle) so the successor scopes its todo honestly instead of pretending
   numbers exist.
5. **Next step** in one line: re-claim the todo in a new cycle once the server is stable.

## The ordering lesson that makes this cheap

Do ALL bridge-free local verification (the stale-finding skill's Step 0/1: read cited lines,
grep for the defect, run the relevant `node tests/<x>.test.js`) *before and independently of* the
MCP-dependent steps, and batch the MCP reads you need at cycle start. A cycle doomed by bridge
death then still yields a verified, handoff-ready state; a cycle that discovers the bridge is dead
halfway through local work yields nothing but an error log.

## Language

Cretli todos here are Polish-language; write the end-of-cycle summary in Polish (paths, line refs,
commands verbatim), same as the companion skills dictate for children.
