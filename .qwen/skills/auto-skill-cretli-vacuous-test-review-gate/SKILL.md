---
name: cretli-vacuous-test-review-gate
description: As the Cretli parent, a child's "N/N tests pass + VERDICT PASS" proves nothing about whether each acceptance clause is covered — write review briefs that hunt test-theater (deny-only tests, `code === 'a' || 'b'`, denies produced by an unrelated gate, fake peers that answer without inspecting the request), demand per-assertion "which line flips RED if the fix is removed" proof, and run the multi-round fix-loop bookkeeping (distinct findings_hash per round, content-sensitive material_revision, resume_rounds at the soft cap, mandatory 5+caught_bug ratings) that closes a security-shaped leaf.
source: auto-skill
extracted_at: '2026-10-08T04:37:15.167Z'
---

# Green suites hide absent features — gate on test *validity*, not test *color*

Trigger: you are the parent of a `cretli-multi-harness` loop (Workspace Watcher cycle or manual
plan→implement→review→fix) on a leaf whose clauses are protocol/security shaped (proxy, allowlist,
auth, SSRF, TLS, framing, tokens). The implement child returns `17/17 pass, VERDICT: PASS`.

Measured on 2026-10-08 (leaf `f36aae6c`, egress-proxy, 4 rounds, 50.9 min, 9 jobs): the first suite
was **17/17 green** while `ws://` was actually rejected with `400` (so WebSocket support did not
exist), request bodies larger than one TCP read were silently truncated, an unknown
`ws:<workspaceKey>` token inherited another workspace's allowlist (fail-closed violated), and
`Proxy-Authorization` was forwarded to the destination origin. Every one of those was caught by a
reviewer who was asked to attack the tests, not the code. The three later FAILs were all
**defects the fixes themselves introduced**.

Companions: **cretli-multi-harness** (loop contract, verdict→next-step rules),
**cretli-delegation-review** (child-side mechanics),
**cretli-orchestrator-failed-child-partial-landing** (crash/stub/spin recovery),
**cretli-skip-gated-e2e-in-ci** (the CI-skip cousin of this problem).

## 0. The rule

A green suite is evidence that *the assertions that exist* pass. It is not evidence that a clause is
implemented. Before delegating any review, do this yourself (read-only, and you must not edit the
workspace while a review runs anyway):

```bash
node --test tests/<leaf>.test.js        # reproduce the child's count + confirm "# skipped 0"
grep -nE "^test\(" tests/<leaf>.test.js | sed 's/(async.*//'   # map clause -> test NAME
```

Then compare that list against the leaf's numbered clauses. The tells of a missing/hollow clause:

- a clause covered only by a **deny** test when the clause demands the success path
  ("WebSocket support" tested as "denied WS never returns 101");
- tests that call a `validate*`/unit helper directly when the clause demanded **live end-to-end**;
- an assertion whose failure would be indistinguishable from an unrelated failure (see §1).
- a protocol test where the fake peer answers before reading the request.

Also grep the *production* path for the clause: `handleAbsoluteHttp` starting with
`if (!target.startsWith('http://') && !target.startsWith('https://')) return 400` is proof that
`ws://` could never work, regardless of what the suite says.

## 1. Anti-test-theater clauses to paste into every review brief

State: **"a test that passes for the wrong reason is a BLOCKER, not a nit."** Then enumerate the
shapes (these exact patterns were all found in one leaf):

1. **Existence-only asserts** — `assert.ok(res.headers['x-egress-deny'])`, `assert.equal(result.allowed,
   false)`, `assert.doesNotMatch(raw, /101/)` — any code passes. Require the **exact code**.
2. **Accepting several reasons** — `assert(code === 'self-origin' || code === 'dns-rebinding')`. Such a
   line stays green with the feature deleted. Forbid `||` in deny-code asserts.
3. **Deny from the wrong gate** — the target is allowlisted and the deny actually comes from an
   injected loopback DNS answer, so the policy branch under test is never reached. Require the test to
   make the intended branch the *only* one that can produce the outcome.
4. **Scheme/prefix mismatch** — `selfOrigins: ['https://app.example.com']` while the request is
   `http://app.example.com`: `normalizeOrigin` preserves the scheme, so `blockedOrigins.includes(...)`
   is false and the self-origin branch is unreachable while the test still "passes". Check that the
   fixture and the request agree on scheme/port/format.
5. **A fake peer that answers without inspecting the request** — the WS mock returned `101` to a bare
   `GET /sock`, so the test passed while the proxy stripped `Connection: Upgrade` and no real server
   would ever handshake. Require the fake to assert the request headers it actually received before
   responding.
