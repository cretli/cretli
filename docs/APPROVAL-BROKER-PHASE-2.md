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
  (Convai). The request is `{ model?, state, questions: { safe_read: { type:
  "noul", instructions } } }`, where `state` is the same redacted tuple and
  `model` is omitted when empty so the server uses its default. The answer is
  accepted only from `answers.safe_read` when `type` is `noul` and `noul` is a
  real number in `[0, 1]`; strings are never coerced, values are never clamped
  and Laya extra fields (`routing`, `action`, `confidence`) are ignored. The
  answer becomes `allow` only when `noul >= approvalBroker.advisor.minProbability`
  (default 0.9, clamped to 0.5–0.99).

In both protocols the request contains only a redacted permission tuple: request
ID, permission, command, resource basenames, risk and categories. It never
contains cwd, chat history, diffs, the full workspace or an API key.

The response is accepted only as structured JSON. `allow` highlights Once on
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
      "dailyQuota": 100
    }
  }
}
```

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

Audit records provider host, protocol, model, latency, usage/cost when supplied,
the raw advisor decision, final decision and a classified error. The advisor
policy version is `advisor-external-3` (narrow review-verify mutation allowlist).
Audit text is
redacted and stored under the existing approval audit directory.

Phase 2 is intentionally opt-in and should first be evaluated in a controlled
environment. Provider retention, model drift, false approvals and external
data-processing policy remain operator responsibilities.
