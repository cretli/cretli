---
title: Xiaomi MiMo
description: Configure Xiaomi MiMo authentication, choose models, and understand its limits.
---

# Xiaomi MiMo

MiMo offers Xiaomi's models in a dedicated Cretli chat backend. It calls the OpenAI-compatible REST API without an extra SDK and runs workspace tools through Cretli. Configure **Settings → Harness → MiMo**, then create a MiMo chat and select a model.

## Authentication and models

Provide a Xiaomi MiMo API key from the MiMo platform in Settings or `MIMO_API_KEY`. The default endpoint is the pay-as-you-go service. Token Plan access still uses a key: enter the plan's exact regional endpoint alongside its matching key. A plan key and a pay-as-you-go endpoint cannot be mixed. The Base URL can also be overridden for an appropriate gateway.

Cretli requests the live models list from the configured endpoint. If it is unavailable, the fallback offers `mimo-v2.6-pro` and `mimo-v2.6-flash`; Pro is the documented default. Speech synthesis and speech recognition companion models are filtered out of this chat picker.

## Known limits

A fallback list does not confirm account access or remaining allowance. Authentication, quota, and supported-model errors still come from the selected service. Check both the key and endpoint before retrying a failed request. MiMo is also available through the separate OpenCode harness; choose which backend you intend to use, since the dedicated harness has its own Settings fields. Provider credentials belong in Settings, never in a task prompt or shared screenshot.

<!-- sources: harnesses/mimo/mimo-api-key.js, harnesses/mimo/mimo-models.js, harnesses/mimo/mimo-client.js, harnesses/opencode/SETUP.md -->
