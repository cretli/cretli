---
name: cretli-browser
description: Preview or inspect a web page from a Cretli chat with the built-in Browser (MCP browser_* tools). Use when asked to open, look at, screenshot or debug a page, a running app or the Cretli UI itself, and before reaching for your own Playwright/Chromium.
---

# Cretli built-in Browser

Cretli runs a server-side Chromium that the user sees in the **Browser** panel of
the Cretli UI. Every harness reaches it through the builtin Cretli MCP tools
`browser_*`. Depending on the harness the names carry an MCP prefix (for example
`mcp__cretli_…__browser_open`); search your tool list for `browser_open`.

Use it whenever the task is "look at the page": the user watches the same tab, and
whatever they did there (a sign-in, a filled form, an opened dialog) is still in it.

When nobody has the chat open in the UI (a Watcher/autopilot cycle, a delegated run,
or a chat right after a server restart), the run gets a **private system session**
instead: its own Chromium context with no user cookies, not shown in the user's
Browser panel. Never ask the user to "open the chat" just to make the tools appear.
A widget-only chat without a Cretli login session is still denied.

## Workflow

1. `browser_sessions` — sessions this chat may use (bound here, bound to a fork
   parent, or unbound/adoptable). An empty list is normal the first time.
2. `browser_open { url }` — adopts an unbound panel session, reuses a parent chat
   session on the fork chain, or creates one. Returns `browserSessionId` and
   `browserTabId`; pass both to every other tool.
3. Inspect:
   - `browser_screenshot` — saves a JPEG and returns its **file path**; open the file.
     Image pixels are CSS pixels, so screenshot coordinates match `browser_input`
     pointer coordinates (no DPR scaling).
   - `browser_elements` — visible interactive elements (links, buttons, inputs,
     ARIA roles) **including inside Lit shadow roots**, with `role`/`name`/`text`
     and a usable `selector`. Prefer this to guessing from screenshot pixels.
     Each row also carries an `index`; pass it back as `browser_input` `index` to
     act on that exact row.
   - `browser_dom` — bounded, redacted HTML (`maxBytes` to get more).
   - `browser_console` / `browser_network` — pull with `since` / `nextSince`.
4. Act (agent mode only): `browser_navigate`, `browser_input` (needs `confirm: true`),
   `browser_close` (free a session slot when at the per-user cap).
   `browser_navigate` takes an optional `waitUntil`
   (`domcontentloaded` default | `load` | `networkidle` | `commit`).
   `browser_input` kinds: `pointer`, `scroll`, `key`, `click`, `fill`, `resize`,
   `select`, `check`, `uncheck`, `hover`, `drag`, `upload`, `wait`. Prefer a
   locator kind over raw coordinates: give it a target from `browser_elements` —
   `selector`, or `role` (+`name`) / `text` / `label` / `placeholder` — and these
   locators pierce open shadow roots. `nth` (alias `index`, which is what
   `browser_elements` numbers) picks one match instead of the first.
   - `{ kind: "fill", value }`, `{ kind: "select", value | optionLabel | optionIndex }`
     (`optionLabel`/`optionIndex` are separate from `label`, which is a locator field).
   - `{ kind: "drag", <source fields>, toSelector | toRole(+toName) | toText | toLabel | toPlaceholder }`
     — a missing destination is an error, never a drop onto the source.
   - `{ kind: "wait", selector(+state) | text | loadState | url, timeout }` — bounded
     (`timeout` is clamped, no script evaluation), because input events queue per tab.
   - `{ kind: "upload", files }` — server-side paths inside the workspace root only.
   - `{ kind: "key", action: "type", text, delay }` — `delay` throttles typing.
   Raw `pointer` events use viewport coordinates only when there is no usable locator.

Plan, ask and review runs get the read tools only.

## When the page needs a sign-in

The Browser is a clean profile, so a third-party app with a login opens on its
sign-in page. Then:

- **Cretli's own origin** is different: when the workspace has enabled the
  `allowSelfOrigin` debug policy, the Browser signs itself in with passwordless
  local login (`/api/auth-status` reports `localLogin: true`), so never ask the
  user for Cretli credentials — just carry on with the page.
- **Any other app:** ask the user to sign in **in the Browser panel of this chat**,
  and continue with the same `browserSessionId` once they confirm.
- Do not search `.env`, `data/` or any cookie store for credentials or session
  tokens, and do not start a second browser to get around the sign-in.

## Which URL

- Use the address the user gave you or the one they have open in the panel.
- `localhost` / `127.0.0.1` may be blocked by the workspace Browser policy; use the
  host the user reaches the app on. A `blocked-url` style error names the reason —
  ask the user to allow the origin in the Browser panel settings rather than
  working around it.

## Errors worth knowing

| Error | Meaning | Do |
|-------|---------|----|
| `OUT_OF_SCOPE: No signed-in Cretli user is attached to this chat` | A widget-only chat has no Cretli login session, and the system fallback deliberately does not apply. | Report it; a login in the Cretli UI is the only way to attach a user. |
| `session-limit` | The per-user Browser session cap is full. | `browser_close` on a session you may access, or ask the user to close one in the panel. |
| `forbidden-chat` | That session id belongs to a chat outside this fork tree. | Call `browser_open` in this chat. |
| `HARNESS_UNAVAILABLE` | No Browser runtime in this process (standalone stdio, or Chromium missing on the server). | Report it; do not substitute another browser silently. |
| `PLAN_MODE_DENIED` | A mutating tool in a plan, ask or review run. | Use the read tools, or ask to switch to Agent mode. |

## When your own Playwright is still right

Automated end-to-end tests (`playwright.*.config.js`, `tests/`) run on the
project's Playwright setup. The built-in Browser is for looking at a page together
with the user, not for running the test suite.
