# Credit ledger, DeepSeek balance and forecast

Contract for the prepaid-credit ledger (`lib/credit-ledger/`), the DeepSeek
balance reader (`harnesses/deepseek/deepseek-balance.js`), the balance forecast and
alerts, the MCP/screenshot import and the Usage billing UI. All examples are
fictional.

## Storage and audit

- One JSON document, `credit-ledger.json` in the data dir (`CREDIT_LEDGER_SCHEMA_VERSION = 1`),
  written under a revision check (`expectedRevision`; a stale write is a `409`
  and the UI reloads instead of overwriting).
  The store functions accept `expectedRevision`, but the MCP `billing_update` tool does not
  pass it: it does not check revisions (last-writer-wins), because the ledger has a single
  user. Only the UI/REST path sends `expectedRevision` and gets the `409` on a stale write.
- Rows: `accounts`, `transactions` (`topup`, `refund`, `grant`, `adjustment`,
  `expiry`; state `pending` or `posted`) and `snapshots` (balance readings).
- Rows are never edited in place. A **correction** appends a new version with
  `supersedes`; a **withdrawal** appends a tombstone. Views use the active
  version only; the history keeps every version.
- Amounts are exact decimal strings (`lib/credit-ledger/decimal.js`), never
  floats. Credits and payments are separate: a transaction carries `credit`
  (wallet currency) and an optional `payment` (what was paid, any currency).
  Currencies are never summed.
- Duplicates: the same `providerTransactionId` or `idempotencyKey` returns the
  existing row; the same amount/time on another screenshot is only *flagged*
  (`possible_duplicate`) and needs an explicit acknowledgement.

## Time rules

- A moment is `{ at | date, precision, uncertain }`. A date-only value keeps
  day precision (no invented midnight) and is flagged uncertain.
- Hour-precision local times use an explicit offset or an IANA zone. Malformed
  offsets, unknown zones, DST gaps and ambiguous folds make the moment
  uncertain instead of guessed.
- Subscription "today" (next payment, awaiting confirmation) is the calendar day
  of `asOf` in the owner's IANA zone, passed as the optional `timeZone` of
  `readSubscriptionsView` / `buildSubscriptionView` (no ledger schema change).
  Without a zone the server zone is used, then UTC. An unknown zone is a
  `time_zone_invalid` validation error. Anchor and due dates stay calendar
  dates (`YYYY-MM-DD`) and are never converted. Example: `2026-03-14T23:30:00Z`
  is 2026-03-15 in `Europe/Warsaw` and 2026-03-14 in `UTC`.
- Forecast windows (`1d`, `7d`, ...) follow real local-day lengths (23/25 h on
  DST days). A window shorter than 24 h is reported as insufficient.

## Sources of the balance

| Source | Notes |
| --- | --- |
| DeepSeek API | `GET {endpoint}/user/balance`, Bearer key, 10 s timeout. Stored as snapshots in series `deepseek-api`, one per currency, exact strings. Refresh: manual (>= 5 s apart), after a top-up (>= 60 s), daily (one catch-up after a pause). Failures back off 5 min doubling to 60 min; manual refresh bypasses the backoff. |
| Manual snapshot | Typed in Usage or imported through MCP; its own series, never mixed with `deepseek-api`. |
| Screenshot import | MCP `billing_create` with `save=true`; the harness reads the image, Cretli stores the attachment reference and hash. |

Failure handling (`kind`): `401` and `403` `auth`, `429` `rate_limited`,
`5xx` `server`, any other non-2xx status (including `402`) `http`; `timeout`
(aborted request), `network` (transport error), `invalid_schema`, `no_key`,
`identity_pending`. Throttled and backed-off attempts never reach the API:
`throttled` (inside the minimum interval) and `backoff` (automatic reasons
only; manual bypasses it) both return `skipped: true`. A failure keeps the
last reading, writes no snapshot and unlocks nothing; the Usage view marks the
reading stale after 36 h. `402 Insufficient Balance` raised by a *run* sets an
account-tagged `insufficient_balance` limit.

## Selective unlock

A fresh reading with `is_available = true` clears **only** the
`insufficient_balance` limit tagged with the same billing `accountId`.
Rate-limit rows, other harnesses, other accounts and legacy rows without an
account tag stay. `is_available = false`, a failed refresh or a rotated key
(pending identity or a different account) never unlock.

## Account identity

The wallet is identified by an HMAC fingerprint of provider + endpoint +
credential (`lib/usage/billing-account-fingerprint.js`); the key itself is
never stored. Fingerprint and secret live in `billing-accounts.json` /
`billing-account-hmac-secret.json`, so the same key after a restart resolves to
the same account series. A new key becomes `pending_identity` until the
operator confirms the rotation (same wallet) or chooses a new account.

## Billing class

Usage events carry `billingClass` (`api_metered`, `subscription_quota`,
`local`, `unknown`) only when the event declares billing (class, mode or
account). Older events have none and are read as `unknown`: never priced as
zero and never counted as spend.

## Forecast and alerts

`buildBalanceForecast` works per account + currency + series:

- spend = opening balance + top-ups/grants/corrections - expiries - closing
  balance, so a top-up or an expiry is never counted as consumption.
  Example: 100 + 20 - 30 - 5 = 85, spend 30.
