# Usage and model-pick acceptance report (stage 9)

Conformance report for the token/measurement and model-pick work
(stages 1-8, leaf 9 `7845950e`). It records the frozen fixture, the single
cutoff, the ten mandatory scenarios, the exact suites that cover them, the
observed pass/fail output and the criteria that are still open.

## 1. Frozen fixture and cutoff

- Fixture: [`tests/helpers/usage-acceptance-fixture.js`](../tests/helpers/usage-acceptance-fixture.js)
  (frozen `Object.freeze` data, no wall clock, no network, no real `data/`).
- Single cutoff: `ACCEPTANCE_CUTOFF = 2026-10-10T12:00:00.000Z`
  (`ACCEPTANCE_CUTOFF_MS`), zone `Europe/Warsaw`. Every acceptance scenario
  derives its timestamps from this one origin, so the ten scenarios are
  comparable on the same frozen data.
- The suite is a **read-only** consumer: it writes only to throwaway temp data
  dirs (`mkdtempSync`) and never to `data/`.

Reproduce the acceptance suite:

```bash
cd path/to/cretli
node --test tests/usage-acceptance-usage.test.js \
            tests/usage-acceptance-decisions.test.js \
            tests/usage-acceptance-policy.test.js
```

Last run: **36 tests, 36 pass, 0 fail** (scenarios 1-3: 3 tests; 4-6: 15 tests;
7-10: 18 tests).

## 2. Scenario coverage on the frozen fixture

| # | Mandatory scenario | Acceptance suite (frozen fixture) | Supporting suite(s) |
| --- | --- | --- | --- |
| 1 | Stamp/versions; production Claude resolved + CodeBuddy raw; cache-write; OpenRouter cache; reasoning; ledger/UI summation | `usage-acceptance-usage` — *scenario 1: versions/cache/reasoning survive the production adapter boundary* | `usage-contract`, `usage-normalize`, `usage-harness-hook`, `usage-ledger`, `usage-insights` |
| 2 | Dedup/replay/restart; two identical requests; provider vs durable_sequence vs none; concurrent writers; crash after append before index; torn tail | `usage-acceptance-usage` — *scenario 2: dedup/replay/restart, identity classes, crash and torn tail* | `usage-ledger-idempotency`, `usage-persist`, `usage-ledger` |
| 3 | Snapshot/out-of-order/reset/compaction/model change; new run; late usage before/after horizon; active-run retention across midnight | `usage-acceptance-usage` — *scenario 3: snapshots/reset/late usage and active-run retention across midnight* | `usage-ledger-idempotency`, `usage-context-epoch`, `usage-retention` |
| 4 | Parent/child own/consolidated/model attribution; complete/partial/missing/unsupported; reported zero; legacy | `usage-acceptance-decisions` — 4 scenario-4 tests (own/consolidated separation, child model, coverage/zero, legacy unknown) | `usage-contract`, `usage-insights`, `usage-ledger` |
| 5 | Pick without start; valid/expired/mismatched `pick_id`; atomic two starts/replay; fanout slots; retry/fallback; manual vs unknown; purpose Watcher/Scout | `usage-acceptance-decisions` — 6 scenario-5 tests | `model-pick-decisions`, `model-pick-service`, `delegation-pick-id-http` |
| 6 | Acceptance by all final reviews + required verify; mixed verdict/verify failure/no link; review FAIL ≠ infra; cost of failed cycles; partial/unpriced/subscription; n accepted=0 → null; parallel reviews not double-timed | `usage-acceptance-decisions` — 5 scenario-6 tests | `model-pick-decisions`, `usage-insights` |
| 7 | Roles (Sol/Luna/Astra/variant/alias/override); unknown family; eligibility/review guarantees; autonomous flash vs named exception | `usage-acceptance-policy` — 3 scenario-7 tests | `model-role-profiles`, `model-pick-rotation`, `model-pick-observed`, `model-pick-hard-gates`, `model-diagnostics` |
| 8 | Cold-start out-of-band; deterministic fairness; budget/CAS after restart; cooldown; cancel vs quality; task/time/cost guards; premium/autopilot opt-in; flag OFF/rollback | `usage-acceptance-policy` — 5 scenario-8 tests | `model-pick-explore` |
| 9 | Shadow policyVersion/flags; window segmentation; 100% eligibility/selected parity; zero network; p99 ≤ 20 ms; original 2584cd05 gates | `usage-acceptance-policy` — 5 scenario-9 tests | `model-pick-shadow`, `model-pick-shadow-measurements` |
| 10 | API/UI/CSV sums and scope; IANA/DST; today vs 24 h and month vs 30 d; two coverage ratios; n and percentage | `usage-acceptance-policy` — 5 scenario-10 tests | `usage-window`, `usage-routes-insights`, `usage-ui-insights`, `usage-ui-sort`, `usage-ui-contract` |

