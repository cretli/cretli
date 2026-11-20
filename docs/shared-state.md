# Shared state signals (`app_front/state/`)

Data several panels need lives in one signal store (`sharedState`, built on
`@lit-labs/signals`) instead of being passed around as `CustomEvent`s plus
repeated fetches.

| Signal | Fed by |
| --- | --- |
| `settings` | `getSettings()` in `api.js` (via `sharedStartupGet('/api/settings')`) |
| `chatsList` | plain `getChats()` (no filters) |
| `gitInfo` | unscoped `getGitInfo()` (via `sharedStartupGet`) |
| `notifications` | notification store `onChange` mirror |
| `watcherRevision` | the `onWatcherChanged` WebSocket frame in `chat.js` |

Fetchers publish after every successful read, so a panel that needs the value
reads the signal (or calls `subscribe(signal, fn)`) and only fetches when it
is `null`. `sharedState.onWatcherChanged(fn)` replaces the former
`cretli:workspace-watcher-changed` window event (sidebar, Todo watcher bar,
watcher settings).

## Measuring requests (before / after)

Count calls to the fetch layer for a scripted scenario: app start, then N tab
switches. Before: every tab refetches on activation and on the event. After:
panels read signals and `sharedStartupGet` dedupes the first read. The unit test
`tests/shared-state.test.js` shows the approach with a counting loader; for the
real app compare the `/api/*` rows of `browser_network` for the same scenario
on both revisions.

## Todo list on signals (stage 1 of 3)

`app_front/state/todoListState.js` (`createTodoListState`) holds the Todo list
state as immutable-value signals: `collapsed` (tree expansion), `batchSelected`
(bulk selection), `rootStatus`, `review` and `integration` (list filters).
`todoPanel.js` reads and writes them through the store (`todoList.*`); localStorage
persistence and view-memory slices behave as before. Every mutator publishes a
new `Set` only when membership really changed, so subscribers are not woken by
no-ops (`tests/todo-list-state.test.js`).

The row skeleton is now the light-DOM Lit element `cr-todo-row`
(`app_front/components/todo/cr-todo-row.js`); the existing keyed reconciler in
`renderList` still decides which rows to paint.

Remaining:

- Stage 2 (details): move per-row painting (`paintTodoRow`) into `cr-todo-row`
  driven by an item property plus signals, so one changed todo re-renders only its
  row (Lit `repeat` keyed by id) and the manual reconciler and paint chunking go.
- Stage 3 (editing): editor/dialog state on signals.
- Measurement (first frame, long tasks, DOM nodes; baseline ~100 ms / 159 ms long
  tasks) still has to be taken in a real browser before and after each stage;
  stage 1 changes no painted output, so no numbers are claimed here.