- Explicit states instead of guesses: `no data`, `stale`, `no funds`, zero
  rate, rate change, insufficient window, and *reconciliation needed* (uncertain
  boundary, negative spend, unexplained increase/drop).
- Missing local rates or history before measurement started do **not** block
  the balance view; they only limit or remove the exhaustion date.
- Alerts: one notification per crossing of the 24 h runway threshold, with
  hysteresis (25 %); reset only on a verified return. Delivery is retried until
  a channel confirms; payloads are generic and link to Settings -> Usage.

## Subscriptions

`lib/credit-ledger/subscriptions.ts` keeps a separate register
(`credit-subscriptions.json` beside the ledger, own revision). Fields: label,
provider, plan, price + currency, cycle (`month`|`year` + first payment date),
state, optional harness for limits, optional manual limit note.

- **Calendar.** Dates are calendar days (no time zone invented). Every payment
  date is derived from the first payment date, not from the previous one: a
  Jan 31 monthly cycle gives Feb 28 (29 in leap years) and returns to Mar 31; a
  Feb 29 yearly cycle gives Feb 28 in non-leap years.
- **Planned vs paid.** The next payment is always `planned, confirmed: false`.
  `POST .../payments` (MCP `billing_create kind=subscription_payment`) records a
  payment only for a real cycle date and with evidence: either an upload
  reference that resolves to an existing file in the upload store (same
  normalisation as the screenshot import; the hash is computed from the file, a
  supplied hash must match, and one screenshot cannot confirm two payments), or a
  provider transaction id, which is an operator attestation the app cannot check
  against the provider (it is only guarded against reuse). A bare image hash is
  rejected because it cannot be verified. A past unconfirmed date is shown as
  *awaiting confirmation*, never assumed paid.
- **Cycle history.** Changing `cycle` (interval or anchorDate) appends
  `{ cycle: <old cycle>, until }` to the optional `cycleHistory`; price changes
  still go to `priceHistory`. Confirmed `payments[].dueDate` are never rewritten
  and the view lists them as `confirmedPayments`, not as a missed payment of the
  new calendar. A change that would strand a confirmed future payment off the new
  calendar is refused (`cycle_change_conflicts_with_confirmed_payment`).
- **Cash vs quota.** Subscription payments are cash and never enter the prepaid
  wallet ledger. Limits and reset times are read from the existing
  `plan-limit-history` for the linked harness (no second measurement); a manual
  limit is used only when the history has no reading. An elapsed reset marks the
  reading outdated and does not touch the payment schedule.
- **No double counting.** The production mechanism: `priceUsage` returns
  `usd: null` for `subscription_quota` usage events (quota use carries no money),
  and confirmed subscription payments live only in the subscription register, never
  in the wallet ledger. `buildCostSeparation` is a helper (not wired into a view
  yet) that reports both sides apart and is covered by tests.
- **States.** `active`, `paused`, `past_due`, `cancelled`, `ended` with a fixed
  transition table and history. They record what the operator did at the
  provider; the app never buys, renews or cancels anything.
- **Accounts by service.** OpenRouter (API wallet) and Cursor/Codex/Claude
  (subscriptions) are suggested only when the matching harness is in use; no
  data is fetched for them.
- **API support.** No official subscription or balance API was verified for
  Cursor, Codex, Claude or OpenRouter in this repository (only DeepSeek's
  `/user/balance` is integrated, and it is a wallet balance). Subscription data
  is therefore manual or screenshot-based.
- **Direct DeepSeek rates.** Not added. The repository holds no official DeepSeek
  price page citation with date/version and exact model mapping; the existing
  `deepseek` estimate in `usage-rates.js` is a flagged estimate and OpenRouter
  prices are not a substitute. Rates stay unknown until such a source is cited.

## Interfaces

- HTTP (owner only; widget/MCP callers get `403` on forecast/links):
  `GET /api/credit-ledger`, `.../forecast`, `.../harness-links`,
  `.../deepseek-balance`, `POST .../deepseek-balance/refresh`, and
  `POST|PUT|DELETE` for accounts, transactions and snapshots; `.../subscriptions`
  (GET, POST, PUT `/:id`, POST `/:id/state`, POST `/:id/payments`).
- MCP: `billing_list`, `billing_show`, `billing_forecast` (read, allowed in plan/review),
  `billing_create`, `billing_update` (also `kind=subscription`/`subscription_payment`; mutating; denied in plan mode and for
  delegation children).

## Coverage limits

- The DeepSeek balance endpoint reports balances only: no transaction history.
  Spend before the first reading is unknown, and a top-up not entered or
  imported appears as a *missing top-up* needing reconciliation.
- Only DeepSeek has a provider reader; other wallets rely on manual or
  imported readings.
- Screenshot reading depends on the harness having vision; otherwise the tool
  asks for manual entry and writes nothing.

## Tests

`credit-subscriptions`, `billing-subscriptions-view`, `credit-ledger`, `balance-forecast`, `billing-accounts`, `billing-mcp-import`,
`billing-view`, `credit-ledger-harness-links`, `deepseek-balance` and the
end-to-end scenarios in `deepseek-billing-e2e` (fictional data, mocked fetch).
