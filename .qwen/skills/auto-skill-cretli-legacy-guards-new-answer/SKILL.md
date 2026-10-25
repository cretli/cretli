---
name: cretli-legacy-guards-new-answer
description: When a Cretli leaf wires a richer/tri-state producer answer into an existing call path, audit legacy consumer guards of the shape `flag === true && payloadField`, and audit the FIX itself the same way — a gate or enum value the fix invents can be reachable only by tests or only outside the contract's closed vocabulary, so green suites hide a new dead/worse branch.
source: auto-skill
extracted_at: '2026-10-07T16:22:05.388Z'
---

# Legacy guards vs. a newly-honest producer answer

Trigger: your leaf adds or expands a **producer** answer that a call path already consumes — a durable
`lookupRequest`, a capability surface, a tri-state instead of a boolean, a `null` that used to be
`false`, or an extra field on an existing return object. The new code itself passes its own unit tests;
the defect is one call site *away*, in a guard written when the producer could only lie differently.

Companion: **cretli-delegation-implement** (the round mechanics), **cretli-delegation-review** (the
same audit from the read-only side).

## The pattern, verbatim from the R6 chat-run leaf (2026-10-07)

The leaf landed a durable request lookup whose honest answer was tri-state:

```js
accepted: true,   // row.acceptance.state === 'accepted'  (proof the executor took it)
runId:    '',     // acceptance.adapterRunId may be legitimately empty — recordExecutorAck() accepts ''
```

Its in-process consumer, written before any kernel transport could answer at all, was:

```js
const found = lookupChatRunRequest({ chatId: chat.id, requestId });
if (found?.accepted === true && found.runId) { return { runId: found.runId, accepted: true, … }; }
// … falls through to adapter.start() → sends the prompt AGAIN
```

The `&& found.runId` conjunct demands a *detail* the producer only sometimes has, so it collapses
"proven accepted, run id unknown" into "not accepted" — and the idempotency guard silently becomes a
duplicate-run launcher: a retry of a request the durable store already recorded as accepted sends the
prompt a second time and starts a **second attempt**.

## Why the brief can lead you to fix the wrong half

Acceptance prose like "`true` = `acceptance.state==='accepted'` **+** durable `adapterRunId`" tempts you
to make the *producer* refuse that row. Don't. It has no correct tri-state home:

- `false` means "a run row exists with NO acceptance proof" — a lie for a row that *has* proof;
- `null` means "nothing proven / unreadable" — also a lie;
- either way the consumer still falls through and re-launches, so the user-visible bug survives.

Keep the producer honest (`accepted` is proven by state; `runId` is a separate, possibly-empty field)
and **relax the consumer to key on the proof alone**. Then document the semantics at both ends, because
the next reader will re-add the conjunct.

## The audit step to run whenever a leaf expands a producer

1. **Enumerate consumers by grep, not by the brief.** `grep -rn "<exportedLookupFn>\|<capabilitiesFn>" lib routes server.js`
   — the brief never lists them, and *your own earlier grep is a lie if you stop at the first two hits*.
   `lookupChatRunRequest` actually has **five** call sites (found by `grep -rn "lookupChatRunRequest("` over
   `lib/` + `server.js`, which also shows you there is no separate top-level `routes/` dir — it is `lib/routes/`):
   `chat-run-service.js` `startChatRun` (in-process replay), `delegation-mailbox.js:460` + `:613`,
   `workspace-watcher.js:1491`, and `workspace-watcher-cycle.js:780`. I first wrote this skill claiming
   "only two consumers" and was wrong twelve minutes later — enumerate, then re-enumerate after the fix.
   Separately: `resolveDelegationAdapterCapabilities` (lib/delegation-adapter-capabilities.js) reads only
   `canLookupRequest`/`canCancel`/`canReconstructSession`, so the 9 new capability keys were inert there
   — check, don't assume.
2. **Look for a proof flag AND-ed with a payload field**: `=== true &&`, `if (!x.id)`, `x.ok && x.runId`,
   or a `|| fallback` that re-widens a deliberately narrow answer.
