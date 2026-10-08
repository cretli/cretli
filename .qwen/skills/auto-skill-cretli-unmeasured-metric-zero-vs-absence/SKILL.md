---
name: cretli-unmeasured-metric-zero-vs-absence
description: When a Cretli leaf makes an optional metric (usage/cost/tokens/count) non-null, zero-initialized accumulators plus an unconditional return literal fabricate `0` for a dimension that was never measured, and a consumer testing "is it a finite number" prints it as a real cost — audit the branch matrix (tokens-only, usd-only, bare marker, empty, throw) against what the tests actually assert, because a green suite (53/53 + eslint + review-verify exit 0) proved none of them, and a reviewer caught it.
source: auto-skill
extracted_at: '2026-10-07T17:38:15.599Z'
---

# An unmeasured metric dimension must never become a stored or rendered zero

Trigger: your leaf turns a field that used to be permanently `null` into a real aggregate — usage,
cost, tokens, latency, counts — and the acceptance text contains a **tri-state** requirement. Cretli
Scout leaf 5.3 (todo `075f151f`, cycle `98861a6c`, 2026-10-07) literally required
"zmierzone usage **albo brak danych**" and "**brak usage nie wygląda jak koszt zero**".

Two-sided failure, both ends of the same wire. Real case: `summarizeScoutScanUsage` in
`lib/workspace-watcher-scout.js` accumulated with `let tokens = 0; let usd = 0;` and returned
**unconditionally** once its flag flipped:

```js
let tokens = 0, usd = 0, eventCount = 0, measured = false;
for (const event of events) { … if (!(tokenTotal > 0 || hasUsd || event.measurementPresent)) continue;
  measured = true; eventCount += 1; if (tokenTotal > 0) tokens += tokenTotal; if (hasUsd) usd += usdValue; }
if (!measured) return null;
return { tokens: Math.round(tokens), usd: Number(usd.toFixed(6)), eventCount };   // ← fabricates zeros
```

So a scan with tokens but no priced USD stored `usd: 0`, and a scan whose only signal was
`measurementPresent: true` stored `tokens: 0` **and** `usd: 0`. The renderer then read
`asCount(usage.usd)` where `asCount(0)` is not `null`, so "no measurement" printed as `$0` /
`0 tokens` — the exact misreading the spec forbids, in the one direction the rule exists for.

- **Producer bug shape:** a `measured` *boolean* gating a return that emits *all* accumulator fields.
  The accumulators' initial value is a real number, so absence and zero are indistinguishable downstream.
- **Consumer bug shape:** treating "is it a finite number" as "was it measured". Any `0` passes that test.

## The 60-second audit that finds it (do this BEFORE calling the wiring done)

1. **Write the branch matrix** for the producer, then check which branches any test asserts:
   `tokens only` / `usd only` / `both` / `bare measurement marker, no numbers` / `empty source` /
   `reader throws`. The Cretli leaf had ~20 green tests covering `null`, `both` and the throw —
   and **nothing** for tokens-without-usd or marker-only. Those two rows were the defect.
2. **Grep the assertions, not the pass count.** A suite that asserts `usage === null` and
   `usage.usd > 0` cannot fail a producer that invents `usd: 0`. "53/53 pass", a clean
   `npx eslint` and `node scripts/review-verify.js <ids>` exit 0 were all green here and all blind:
   **a green gate proves only what its cases assert**, so when you accept or hand off an implement
   round that touches an optional metric, restate the matrix in the review brief and ask the reviewer
   to name which rows are untested. On this leaf the independent review (job `fce04895`) returned
   `VERDICT: FAIL` on exactly that uncovered row while passing four other clauses with file:line proof.
3. **Read the producer's `return` literal and the consumer's reads side by side**, checking the
   KEY NAMES too (`tokens` vs `totalTokens`, `usd` vs `costUsd`, `eventCount` vs `events`). A
   key mismatch renders "no data" forever with every test still green — the same silent direction.
4. **Reproduce without the harness when the tree is hostile.** Trying to import the module and call
   it with a stubbed `deps.readUsageEvents` died on an unrelated `ReferenceError` from another cycle's
   in-flight edit (`DELEGATION_ACK_REASONS is not defined` in `lib/mcp/builtin/delegation-tools.js`).
   Falling back to reading the function body + its tests was still conclusive; don't mistake a broken
   import for an unprovable defect, and don't "fix" the foreign file.

## The rule to put in the brief (producer + consumer, with its keep-list)

Producer: emit a dimension **only when it was actually summed from a positive value**; a bare
"something happened" marker may emit a count but must not emit `0` for money or tokens; if nothing
numeric arrived, return `null` (absence), not an object of zeros. Consumer: keep the
`null` → explicit "no data" label path, and let a genuinely stored `0` print (the store is then
telling the truth) — so the fix belongs on the producer side, not by deleting the number path.
Do not let a cheap model "fix" this by pricing the run: forbid estimating cost from a rate table.

State the keep-list explicitly, because the fixer will otherwise widen the change: the identity match
(`chatId`, optional `runId`), the fail-safe `catch → null`, the injectable reader seam,
"empty ⇒ null", the settle writing `patch.usage` only when the object is truthy, and the normalizer
mapping `{}` → `null`. In Cretli that last pair was already correct and must stay: the store never
fabricated the zero, only the aggregation did.

Require tests that **fail before the fix** and assert absence rather than falsiness — `!('usd' in
usage)`, not `usage.usd === undefined` — plus a renderer case: usage with tokens and no `usd` must
not produce a `$0` / `0 USD` string anywhere in the row.

## Companions

- **cretli-legacy-guards-new-answer** — the mirror problem: consumers whose *guards* assume the old
  shape. Here the guard was `asCount()` treating `0` as a measurement.
- **cretli-orchestrator-failed-child-partial-landing** — this defect shipped from a crashed child's
  landed work that the parent then verified as green; verifying "it loads and its tests pass" is not
  verifying "it covers the clause".
- **cretli-delegation-review** — hand the reviewer the branch matrix and the clause text; that is what
  turned a PASS-looking round into a real FAIL.
