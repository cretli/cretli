# Cretli Chrome extension bridge

## Implementation status

The server side and MV3 extension are implemented. The settings UI is pending.

## Implementation decisions

- **Consent is per exact host**, not per registrable domain. Approving
  `invoices.example.com` does not cover `example.com`.
- **Redirects are never followed.** A redirect to another host fails with
  `E_DOMAIN_NOT_ALLOWED`.
- **The install is bound to the instance owner** (single-password auth), not to
  a login session. Pairing, unpairing, domain approval and the kill switch need
  an interactive login (`human-required` otherwise).
- **The kill switch deletes the token**, so the extension must be paired again.
- Bytes are streamed into `data/chrome-ext-downloads/<chatId>/`. Limits: PDF/CSV
  only; 20 MiB per file, 10 files and 50 MiB per command.
- The workspace MCP policy toggle is `allowCretliChromeExtension` and defaults
  to false.
- REST ownership uses the single instance owner; MCP dispatch also requires an
  in-workspace chat with the same active resolved owner throughout each call,
  then dispatches as `INSTANCE_OWNER_ID`.

Goal: let an agent in an interactive Cretli Agent chat list and download
documents (invoices, statements: PDF/CSV) from sites where the user is already
signed in in their own Chrome, without download/save modals, without
coordinate clicks, and with the file landing where the agent can read it, also
when Cretli runs in WSL and Chrome runs on Windows.

## 1. Options compared

Legend: **+** fits, **~** partial / with workarounds, **-** does not fit.
"Manual check" marks a cell that is not backed by repository code and must be
confirmed on a real Chrome during leaf 2/2 acceptance.

| Criterion | A. Own MV3 extension | B. Playwright/CDP on the user's Chrome (`CRETLI_BROWSER_CDP_URL`) | C. Claude in Chrome (`chrome_call`) | D. In-page `fetch` returning base64 |
|---|---|---|---|---|
| Silent download into a chosen folder | **+** The extension fetches the document URL itself (`fetch` from the service worker with host permission, `credentials: 'include'`) and streams bytes to Cretli; no Chrome download UI is involved. `chrome.downloads` would only reach the Windows Downloads folder (see section 3). | **~** Playwright `page.waitForEvent('download')` works on owned pages, but Cretli only routes/closes the tab it created and must not change the profile's download settings (browser-runtime.md "External Chrome over CDP"). Manual check: whether `Browser.setDownloadBehavior` on an attached user profile is honoured without a Save-as prompt. | **-** Upstream tools are discovered at runtime (`chrome_tools`, `lib/mcp/builtin/chrome-tools.js:93-117`); there is no download tool, only page reading, navigation, clicks, typing and screenshots (tool description at `chrome-tools.js:103`). A click on a download link triggers Chrome's own download flow in the user's Downloads folder. | **~** Possible through a page-script evaluation, but needs an evaluation channel (B or C) and the base64 payload travels through the agent's tool result; size grows by 33 % and large PDFs blow the model context. |
| Selector-based (not coordinate) interaction | **+** Content script uses `document.querySelectorAll` and returns stable selectors / link URLs (section 4, `list_documents`). | **+** Playwright locators (`browser_input`/`browser_elements` tooling in `lib/browser/agent-tools.js`). | **~** Upstream tools accept element refs from a page read, but the tool surface is owned by Anthropic and may change with CLI updates (browser-runtime.md "Claude in Chrome": "internal CLI entry point and may change"). Screenshot+click by coordinates is the common path. | **+** Selectors are evaluated in-page; same dependency on B/C for the channel. |
| Reading PDF bytes | **+** Service-worker `fetch` returns an `ArrayBuffer`; Chrome's PDF viewer is bypassed. | **~** `page.request`/`route.fetch()` replays from Node, not Chrome, so bot-protected sites see a Node fingerprint (browser-runtime.md "Native networking for public sites"); an in-page fetch avoids it. | **-** No byte-level read tool; only page text and screenshots. | **+** In-page `fetch` with the page's cookies returns the bytes (same-origin only; cross-origin document hosts need CORS). |
| WSL file delivery | **+** Bytes travel over the socket to the Cretli process in WSL and are written to a Cretli-owned directory (section 3); no Windows path translation. | **~** Playwright downloads land on the Chrome machine (Windows) unless bytes are pulled over CDP; plus the WSL->Windows port forwarding in browser-runtime.md "WSL2 with Chrome on Windows". | **-** Files land in Windows Downloads; the agent in WSL would need `/mnt/c/...` access, path guessing and a Windows user path. | **~** Bytes arrive in WSL as tool output, bounded by context size. |
| Login / 2FA handling | **+** Uses the user's real profile and cookies; the user logs in and completes 2FA themselves in a normal tab; the extension never handles credentials. | **~** Real profile, but bot-protection risk (see above) and Chrome must be started with `--remote-debugging-port`, which Chrome refuses for the default profile since Chrome 136 (manual check on the installed version). | **+** Real profile and sessions. | **~** Inherits from the channel used. |
| Permission surface | **~** `downloads` is not needed; `storage`, `scripting`, `alarms` plus `optional_host_permissions` granted per domain at runtime (section 5). Smaller than CDP. | **-** A debugging port exposes the whole profile (all cookies, all tabs) to anything that reaches it (browser-runtime.md: never forward with `0.0.0.0`). | **~** Broad, owned by the Anthropic extension; site approvals in the extension; Cretli cannot narrow it. Requires Claude CLI and a Claude Code subscription login (`chrome-tools.js:53-55`). | **~** As the channel. |
| Maintenance cost | **~** New code: extension (~3 files), WS path, pairing, MCP module, settings panel, tests. Chrome MV3 API is stable; unpacked load avoids Web Store review. | **+** Already implemented; but the download/default-profile gaps above are not fixable in Cretli. | **+** Already implemented; but depends on an undocumented CLI flag (`--claude-in-chrome-mcp`) Cretli does not control. | **+** Small, but not a solution on its own. |