### Exact acceptance test names

`tests/usage-acceptance-usage.test.js` (3):

1. `scenario 1: versions/cache/reasoning survive the production adapter boundary`
2. `scenario 2: dedup/replay/restart, identity classes, crash and torn tail`
3. `scenario 3: snapshots/reset/late usage and active-run retention across midnight`

`tests/usage-acceptance-decisions.test.js` (15):

1. `scenario 4: own and consolidated usage stay separate (summary.tokens is the own view)`
2. `scenario 4: child model resolves from the child payload`
3. `scenario 4: completeness/coverage keep a reported zero and never fake zero ratios`
4. `scenario 4: legacy rows without a source stay unknown/legacy, never auto/manual`
5. `scenario 5: a pick without a delegation start only raises proposals`
6. `scenario 5: pick_id links valid, expired, or mismatched role/model`
7. `scenario 5: one slot winner, idempotent replay and release`
8. `scenario 5: fanout slots classify alternate/fanout; audit candidates never match`
9. `scenario 5: manual source is an allow-list counted apart from auto/unknown`
10. `scenario 5: purpose Watcher/Scout uses are tagged and scoped`
11. `scenario 6: accepted-by-review needs a completed implement and every sibling PASS`
12. `scenario 6: infra/cancelled reviews stay undecided and set the run class`
13. `scenario 6: cost per accepted divides only priced closed usage; zero accepted is null`
14. `scenario 6: unknown and subscription usage stay counts, never billed at API prices`
15. `scenario 6: unionWallMs counts overlapping reviews once, sequential adds durations`

`tests/usage-acceptance-policy.test.js` (18):

1. `scenario 7: role eligibility matches verified families, variants, aliases and the unknown-family fallback`
2. `scenario 7: hard gates (favorites, readiness, lockout, excludes) stay hard and match the picker`
3. `scenario 7: autonomous review never picks flash; named flash and premium review need the confirmation gate`
4. `scenario 8: cold-start out-of-band pair reports would-explore in dry-run; off omits explore and the pick is unchanged`
5. `scenario 8: deterministic ordering and task/time/cost guards`
6. `scenario 8: atomic idempotent budget reserve and a refused start releases the slot`
7. `scenario 8: cooldown follows infra_fail/timeout, never cancelled; cancel is not quality evidence`
8. `scenario 8: credits earn one slot per ten auto jobs and exclude manual jobs`
9. `scenario 9: shadow policy version and flags are stable and the observer is selection-neutral`
10. `scenario 9: the shadow layer makes zero network requests`
11. `scenario 9: shadow p99 overhead stays within the 20 ms budget over 300 calls`
12. `scenario 9: the 2584cd05 rollout gate stays dormant and review pass-rate never enters the score`
13. `scenario 9: subscription/local/unknown pairs are never charged a hypothetical API price`
14. `scenario 10: resolveUsageWindow distinguishes today/24h and month/30d in the acceptance zone`
15. `scenario 10: date-only endpoints are inclusive days, ISO instants are exact, and an invalid zone is rejected`
16. `scenario 10: DST spring-forward and fall-back windows are correct`
17. `scenario 10: buildUsageInsights composes one filter-consistent payload with coverage ratios`
18. `scenario 10: CSV export carries meta and the exact insights numbers with n and a share`

## 3. Existing usage/model-pick suites — exact run output

Command: each `tests/*usage*.test.js` and `tests/model-pick*.test.js` plus the
role/stats/gate/cycle-adjacent suites was run in its own Node process with a
scratch `CRETLI_DATA_DIR` (the same isolation the project's
`scripts/run-unit-tests.mjs` uses).

Result: **57 pass / 1 fail**.

