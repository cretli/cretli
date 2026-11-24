---
title: Antigravity
description: Configure Antigravity authentication, choose models, and understand its limits.
---

# Antigravity

Antigravity is an experimental Cretli harness for Google's CLI. It runs through ACP rather than a Python SDK. Install the CLI using **Settings → Harness → Antigravity** on supported Linux or macOS hosts, or follow the vendor's installation process. Confirm the executable is available to the Cretli server account.

## Authentication and models

Choose **Sign in with Google**, open the displayed link, and paste the authorization code back into Cretli. Complete sign-in and wait for success. The CLI stores the login for the server account. This is Google account authentication, not an API-key field; the availability indicator alone does not prove login or subscription access.

Refresh models and select favorites in Settings. Model identifiers come from the CLI's `agy models` command. Choosing `default` leaves selection to the CLI. If listing fails, Cretli falls back to default and saved favorites.

## Known limits

Plan and Ask require the CLI to advertise native plan mode; unsupported modes fail explicitly. Scout is unsupported. Review is not a certified read-only sandbox and requires the setting allowing uncertified review harnesses. Images require advertised image support. PDFs, background agents, interactive elicitation, and per-turn cost accounting have not been certified. Automatic recovery is also uncertified. Continuation requires native session loading; a CLI lacking that capability refuses continuation rather than silently losing context.

<!-- sources: harnesses/antigravity/SETUP.md, docs/harnesses.md -->
