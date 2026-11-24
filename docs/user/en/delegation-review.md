---
title: Delegation and independent review
description: How Cretli splits work across harnesses and why a different model reviews the result.
---

# Delegation and independent review

Cretli can split one task across several harnesses. A coordinating chat does not write the code itself. It starts child chats on other models, reads their reports, and decides what happens next. Use it when a result should be checked by something other than the model that produced it.

## The loop

1. **Plan.** A plan is drafted and, where your workspace requires it, approved by you. Agents never approve plans.
2. **Implement.** One child chat edits the workspace and reports what it changed.
3. **Verify.** Cretli can run a fixed catalog of checks on the result before any review starts.
4. **Review.** A different child chat inspects the work read-only and ends with a verdict: PASS, FAIL, or BLOCKED.
5. **Fix.** On FAIL, an implementer addresses the findings and the loop repeats until the work passes, a round limit is reached, or a human decides.

The same loop runs inside [Watcher](workspace-watcher.md) cycles, and the outcome appears on the [task](todos.md) as a review badge. Only the server writes that badge, based on real delegation records; nobody sets it by hand.

## How a reviewer is chosen

In plain terms, Cretli picks from the models you enabled as favorites in **Settings** for each role (plan, implement, review, fix). When it picks a reviewer, it:

- prefers a model other than the one that implemented the work, and avoids repeating the last reviewer when it has a choice;
- skips models that recently hit a usage limit or failed to start;
- avoids very fast, lightweight models for reviews unless you ask for one explicitly;
- spreads work across harnesses, so one provider is not always the only reviewer.

You can instead set a **fixed pair** of reviewers per kind of review. Plan reviews can also run in three cooperation modes: independent (the default, reviewers cannot see each other), exchange (one round to see peer summaries), or collaborative.

## Limits you control

Delegated children cannot start further delegations by default; nesting is an explicit opt-in with a depth limit. You can set round, time, and spending budgets per task. Check which harnesses you enable before allowing automatic work, and read the diff yourself before integrating.

<!-- sources: docs/delegation-workflow-per-leaf.md, docs/plan-reviewer-cooperation.md, docs/todo-review-contract.md, docs/workspace-watcher.md -->