3. **Decide whose defect it is with `git diff`, not with intuition.** If the bad conjunct shows up as a
   *context* line, it predates your leaf — but if your leaf is what makes that branch **reachable** (on
   R6, kernel adapters had `canLookupRequest:false` and no `lookupRequest` at all, so `found` was always
   `null` and the conjunct was dead code), then it is a regression *introduced by* this leaf and yours to
   fix. State exactly that in the report: "pre-existing line, newly reachable".
4. **Reachability check on the empty/extra value.** Ask "can a caller actually produce this shape today?"
   Trace the producer's own writer (`recordExecutorAck` accepts `adapterRunId: text(src.adapterRunId)`,
   i.e. `''`) and the runtime source (`acceptRoomPrompt` returns `room.currentRun?.id || ''`, and real
   kernel rooms assign `room.currentRun` synchronously inside `startPrompt`, before the first `await` —
   so it *does* hold for codex/qwen/deepseek/claude, and the empty case comes from the ack, not the room).
   An unreachable shape is a documentation note; a reachable one is a bug.
5. **Then check reachability one level UP: does anything write the producer's input at all?** A
   producer/consumer pair that *can* carry the shape is still not a live defect if no production code
   emits the row. On R6 the mailbox conjuncts looked identical to the one I fixed, but
   `grep -rn "beginRunLaunch\|recordExecutorAck\|writeRunIntent" lib server.js routes | grep -v '^lib/recovery/'`
   returned **zero non-test callers** — durable recovery rows did not exist in production yet, so
   `getRunByRequestId` could only return `null` and the branch stayed dead until a later leaf (R8/R10/R12)
   wires recovery in. Classify that as **latent debt, non-blocking for this leaf**, and hand it forward in
   Workspace Memory (key + the exact `file:line` + the trigger that makes it live) rather than expanding
   the leaf's scope or silently dropping it. A reviewer independently reached the same downgrade, citing
   that `deliveryRequestId` is preserved and the fixed `startChatRun` replays on proof alone — so the
   observable harm was a wrong status and an ineffective retry, not a duplicate prompt.

## Two more consumer shapes of the same class (both caught in R6 review, 2026-10-07)

The `flag && payloadField` conjunct is not the only way a consumer mis-handles a newly-honest answer:

- **An early-return branch keyed on the new proof that skips the fallback probe.**
  `isWorkspaceWatcherActiveCycleChatAlive` (`lib/workspace-watcher.js:1492-1501`) added nothing, but its
  existing `if (found?.accepted === true)` branch ends in `return false` when both the durable
  `adapterRunId` and the cycle's own `runId` are empty — so it never reaches the chat-scoped probe below,
  and a `state_missing` (room-gone-after-restart) run is reported DEAD. Dead-on-arrival was masked
  pre-R6 because kernel `lookupChatRunRequest` always returned `null` and fell through to the probe.
  A wrong `false` here is severe: it feeds claim release (`workspace-watcher.js:1594`), cycle-stall abort
  (`workspace-watcher-cycle.js:1273`/`:1315`) and history repair (`:1882`) — i.e. it can abandon a live
  orchestrator cycle.
- **A "context preserved" claim derived from mere presence.** In the lookup result,
  `transcriptLost: roomMissing || contract.transcriptLost` means a reattach-capable contract (opencode,
  where `contract.transcriptLost` is `false`) reduces to `rooms.has(sessionKey)`. A room *recreated*
  after a restart, an idle room with no `currentRun`, or a room holding a **different** run all falsely
  report the transcript as preserved. Presence of a key in the Map is not proof that it holds *this*
  run's context — require the room's `currentRun.id` to match the durable `adapterRunId`, and treat an
  empty `adapterRunId` as can-never-prove-preservation. Also keep the runtime and the metadata honest
  together: if `canReattach` is false you must not still report reason `'none'` / strategy
  `server_reattach`.

**Cheapest tie-breaker when you cannot tell which branch is wrong: read the consumer function's own
JSDoc invariant.** That function literally documented "A missing room (`state_missing` /
`adapter_missing` …) is still 'alive' here. Claim release and boot reconcile depend on that." The new
proof-keyed branch contradicted a rule the same author had written down, and the docstring named the
blast radius. Grep the invariant text before arguing about intent.

