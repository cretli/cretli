---
title: CodeBuddy
description: Configure CodeBuddy authentication, choose models, and understand its limits.
---

# CodeBuddy

CodeBuddy connects Cretli to Tencent's coding agent through its optional Agent SDK and the CodeBuddy CLI. Install both, or point Settings to an existing CLI executable. In **Settings → Harness → CodeBuddy**, check that the package, CLI, and credentials are ready before creating a chat.

## Authentication and models

Create a CodeBuddy API key and save it in Settings or `CODEBUDDY_API_KEY`. This integration uses API-key authentication rather than a plan sign-in flow. Special China, iOA, or dedicated editions require server-side environment configuration; that edition choice is not available in Settings.

The picker probes the live account catalog and keeps explicit Tencent Hunyuan Hy model identifiers. Routing aliases that might select third-party models are excluded. The documented default is `hy4-preview-f`; a failed account probe falls back to Hy3 and Hy4 Preview. Use another dedicated harness for third-party models.

## Known limits

Model availability is account-specific, and a fallback identifier may still be rejected. A rejected model is excluded from automatic selection for 24 hours; inspect the harness health card to unlock it. Agent mode bypasses native permission prompts, while Plan uses native plan permissions. Project instructions are loaded, but user and local CodeBuddy settings are not. Follow-up messages use one live CLI process; do not assume a fresh process will preserve every part of the previous runtime state.

<!-- sources: harnesses/codebuddy/SETUP.md -->
