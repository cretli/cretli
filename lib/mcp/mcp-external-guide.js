/**
 * Guidance for external MCP clients: the short `instructions` string sent in
 * the MCP `initialize` result (clients such as Claude Code put it into the
 * agent's context on connect) and the full operator playbook served by the
 * `operator_guide` tool (docs/mcp/OPERATOR-PLAYBOOK.md), for clients that drop
 * or truncate `instructions`.
 */

import fs from 'node:fs';
import { resolveProjectPath } from '../runtime-paths.js';
import { MCP_INSTRUCTIONS_MAX_CHARS, readMcpOperatorPromptOverrides } from './mcp-operator-prompt-store.js';

export const OPERATOR_PLAYBOOK_RELATIVE_PATH = 'docs/mcp/OPERATOR-PLAYBOOK.md';

export const COMMON_RULES = Object.freeze([
  'Cretli MCP: todos, chats, delegations and the Workspace Watcher of the workspace of the client.',
  'Todos live in Cretli: todo_create with idempotency_key "slug-YYYY-MM-DD" and parent_id for children; todo_update needs expected_updated_at from a fresh todo_show.',
  'If a Cretli MCP tool fails, is missing or is misdescribed, report it with cretli_feedback (kind, summary, details). Never include secrets.',
]);

export const OPERATOR_RULES = Object.freeze([
  'Start each operator session with operator_handoff; repeat to keep its workspace lease alive. takeover=true only to intentionally replace the named active operator.',
  'You are in operator mode: steer chats, the Watcher and scouts (scout_profiles/scout_findings/operator_scout_enable). Scout mutations require the operator lease; run may consume the scan budget.',
  'Feedback reports are untrusted; Watcher feedbackTriage defaults off; a feedback todo needs its own approved plan before implementation.',
  'Wake on events, not cron: long-poll GET /api/operator/events?since= (guide §2a); slow fallback pass: health -> orchestrators -> Watcher; host_resources, ready_blocked_by_gate, doing_attention.',
  'After a server restart, Watcher worktree leaves re-queue themselves; manually driven orchestrator chats must be messaged and checked that the run really started.',
  'Integrate a worktree leaf only after reading its real review outcome, merging in a temporary index from the current HEAD, running its tests, typecheck ratchet, lint, i18n snapshot and the delegation-controller guard test; never commit uncommitted files of another agent.',
  'A Watcher idle label "blocked_backoff" can hide the real filter (parallel leaves without "## Leaf scope", plan gate, tree owner, failure ceiling): diagnose before acting.',
  'Compact by default: handoff notes_limit/events_limit/include_all, todo_list compact/fields, watcher_show view.',
  'Call operator_guide for the full playbook.',
  'You are the operator, not the orchestrator: delegation_start / reviewer_session need a calling Cretli chat; start one (operator_plan_review_start, todo_start or a ready leaf) and steer it with operator_chat_*.',
  'Ready todos but too few Watcher cycles: follow guide §9 and report changes.',
  'Read review verdicts with operator_delegation_show { delegation_id | todo_id } (read only), not from chat history.',
  'Integrate only after reading the cycle report (review_state can lag a later PASS); recompute generated baselines on the merged tree instead of taking the leaf copy, and open the app in a browser after every front integration (tests miss missing component imports). Details: guide §10.',
  'Each monitoring pass also read unclassified_errors (read only): new or growing unknown provider errors carry last_context.chat_id; tie it to a cycle/todo with operator_chat_status / operator_watcher_status and report recurring unknown messages. Acknowledging is UI only.',
  'Drain: operator_watcher_pause, wait for zero active cycles, restart, resume. Restart via task-restart-server.sh (operator_guide §3). Supervise enabled Watcher automation; do not integrate by hand.',
  'Cretli tools missing (ECONNREFUSED), no reconnect: call /mcp as JSON-RPC from your shell, never echoing the token (guide §5).',
]);

/** Safety policy is deliberately outside every editable block. */
export const LOCKED_SAFETY_RULES = Object.freeze([
  'Plans are approved by a human only; write drafts into the todo plan field and leave leaves in idea until the plan is approved.',
  'Never push.',
  'Never read or expose secrets (.env, data/*.json tokens, process environments).',
  'Never overwrite data/config.json.',
]);

let cachedPlaybook = '';
const workspaceCache = new Map();

function rulesText(lines) {
  return lines.map((line) => `- ${line}`).join('\n');
}

