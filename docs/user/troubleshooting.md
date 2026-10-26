---
title: Troubleshooting
description: Resolve common startup, browser, harness, and update issues.
---

# Troubleshooting

If the server does not respond, check that the Node process is still running and inspect its terminal output. If startup reports that the port is already in use, stop the other process or choose a supported port configuration before starting Cretli again.

The built-in browser requires a compatible Chromium runtime. If browser tools fail because Chromium is missing, follow the runtime setup documented in the [browser runtime guide](https://github.com/cretli/cretli/blob/master/docs/browser-runtime.md), then restart the server.

If a chat cannot start, verify that the selected harness is enabled, its model is available, and its API key or other credential is configured under **Settings → Harness**. Check server logs for provider or network errors rather than repeatedly submitting the same prompt.

After a frontend update, the PWA may show an update banner. Reload through that banner so the browser activates the current asset version. If the page is stale, close old tabs and reload once the server is healthy.

For bind, TLS, Docker, and platform-specific diagnosis, see the full [Troubleshooting guide](https://github.com/cretli/cretli/blob/master/docs/TROUBLESHOOTING.md).

<!-- sources: docs/TROUBLESHOOTING.md, docs/browser-runtime.md, app_front/features/chat/chatServerRecovery.js, public/sw.js -->
