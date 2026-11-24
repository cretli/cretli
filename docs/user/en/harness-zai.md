---
title: Z.AI
description: Configure Z.AI authentication, choose models, and understand its limits.
---

# Z.AI

Z.AI gives Cretli a dedicated GLM chat backend using the official Python SDK. In **Settings → Harness → Z.AI**, install the SDK with the provided action, or run `npm run setup:zai-sdk` on the server. Confirm both SDK availability and credentials before creating a Z.AI chat.

## Authentication and models

Enter the key in this harness's Settings section or set `ZAI_SDK_API_KEY`. Select the matching provider: Coding Plan or regular Z.AI API. Coding Plan access uses a key, not an interactive consumer-account login. These credentials and provider choices are separate from OpenCode's Z.AI configuration. A key configured for OpenCode does not automatically configure this backend.

The model picker uses Cretli's maintained static GLM catalog rather than a live account-model request. The documented entries include `glm-5.3`, `glm-5.3-flash`, and `glm-5.2`, with `glm-5.3` as default. Enable the models you intend to use in Settings.

## Known limits

The SDK requires Python support on the server; a saved key alone cannot make the harness ready. Restart the server after installation if availability does not update. Key validation rejects unsupported formats, including keys beginning with `sk-`. A static catalog cannot prove that your selected provider or plan grants access to every listed model. If a request fails, check the SDK, key, provider choice, and account allowance before retrying.

<!-- sources: harnesses/zai/zai.en.js, harnesses/zai/zai-api-key.js, harnesses/zai/zai-models.js, harnesses/zai/zai-routes.js, harnesses/zai/zai-sdk-client.js -->
