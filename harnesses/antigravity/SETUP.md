# Antigravity harness

Cretli runs Google's Antigravity CLI as an optional harness through ACP v1
(`agy acp`, newline-delimited JSON-RPC on stdio). No Python SDK is required.

1. Install the CLI following [Google's instructions](https://antigravity.google/docs/install).
2. Confirm `agy acp --help` works under the account that runs the Cretli server.
   Sign-in can be completed from Cretli Settings, without a separate terminal.
3. Restart Cretli after adding this plugin. It is enabled by default. If
   `CRETLI_OPTIONAL_HARNESSES` is explicitly set, add `antigravity` to that list.
4. In Settings → Harness → Antigravity, optionally set the CLI executable path.
   `ANTIGRAVITY_BIN` takes precedence; otherwise Cretli looks for `agy` on PATH.
   Click **Sign in with Google**, open the displayed link, and paste the Google
   authorization code into Cretli. Click **Complete sign-in** and wait for success.
   Cretli runs the official `agy acp --login` command and writes the code to its
   stdin. The CLI exchanges and stores credentials. Cretli never reads credential
   files or exposes the raw CLI output. You can cancel an attempt; it expires
   after 15 minutes. Login is shared by the server account, like the CLI itself.
5. Refresh the model list, select favorites, save, and create an Antigravity chat.
   `default` leaves model selection to the CLI. Other model ids come from
   `agy models`; Cretli sends the selected id through ACP without substitution.

The availability indicator confirms the executable exists. It does not assert a
valid login or an active subscription. Missing authentication is reported by ACP.
The CLI runs under the server account and uses its normal Antigravity configuration.

## Supported behavior

- Assistant text, thoughts and tool updates stream into the regular chat history.
- Each turn gets its own CLI process. The exact ACP session id is saved on the
  chat and loaded on subsequent turns. History replay during load is suppressed
  because Cretli already holds it. A CLI without `loadSession` refuses continuation
  instead of silently discarding context.
- MCP is provided by Cretli's managed stdio bridge, including the builtin tools.
  Bridge settings and policy are refreshed on each turn.
- ACP permission requests use Cretli's permission cards and policy. Grants select
  `allow_once` only. The adapter never enables `--dangerously-skip-permissions`.
  CLI-native permission rules still apply; Cretli can only answer requests the
  CLI sends.
- Cancellation terminates the CLI process group on Unix, with forced termination
  after a short grace period. Queueing, reconnect replay and server-run delegation
  use the shared room lifecycle. Automatic recovery is not certified.
- Plan and Ask require the CLI to advertise native `plan` mode. Without it, the
  turn fails explicitly. While restricted, permission requests for execution or
  mutation are denied. This is not a certified read-only sandbox: Antigravity is
  excluded from review and scout runs.

## Current limits

The first version sends text prompts. It does not advertise client filesystem or
terminal capabilities; native agent tools must execute in the CLI. Image/PDF
attachments, background agents, interactive elicitation, and per-turn token/cost
accounting have not been certified. Unknown client requests receive an ACP
method-not-found response. Model-list failures fall back to `default` and saved
favorites. Model selection uses `session/set_config_option` when advertised and
legacy `session/set_model` otherwise; unsupported requests fail explicitly.

Protocol references: [Google ACP](https://antigravity.google/docs/cli/acp/),
[ACP v1](https://agentclientprotocol.com/protocol/v1/overview).

Run the isolated adapter tests:

```sh
node --test harnesses/antigravity/tests/antigravity.test.js
```

These tests use a simulated ACP agent and do not consume Google credits.
A live smoke test requires an installed, authenticated `agy` CLI.