**A test that asserts on an absent room passes for the wrong reason.** Same lesson applies to the new
shapes: seed the room into the Map (idle, or holding a different run) so the branch under test is
genuinely reachable, and assert the side effect, not the return object.

## The fix-side trap: a gate that only tests satisfy (R6 round-3, 2026-10-07)

Fixing a presence-based claim can silently swap one dead branch for another. The B2 fix gated the
honest observation on a **new** parameter:

```js
const effectiveReattach = contract.reattach === true && reattachCapability === true;  // kernel-adapter.js:131
```

`reattachCapability` was optional and **no production caller ever passed it** — `grep -rn
"reattachCapability" lib` hit only the module's own param/capabilities lines plus tests, while all five
`registerKernelChatRunAdapter` sites (codex `:537`, claude `:1754`, qwen `:790`, deepseek `:705`,
codebuddy `:556`) and opencode's direct `createDurableRequestLookup` (`opencode-agent-ws.js:1865`) omit
it. So `undefined === true` is false, `effectiveReattach` was **always false in production**, and the
fix produced three silent inversions:

- the live-reattach path became unreachable: a healthy, matching live OpenCode run got
  `transcriptLost:true` / `fresh_turn_in_saved_session` instead of `'none'` — the *new* bug was worse than
  the one being fixed, and it was the conservative-looking direction, so green tests felt safe;
- `resumeStrategy: effectiveReattach ? contract.resumeStrategy : ''` blanked
  `agent_resume`/`session_resume`/`resume_thread`/`session_id` for **every** non-opencode MVP transport,
  while `getChatRunAdapterCapabilities` still reported them from the same table — two surfaces, one
  question, opposite answers (`tests/kernel-chat-run-adapter.test.js:226` asserted
  `caps.resumeStrategy === 'resume_thread'` for codex next to a lookup returning `''`);
- the downstream consequence was deferred, not local: `resolveRecoveryDecision` rule 4 requires a
  non-empty `descriptor.resumeStrategy`, so R8/R12 would degrade every MVP transport to `manual_only`.

Three checks worth running on **any** fix, as the parent before you accept it:

1. **Grep every new parameter/gate the fix introduces for a production caller.** If the only hits are the
   defining module and `tests/`, the intended branch is dead and you must say so — a flag defaulting to
   `undefined` is *not* opt-in, it is off. Fix the DEFAULT (absent ⇒ "no narrowing", mirroring the
   existing `caps.canReattach !== false` rule), don't sprinkle `: true` across N registration files and
   leave the default broken.
2. **Require a production-path test** that drives the real registration/call shape *without* the flag.
   Hand-feeding `reattachCapability: true` into `createDurableRequestLookup` is exactly what let the fix
   look covered while production stayed dark.
3. **Diff the same value across surfaces.** When a fix narrows one view of a shared table, assert the
   per-run lookup and the capabilities surface agree per transport; "may report LESS" must never mean
   "may silently disagree".

Related half-lesson from the same round: a fix may also **emit a new string outside the contract's closed
vocabulary**. `no_live_run_match` was legal-looking to the producer but is absent from
`RUN_TRANSCRIPT_LOSS_REASONS` (exactly 4 tokens), so the sanctioned
`normalizeRunTranscriptLossReason()` maps it to `''` — the explicit signal the leaf exists to produce was
blanked one level down. The closed-vocabulary test stayed green because **it compares the list, never the
producer's output**. So when a fix introduces a new enum-ish value: register it in the contract module,
bump the documented revision, update the table in the doc, and add a guard that asserts
`normalize(produced) === produced` for **every value the producer can emit, enumerated at runtime** — not
a hardcoded second list that can drift again.

## Proving it: assert the side effect, not the return value

A replay defect looks fine if you only assert the result object. Assert the *counter of the thing that
must not happen*:

