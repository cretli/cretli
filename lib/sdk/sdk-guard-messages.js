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
  'Review is read-only. This Bash command was denied before execution. Run file inspection commands separately. Run audited catalog tests as `node scripts/review-verify.js <catalog-id>` with no flags, pipes, redirects, or extra commands, or run a project test as `node --test tests/<file>.test.js`. Opaque interpreters (`python`/`python3`, `node -e`, `perl`, `ruby`, and `-c`/heredoc scripts) are denied too: review runs without a filesystem sandbox, so their writes cannot be ruled out. Do not retry them; inspect with the read-only explorers instead (`jq`, `grep`/`rg`, `sed -n`, `find`, `awk` programs without `system(` or output redirection, `git log/diff/show`). Continue the review using read-only tools.';
