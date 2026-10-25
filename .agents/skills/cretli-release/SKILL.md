---
name: cretli-release
description: Review Cretli release candidates for correctness, changelog coverage, secret exposure, and release readiness. Use when asked to run cretli-release or review a release branch.
disable-model-invocation: true
---

# Cretli Release Review

Run a read-only release review for the Cretli repository.

## Workflow

1. Identify the current branch and whether there are staged, unstaged, or
   untracked changes. Determine the intended review scope from the request.
2. Review the relevant branch diff or working-tree diff and inspect new source,
   test, and documentation files.
3. Check that user-facing changes are represented under `Unreleased` in
   `CHANGELOG.md` and that release instructions remain consistent.
4. Look for defects, risky configuration changes, and accidental secret or
   private-environment exposure. Never read or print values from `config.json`,
   `.env` files, credential stores, or private keys. Report whether such files
   are staged or tracked using filenames and Git metadata only.
5. Do not edit files, stage changes, commit, push, or deploy. Do not claim an
   agent or external review ran unless its report is available.

## Report

Write in the user's language. List only actionable findings, sorted by
severity, with `file:line`, impact, and evidence. Separate release blockers
from lower-priority issues. If there are no findings, say so and summarize the
scope reviewed. State any unavailable checks or missing review tools clearly.

End with exactly:

`TASK: review`

`VERDICT: PASS|FAIL|BLOCKED`
