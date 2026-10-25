# Operator integration reference (2026-10-24)

Shell scripts an external operator (Claude Code over `/mcp` in `operator` mode)
used on 2026-10-24 to integrate ~40 Watcher leaves by hand. They are the
working reference for an automatic integrator, not a supported tool: they
assume `$SCRATCH` (a temp dir) and an `op.sh` MCP helper.

Flow for one leaf with review PASS (`integ-auto.sh <todo8> "<message>"`):

1. `integx.sh` — take the newest `data/worktree-results/<id>/*.patch`, check a
   3-way apply in a **temporary index** first (no working-tree change on a
   conflict), then apply to the working tree. Generated baselines
   (`tests/fixtures/front-size-baseline.json`, `docs/typecheck-baseline.json`)
   are excluded: every leaf regenerates them on its own base, so they always
   conflict and must be recomputed on the merged tree instead.
2. `gatewt.sh` — affected tests (the leaf's tests + tests importing changed
   modules + size ratchet, architecture acceptance, i18n packs), typecheck
   ratchet, eslint on changed files.
3. A failing test is re-run on HEAD (stash); if it fails there too it is a known
   baseline failure and does not block.
4. `tc-moved.sh` — a refactor moves type errors into new files; accept the new
   per-file counts only when the total does not grow and no file outside the
   leaf grew, then rewrite `docs/typecheck-baseline.json`.
5. `node scripts/front-size-baseline.js --write` (tighten-only).
6. `commit-int.sh` — commit only the leaf's paths on top of HEAD from a
   temporary index (foreign dirty files stay untouched), then
   `todo_integration confirm` with `expected_updated_at`.
7. On a real failure: stash, append a "zwrot do poprawki" note to the todo
   body (`body.py`: findings + absolute patch path), `todo_integration reject`
   -> the leaf is `ready` again for a fix cycle.

After integrations: `npm run -s build:front` when `app_front/` changed; restart
the server when `lib/` changed, after draining cycles
(`restart-when-quiet.sh`; Settings -> Workspace Watcher has "Block new starts").
