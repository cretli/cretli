---
title: Security basics
description: Keep a Cretli installation private, authenticated, and appropriately exposed.
---

# Security basics

Cretli can execute terminal commands and give configured agents access to a workspace. Treat the server and its credentials as sensitive. The default bind is `127.0.0.1`, which limits access to the local machine. If you deliberately bind to `0.0.0.0` for trusted LAN access, configure a strong password or `CRETLI_SETUP_TOKEN` before connecting other devices.

Use HTTPS and do not forward the service directly to the public internet without an appropriate authenticated and encrypted deployment boundary. Keep provider keys, setup tokens, session credentials, and backup data out of repositories, screenshots, logs, and chat messages. Grant MCP servers and workspace paths only the access they need.

Before enabling agent execution, understand which harness is selected and what commands it can run. Review plans, diffs, and test results. If a credential or session may have been exposed, rotate it and inspect the server logs.

This page is only a practical summary. Read the project [security policy](https://github.com/cretli/cretli/blob/master/SECURITY.md) for the threat model, reporting process, and deployment guidance.

<!-- sources: SECURITY.md, README.md, lib/bind-host.js, server.js -->
