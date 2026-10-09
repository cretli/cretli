/**
 * User-facing text for the read-only guards (Plan / Ask / review assignment).
 *
 * These are pure constants on purpose. `sdk-plan-guard.js` imports the MCP
 * policy, which imports the builtin tool catalog, which imports the delegation
 * tools, which import `delegation-service.js`. A service that needs only the
 * wording must not be pulled into that cycle, so the strings live here and
 * `sdk-plan-guard.js` re-exports them for existing callers.
 */

export const PLAN_GUARD_USER_MESSAGE =
  'Plan mode blocked execution. Switch to Agent mode to apply changes.';

export const ASK_GUARD_USER_MESSAGE =
  'Ask mode blocked this change. Switch to Agent mode to apply changes.';

export const REVIEW_GUARD_USER_MESSAGE =
  'Blocked by the read-only review policy: this invocation is not allowed; other commands are not blocked. Use read tools (`rg`, `jq`) or `node scripts/review-verify.js [ids]`, `node [--test] tests/<file>.test.js`, or `node scripts/review-lint.js <source-file>`. Test paths may be absolute inside workspace tests. Shell read pipelines and 2>&1 are supported. Writes, python/python3, node -e, arbitrary executables, and unknown catalog ids stay denied. Do not retry or bypass a denial. Finish with TASK and VERDICT.';

export const DEEPSEEK_REVIEW_GUARD_USER_MESSAGE =
  'The DeepSeek review remains active. Its read-only sandbox blocks filesystem writes. Inspect assigned workspace artifacts only; do not read secrets or send data over the network. Use read tools, sandboxed analysis, or `node scripts/review-verify.js [ids]` and `node [--test] tests/<file>.test.js`. Test paths may be absolute inside workspace tests. Do not retry write attempts. Finish with TASK and VERDICT.';
