---
title: Codex
description: Configure Codex authentication, choose models, and understand its limits.
---

# Codex

Codex runs OpenAI's coding CLI on the Cretli server and streams its work into chat. Cretli normally uses the CLI's app-server transport; the optional SDK provides a fallback. Check **Settings → Harness → Codex** for the package, executable, and authentication, then create a Codex chat.

## Authentication and models

Choose a ChatGPT plan login or API-key billing. For ChatGPT, enable device-code authorization in account security settings and complete **Sign in with ChatGPT**. For API billing, enter a key in Settings or `CODEX_API_KEY`. Plan usage and Platform API charges are separate. Cretli keeps the plan session separate from API-key execution.

With a ChatGPT plan, models come from the account catalog maintained by Codex. A model absent from that catalog can fail even if another account has it. API-key mode uses Cretli's fallback catalog, with a configurable default. Select from the current enabled list rather than assuming a particular model is included with every plan.

## Known limits

Agent mode has full host access and does not ask interactive execution approvals. Plan and default review use a read-only sandbox. Mid-turn steering is supported by the normal app-server transport; SDK fallback does not support it. Stop interrupts the active turn, while later prompts resume the saved thread. Optional binaries may be unavailable on Android, so Termux requires extra platform-specific setup and is not guaranteed to run Codex.

<!-- sources: docs/codex/SETUP.md -->
