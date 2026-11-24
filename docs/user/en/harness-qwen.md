---
title: Qwen Code
description: Configure Qwen Code authentication, choose models, and understand its limits.
---

# Qwen Code

Qwen Code brings its coding agent into Cretli through the optional Qwen Code SDK, which bundles the CLI. Check **Settings → Harness → Qwen** for readiness, save the credentials and endpoint preset, then create a Qwen chat.

## Authentication and models

Create an API key in Qwen Cloud and enter it in Settings or `QWEN_API_KEY`. Choose pay-as-you-go, Token Plan, or Coding Plan to match that key. Token Plan and Coding Plan keys can share a prefix but are not interchangeable. This integration does not use the former free OAuth login; a paid plan still uses an API key and its matching endpoint.

The picker requests the live models list from the configured endpoint. If it fails, Cretli uses a plan-specific fallback. The documented default is `qwen3.8-max`; pay-as-you-go and subscription plans can expose different identifiers. Select a model from the list for your preset.

## Known limits

A mismatched key and endpoint returns authentication errors; an unsuitable model can return a missing-model error. Weekly Token Plan quota exhaustion requires waiting for the provider's reset, not repeated retries. Plan mode uses the SDK's plan permissions and Cretli's mutation guard. Questions always need a human answer, even in Agent mode, and appear in chat with a ten-minute wait. Stop interrupts the run; follow-up prompts can resume the saved Qwen session.

<!-- sources: harnesses/qwen/SETUP.md -->
