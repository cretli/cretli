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

## Workflow

1. `browser_sessions` — the session this chat already uses. An empty list is normal
   the first time.
2. `browser_open { url }` — adopts the session the user opened in the panel, or
   creates one. Returns `browserSessionId` and `browserTabId`; pass both to every
   other tool.
3. Inspect:
   - `browser_screenshot` — saves a JPEG and returns its **file path**; open the file.
   - `browser_dom` — bounded, redacted HTML (`maxBytes` to get more).
   - `browser_console` / `browser_network` — pull with `since` / `nextSince`.
4. Act (agent mode only): `browser_navigate`, `browser_input` (needs `confirm: true`).

Plan, ask and review runs get the read tools only.

## When the page needs a sign-in

The Browser is a clean profile, so an app with a login (Cretli included) opens on
its sign-in page. Then:

- Ask the user to sign in **in the Browser panel of this chat**, and continue with
  the same `browserSessionId` once they confirm.
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
| `OUT_OF_SCOPE: No signed-in Cretli user is attached to this chat` | Nobody has this chat open in the UI, so there is no user to act for. | Ask the user to open the chat, then retry. |
| `session-limit` | The user's Browser session is bound to another chat. | Ask them to close it in the panel, or continue in that chat. |
| `forbidden-chat` | That session id belongs to another chat. | Call `browser_open` in this chat. |
| `HARNESS_UNAVAILABLE` | No Browser runtime in this process (standalone stdio, or Chromium missing on the server). | Report it; do not substitute another browser silently. |
| `PLAN_MODE_DENIED` | A mutating tool in a plan, ask or review run. | Use the read tools, or ask to switch to Agent mode. |

## When your own Playwright is still right

Automated end-to-end tests (`playwright.*.config.js`, `tests/`) run on the
project's Playwright setup. The built-in Browser is for looking at a page together
with the user, not for running the test suite.
