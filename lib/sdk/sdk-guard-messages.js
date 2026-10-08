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
  'This command was blocked by the read-only review policy; the review is still active, and other commands are not blocked. Do not retry it or bypass the block with different quoting, a pipe, or another interpreter. Continue with native read tools or one standalone read-only explorer command (`grep`, `rg`, `sed -n`, `find`, `jq`, or `git log/diff/show`). Opaque scripts (`python`/`python3`, `node -e`, `perl`, `ruby`, heredoc or `-c` scripts) are blocked by policy; do not retry them. If an artifact cannot be inspected with allowed tools, state that limitation and finish the review instead of looping on shell attempts. For tests, use only `node scripts/review-verify.js <audited-id>` (exact command, no flags, pipes, redirects, or extra commands) or `node --test tests/<file>.test.js`; an absolute test path is also allowed when it resolves inside the assigned workspace’s `tests` directory. Unknown catalog ids are denied; do not retry the same id. Include the required final `TASK` and `VERDICT` lines.';

export const DEEPSEEK_REVIEW_GUARD_USER_MESSAGE =
  'The DeepSeek review remains active. The DSH read-only sandbox rejects filesystem writes, so do not retry edits, deletes, redirects, or other write attempts. For artifact analysis you may use read-only commands, including Python via the sandboxed `bash` tool. Keep inspection within the assigned workspace and do not read secrets or send data over the network: DSH read-only mode does not isolate reads or disable network access. If an artifact cannot be safely inspected, state the limitation and finish the report. For tests, use only `node scripts/review-verify.js <audited-id>` (exact command, no flags, pipes, redirects, or extra commands) or `node --test tests/<file>.test.js`; an absolute test path is also allowed when it resolves inside the assigned workspace’s `tests` directory. Include the required final `TASK` and `VERDICT` lines.';