### Decision: **GO** for option A (own MV3 extension)

Rationale:

- Only A meets the three hard requirements together: no modal, bytes delivered
  into WSL, and selector-based listing on the user's signed-in profile.
- B is rejected for this use case: it exposes the whole profile over a debugging
  port, cannot attach to the default profile on current Chrome (manual check),
  and its downloads land on Windows.
- C is kept as is for general browsing, but has no download primitive, requires a
  Claude subscription and an internal CLI flag.
- D is not a standalone option; A uses the same idea (fetch with the user's
  cookies) but returns bytes over the socket instead of the model context.

## 2. Pairing and transport

### Transport: WebSocket on `/ws-chrome-ext` (chosen), not Native Messaging

| | WebSocket `/ws-chrome-ext` | Native Messaging |
|---|---|---|
| Works with Chrome on Windows and Cretli in WSL | yes, over WSL localhost forwarding | no: the native host must be a Windows executable registered in the Windows registry; it would itself need a socket to WSL |
| Install footprint | extension only | extension + Windows host binary + registry key |
| Reuses Cretli auth/origin code | yes (`lib/ws/`) | no |

Final path: **`/ws-chrome-ext`** (a new `isChromeExtPath()` in `lib/ws/ws-path.ts`).

### Networking direction

The extension runs in **Windows Chrome** and connects **to the Cretli server in
WSL**. This is the reverse of browser-runtime.md "WSL2 with Chrome on Windows"
(WSL reaching Windows loopback, which needs `netsh portproxy`). For this
direction WSL2's default `localhostForwarding=true` makes a server bound to
`127.0.0.1` inside WSL reachable as `127.0.0.1:<port>` from Windows, so:

- **No `CRETLI_BIND=0.0.0.0` / LAN setting is needed and none is recommended.**
  The default bind stays `127.0.0.1`.
- The extension's server URL defaults to `wss://127.0.0.1:3011/ws-chrome-ext`
  and is editable in the extension options page (`ws://` allowed only for
  `127.0.0.1`/`localhost`).
- Manual checks for leaf 2/2: (a) localhost forwarding is active (it is off when
  `localhostForwarding=false` in `.wslconfig`; `networkingMode=mirrored` also
  works); (b) with Cretli's self-signed HTTPS certificate the service-worker
  WebSocket succeeds after the user has opened and accepted
  `https://127.0.0.1:3011` once in the same profile; if not, document the
  `http://` loopback alternative.

### Origin gate (`lib/ws/ws-origin.ts`)

Today `normalizeOrigin()` accepts only `http:`/`https:`, so `isValidOriginHeader`
rejects `chrome-extension://<id>` and `isWsOriginAllowed` closes the socket with
`4403 origin not allowed` (`ws-origin.ts:57`, `:150`). The new path gets its own
branch in `isWsOriginAllowed`, placed before the generic checks, in the same
style as the page-bridge branch:

