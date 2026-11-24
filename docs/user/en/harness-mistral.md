---
title: Mistral
description: Configure Mistral authentication, choose models, and understand its limits.
---

# Mistral

Mistral connects Cretli to the Mistral API through its optional official JavaScript SDK. No vendor CLI is needed. Models run remotely; Cretli executes the workspace tools on the host. Configure **Settings → Harness → Mistral**, confirm readiness, and create a Mistral chat.

## Authentication and models

Enter a Vibe Code key (`MISTRAL_VIBE_API_KEY`) or a Studio API key (`MISTRAL_API_KEY`). Vibe Code access uses its key rather than an interactive plan login. The automatic billing choice prefers Vibe when available; you can explicitly select Vibe or Studio API billing. A Studio key uses the Studio API allowance, so check the billing choice before starting work.

Cretli loads the live SDK model list when a key is configured and uses a static fallback if that fails. The documented default is `mistral-medium-latest`. The fallback includes large, small, Codestral, and Ministral choices. Deprecated Devstral and Magistral families are not offered by default.

## Known limits

Plan and Ask block mutating tools in Cretli's tool loop, rather than providing an operating-system sandbox. Review delegations also run read-only. After a crash, recovery restores conversation text but not an unfinished tool-call loop. Older usage records may lack billing-source classification. If only fallback models appear, check the key and catalog status before assuming a model is available to your account.

<!-- sources: harnesses/mistral/SETUP.md -->
