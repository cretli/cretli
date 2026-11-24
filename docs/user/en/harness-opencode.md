---
title: OpenCode
description: Configure OpenCode authentication, choose models, and understand its limits.
---

# OpenCode

OpenCode connects Cretli chat to a local OpenCode CLI and its provider models. Install the CLI or use the optional package installed with Cretli. In **Settings → Harness → OpenCode**, check readiness and choose credentials, then create an OpenCode chat.

## Authentication and models

Use an OpenCode Zen API key (`OPENCODE_API_KEY`) or the CLI's provider login. Z.AI and Xiaomi MiMo keys are also supported through OpenCode. For Z.AI, select the matching regular API or Coding Plan provider. MiMo pay-as-you-go and Token Plan keys require their matching endpoint; a subscription key cannot be mixed with the pay-as-you-go URL.

The model picker comes from OpenCode's provider catalog. Depending on credentials, it can include Zen models, GLM models, and MiMo models such as `cretli-mimo/mimo-v2.6-pro`. Enable the choices you want in Settings rather than assuming every provider model is available.

## Known limits

The first prompt can take one or two minutes while the local server starts. Each chat has an isolated instance and consumes host memory. An optional instance cap rejects a new chat if all allowed instances are busy. Plan mode blocks mutating tools through permission rules; this is not an operating-system sandbox. Questions and permission requests appear in chat and keep the run waiting until answered.

<!-- sources: harnesses/opencode/SETUP.md -->
