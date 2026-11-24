# Antigravity harness

Cretli runs Google's Antigravity CLI as an optional harness through ACP v1
(`agy acp`, newline-delimited JSON-RPC on stdio). No Python SDK is required.

1. Install the CLI. On Linux and macOS, Settings → Harness → Antigravity shows
   **Install Antigravity CLI** while `agy` is missing: Cretli downloads Google's
   official bootstrapper (`https://antigravity.google/cli/install.sh`) and runs it
   with bash under the server account. The script verifies the release checksum,
   installs `~/.local/bin/agy` without sudo and adds it to the shell PATH; Cretli
   also finds it there when its own PATH lacks `~/.local/bin`. On Windows, or to
   install by hand, follow [Google's instructions](https://antigravity.google/docs/getting-started?tab=cli).
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
- Cancellation first sends ACP `session/cancel`, then terminates an unresponsive
  CLI process group on Unix, with forced termination
  after a short grace period. Queueing, reconnect replay and server-run delegation
  use the shared room lifecycle. Automatic recovery is not certified.
- Plan and Ask require the CLI to advertise native `plan` mode. Without it, the
  turn fails explicitly. While restricted, permission requests for execution or
  mutation are denied. Review runs are forced into Plan mode and may request
  shell commands classified as read-only by the shared guard; those requests
  still pass through Cretli's permission gate. Mutations, unknown commands and
  empty commands are denied. This is not a certified read-only sandbox, so
  Antigravity is picked for review only when "Allow uncertified review harnesses"
  is on in Settings → Delegation. Scout remains unsupported and fails closed.

## Current limits

Text prompts and uploaded screenshots are sent as native ACP content blocks.
Images require the agent to advertise image support; otherwise the turn fails
explicitly. Cretli does not advertise client filesystem or terminal capabilities;
native agent tools execute in the CLI. PDF attachments, background agents,
interactive elicitation, and per-turn token/cost accounting have not been certified. Unknown client requests receive an ACP
method-not-found response. Model-list failures fall back to `default` and saved
favorites. Model and reasoning selectors use advertised ACP config options,
including grouped values. CLI variants such as `gemini-3.8-flash-medium` select
the base model and the `medium` thought level separately. Mode selection also
uses config options, with legacy `session/set_model` and `session/set_mode` only
when the corresponding config selector is absent. Requested models and levels
are validated; unsupported choices fail explicitly. Room diagnostics expose
the effective model, thinking level and mode.

Protocol references: [Google ACP](https://antigravity.google/docs/cli/acp/),
[ACP v1](https://agentclientprotocol.com/protocol/v1/overview).

Run the isolated adapter tests:

```sh
node --test harnesses/antigravity/tests/antigravity.test.js
```

These tests use a simulated ACP agent and do not consume Google credits.
A live smoke test requires an installed, authenticated `agy` CLI.
