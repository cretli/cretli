---
name: cretli-poll-cursor-rev
description: Fix a poll-with-cursor buffer whose rows are mutated in place (status transitions) — the client's seq cursor already passed the row so the update is never delivered. Split seq (stable identity) from rev (per-write revision), pull by rev with sort-before-limit, and pair it with a keyed-upsert client merge so the re-delivered row resolves in place instead of duplicating.
source: auto-skill
extracted_at: '2026-10-07T16:56:52.571Z'
---

# Cursor invalidation for mutating poll buffers (seq vs rev)

Trigger: a "…" / pending row never resolves in a polled list, or an agent/consumer that pulls with
`since` + `nextSince` never sees a response/failure that belongs to an item it already pulled. The
root cause shape: the buffer **mutates a stored row in place** (same `seq`) and the cursor filter is
`seq > since` — so the write is permanently behind the client's cursor.

Observed and fixed 2026-10-07 in `lib/browser/buffers.js` (Browser `NetworkBuffer`:
`recordRequest` pushes with `status: null`, `recordResponse`/`recordFailure` → `update()` mutates the
same row). Same shape exists anywhere a row transitions in place: chat-history/event stores, usage
journal, watcher snapshots, todo changelog. **Verify the file/line claims against the live tree
before relying on them.**

## The two-counter design

- `seq` stays exactly what it was: caller-provided, stable per row, used as **identity** (the client's
  merge key). Do not repurpose it as the cursor.
- `rev` = new per-buffer monotonic counter (`this.rev = 0` in the constructor, reset in `clear()`
  alongside `total`/`dropped`) that increments on **every stored write**, and becomes the cursor.
- `push()` stores `{ ...bounded, rev: ++this.rev }` and returns the stored object (not the input).
- The in-place mutator (`update()`) keeps `seq` and the array position, and bumps
  `entry.rev = ++this.rev` so the mutation re-enters every cursor that already passed it.
- `pull()`: filter `Number(entry.rev) > since` → **`.sort()` by rev ASC → then `.slice(0, limit)`** →
  `nextSince = Math.max(rev of returned rows)` falling back to the incoming `since` when the page is
  empty. Sorting before the limit is what stops a cut from stranding a higher-rev (updated) row behind
  the page; `Math.max` (not "last row") keeps `nextSince` monotonic.
- Keep existing coercion of string `since`/`limit` from REST query params, and keep the returned shape
  (`{ entries, nextSince, dropped, total }`) byte-identical otherwise.

### Why existing tests usually survive

For an **append-only** buffer the two counters are order-equivalent by construction — `ConsoleBuffer`
assigns `seq = this.total + 1` and `push()` increments `rev` once per insert, so `rev === seq` and
assertions like "nextSince equals the max seq" keep passing untouched. State this explicitly in the
report; it is the argument that the cursor change is not a breaking wire change.

### Two micro-traps in the implementation

- Assign `rev` **after** `redactValue(...)` (which round-trips object keys and numbers, but caps at
  `maxItems` keys and could drop/mangle a field):
  `this.entries[i] = redactValue({...}); this.entries[i].rev = ++this.rev;` — writing into the stored
  slot beats mutating a local (`Record<string, unknown>` typing stays clean too).
- Adding a field widens the payload. Grep for tests asserting the entry shape
  (`assert.equal('headers' in entry, false)`) and for consumers that spread entries
  (`{ ok:true, ...payload }` in `lib/browser/agent-tools.js`, `routes.js`, `ws-handler.js`) before
  claiming "no blast radius".

## The paired client change is mandatory (never ship the server half alone)

A rev cursor re-delivers rows the client **already has** (same `requestId`, higher `rev`). A blind
`[...prev, ...entries]` merge then renders a duplicate stuck on the old value — i.e. the fix moves the
bug instead of removing it. Switch to a keyed upsert:

```js
function pullEntryKey(channel, entry) {
  if (channel === 'network') return `r:${String(entry.requestId ?? entry.seq ?? '')}`;
  return `s:${String(entry.seq ?? '')}`;
}
function mergePullEntries(channel, previous, entries) {
  const byKey = new Map();
  for (const entry of previous) byKey.set(pullEntryKey(channel, entry), entry);
  for (const entry of entries) byKey.set(pullEntryKey(channel, entry), entry);
  return [...byKey.values()].slice(-PULL_RENDER_MAX);
}
```