- `/ws-chrome-ext` allows **only** an `Origin` of the exact form
  `chrome-extension://<32 chars a-p>`; a missing origin, `null`, `http(s)` or the
  Cretli origin is refused (4403).
- The extension id is **not** trusted by itself (an unpacked extension id is
  derived from its path / key and any local extension can claim it); it is
  bound to the pairing record and re-checked on every connection.
- Widget protocols on this path stay refused (`hasWidgetProtocol` -> reject).
- `CRETLI_EXTRA_WS_ORIGINS` is not consulted for this path, and
  `chrome-extension://` origins stay refused on every other path.

### Authentication (`lib/ws/ws-auth-boundary.ts`, `lib/ws/ws-router.ts`)

The extension has no Cretli session cookie, so the path is handled in
`ws-router.ts` **before** `requiresSessionAuth` / `isAuthenticated(req)`, like
`/ws-page-bridge` (`ws-router.ts:152-209`), with first-message auth:

1. **Pairing.** A signed-in owner opens Settings -> Browser -> Chrome extension
   and clicks "Pair". `POST /api/browser/chrome-ext/pairing` (session cookie,
   same-origin) returns a one-time **pairing code** (8 chars, 120 s TTL, single
   use, max 5 failed attempts then invalidated). The user pastes it into the
   extension options page.
2. The extension connects and sends `{ "type": "pair", "code", "extensionId",
   "label" }` within 5 s (else `4401`). The server verifies the code, that
   `extensionId` equals the Origin id, creates an **install** record
   `{ installId, ownerUserId, extensionId, label, tokenHash, createdAt,
   lastSeenAt, revokedAt }` and returns `{ "type": "paired", installId, token }`
   once. The token is 32 random bytes (base64url); only `sha256(token)` is
   stored (`data/chrome-ext/installs.json`, constant-time compare).
3. Later connections send `{ "type": "auth", installId, token }` as the first
   message (5 s timeout, `4401` missing / `4403` invalid or revoked or origin id
   mismatch).
4. Commands require a chat in the calling workspace with a resolved owner and
   an active session. Dispatch uses `INSTANCE_OWNER_ID`; the resolved owner is
   rechecked and must stay stable for each call.
5. One live connection per owner: a new authenticated connection replaces the
   previous one (old closed with `4409 replaced`). Heartbeat: reuse
   `attachWsKeepalive`; the extension reconnects with exponential backoff
   (1 s .. 60 s) and MV3 `chrome.alarms` keep the service worker alive while
   paired.
6. Revocation (Settings "Unpair", kill switch) closes the socket with
   `4403 revoked` and deletes the token hash.

`ws-auth-boundary.ts` gets no widget-token change; `requiresSessionAuth` is
simply never reached for this path, which a test must assert (an extension
connection without the cookie is not rejected with `auth.loginRequired`, and a
cookie alone without the token is rejected).

## 3. File delivery

**Chosen: bytes streamed over the socket into a Cretli-owned directory.**
`chrome.downloads` is rejected: it writes into the Windows Downloads folder (or a
subfolder of it), which the WSL server can only reach through `/mnt/c/Users/...`
paths that differ per machine, it may show the Save-as dialog depending on the
user's Chrome setting, and it needs the `downloads` permission.

- Target directory: `resolveDataPath('chrome-ext-downloads/<chatId>/')`
  (`lib/runtime-paths.js`), created `0700`; file name sanitised
  (`[A-Za-z0-9._-]`, max 120 chars, collision suffix). The tool returns the
  absolute path to the agent.
- Transfer: the extension sends `download.begin { requestId, mime, size? }`, then
  binary frames (max 256 KiB each, prefixed by the 16-byte request id), then
  `download.end { sha256 }`. The server counts bytes, recomputes sha256 and
  deletes the partial file on any error, cancel or mismatch.
- Type limits: only `application/pdf` (magic `%PDF-`) and `text/csv`
  (`.csv`, UTF-8 text, no NUL bytes). The declared MIME and the sniffed content
  must both match; otherwise `E_TYPE`.
- Size/count limits per command: max **10 files**, max **20 MiB per file**, max
  **50 MiB per command**; exceeding any is `E_LIMIT` and stops the command.
- Tests and fixtures use an injected `downloadsDir` (temp dir from
  `fs.mkdtemp(os.tmpdir())`) and must never write into the repository `data/`.

## 4. Command protocol

All control messages are JSON text frames. Server -> extension:

