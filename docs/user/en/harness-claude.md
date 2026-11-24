---
title: Claude Code
description: Configure Claude Code authentication, choose models, and understand its limits.
---

# Claude Code

Claude Code gives Cretli access to Anthropic's coding agent through the optional Claude Agent SDK, which includes its CLI. Cretli installs this package separately from the other harness dependencies. In **Settings → Harness → Claude**, confirm package availability, configure billing, and create a Claude chat.

## Authentication and models

Choose **Claude Code plan** and complete the sign-in code flow to use the local plan session. Alternatively, choose **Anthropic API key** and enter a key in Settings or `ANTHROPIC_API_KEY`. Plan login and API credits are separate billing choices. If a run reports insufficient API credit when you intended to use a plan, check the selected mode.

The picker prefers models reported by a live SDK session, then the Anthropic models API when a key is present. It falls back to Claude Code aliases such as `sonnet`, `opus`, and `haiku`; Cretli also adds newer numbered identifiers. The documented default is `sonnet`. Account access still determines which models can run.

## Known limits

Agent mode accepts edits but does not bypass all permissions. Plan uses native plan mode; Ask and read-only review deny mutating tools before execution. Stop interrupts the run, and later prompts can resume the saved session. Bedrock, Vertex, computer use, and native subagents are outside this integration's documented scope. A failed optional SDK installation leaves other harnesses usable; check readiness before troubleshooting provider credentials.

<!-- sources: docs/claude/SETUP.md -->
