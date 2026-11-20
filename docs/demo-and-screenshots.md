# Demo instance and documentation screenshots

Run `node scripts/demo-instance.mjs` for a local, fictional demo on
`http://127.0.0.1:3099`. Sign in with `demo-password`. Stop it with Ctrl-C.
Use `--port 3100` to change the port and `--dir /tmp/my-demo` to keep its files.
Runtime directories must resolve outside the repository, including when a parent
directory is a symbolic link or the destination does not yet exist. Existing
demo trees must contain no symbolic links; validation runs before seeding.
`--seed-only` prepares
projects, chats, histories, a completed delegation and Usage without starting
the server. Account setup and the todo hierarchy require the running API.
Repeated offline seeding does not duplicate records. No provider account is
needed and the Workspace Watcher remains off.

Run `npm run docs:screenshots` after building the frontend. Requirements:
Node.js 22.18+, installed project dependencies, Chromium (detected by Cretli's
runtime detector) and `tesseract` on PATH. No additional npm packages are needed.
The generator starts an isolated demo in a temporary directory, signs in,
selects English and the dark theme, captures the viewport, and stops the demo
and removes its runtime directory when finished.

The outputs in `website/docs/img/` are:

- `chat-list-mobile.png` and `chat-open-mobile.png`: 390 × 844 CSS pixels at DPR 2.
- `chat-desktop.png`, `todo-tree.png`, `settings-usage.png`,
  `watcher-panel.png`, `settings-workspace.png`: 1280 × 720 at DPR 1.
- `manifest.json`: image names, physical dimensions, DPR, bytes, SHA-256 and generation time.

Every image must pass both DOM and mandatory OCR privacy checks. The gate checks
user home paths, private IPv4 addresses, non-example email addresses, the current
username and hostname, and comma-separated `CRETLI_PRIVATE_TOKENS`. Diagnostics
name the screen and matched pattern without repeating private values. Images
are staged in memory and published only after every capture passes. Each PNG
must fit within 700 kB. The screenshots contain fictional data only.

Exit codes: 0 success, 1 generation/runtime error, 2 Chromium unavailable,
3 tesseract unavailable, 4 privacy rejection. Missing OCR fails before starting
the demo or changing outputs. A blocked built-in Browser preview requires the
demo origin to be allowed in the workspace Browser settings; the generator
itself is a separate automated capture tool.

The username check is intentionally strict. On a host whose account name is a
common UI word, the gate can reject otherwise fictional content (for example,
the Watcher policy has a technical radio value named `root`). Use a dedicated
unprivileged capture account in that case; do not disable or whitelist the
username check.