```json
{ "type": "cmd", "id": "<uuid>", "name": "chrome_ext_docs|chrome_ext_fetch|chrome_ext_open|cancel",
  "timeoutMs": 30000, "args": { } }
```

Extension -> server: `{ "type": "result", "id", "ok": true, "data": { } }` or
`{ "type": "result", "id", "ok": false, "error": { "code", "message" } }`.
`cancel` carries `args: { "targetId" }` and the target ends with `E_CANCELLED`.
An MCP abort signal sends `cancel`. Per-command timeouts are enforced by the
server (default 30 s, `download` 120 s, max 300 s) and end with `E_TIMEOUT`.

| Command | args | data |
|---|---|---|
| `chrome_ext_open` | `{ url, reuseTab?: boolean }` (`https:` only, host must be on the opt-in list) | `{ tabId, url, title }` |
| `chrome_ext_docs` | `{ tabId, selector?: string, match?: { hrefPattern?, textPattern? }, limit?: 1..200 }` | `{ items: [{ selector, href, text, mimeHint }] }` (text trimmed to 200 chars) |
| `chrome_ext_fetch` | `{ tabId, items: [{ selector? , href? }] }` (1..10, `href` must be same-site as the tab or on the opt-in list) | `{ files: [{ path, name, size, sha256, mime, sourceHost }] }` |

Error codes: `E_NOT_PAIRED`, `E_DISCONNECTED`, `E_KILLED`, `E_DOMAIN_NOT_ALLOWED`,
`E_PERMISSION_DENIED` (host permission not granted in Chrome), `E_NO_TAB`,
`E_SELECTOR` (no match / ambiguous), `E_TYPE`, `E_LIMIT`, `E_HTTP` (status only),
`E_TIMEOUT`, `E_CANCELLED`, `E_BUSY` (one command per owner at a time),
`E_INTERNAL`.

Responses never contain cookies, request/response headers, authorization
values, form field values or credentials; `E_HTTP` carries only the status
code. The server schema-validates every result and drops unknown fields.

Agent-facing MCP tools (new module `lib/mcp/builtin/chrome-ext-tools.js`,
registered in `lib/mcp/builtin/catalog.js`): **`chrome_ext_open`**,
**`chrome_ext_docs`**, **`chrome_ext_fetch`**, plus read-only
**`chrome_ext_status`** (paired / connected / allowed domains, no secrets).

## 5. Security model

- **Policy key:** a new workspace Browser policy key **`allowCretliChromeExtension`**
  (default `false`) in `lib/browser/policy-store.js`, inherited like
  `allowClaudeChrome` (`policy-store.js:176`, `:207`). It is separate from
  `allowClaudeChrome`, because consenting to Anthropic's extension is not
  consent to Cretli's.
- **Domain opt-in list:** per owner, stored server-side
  (`data/chrome-ext/domains.json`). The first command against a new
  exact host fails with `E_DOMAIN_NOT_ALLOWED` and creates a pending
  request the human approves in Settings (or a consent card in the chat); the
  extension then calls `chrome.permissions.request` for that origin, which Chrome
  shows to the user. `manifest.json` lists only `optional_host_permissions`
  (`https://*/*`), never `<all_urls>` or host patterns in `host_permissions`.
- **Kill switch:** in Settings (server-side flag: refuses all commands with
  `E_KILLED` and closes the socket) and in the extension popup (disconnects and
  clears the token locally). Both are independent.
- **Audit log:** every download (owner, chat id, domain, file name, size,
  sha256, time, result) appended to `data/chrome-ext/audit.jsonl`, shown in
  Settings, rotated at 5 MB.
- **Untrusted page text:** `list_documents` text and titles are returned as data
  inside a fixed JSON field; tool descriptions state that page text is untrusted
  and never contains instructions; the extension executes no code or command
  derived from page content; only the fixed command set above exists.

### Authorization gates per tool (against `lib/mcp/builtin/chrome-tools.js`)

| Gate in `chrome-tools.js` | Applies to `chrome_ext_*`? |
|---|---|
| Agent mode only (`:34`) | **yes**, all four tools (`chrome_ext_status` included, to keep discovery quiet in plan/read-only chats) |
| Chat must belong to the calling workspace (`:36-38`) | **yes** |
| No delegation / Watcher orchestrator / Scout (`:41-44`) | **yes** |
| Workspace consent (existing `allowClaudeChrome` pattern: `:23`, `:45-47`) | **yes**, a **new implementation gate** via `allowCretliChromeExtension`; the cited code checks `allowClaudeChrome`, not the new key |
| Signed-in owner attached and active, stable during the call (`:48-52`) | **yes**, dispatch uses `INSTANCE_OWNER_ID` after rechecking the active resolved owner |
| `confirm: true` (`:58-61`) | **yes** for `chrome_ext_open` and `chrome_ext_fetch`; no for `list_documents` and `status` |
| Claude Code subscription (`:53-55`) | **no**: the extension is independent of Claude CLI |
| Re-authorize before dispatch (`authorize` passed to the bridge, `:65`) | **yes**, rechecked before each command |

