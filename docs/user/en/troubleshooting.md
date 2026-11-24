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

## Quick symptom guide

| Symptom | What to check |
| --- | --- |
| Browser shows a connection reset or closed error | Confirm the Node process is listening on port 3011, then test the health address from the same machine. A webpack error is a different problem. |
| Works on the server, not from a phone | The default bind is local only. Enable LAN access as described in [remote access](remote-access.md), and allow the firewall prompt. |
| Certificate warning | Expected with the self-signed certificate. Accept it once per device, or set up trusted HTTPS. |
| Agent does not see an MCP server | Enable **For automatic agents** for that server; see [MCP](mcp.md). |
| Restore or backup refuses to run | Stop the server first; see [backups and data](backups-and-data.md). |

Still stuck? Read the [FAQ](faq.md).

<!-- sources: docs/TROUBLESHOOTING.md, docs/browser-runtime.md, app_front/features/chat/chatServerRecovery.js, public/sw.js -->