- `Map.set` on an **existing** key overwrites the value but keeps the original insertion position, so
  the row resolves **in place** (no reordering churn, no duplicate). New rows append.
- Key per channel: mutable rows key on their stable identity (`requestId`); append-only rows key on
  `seq` (never re-delivered, so upsert == append).
- Re-apply the render cap *after* the merge (`slice(-PULL_RENDER_MAX)`), not before.
- Keep consuming `payload.nextSince` as the cursor. Cretli has a **source-scan** wiring test
  (`tests/browser-panel-wiring.test.js`) that asserts `payload.nextSince` is used and forbids
  `payload.cursor` / `payload?.cursor` — inventing a second cursor field fails that test on sight.

## Proving the fix without touching a dirty shared tree

Do **not** `git stash` / revert files on a branch that holds other people's WIP. Two non-destructive
tricks used here (scratch under `/tmp`, never under `tests/` — `scripts/run-unit-tests.mjs` globs
`tests/*.test.js` and would auto-wire your throwaway into `npm test`):

1. **Pre-fix reproduction**: copy the module's sibling files to `/tmp/x/`, overwrite the target with
   HEAD, and run the repro against that copy — relative imports still resolve inside the copy:
   ```bash
   mkdir -p /tmp/bufpre && cp lib/browser/*.js /tmp/bufpre/
   git show HEAD:lib/browser/buffers.js > /tmp/bufpre/buffers.js
   node /tmp/bufpre/repro.mjs    # {"firstNextSince":1,"secondCount":0,"secondNextSince":1} = the bug
   ```
   Then import the **real** module by absolute path in the same script and print the fixed row
   (`secondCount:1, secondStatus:200, secondNextSince:2`). Also proves your new test is a genuine
   guard rather than a post-hoc lock. `rm -rf` the scratch afterwards.
2. **Behavioural check of an unexported front-end function** (no DOM harness, no repo test file you
   are allowed to edit): slice the source between two stable markers and eval it with its one
   dependency injected —
   ```js
   const src = readFileSync('app_front/features/browser/browserPanel.js', 'utf8');
   const body = src.slice(src.indexOf('function pullEntryKey'), src.indexOf('async function pullChannel'));
   const merge = new Function('PULL_RENDER_MAX', `${body}; return mergePullEntries;`)(200);
   ```
   Real code, zero copy-paste drift. Assert the three things that matter: one resolved row for the
   same `requestId`, seq-keyed append for console, cap preserved.

## Test-writing notes from this round

- Assert the whole cursor story, not just "the row came back": pending row + `nextSince`; update;
  same `requestId` **and same `seq`**, new status/`finishedAt`; `nextSince` strictly advanced; and a
  final pull with the new cursor returns `[]` (delivery is single-shot, no infinite re-send).
- Add the limit-stranding case separately (`limit: 1` after an update bumps an earlier row's rev) —
  it is the only assertion that justifies the sort-before-slice.
- **Write literal expected cursor numbers with an enumeration comment**
  (`// rev 1 = request a, 2 = request b, 3 = the response update`). A derived expression I tried first
  (`pull({since:0}).entries.length + 2`) was silently wrong (4 vs 3) because length ≠ max rev once
  rows are reordered by rev.
- Plain `assert` scripts abort at the first failure, so run each new test file with `node --test` and
  list `ok/not ok` lines to see all of them.

## Out-of-scope findings: report, don't fix

Adjacent defects noticed while verifying (list them under "remaining problems" for the parent; the
brief's file whitelist is binding):
- `lib/browser/agent-tools.js` still documents `since` as "Last seen **seq**" — after this change the
  cursor is a revision. Behavior is correct (`nextSince` round-trips), only the description drifts;
  that file was outside the allowed list.
- `browserPanel.js` `selectTab()` zeroes both cursors but only `reloadTabs()` clears `_crEntries`, so
  rows from two tabs of one session mix after a tab switch (pre-existing, harmless under the keyed
  merge because requestIds differ).
- When the brief forbids editing the front-end test file, note that the merge logic has no DOM-level
  test and that your verification was the `/tmp` source-slice eval — say which part is unverified
  rather than implying coverage you could not add.
