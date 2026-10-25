# Optional harness plugins

Repo-shipped harnesses with origin `builtin-optional`
(docs/ts-migration-and-core-harnesses-plan.md, §3 B3). Each plugin is a
directory `harnesses/<id>/` with:

- `harness-plugin.json` — manifest (`origin: "builtin-optional"`, `entries`,
  optional `defaultEnabled`, optional `dependsOn`).
- `light.js` — default export `{ backend?, mcpAdapter?, titleProvider?, versions? }`.
  `titleProvider` registers a one-shot OpenAI-compatible chat-title generator
  (`registerOptionalTitleProvider` in `lib/chat-title-providers.js`), `versions`
  a row of the harness-versions table (`registerOptionalHarnessVersions` in
  `lib/harness-versions.js`). Optional host hooks (`lib/agent-harness/optional-harness-hooks.ts`): `limitBinding`, `billingCredential`, `creditLedger`. A heavy `provider.processLifecycle` runs background jobs at boot and shutdown. Must not import `room-kernel` or `builtin-harness-providers`.
- `heavy.js` — default export `{ provider }` (the provider spec).
- optional `lifecycle.js` — default export `{ processLifecycle }` for a harness that owns long-lived OS
  processes (OpenCode). It must stay importable without the chat runtime: the heavy loader attaches it to
  the provider (`provider.processLifecycle`) and registers it in `lib/agent-harness/builtin-process-lifecycles.ts`,
  and the memory monitor CLI (`scripts/memory-orphan-monitor.js`) loads only this entry through
  `loadOptionalProcessLifecycles()`. Core (`server.js`, `lib/memory-monitor.js`, `lib/boot-log.js`) iterates the
  registered hooks (`start`, `warmUp`, `beginStop`, `finishStop`, `monitor`, ...) and never names the harness.
- optional `front.js` — browser settings panel (`init` / `refresh`, optional
  `settingsHooks` for DOM behaviour a settings schema cannot express), wired
  through the lazy `import()` map in `app_front/optionalHarnessPanels.js`.

Which plugins load:

- `CRETLI_OPTIONAL_HARNESSES` **unset** — every plugin whose manifest has
  `"defaultEnabled": true` (default `false`) loads. A harness that left the core
  ships with `true`, so existing installs lose nothing.
- `CRETLI_OPTIONAL_HARNESSES` **set** (comma separated ids, an empty string
  included) — exactly that list loads and `defaultEnabled` is ignored.
  `CRETLI_OPTIONAL_HARNESSES=` disables every optional harness.

A plugin that is not selected is never imported: it is absent from the harness
list, the model catalog, Settings and the MCP adapter registry.

`dependsOn` lists plugin ids that must be loaded first (`zai` and `mimo` use the OpenCode runtime and key helpers, so
they depend on `opencode`). The loader orders the selection so dependencies load first; when one is not loaded the
plugin is skipped with a `dependency_missing` error (logged at boot) and stays a known-but-disabled plugin: its chats
open read-only, with a message naming the missing plugin, and nothing crashes. Fix it with
`CRETLI_OPTIONAL_HARNESSES=opencode,zai`.

Plugin tests live in `harnesses/<id>/tests/*.test.js`; `scripts/run-unit-tests.mjs`
runs them with the rest of the suite.

Shipped plugins: `mistral` (pilot), `qwen`, `codebuddy`, `deepseek`, `openrouter` (chat harness only), `opencode`, and `zai` / `mimo` (both `dependsOn: ["opencode"]`), all `defaultEnabled: true`.

A `backend` (and a `versions` row) may declare `insertBefore: '<id>'` or a list of ids (the first one present wins) to keep its place in the backend list (settings-patch order, status key order); `openrouter` uses it to stay ahead of `opencode`.

The OpenRouter *client* (API key, model list, pricing cache, SSE streaming, conversation hydration) is not part of the plugin: it lives in `lib/providers/openrouter/` and serves model-pick, chat titles, the cost proxy, usage and other harnesses whether or not the plugin is loaded.

Pieces the core genuinely uses stay in core even though OpenCode used to own them: the generic `/proc` process helpers
(`lib/process-probes.js`, used by the child-process registry; the OpenCode port registry re-exports them) and the
harness-neutral permission classifier and approval policy (`lib/approval/permission-classifier.ts`, used by every
harness through `can-use-tool-adapter.js`; the OpenCode SSE/HTTP part is `harnesses/opencode/opencode-permission.js`).