6. **Count the bytes/frames, don't spot-check arrival** — for tunnels and duplex streams require
   occurrence counts (`(raw.match(/MARKER_A/g) || []).length === 1`) and a status-line count
   (`(raw.match(/HTTP\/1\.[01] \d{3}/g) || []).length === 1`), which is how duplicated WS frames and
   an appended `502` get caught.
7. **Pinning / rebinding needs a changing dependency** — a `lookup` that answers the same way every
   call proves nothing. Require a **counting** injected dependency: first call public, second call
   loopback/metadata, asserting the socket opened only to the first validated address.
8. **Error branches are usually untested** — explicitly ask for connect-refused, mid-stream error, and
   abort-during-connect cases, and for teardown/FD claims require an observable (`socket.destroyed`)
   rather than a `setTimeout`.
9. **The test fixture's *shape* differs from the real producer's wire shape** — the sharpest
   false-coverage trap, and it survives an otherwise-honest suite. Measured 2026-10-08 on the CDP
   debugger leaf `7514f021`: `tests/browser-debugger.test.js` was **9/9 green** (a reviewer even
   re-ran it) while a secret leaked in plaintext. The redaction test fed a *flat* hand-written shape
   `{name:'authorization', value:'Bearer …'}` that got masked only because the TEXT matched a Bearer
   regex — but Chrome's `Runtime.getProperties` actually returns
   `{name:'password', value:{type:'string', value:'hunter2'}}`: the sensitive identifier sits in the
   **sibling `name` field**, and the secret is nested at `value.value`. `redactValueInner`
   (`lib/browser/redaction.js`) masks a property only when the JSON **object key** is sensitive
   (`isSensitiveHeaderName(key)`), so neither the `name` nor the `value` key trips it and the whole
   thing leaks. Rule for any redactor / validator / allowlist / guard brief: **demand a fixture lifted
   from the REAL producer response** (paste the actual API/CDP/DB shape into the brief), and require
   the discriminant be exercised **where production puts it** — a field *VALUE* (`name:'password'`) is
   not an object *KEY*, and a nested `{value:{value:…}}` is not a flat string. A matcher that reads the
   wrong axis of the payload is the bug, and a test built on the convenient shape proves the matcher
   matches nothing real. This is a sibling of §1 #4 (scheme/prefix mismatch) but about the
   *discriminant's location in the payload*, not its format. Generalizes beyond redaction: any
   key-based lookup (allowlists, scope/role maps, header policies) must be tested against the
   producer's true `{discriminantField, valueField}` layout, not a flattened surrogate.

10. **A fix that adds the real-shape test can still leave the secret on sibling fields and on a second
   serialization path.** Measured on the same debugger leaf *after* the round-1 fix: the suite went
   9/9 → 14/14 and a real `Runtime.getProperties` fixture was added, yet two vectors still leaked.
   (a) The redactor zeroed the RemoteObject's `value`/`unserializableValue` for a sensitive name but
   **not its sibling `description`/`preview`**, so `{name:'pin', value:{type:'number', value:1234,
   description:'1234'}}` still emitted `1234` in `description` (same for `bigint`
   `unserializableValue`+`description`). (b) The `watch` path serializes with `returnByValue:true`,
   so the payload is a *plain object keyed by the variable name* matched by the **header** matcher
   (`isSensitiveHeaderName`), while the *scope* path is matched by the **variable-name** matcher
   (`isSensitiveVariableName`) — the same name (`accessToken`/`clientSecret`/`userPassword`/
   `sessionId`) was masked on one path and leaked on the other. Rule for any "mask this secret" fix
   brief: **enumerate every field of the structure that can carry the value, and every code path that
   serializes the same logical payload differently**, and demand a test per vector. Masking one field
   of one path is not "the secret is redacted"; two matchers for one job is the leak.

