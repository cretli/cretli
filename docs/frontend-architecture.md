# Frontend architecture

Living document (not frozen). It describes where `app_front/` code goes, how
Lit components and signals are used, the size budgets enforced by a ratchet
test, and how performance changes are measured.

## Target directory structure

New and refactored code lives in feature folders:

```
app_front/features/<feature>/
  index.js        public surface of the feature (only file other features import)
  state/          signals, stores, derived state; no DOM access
  components/     Lit components (cr-* primitives stay in components/ui/)
  views/          composition of components for one screen or panel
  services/       API calls, WebSocket handling, persistence; no rendering
```

Rules:

- Other features import a feature only through its `index.js`.
- `state/` and `services/` must not import from `components/` or `views/`.
- Shared primitives stay in `app_front/components/ui/`; shared helpers in `lib/`.
- A structure refactor (moving/splitting files) and a behavior change are
  **separate steps** and separate changes, so a regression can be reverted
  without losing the other.

## Lit + signals patterns

- Components are Lit elements with Shadow DOM and `var(--cr-*)` tokens, as in
  `.cursor/rules/cretli-ui.mdc`.
- Shared state is held in signals owned by `state/`. Components read signals
  in `render()` so only the affected component re-renders; they do not copy
  signal values into properties.
- Writes go through small functions exported from `state/` (or `services/`),
  never by mutating signal values from a view.
- Update only what changed (per-row signals instead of repainting a list).
- No `innerHTML` in new code: use Lit templates. Where HTML from outside must
  be shown, sanitize it in a service and render it with an explicit, reviewed
  directive.
- No new dependencies.

## Budgets

| Rule | Limit | Enforced by |
| --- | --- | --- |
| File length | <= 600 lines: target; > 600 warning; > 1000 error | review / ratchet |
| `innerHTML` in new code | 0 | ratchet test |
| Existing files | over 1000 lines: may only shrink; up to 1000: may grow to 1000; `innerHTML` count may only shrink | ratchet test |
| New files | <= 1000 lines, zero `innerHTML` | ratchet test |
| Type errors | must not grow | `scripts/typecheck-ratchet.mjs` |

### Size ratchet

`tests/front-size-ratchet.test.js` compares `app_front/` (`.js`, `.mjs`, `.ts`)
with `tests/fixtures/front-size-baseline.json` (string catalogs in
`app_front/i18n/` are skipped), which stores per-file line
counts and `innerHTML` occurrence counts. A file missing from the baseline is
new. Renamed or split files count as new, so each part must meet the new-file
limits.

After shrinking files, lock the gain in:

```
node scripts/front-size-baseline.js --write
```

Never raise a baseline value to make the test pass; that defeats the ratchet.
`--write` enforces this: it only lowers recorded values and does not record a
new file that breaks the new-file limits. Accepting growth needs
`--allow-raise`, which is for the operator at integration, not for leaves.

## Measurement method

Performance work is judged in a real browser, not by reading code:

1. Open the app in the built-in Browser and exercise the scenario (for example
   switching chats).
2. Read the probes exposed as `window.__cretliPerf`.
3. Sum the long tasks (`PerformanceObserver` entries of type `longtask`) over
   the same scenario.
4. Compare before/after on the same data and scenario; repeat a few runs.

A change that makes these numbers worse is a regression, and the answer to a
regression is to **revert** it, not to patch around it.
