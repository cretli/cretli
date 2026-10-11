# Approval broker Phase 2 — external model advisor

Phase 2 adds an optional external advisor for the OpenCode permission flow. It
does not host a model and does not use a Cretli harness as an advisor.

## Defaults and scope

- `approvalBroker.mode` remains `off` by default.
- `approvalBroker.advisor.enabled` is `false` by default.
- The advisor is consulted only in opt-in `local_reads` mode, for a local
  `ask_user` decision that is either low-risk with no unsafe categories, or the
  mutation-only `medium` invocation of the host-owned
  `node scripts/review-verify.js` runner (the only mutation the advisor may
  widen).
- `shadow` never sends an automatic permission reply. Writes, edits, deletes,
  network access, secrets, privilege changes, production actions and git writes
  remain manual, as does every mutation other than the review-verify runner.
- Missing HTTPS endpoint or API key means no network request.

## Provider contract

Two wire protocols are supported, selected by `approvalBroker.advisor.protocol`:

- `openai_chat` (default) — a public HTTPS OpenAI-compatible
  `/chat/completions` endpoint. Requests are single, non-streaming JSON requests
  without tools and ask the model to answer with a structured decision object.
- `systemone` — the System One protocol used by Jev (TypeSafe AI) and Laya
  (Convai). Official reference: [TypeSafe API — System One](https://docs.typesafe.ai/api)
  and [Noul primitive](https://docs.typesafe.ai/primitives/noul). The request is
  `{ model?, state, questions: { safe_read: { type: "noul", instructions } } }`,
  where `state` is the same redacted tuple and `model` is omitted when empty so
  the server uses its default. **Authority** role accepts only
  `answers.safe_read` when `type` is `noul` and `noul` is a real number in
  `[0, 1]`; strings are never coerced, values are never clamped and Laya extra
  fields (`routing`, `action`, `confidence`) are ignored. The answer becomes
  `allow` only when `noul >= approvalBroker.advisor.minProbability` (default
  0.9, clamped to 0.5–0.99). **Advisory** role (`riskScope=advise_all`) sends
  the same single `safe_read` question today; extra question ids in the response
  are rejected. Advisory never uses `minProbability` for automation — it maps
  `noul` to informational risk bands (`>= 0.85` low, `>= 0.55` medium, else
  high), sets `assessmentLimited: true`, leaves `recommended: null`, and keeps
  `advisorDecision: ask_user`.

In both protocols the request contains only a redacted permission tuple: request
ID, permission, command, resource basenames, risk and categories. It never
contains cwd, chat history, diffs, the full workspace or an API key.

With `riskScope=advise_all`, the advisor runs in **advisory** role: OpenAI
protocol answers use `{ risk, recommended, reason, optional probabilities }`
(prompt-injection resistant user envelope); results are shown to the human only.
`recommended: always` is kept only when the OpenCode permission event includes
validated `saveOptions` (from the harness payload `always` / `save` arrays — never
from forgeable `metadata`) and model risk is `low`. When the advisory tuple omits
command/resources (default privacy, sensitive categories, or unknown risk),
`assessmentLimited: true` and `recommended: null` regardless of the model.
Advisory answers never send `once`/`always`/`reject` automatically.

The response is accepted only as structured JSON. **Authority** `allow` highlights Once on
the permission card and waits `timeoutMs` (the same 3000–8000 ms setting,
default 5000). The `once` reply is sent only if the request is still pending
when that window ends; a human click during the wait wins. `ask_user`, `deny`, bad
JSON, a malformed System One answer, timeout, quota exhaustion, HTTP/429,
transport errors and configuration errors all keep the human approval card. The
advisor never sends `always` or `reject`, and there is no retry or provider
failover.

## Secrets and endpoint safety

`CRETLI_APPROVAL_ADVISOR_API_KEY` takes precedence over the stored
`approvalAdvisorApiKey`. Settings GET responses, UI metadata, audit entries and
logs expose only booleans/metadata, never the key or Authorization header.

Only HTTPS is accepted. Userinfo, `file:`/`unix:` URLs, loopback, private,
link-local, IMDS and other non-public resolved addresses are rejected. DNS is
resolved before connecting, every resolved address is classified, and the
validated public addresses are pinned into the HTTPS `lookup` callback to
prevent DNS-rebinding/TOCTOU redirects.

## Configuration

The settings shape is:

```json
{
  "approvalBroker": {
    "mode": "local_reads",
    "advisor": {
      "enabled": true,
      "protocol": "systemone",
      "baseUrl": "https://api.typesafe.ai/v1/systemone",
      "model": "jev-latest",
      "minProbability": 0.9,
      "timeoutMs": 5000,
      "dailyQuota": 100,
      "riskScope": "low_only",
      "sendSensitiveCommand": false
    }
  }
}
```

`riskScope=advise_all` is **advisory-only**: the model may suggest risk and a
recommended button, but Cretli never sends `once`/`always`/`reject` automatically.
`sendSensitiveCommand` defaults to `false`; when `true`, advisory requests may
include a bounded, redacted command snippet (basename resources only). Redaction
is best-effort — operators must not assume every secret is removed.

A System One preset is only a hint in the settings panel: Jev at
`https://api.typesafe.ai/v1/systemone` with model `jev-latest`. `minProbability`
applies to `systemone` only and is clamped to 0.5–0.99 (a non-number falls back
to 0.9). An empty `model` is allowed for `systemone` but not for `openai_chat`.

The stored key is write-only through settings PATCH and can be removed with
`clearApprovalAdvisorApiKey`. Environment configuration takes precedence.

## Async behavior and audit

The permission card is inserted into the pending map and broadcast before any
advisor request begins. When the advisor allows, the card highlights Once and
counts down for `timeoutMs` before the reply is posted. A human reply claims
the `requestId` guard first and wins over a late model response, including a
reply that arrives during the countdown. A late or failed advisor response leaves the
run in `waiting_for_input`; it is not converted to `adapter_incomplete`.

Audit is append-only JSONL under the approval audit directory. Two correlated
kinds share `requestId` (plus `chatId` / OpenCode `sessionId` when known):

- `advisor_assessment` — written when the external advisor finishes (or errors).
  Includes provider host, protocol, model, latency, usage/cost when supplied,
  `role` (`authority` | `advisory`), local risk/categories, model risk/recommended
  when advisory, `assessmentLimited`, `advisorAutomationOutcome` (`allow_once` only
  when authority auto-once actually posted), and classified errors. Human choice is
  **not** recorded here.
- `human_permission_decision` — written only after a successful OpenCode permission
  POST from the user card (`once` | `always` | `reject`). Never uses `ask_user` as
  a stand-in; duplicate lines for the same `requestId` are ignored.

The advisor wire policy version is `advisor-external-4` (adds advisory assessment
audit and separated human decisions). OpenCode broker rules stay
`opencode-local-1` (`APPROVAL_BROKER_POLICY_VERSION`). Audit text is redacted;
there is no guarantee that every secret is removed from free-text reason fields.

Phase 2 is intentionally opt-in and should first be evaluated in a controlled
environment. Provider retention, model drift, false approvals and external
data-processing policy remain operator responsibilities.
