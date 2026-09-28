# Approval broker Phase 2 — external model advisor

Phase 2 adds an optional external advisor for the OpenCode permission flow. It
does not host a model and does not use a Cretli harness as an advisor.

## Defaults and scope

- `approvalBroker.mode` remains `off` by default.
- `approvalBroker.advisor.enabled` is `false` by default.
- The advisor is consulted only in opt-in `local_reads` mode, for a local
  `ask_user` decision classified as low-risk with no unsafe categories.
- `shadow` never sends an automatic permission reply. Writes, edits, deletes,
  network access, secrets, privilege changes, production actions and git writes
  remain manual.
- Missing HTTPS endpoint or API key means no network request.

## Provider contract

The configured endpoint must be a public HTTPS OpenAI-compatible
`/chat/completions` endpoint. Requests are single, non-streaming JSON requests
without tools. The request contains only a redacted permission tuple: request
ID, permission, command, resource basenames, risk and categories. It never
contains cwd, chat history, diffs, the full workspace or an API key.

The response is accepted only as structured JSON. `allow` may produce one
OpenCode `once` reply if the request is still pending. `ask_user`, `deny`, bad
JSON, timeout, quota exhaustion, HTTP/429, transport errors and configuration
errors all keep the human approval card. The advisor never sends `always` or
`reject`, and there is no retry or provider failover.

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
      "baseUrl": "https://provider.example/v1/chat/completions",
      "model": "provider-model",
      "timeoutMs": 5000,
      "dailyQuota": 100
    }
  }
}
```

The stored key is write-only through settings PATCH and can be removed with
`clearApprovalAdvisorApiKey`. Environment configuration takes precedence.

## Async behavior and audit

The permission card is inserted into the pending map and broadcast before any
advisor request begins. A human reply claims the `requestId` guard first and
wins over a late model response. A late or failed advisor response leaves the
run in `waiting_for_input`; it is not converted to `adapter_incomplete`.

Audit records provider host, model, latency, usage/cost when supplied, the raw
advisor decision, final decision and a classified error. Audit text is
redacted and stored under the existing approval audit directory.

Phase 2 is intentionally opt-in and should first be evaluated in a controlled
environment. Provider retention, model drift, false approvals and external
data-processing policy remain operator responsibilities.
