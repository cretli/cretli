---
title: OpenRouter
description: Configure OpenRouter authentication, choose models, and understand its limits.
---

# OpenRouter

OpenRouter gives one Cretli harness access to models from many providers. The model runs remotely while Cretli runs workspace tools on your server. You do not need a separate vendor CLI for this backend. Configure it in **Settings → Harness → OpenRouter**, then create a chat and choose an enabled model.

## Authentication and models

Provide an OpenRouter API key in Settings or through `OPENROUTER_API_KEY`. This uses OpenRouter API billing; logging into another provider's consumer chat plan does not configure this harness. Keep the key in Settings rather than pasting it into a conversation.

Cretli retrieves the model catalog from OpenRouter's models API. The picker can retain the last successful catalog when refresh fails, with a stale indication; a fallback is used when no successful catalog is available. Select your preferred models in Settings. Listed prices and availability can change, so inspect the selected entry before substantial work.

## Known limits

Model context, supported inputs, provider quotas, and tool behavior vary by selection. A visible catalog entry does not guarantee that a request will succeed with your account. Plan and Ask modes block mutating workspace tools. After a crash, recovery restores conversation text rather than an unfinished tool-call sequence. Read any reported failure before retrying work that may already have changed files.

<!-- sources: docs/harnesses.md, docs/ARCHITECTURE.md, lib/providers/openrouter/openrouter-models.ts, docs/recovery-contract.md -->