```js
const { room, calls } = makeRoom();            // calls.startPrompt, room.busy
rooms.set('sess-no-runid', room);              // idle room → the fall-through WOULD start
const replay = await startChatRun({ chatId: chat.id, prompt: 'must not be sent again', requestId: ids.requestId });
assert.equal(replay.runId, '');                // documents "proven ≠ identified"
assert.equal(calls.startPrompt, 0);            // the real guard
assert.equal(room.busy, false);
```

Pre-fix signature was `AssertionError: expected '' actual 'run-live-1'` — i.e. the retry had started a
fresh live run. Post-fix 10/10. The idle room in the `rooms` Map is essential: with the room missing,
`getChatRunStateForChat` returns `null` and the fall-through may be blocked for an unrelated reason, so
the test passes for the wrong reason.

## Scope defence

A brief clause like "do NOT make `startChatRun` auto-resume / launch new attempts" reads as forbidding
the edit but is satisfied by it: the fix *reduces* launches. Touch the consumer, keep it to the one
condition plus a comment, and list it under deviations as "one line, in a function the brief named as
off-limits for *feature* work" rather than skipping the fix and leaving a duplicate-run bug.

## Report wording that survived review

Separate the three honest claims: the producer contract (`accepted`/`runId` semantics, unchanged), the
consumer fix (the bug, with its pre-fix failure line), and the pre-fix-green additions labelled as
**locks, not evidence** — one of my two new tests (the qwen/deepseek capability surface) was already
green before the fix, so claiming it "proved the finding" would have been false.

## Resolution shape when two surfaces must agree (R6 round-4, F1, 2026-10-07)

Check #3 above ("diff the same value across surfaces") was satisfied here by *aligning two expressions*,
which is the wrong fix — it leaves the divergence one edit away. Note how the finding was actually
reachable in both directions:

- the aggregate view `getChatRunAdapterCapabilities` intersected the contract with the registered
  adapter: `canResumeSession = contract.canResumeSession && caps.canResumeSession !== false`;
- the per-run `createDurableRequestLookup` used the **raw contract** half —
  `contract.canResumeSession && …` — and accepted **no** runtime resume input at all.

So a runtime that explicitly disclaimed resume was honoured on one surface and ignored on the other, and
the adapter carried a comment claiming it narrowed "the SAME way the capabilities surface does". **A
prose claim of shared derivation is not shared derivation.** Treat that class of comment as a finding to
verify: grep the sibling site and compare the boolean expressions term by term; one missing
`&& input.XDeclared !== false` factor is the whole bug. It can be latent (no registration set
`canResumeSession:false`) and still be the leaf's defect, because the leaf *is* the contract surface.

The durable fix, in the order that generalises:

1. **Extract one pure module** returning the *whole* derived bundle — here
   `lib/chat-run/adapter-capabilities.js#resolveEffectiveRecoveryCapabilities({contract,
   canReattachDeclared, canResumeSessionDeclared})` → `{canReattach, canResumeSession, resumeStrategy,
   transcriptLost, transcriptLossReason}` — with **zero imports** and the contract half still coming only
   from `describeRecoveryAdapterContract` (so no second adapter table reappears). Have **both** surfaces
   consume it. Now agreement is structural, not intent-based.
2. **Thread every declarable input from a single place.** `registerKernelChatRunAdapter` reads
   `reattachCapability` and `canResumeSessionCapability` from one `input` and injects both into
   `capabilities` *and* the lookup factory, so an adapter cannot express the same fact twice.
3. **Kill duplicate literals at the registration site.** opencode built the lookup without any capability
   input while independently hardcoding `canReattach: true` in its capabilities object — two literals, one
   truth, silently divergent. Declare it once (`const OPENCODE_REATTACH_CAPABILITY = true`) and pass that
   constant to both.
4. **Pin it with a structural test, not just behavioural ones.** Behavioural cross-asserts
   (`lookup.resumeStrategy === caps.resumeStrategy` per transport × per declaration) cannot catch step 3
   regressing. Add a guard that reads the registration source and asserts the reattach capability reaches
   both call sites through the single constant — the only test that fails when someone re-splits it.
5. Fix the comment in the same commit, and state in the report whether the refactor changed observable
   behaviour for existing registrations (it should not; a reviewer should confirm value-for-value that
   nothing silently narrowed a live transport).
