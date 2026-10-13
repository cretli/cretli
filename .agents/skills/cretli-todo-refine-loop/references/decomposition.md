# Task decomposition: benefit must outweigh overhead

Detail for `cretli-todo-refine-loop` — read in round 0 and whenever findings
change the scope or the dependencies.

- Keep small, cohesive work as one leaf by default. A numbered plan step is
  not automatically a separate todo. Each extra leaf repeats research,
  context loading, agent startup, implementation review and integration; weigh
  that cost against a concrete benefit, without inventing time estimates.
- Split only when it makes a substantial task manageable in context, isolates
  a meaningful dependency or risk, or enables independent work with disjoint
  scopes. Choose the fewest leaves with independently verifiable outcomes.
  Do not split by file, by arbitrary step count, or just to add more agents.
- Keep research, implementation, tests and documentation for the same outcome
  in its leaf. Separate them only when they deliver an independently useful
  result or resolve a dependency that later work genuinely needs.
- Inspect and reuse existing descendants first. For a justified split, create
  missing children with `todo_create`, `parent_id` and a stable
  `idempotency_key`; keep them in `idea` status and do not start them. Do not
  duplicate existing work or restructure active or completed leaves. If those
  need different boundaries, record a proposal for the human in the plan.
- Each leaf body must state its outcome, measurable acceptance criteria,
  dependencies and a `## Leaf scope` listing the files/modules it may touch.
  Set `sibling_index` to reflect dependency order and put the actual child ids
  and order in the root plan. Keep sequential execution by default; propose
  parallel execution only for disjoint scopes, leaving approval to the human.
- Record a short split/no-split rationale in the plan: the benefit and added
  execution overhead, or why one leaf is sufficient. Reassess during rewrites
  only when findings change the scope or dependencies; avoid gratuitous tree
  churn and extra review/consult runs just to decide how many leaves to create.
