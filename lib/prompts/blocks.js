/**
 * Prompt block registry: named instruction blocks shared by agent prompt
 * builders. A migrated builder composes these constants instead of carrying its
 * own copy, so a policy sentence is edited in one place and the consistency test
 * (tests/prompt-registry-consistency.test.js) can prove each block appears
 * exactly once in every migrated prompt.
 *
 * Blocks are plain strings (one logical rule each) and have no side effects.
 */

/** Plan gate: an approved ancestor plan opens the whole subtree; only a human approves. */
export const PLAN_GATE_ANCESTOR_BLOCK = 'Plan gate: check the `plan_gate` line of `todo_show` (a plan approved on any ancestor opens the subtree); if not open, stop and wait for human approval. Never set `plan.approvedAt` or bypass the gate.';

/** Orchestrators delegate; they never write git history. */
export const NO_COMMIT_PUSH_BLOCK = 'Never commit, push, merge, rebase, cherry-pick, reset or clean.';

/** Variant for flows that legitimately commit (integration): history rewrites stay forbidden. */
export const NO_PUSH_DESTRUCTIVE_BLOCK = 'Never push, reset, stash or discard local changes.';

/** Runtime data is not workspace material. */
export const NO_DATA_DIR_BLOCK = 'Never touch files under `data/`.';

/** MCP is the primary channel for every Cretli action. */
export const MCP_FIRST_BLOCK = 'Use the Cretli MCP tools first; they are the primary channel.';

/** HTTP is a fallback only when the MCP tool is unavailable. */
export const CURL_FALLBACK_BLOCK = 'Use the curl callback only as a fallback when MCP is unavailable (same fields, camelCase).';

/**
 * Reviewer policy shared by every orchestrating prompt: explicit subject, an
 * independent reviewer, and a server-owned review block.
 */
export const REVIEWER_POLICY_BLOCK = 'Reviewer policy: start every review with an explicit `review_subject` (`code` or `plan`), never the server default; the reviewer must be independent of the implementer, and an implementer PASS is never a review PASS. The todo `review` block is server-owned: re-read it with `todo_show` before closing a leaf and never try to set it with `todo_update` or `todo_create`.';

/** Forward model_pick's pickId so the server can validate the link. */
export const PICK_FORWARDING_BLOCK = 'Forward the `pickId` returned by `model_pick` as `pick_id` on the matching `delegation_start` (one pick -> one start). Never re-pick or match the proposal by time.';

/** Frozen registry of all named blocks, for tests and tooling. */
export const PROMPT_BLOCKS = Object.freeze({
  planGateAncestor: PLAN_GATE_ANCESTOR_BLOCK,
  noCommitPush: NO_COMMIT_PUSH_BLOCK,
  noPushDestructive: NO_PUSH_DESTRUCTIVE_BLOCK,
  noDataDir: NO_DATA_DIR_BLOCK,
  mcpFirst: MCP_FIRST_BLOCK,
  curlFallback: CURL_FALLBACK_BLOCK,
  reviewerPolicy: REVIEWER_POLICY_BLOCK,
  pickForwarding: PICK_FORWARDING_BLOCK,
});