## 6. Test plan for leaf 2/2

All tests inject temp dirs and fake stores; none touches the repo `data/`.

| Test file | Asserts |
|---|---|
| `tests/ws-origin.test.js` (extend) | `/ws-chrome-ext` accepts only `chrome-extension://<id>`; refuses missing/`null`/http(s)/Cretli origin; extension origins refused on every other path; extra-origins env ignored for this path. |
| `tests/ws-auth-boundary.test.js` (extend) | Widget protocol on `/ws-chrome-ext` rejected; path does not require cookie auth. |
| `tests/chrome-ext-pairing.test.js` (new) | Code TTL, single use, attempt cap; token stored only as hash; origin id must match; revoke closes socket; second connection replaces first. |
| `tests/chrome-ext-ws-router.test.js` (new) | Fake extension client over a real `ws` server: auth timeout `4401`, bad token `4403`, kill switch `E_KILLED`, reconnect after drop. |
| `tests/chrome-ext-download.test.js` (new) | Binary framing, sha256 check, partial file removed on cancel/timeout/mismatch; PDF/CSV only (`E_TYPE`); 10 files / 20 MiB / 50 MiB limits (`E_LIMIT`); file names sanitised; audit entry written. |
| `tests/chrome-ext-protocol.test.js` (new) | Result schema validation drops unknown fields; no `cookie`/`headers`/`authorization` keys can pass; timeouts and cancel. |
| `tests/mcp-chrome-ext-tools.test.js` (new) | Every gate in the table above (agent mode, workspace, delegation/Watcher/Scout, policy key, owner, `confirm`), and that no subscription check runs; domain gating `E_DOMAIN_NOT_ALLOWED`. |
| `tests/mcp-bridge-catalog.test.js` (update) | The four `chrome_ext_*` tools are in the catalog with schemas. |
| `tests/browser-policy-store.test.js` or the existing policy-store test (extend) | `allowCretliChromeExtension` default `false`, inheritance, update. |
| Manual (real Chrome) | Unpacked load; pairing; mock invoice list page: list + download 3 PDFs with no modal and no coordinates; WSL localhost forwarding and self-signed cert checks from section 2. |

## 7. Hand-off and split proposal

Leaf 2/2 touches (scope):

- `extensions/cretli-chrome/` (new: `manifest.json`, `service-worker.js`,
  `content-script.js`, `options.html`/`options.js`, `popup.html`/`popup.js`)
- `lib/ws/ws-path.ts`, `lib/ws/ws-origin.ts`, `lib/ws/ws-router.ts`
  (and `ws-auth-boundary.ts` only if a helper is shared)
- `lib/browser/cretli-extension-bridge.js` (new; the existing
  `lib/browser/chrome-extension-bridge.js` is the Claude in Chrome bridge and is
  not reused), `lib/browser/chrome-ext-store.js` (new: installs, domains, audit),
  `lib/browser/policy-store.js`, `lib/browser/routes.js`
- `lib/mcp/builtin/chrome-ext-tools.js` (new), `lib/mcp/builtin/catalog.js`
- `server.js` only if router context needs the new store
- `app_front/features/settings/` (new chrome extension panel),
  `app_front/app/appShell/settingsTabs.js`,
  `app_front/app/appShell/browserStorageTools.js` (policy toggle),
  `app_front/i18n/en.js`, `app_front/i18n/pl.js`
- tests from section 6, `docs/browser-runtime.md`, `docs/mcp/SETUP.md`,
  `docs/chrome-extension-bridge.md` (status update), `CHANGELOG.md`

**Split recommendation:** leaf 2/2 is large. Proposed split (for the human to
decide; this leaf does not execute it): **2a** extension + `/ws-chrome-ext` +
pairing + bridge + MCP tools + tests; **2b** Settings UI (pairing button, domain
list, audit view, kill switch) + i18n + docs. 2b depends on the REST endpoints
from 2a.