11. **A redaction/truncation budget measured on the container nesting silently kills the feature while
   keeping the security property.** The redactor capped depth at 5 (`DEBUGGER_REDACT_MAX_DEPTH`), but
   the real nesting `scopes→array→scope→properties→descriptor→value` is *exactly* depth 5, so every
   **benign** value collapsed to `[truncated]` — scopes returned names but never values (the "read
   scopes" clause was functionally dead) while the suite stayed green because the test asserted
   `scopes.length`, not a value. Assert **both axes** for any redactor: secret-absent (security) AND
   non-secret-present (function). This extends §1 #1 from "existence-only asserts" to **structure-only
   asserts** (`arr.length === N`, `Object.keys(...).length`) — a length/count assert proves the array
   is shaped, not that it carries data.

12. **A redaction/sanitizer fix must be proved across the WHOLE *grammar* of the producer's payload,
    not one shape — the same leaf (`7514f021`, CDP debugger) burned 4 extra fix/review rounds because
    each round fixed the one shape a reviewer happened to name and left the next sibling variant
    green-but-leaking.** The CDP `RemoteObject`/`Runtime` envelope alone has, at minimum, these
    distinct carrier shapes, and a redactor that handles a subset leaks the rest (each was found
    one-per-round with a *green* suite):
    - flat object keyed by the secret name `{accessToken:'LEAK'}` (the convenient test shape — see #9/#10);
    - the real `getProperties`/scope **descriptor** `{name:'password', value:{type:'string', value:'…'}}`
      (name is a sibling FIELD, secret is nested — #9);
    - a `RemoteObject` **envelope** `{type:'object', value:{…secrets by key…}}` — treat `type`/`value`/
      `properties`/`description`/`preview` as reserved and RECURSE into `value`;
    - **`value` as an array** `{type:'object', value:[{accessToken:'LEAK'},{count:1}]}` (`returnByValue`
      of an array expression) — walk each element, keep benign keys;
    - **array nested in array** `value:[[{accessToken:'LEAK'}]]` — the array-walk must recurse when an
      element is itself an `Array` (the round-5 residual; a one-level `.map`/`for` misses it). The fix
      must recurse to **arbitrary depth** with a sane depth cap, not add exactly one extra level:
      validate with a deliberately deep shape (`[[[{clientSecret:'LEAK'}]]]`) in your own probe, because
      a fix that recurses one more level than the last test passes the 2-level case and still leaks at
      3 (round-6 residual; the parent's probe must nest deeper than any single reviewer named).
    - **sibling keys next to `type`** on the envelope `{type:'object', accessToken:'LEAK'}` — mask any
      non-reserved key whose name is sensitive, keep benign (`note`);
    - **`ObjectPreview.properties[]`** `{type:'object', properties:[{name:'clientSecret', value:'…'}]}` —
      walk `properties` through the descriptor matcher;
    - `description`/`unserializableValue`/`preview` on a numeric/bigint RemoteObject (#10).
    Rule: when the leaf is "redact/mask/allowlist a producer payload", write the acceptance list as a
    **shape matrix** (one row per carrier shape the producer's own serialization mode can emit — here
    `returnByValue:true` yields plain objects AND RemoteObject envelopes AND arrays), require a
    fail-first test per row, and in the brief demand the fixer enumerate *every branch of its own
    recursion*, not just patch the named shape. Treat "leak in an exotic shape" as a BLOCKER for a
    security leaf (a `watch` expression legitimately returns nested arrays); only accept a
    "non-blocking" downgrade if the shape is provably unreachable in the producer.

13. **A no-shell reviewer's PASS is untrusted; when two reviews split PASS/FAIL on the same fix, FAIL
    wins — reproduce with your own probe before trusting the PASS or launching the next fix.** On this
    leaf grok r2 PASSed while a later round FAILed (RemoteObject treated as an atom) and the green suite
    stayed silent; the parent settled each dispute with a throwaway `/tmp/*.mjs` probe that imports the
    real redactor (`redactDebuggerPayload`/`redactValue`) and asserts `JSON.stringify(out).includes('LEAK')`
    per shape — confirming a real leak in ~10s with no repo edit and no review round spent. So: (a) for a
    redactor/validator leaf the parent's own shape-by-shape probe is the cheapest ground truth and should
    run *before* delegating the next fix; (b) aggregate a fanout conservatively (FAIL beats PASS); (c) a
    reviewer that says "not a blocker" about a leak shape is overridden by the parent's reproduction, not
    by another round — and a PASS that itself flags a residual (claude/sonnet r5's array-in-array caveat)
    is a FAIL-to-reproduce, not a close.

## 2. Hand the reviewer your own hypotheses — as falsifiable items, not verdicts

List the defects you found by reading the code as numbered `D1..Dn` with `file:line` and demand
**"CONFIRM or REFUTE each with evidence; do not just repeat them."** Two reasons: the reviewer
correctly downgraded a parent hypothesis in an earlier leaf when it gave the mechanism, and a parent
hypothesis presented as a fact gets rubber-stamped. Close the brief with
`Also audit independently (not on my list): …` — the highest-value findings here (the credential leak,
the unbounded header buffer, the un-removed `setTimeout` listener) came from that line.

## 3. For a reviewer with no shell: per-assertion revert reasoning

When the pick comes back `traits.review_can_run_tests: false` / `verify=required`, it cannot prove
anything by running. Make it prove it analytically — require, per claim:

> "does this assertion read the **CHANGED behavior**, or only the producer's output? Name the line
> that flips RED if the fix line were removed. If you cannot establish that, mark the item
> UNVERIFIED rather than OK."

That converts a no-shell reviewer into a vacuous-test detector. Then **you** must still run the host
catalog, or the PASS does not count: `delegation_verify({delegation_id, ids: [...]})`. Ids
auto-register from `tests/*.test.js` (the curated catalog only wins collisions), so a test file the
child just added is verifiable in the same cycle — `node scripts/review-verify.js <new-file-id>`.

## 4. "The fix is your prime suspect" — every re-review round

Fix rounds reliably introduce their own defects. In round ≥2 briefs say so explicitly and name the
failure classes the previous fix touched:

- **header rewriting** → over-stripping: `transfer-encoding` removed while the chunked body is still
  piped raw (malformed request); `connection` removed on a WS upgrade (handshake dead); and `TE` +
  `Content-Length` both surviving (CL/TE divergence — a smuggling class for a validating proxy).
- **single-response guards** → the opposite bug: a client left with no response and a socket never
  destroyed.
- **anonymously attached listeners** — `socket.setTimeout(ms, () => fail(...))` is *not* undone by
  `setTimeout(0)`: the listener survives, the next `armIdleTimeout` re-arms the timer, and a stale
  handler then appends a `502` after a valid response. Ask specifically for `removeListener` on
  every success path.
- **two mechanisms for one job** — a `pipe` plus a `data` listener duplicates every byte.

Re-list the prior round's blockers verbatim (they came from your own `record_findings` text) as a
regression gate, and require each earlier item be re-confirmed as un-regressed, not assumed.

## 5. Multi-round bookkeeping that actually bites

- **A new `findings_hash` per round.** Re-using the hash with an unchanged `material_revision` sets
  `stop_reason=same_findings` and ends the loop. Findings genuinely differ between rounds — record
  them and don't collide.
- **`record_findings` feeds the fix brief.** Pass `findings_text` to both `watcher_update
  (action=record_findings)` and `workflow_update`, and paste it into the next review brief as the
  regression gate. On PASS, clear the stored finding (empty `findings_text`) so the Scout does not
  re-flag a closed leaf.
- **The fix-start event must NOT re-carry `last_verdict: "FAIL"`** on still-unchanged material — that
  double-counts into a spurious `same_findings`. Write `role=fix, round=N+1, last_implementer=…` only.
- **`material_revision` from `git status --porcelain` is content-blind.** When the changed path *set*
  is stable (untracked files already listed), the hash is identical before and after ~1,400 lines of
  edits — observed: two rounds both fingerprinted `79b8329+50a627afbc19`. Hash the leaf's **file
  contents** (plus the porcelain list): `sha256(porcelain + Σ(path+content))`. Otherwise
  `same_findings` and "did the fix change anything" both silently lie.
- **The soft round cap fires mid-loop.** At `round=max_rounds` a `workflow_update` reports
  `stop=rounds_exhausted_soft`. The final gate review then cannot start. Lift it deliberately with
  `workflow_update {resume_rounds: true, max_rounds: N+1}` (a fresh `idempotency_key`) — it clears
  `stop` to `-` and reopens the gate. Do the same **before** starting the last fix round, not after a
  rejected start.
- **`deadline_at` is your knob, not a wall.** Set it generously for a greenfield security module
  (each review of a ~1,400-line module ran 8–15 min); extend it with a later `workflow_update` rather
  than letting starts fail on a past deadline.
- **`model_pick` results render as one compact line with no `pickId`.** Omit `pick_id` and put the
  reasoning in `pick_reason`; never fabricate one. Re-pick with `exclude_models` when a candidate has
  evidence against it — a `78%` observed `infra_fail_rate` on the top pick is a concrete, auditable
  reason to re-pick rather than burn the round.
- **Ratings are obligations, not courtesy.** Once the cycle proves a FAIL real (FAIL → fix → PASS),
  rate **each** FAIL-issuing review `5` + `caught_bug` (never `missed_bug` at 5). Rate a job whose
  report is a stub/`unspecified` down (`2` + `too_slow`). A reviewer that did careful no-shell work
  deserves a note that the parent ran `review-verify` for it.

## 6. Brief discipline that changed outcomes here

- Enumerate every leaf clause as its own numbered acceptance item and **quote the leaf's wording**
  (paraphrasing drops clauses — see the orchestrator-brief-paraphrasing memory).
- Forbid silent skips in the same breath: "a capability gate that hides an assertion is a BLOCKER".
- Require the child to report which **new test is RED before its change and why** — the cheapest
  possible test-validity check, and the one item that stopped this leaf from shipping renamed vacuous
  tests twice.
- Require the full report inline, not "see chat" (see the partial-landing skill for stub recovery).
- Scope-lock: name the files to touch, name the already-shipped gate not to weaken, and list the
  pre-existing foreign red suites so the child reports a baseline instead of "fixing" another cycle's
  work.
