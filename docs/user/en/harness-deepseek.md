---
title: DeepSeek
description: Configure DeepSeek authentication, choose models, and understand its limits.
---

# DeepSeek

DeepSeek uses the official DeepSeek Harness SDK and its local runtime to work on your project from Cretli chat. Cretli's optional dependencies include both packages. Confirm they installed successfully, then configure **Settings → Harness → DeepSeek** and create a DeepSeek chat.

## Authentication and models

Use a DeepSeek Platform API key, entered in Settings or `DEEPSEEK_API_KEY`. This is API access, not a consumer chat subscription login. The harness needs both the key and the runtime before it is ready.

With credentials, Cretli loads models from DeepSeek's live models endpoint. The documented default is `deepseek-flash`; the fallback also includes `deepseek-v4-pro`. The enabled model list normalizes older Flash identifiers. Pick from the current Settings list instead of supplying a model from an unrelated provider. DeepSeek's own child agents accept official DeepSeek models; work on another Cretli harness uses Cretli delegation.

## Known limits

The harness is in developer preview and upgrades can break compatibility. Its first startup can take tens of seconds. Plan mode supplies a read-only instruction rather than a native plan permission mode. Stopping a run closes its runtime process; after a stop or server restart the next prompt starts a fresh native session. Flash supports image input, while the documented Pro model is text-only. Inspect errors and retained conversation context before resuming interrupted work.

<!-- sources: harnesses/deepseek/SETUP.md -->
