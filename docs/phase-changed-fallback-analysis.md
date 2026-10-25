# `phase_changed` session-resume fallback: avoidability analysis

Scope: `SESSION_RESUME_REASON.PHASE_CHANGED` in `lib/delegation-session-resume.js`.

## Where it comes from

The gate in `inspectDelegationSessionResume` fires when all of these hold:

- the source is not a cross-role (implement/fix) row;
- the request carries a non-empty `reviewMode` (`audit` or `closure`, see
  `lib/delegation-code-review-phase.js`);
- the source's `reviewMode` (lower-cased) is **not equal** to the requested one.

The last clause is a plain inequality, so a source whose `reviewMode` is
empty also yields `phase_changed`. A request with no `reviewMode` (for
example a plan review) never triggers it, whatever the source holds. Work
roles (plan/implement/fix) take a separate path and never emit it.

`findPairResumeSource` prefers a finished same-phase source over a newer one
of another phase. A source of another phase (or with an empty phase) is
returned only when no same-phase source exists, so the gate can record
`phase_changed`. Hence the fallback fires only when the reviewer has no
finished same-phase session for this leaf/subject/executor.

## Why the phase is part of the compat check

Audit is one scoped, independent review. Closure rounds re-check open findings
and regressions only, with a regression gate and a findings-key table in the
prompt. Re-entering an audit session for closure carries the auditor's full
exploration into a narrowly scoped round; the reverse anchors a fresh,
independent audit on closure-scoped context. The documented contract (code
comment and reason text) is that audit and closure never share a session.

## Data availability (acceptance item NOT met)

The leaf asks for the per-transition count (n) and share (%). **This is not
delivered.** The usage ledger (`usage_top`) can split runs into `resumed` vs
`fresh` per harness and role, but it has no `reasonCode` dimension; the code
lives only on `delegation.sessionResume.reasonCode` in the delegation store
under `data/`, which this analysis is not allowed to read. No count or
percentage is therefore claimed anywhere below. Resumed/fresh totals were
deliberately left out: they do not identify `phase_changed` and could not be
backed by a source in this document.

## Transitions

| Transition | n | % | Verdict | Justification |
| --- | --- | --- | --- | --- |
| audit -> closure (first closure round of a reviewer that audited) | no data | no data | unavoidable (by design) | Closure must be a narrowly scoped re-check; the audit session holds a full exploration and the contract forbids sharing. Relaxing it is a policy change, not a bug fix. |
| closure -> audit (new audit when the latest same-reviewer session was closure, e.g. a new closure epoch or restarted leaf) | no data | no data | unavoidable (by design) | The audit must be an independent clean-context read; reusing a closure session anchored on earlier findings breaks that. |
| empty/unknown source phase -> audit or closure (legacy rows, or rows written before `reviewMode` was recorded) | no data | no data | avoidable in principle (judgement from code, not fixed here) | Inequality against an empty source mode is not a proven phase difference: the source's phase is unknown, not different. Two options: treat an empty source phase as compatible (risky: it may have been either phase, so the audit/closure separation is no longer guaranteed) or skip such sources in `findPairResumeSource` and report a fresh-by-policy style reason (safe, keeps the separation, only changes the label). The second is preferred. Because the first-order effect is only the label (the outcome is a new chat either way), no code change was made; there is no cost saving unless the first option is chosen. |

No code was changed: the first two transitions need a contract change to
avoid, and the third is a classification question without data on how often
it occurs.

## Proposed follow-up leaves (ideas, not done)

1. Measurement: add `reasonCode` (from `delegation.sessionResume`) as a
   `usage_top` group-by so `phase_changed` n and % per transition can be
   measured. Re-evaluate all three verdicts once real counts exist.
2. Classification: when no same-phase source exists, or the source phase is
   empty, record a "no eligible same-phase source" reason instead of
   `phase_changed`, with a regression test in
   `tests/delegation-session-resume.test.js` (empty source `reviewMode` with
   a requested mode), so dashboards stop counting it as a refused resume.
