---
title: Cursor SDK
description: Configure Cursor SDK authentication, choose models, and understand its limits.
---

# Cursor SDK

Cursor SDK runs Cursor's agent through the optional `@cursor/sdk` package. Configure **Settings → Harness → Cursor SDK**, confirm the package is installed, and create a chat using this backend. Cretli's terminal, files, and other harnesses remain usable if the optional package is missing.

## Authentication and models

Enter a Cursor API key in Settings or set `CURSOR_API_KEY` on the server. The documented integration uses this key; signing into a desktop editor plan does not replace this setup step. Cursor's service terms and account limits apply separately from Cretli's open-source license.

Cretli asks the SDK for the account's available models and combines that result with a maintained fallback catalog. If listing fails, the fallback remains visible with a warning. The configured default is also included. Enable the models you want in Settings and check account access when a listed choice fails.

## Known limits

A Cursor-native subagent model list is limited to Cursor's local choices; it is not the catalog of all Cretli harnesses. Use Cretli delegation for work on another backend such as Qwen or DeepSeek. Tools and execution behavior depend on the SDK and chosen chat mode. Missing credentials or a failed optional install can prevent chat startup even when the rest of Cretli works. This SDK is usually unavailable on Termux; use a backend supported on that host instead.

<!-- sources: docs/harnesses.md, docs/ARCHITECTURE.md, lib/routes/agent-sdk-routes.js, docs/INSTALL.md -->