| Result | Suites |
| --- | --- |
| PASS (57) | `cache-state`, `codebuddy-usage-telemetry`, `context-restarts`, `deepseek-usage-telemetry`, `delegation-model-gates`, `delegation-pick-id-http`, `harness-usage-limits`, `model-alias-policy`, `model-catalog`, `model-catalog-meta`, `model-diagnostics`, `model-fact-schema`, `model-fact-telemetry`, `model-pick-decisions`, `model-pick-explore`, `model-pick-hard-gates`, `model-pick-observed`, `model-pick-plan-forecast`, `model-pick-rotation`, `model-pick-service`, `model-pick-shadow`, `model-pick-shadow-measurements`, `model-role-config-store`, `model-role-profiles`, `model-stats`, `opencode-usage-telemetry`, `usage-acceptance-decisions`, `usage-acceptance-policy`, `usage-acceptance-usage`, `usage-alerts`, `usage-context-epoch`, `usage-contract`, `usage-cursor-sdk`, `usage-harness-health`, `usage-harness-hook`, `usage-insights`, `usage-ledger`, `usage-ledger-idempotency`, `usage-normalize`, `usage-persist`, `usage-privacy`, `usage-rates`, `usage-retention`, `usage-routes`, `usage-routes-insights`, `usage-settings`, `usage-settings-routes`, `usage-ui-chart`, `usage-ui-contract`, `usage-ui-format`, `usage-ui-insights`, `usage-ui-insights-view`, `usage-ui-sort`, `usage-ui-view`, `usage-window`, `workspace-scout-scan-usage`, `workspace-watcher-cycle-usage` |
| FAIL (1, pre-existing) | `delegation-pick-reason` — `ReferenceError: Cannot access 'DELEGATION_MCP_TOOLS' before initialization` at `lib/mcp/builtin/catalog.js:25`. A circular-import initialisation bug in `lib/mcp/builtin/catalog.js` / `delegation-tools.js`; `lib/mcp/` is untouched by this change and the failure reproduces on the unmodified tree. |

## 4. Open criteria / gaps (honest)

These are **not** claimed as satisfied by this report:

- **Live control comparisons.** The leaf asks for control comparisons against
  real SDK/provider usage; the acceptance suite is fixture-only and needs no
  credentials. A real-sample comparison (and, for a subscription plan, a
  token-only comparison rather than a hypothetical API invoice) must still be
  run before any promotion.
- **Mobile/desktop E2E.** The leaf's verification mentions E2E for mobile and
  desktop. No Playwright run was executed here; the acceptance suite is
  unit/integration-level. The UI contract is covered by
  `usage-ui-contract` / `usage-ui-insights` / `usage-ui-sort`.
- **Shadow p99 scope.** Scenario 9 measures the p99 of the pure shadow layer
  (`scoreShadowCandidates`) over 300 calls, not the full HTTP `model_pick`
  round-trip. The end-to-end budget is bounded by the same layer plus the
  already-existing picker work.
- **CSV export wiring.** Scenario 10 tests `buildCsv` and `exportMetaRows`
  (the pure builders). The DOM-bound `exportCsv()` in
  `app_front/features/usage/usageSettings.js` is not unit-tested here.
- **CodeBuddy/Claude full WS path.** Scenario 1 exercises the adapter
  boundary (`resolveHarnessUsageTokens`) directly; the full harness WS path is
  covered by `codebuddy-usage-telemetry` and `usage-harness-hook` (both PASS).
- **`delegation-pick-reason`.** The one failing suite above is pre-existing and
  unrelated; it is reported rather than papered over. It should be fixed
  separately (circular import in `lib/mcp/builtin/catalog.js`).
- **Independent PASS of the plan.** Stages 1-8 were implemented under this
  plan; leaf 9 does not claim an independent review PASS for them.

## 5. Related documents

- [`usage-contract.md`](usage-contract.md) — machine-checked contract and matrix.
- [`usage-telemetry.md`](usage-telemetry.md) — event schema, endpoints, privacy,
  retention/alerts.
- [`usage-rollout.md`](usage-rollout.md) — staged rollout and rollback.
- [`model-pick-decisions.md`](model-pick-decisions.md) — pick/cost contract.
- [`model-scoring-facts.md`](model-scoring-facts.md) — observed/shadow facts.
