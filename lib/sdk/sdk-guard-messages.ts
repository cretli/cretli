/**
 * User-facing text for the read-only guards (Plan / Ask / review assignment).
 *
 * These are pure constants on purpose. `sdk-plan-guard.ts` imports the MCP
 * policy, which imports the builtin tool catalog, which imports the delegation
 * tools, which import `delegation-service.js`. A service that needs only the
 * wording must not be pulled into that cycle, so the strings live here and
 * `sdk-plan-guard.ts` re-exports them for existing callers.
 */

export const PLAN_GUARD_USER_MESSAGE =
  'Plan mode blocked execution. Switch to Agent mode to apply changes.';

export const ASK_GUARD_USER_MESSAGE =
  'Ask mode blocked this change. Switch to Agent mode to apply changes.';

export const REVIEW_GUARD_USER_MESSAGE =
  'Blocked by the read-only review policy: this invocation is not allowed; other commands are not blocked. Command substitution (`$(...)`, backticks), parameter/arithmetic expansion (`${...}`, `$((...))`), process substitution (`<(...)`, `>(...)`), and variable assignments (`name=value ...`) are not allowed; do not capture output into a variable. Use SEPARATE calls instead: one search call (`rg -l <pattern> <dir>` or `grep -rln <pattern> <dir>`), then explicit reads (`cat`, `rg -n`, `sed -n`) on the listed files. Other read tools (`rg`, `jq`) work, as do `node scripts/review-verify.js [ids]` and `node scripts/review-lint.js <source-file>`. Run tests through the review-verify catalog (`node scripts/review-verify.js [ids]`); direct test-file runs are refused by the in-process review executor. Shell read pipelines and 2>&1 are supported. Writes, python/python3, node -e, arbitrary executables, and unknown catalog ids stay denied. Do not retry or bypass a denial. Finish with TASK and VERDICT.';

export const DEEPSEEK_REVIEW_GUARD_USER_MESSAGE =
  'The DeepSeek review remains active. Its read-only sandbox blocks filesystem writes. Inspect assigned workspace artifacts only; do not read secrets or send data over the network. Use read tools, sandboxed analysis, or `node scripts/review-verify.js [ids]` for tests (direct test-file runs are refused by the in-process review executor). Do not retry write attempts. Finish with TASK and VERDICT.';