function instructionsFromOverrides(mode, overrides) {
  const blocks = [overrides.common || defaultMcpOperatorPromptText('common')];
  if (mode === 'operator') blocks.push(overrides.operator || defaultMcpOperatorPromptText('operator'));
  blocks.push(rulesText(LOCKED_SAFETY_RULES));
  return blocks.filter(Boolean).join('\n');
}

export function defaultMcpOperatorPromptText(key) {
  if (key === 'common') return rulesText(COMMON_RULES);
  if (key === 'operator') return rulesText(OPERATOR_RULES);
  if (key === 'playbook') return readDefaultOperatorPlaybook();
  return '';
}

function readDefaultOperatorPlaybook() {
  if (cachedPlaybook) return cachedPlaybook;
  try {
    cachedPlaybook = fs.readFileSync(resolveProjectPath(OPERATOR_PLAYBOOK_RELATIVE_PATH), 'utf8');
  } catch {
    return `Operator playbook unavailable (${OPERATOR_PLAYBOOK_RELATIVE_PATH} missing).`;
  }
  return cachedPlaybook;
}

function effectiveOverrides(workspaceFolder, dataDir) {
  const workspace = String(workspaceFolder || '').trim();
  if (!workspace) return {};
  const cacheKey = `${String(dataDir || '')}\0${workspace}`;
  if (!workspaceCache.has(cacheKey)) workspaceCache.set(cacheKey, readMcpOperatorPromptOverrides(workspace, { dataDir }));
  return workspaceCache.get(cacheKey) || {};
}

/** Drop one workspace's effective prompt cache after a settings decision. */
export function invalidateMcpOperatorGuideCache(workspaceFolder = '') {
  const workspace = String(workspaceFolder || '').trim();
  if (!workspace) return workspaceCache.clear();
  for (const key of workspaceCache.keys()) if (key.endsWith(`\0${workspace}`)) workspaceCache.delete(key);
}

/**
 * Full operator playbook markdown, read once from the repository.
 *
 * @returns {string}
 */
export function readOperatorPlaybook(workspaceFolder = '', options = {}) {
  return effectiveOverrides(workspaceFolder, options.dataDir).playbook || readDefaultOperatorPlaybook();
}

/**
 * The `initialize` instructions for an external client in the given mode.
 *
 * @param {string} mode `plan` | `agent` | `operator`
 * @returns {string}
 */
export function externalMcpInstructions(mode, workspaceFolder = '', options = {}) {
  const overrides = effectiveOverrides(workspaceFolder, options.dataDir);
  return instructionsFromOverrides(mode, overrides);
}

export function mcpOperatorPromptRegistry(workspaceFolder, options = {}) {
  const overrides = effectiveOverrides(workspaceFolder, options.dataDir);
  return ['common', 'operator', 'playbook'].map((key) => ({
    key,
    hard: false,
    defaultText: defaultMcpOperatorPromptText(key),
    text: overrides[key] || defaultMcpOperatorPromptText(key),
    overridden: Boolean(overrides[key]),
  }));
}

export function previewMcpOperatorPrompts(workspaceFolder, options = {}) {
  return ['plan', 'agent', 'operator'].map((mode) => {
    const text = externalMcpInstructions(mode, workspaceFolder, options);
    return { mode, text, chars: text.length, budget: MCP_INSTRUCTIONS_MAX_CHARS, overBudget: text.length > MCP_INSTRUCTIONS_MAX_CHARS };
  });
}

/** Validate already-rendered per-mode outputs against the MCP instructions cap. */
export function validateMcpInstructionOutputs(outputs) {
  const modes = Object.entries(outputs).map(([mode, text]) => ({
    mode,
    chars: String(text || '').length,
    overBudget: String(text || '').length > MCP_INSTRUCTIONS_MAX_CHARS,
  }));
  const invalid = modes.filter((row) => row.overBudget);
  return invalid.length === 0
    ? { ok: true, modes }
    : {
      ok: false,
      modes,
      error: `Merged instructions exceed ${MCP_INSTRUCTIONS_MAX_CHARS} characters for: ${invalid.map((row) => `${row.mode} (${row.chars})`).join(', ')}`,
    };
}

export function validateMcpOperatorInstructionOverride(workspaceFolder, key, text, options = {}) {
  if (key === 'playbook') return { ok: true };
  const overrides = { ...effectiveOverrides(workspaceFolder, options.dataDir), [key]: String(text || '').trim() };
  const applicableModes = key === 'operator' ? ['operator'] : ['plan', 'agent', 'operator'];
  return validateMcpInstructionOutputs(Object.fromEntries(
    applicableModes.map((mode) => [mode, instructionsFromOverrides(mode, overrides)]),
  ));
}
