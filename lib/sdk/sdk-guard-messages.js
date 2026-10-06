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
  'Review is read-only. This one Bash command was denied before execution; other commands are not blocked. `grep`, `rg`, `sed -n`, `find`, `jq`, and `git log/diff/show` still run. An unknown catalog id is denied: `node scripts/review-verify.js <catalog-id>` accepts only an audited id, with no flags, pipes, redirects, absolute paths, or extra commands. Do not retry the same id. A project test that is not in the catalog runs as `node --test tests/<file>.test.js`. Opaque interpreters (`python`/`python3`, `node -e`, `perl`, `ruby`, and `-c`/heredoc scripts) are denied too: review runs without a filesystem sandbox, so their writes cannot be ruled out. Do not retry them. Continue the review using read-only tools.';
