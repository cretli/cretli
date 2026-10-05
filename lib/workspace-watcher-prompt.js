/**
 * Prompt contract for one Workspace Watcher orchestrator cycle.
 *
 * The orchestrator is a short-lived chat: it has no memory across cycles, so
 * every durable fact (which todo, whether a plan is approved, which harnesses
 * are allowed, what earlier cycles did) must travel in the prompt text. This
 * module is the single source of that contract and is intentionally free of
 * side effects so it can be unit-tested without a store or a chat adapter.
 *
 * Non-negotiables encoded here:
 *   - one cycle = exactly this chat run; the orchestrator never starts the next
 *     cycle (the watcher does),
 *   - a plan draft is saved with a real CAS tool and never carries
 *     `approvedAt`; only a human approves, and only when the policy asks for it,
 *   - implementation/review happen through `delegation_start` (never Cursor
 *     Task), and the todo is completed only after an independent review PASS,
 *   - the cycle always ends with a durable report
 *     (`workspace_watcher_update` action "report": success|blocked|failure),
 *   - previous cycle chats are linked so a fresh orchestrator can recover the
 *     earlier context instead of redoing it.
 */

/**
 * @param {object} watcher
 * @param {object[]} activeUsageLimits
 * @returns {string[]}
 */
function blockedHarnessesFor(watcher, activeUsageLimits) {  const allowed = Array.isArray(watcher?.policy?.allowedHarnesses)
    ? watcher.policy.allowedHarnesses.map((h) => String(h ?? '').trim()).filter(Boolean)
    : [];
  const limits = Array.isArray(activeUsageLimits) ? activeUsageLimits : [];
  /** @type {Set<string>} */
  const blocked = new Set();
  for (const row of limits) {
    const harness = String(row?.harness ?? '').trim();
    if (harness) blocked.add(harness);
  }
  // A hard allow-list means every harness outside it is unavailable too.
  if (allowed.length > 0) {
    for (const harness of blocked) {
      if (!allowed.includes(harness)) blocked.add(harness);
    }
  }
  return [...blocked];
}

/**
 * Human-readable "previous chats" block. Newest first, id-only links so the
 * orchestrator can pull the context on demand with `chat_show`.
 *
 * @param {Array<{ id?: string, cycleId?: string, todoIds?: string[], at?: string, outcome?: string }>} chats
 * @returns {string}
 */
export function buildWorkspaceWatcherPreviousChatsBlock(chats) {
  const rows = (Array.isArray(chats) ? chats : [])
    .map((chat) => {
      const id = String(chat?.id || '').trim();
      if (!id) return '';
      const todos = Array.isArray(chat?.todoIds) ? chat.todoIds.filter(Boolean).map((t) => String(t).slice(0, 8)) : [];
      const outcome = String(chat?.outcome || '').trim();
      const at = String(chat?.at || '').trim();
      return `- ${id} · todo=${todos.join(',') || '-'}${outcome ? ` · outcome=${outcome}` : ''}${at ? ` · ${at}` : ''}`;
    })
    .filter(Boolean);
  if (rows.length === 0) return '';
  return [
    'PREVIOUS CYCLES for this workspace (newest first; load one with MCP `chat_show({ chat: "<id>" })`',
    'or `chat_history` when you need the earlier context — do not redo work they already finished):',
    ...rows,
  ].join('\n');
}

/**
 * The memory section is capped so it can never crowd out the cycle contract.
 * A token is ~4 characters, so the 3000-token budget is a character budget of
 * 12000; the builder stops adding facts once it would be exceeded.
 */
export const WORKSPACE_MEMORY_PROMPT_TOKEN_BUDGET = 3000;
export const WORKSPACE_MEMORY_PROMPT_CHAR_BUDGET = WORKSPACE_MEMORY_PROMPT_TOKEN_BUDGET * 4;
/** Longer values are shortened; the full text stays available via the list tool. */
export const WORKSPACE_MEMORY_PROMPT_ENTRY_VALUE_CHARS = 300;

/**
 * Blockers and decisions are the facts a fresh cycle must not miss; patterns and
 * loose context matter least when the budget is tight.
 */
const WORKSPACE_MEMORY_TYPE_PRIORITY = Object.freeze({
  blocker: 0,
  decision: 1,
  finding: 2,
  pattern: 3,
  context: 4,
});

/**
 * @param {unknown} value
 * @returns {string}
 */
function collapseMemoryWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

/**
 * Render durable workspace facts as the "WORKSPACE MEMORY" prompt section.
 * Expired entries are ignored, the rest is ordered by importance (blocker,
 * decision, finding, pattern, context) and then newest-first, and the block is
 * clipped to `maxChars` (default the 3000-token budget) so it stays a hint, not
 * the bulk of the prompt. Empty input yields an empty string.
 *
 * @param {Array<{ type?: string, key?: string, value?: string, createdAt?: string, expiresAt?: string }>} entries
 * @param {{ now?: number, maxChars?: number }} [options]
 * @returns {string}
 */
export function buildWorkspaceMemoryPromptBlock(entries, options = {}) {
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const configuredMax = Number(options.maxChars);
  const maxChars = Number.isFinite(configuredMax) && configuredMax > 0
    ? Math.floor(configuredMax)
    : WORKSPACE_MEMORY_PROMPT_CHAR_BUDGET;
  const live = (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && typeof entry === 'object')
    .filter((entry) => {
      const expiresAt = String(entry.expiresAt || '').trim();
      if (!expiresAt) return true;
      const parsed = Date.parse(expiresAt);
      return !Number.isFinite(parsed) || parsed > now;
    })
    .map((entry) => ({
      type: String(entry.type || 'context').trim().toLowerCase(),
      key: String(entry.key || '').trim(),
      value: collapseMemoryWhitespace(entry.value),
      at: String(entry.createdAt || '').trim(),
    }))
    .filter((entry) => entry.key && entry.value);
  if (live.length === 0) return '';
  live.sort((a, b) => {
    const priorityA = WORKSPACE_MEMORY_TYPE_PRIORITY[a.type] ?? 9;
    const priorityB = WORKSPACE_MEMORY_TYPE_PRIORITY[b.type] ?? 9;
    if (priorityA !== priorityB) return priorityA - priorityB;
    const timeA = Date.parse(a.at);
    const timeB = Date.parse(b.at);
    return (Number.isFinite(timeB) ? timeB : 0) - (Number.isFinite(timeA) ? timeA : 0);
  });
  const header = 'WORKSPACE MEMORY (durable facts from earlier cycles — treat as prior decisions; do not redo them):';
  const footerReserve = 220;
  /** @type {string[]} */
  const lines = [header];
  let used = header.length + 1;
  let omitted = 0;
  for (const entry of live) {
    const line = `- [${entry.type}] ${entry.key}: ${entry.value.slice(0, WORKSPACE_MEMORY_PROMPT_ENTRY_VALUE_CHARS)}`;
    if (used + line.length + 1 > maxChars - footerReserve) {
      omitted += 1;
      continue;
    }
    lines.push(line);
    used += line.length + 1;
  }
  if (lines.length === 1) {
    // Not even the first fact fit; truncate it instead of emitting a bare header.
    const entry = live[0];
    const prefix = `- [${entry.type}] ${entry.key}: `;
    const room = Math.max(0, maxChars - header.length - 1 - prefix.length);
    lines.push(prefix + entry.value.slice(0, room));
    omitted = live.length - 1;
  }
  if (omitted > 0) {
    lines.push(`(${omitted} older/lower-priority fact(s) omitted to stay within the memory budget; call \`workspace_memory_list\` for the rest.)`);
  }
  return lines.join('\n');
}

/**
 * @param {{
 *   workspaceFolder: string,
 *   watcher: object,
 *   decision: object,
 *   todo: object | null,
 *   orchestrator: { harness?: string, model?: string, source?: string },
 *   activeUsageLimits?: object[],
 *   previousChats?: Array<object>,
 *   memory?: Array<object>,
 *   cycleId?: string,
 *   chatId?: string,
 * }} input
 * @returns {string}
 */
export function buildWorkspaceWatcherCyclePrompt(input) {
  const workspaceFolder = String(input.workspaceFolder || '');
  const todo = input.todo || {};
  const todoId = String(todo.id || '');
  const planOnly = input.decision?.planOnly === true || input.decision?.kind === 'plan_gate';
  const planTargetId = String(input.decision?.planTargetId || '').trim();
  const policy = input.watcher?.policy || {};
  const allowed = Array.isArray(policy.allowedHarnesses) ? policy.allowedHarnesses : [];
  const limits = Array.isArray(input.activeUsageLimits) ? input.activeUsageLimits : [];
  const blocked = blockedHarnessesFor(input.watcher, limits);
  const pickRoles = Array.isArray(policy.pickRoles) && policy.pickRoles.length
    ? policy.pickRoles.join(', ')
    : 'plan, implement, review';
  const reportId = String(input.cycleId || '').trim();
  const previousChatsBlock = buildWorkspaceWatcherPreviousChatsBlock(input.previousChats);
  const memoryBlock = buildWorkspaceMemoryPromptBlock(input.memory || input.workspaceMemory);

  /** @type {string[]} */
  const lines = [
    'You are the Workspace Watcher orchestrator for exactly ONE cycle. Do the work, report it, and stop.',
    'Do not start another cycle. Do not commit or push. Do not merge.',
    '',
    `Workspace: ${workspaceFolder}`,
    `Todo: ${todoId || '(none)'} — ${String(todo.title || '(untitled)')}`,
    'Snapshot: call `workspace_watcher_show` (watcher snapshot) and `todo_show` (todo + plan) before acting.',
  ];
  if (todoId) lines.push(`cretli-ref todo=${todoId}`);
  lines.push(
    `Orchestrator executor: ${input.orchestrator?.harness || 'default'}${input.orchestrator?.model ? `:${input.orchestrator.model}` : ''} (${input.orchestrator?.source || 'default'})`,
    `Pick roles: ${pickRoles}`,
    `Allowed harnesses: ${allowed.length ? allowed.join(', ') : '(no restriction)'}`,
    `Harnesses under an active usage limit (do NOT pick): ${blocked.length ? blocked.join(', ') : '(none)'}`,
  );
  if (previousChatsBlock) {
    lines.push('', previousChatsBlock);
  }
  if (memoryBlock) {
    lines.push('', memoryBlock);
  }
  lines.push('', 'Required loop (cretli-multi-harness skill):');
  if (planOnly) {
    const planSaveTarget = planTargetId || todoId;
    const planSaveNote = planTargetId && planTargetId !== todoId
      ? `\n   Target for the plan is the SUBTREE ROOT ${planTargetId} (not the individual leaf ${todoId}).\n   Call \`todo_show\` on ${planTargetId} to read its context, then save the plan on ${planTargetId}.`
      : '';
    lines.push(
      `1) PLAN ONLY. Read the todo and snapshot, then save the draft plan markdown with${planSaveNote}`,
      `   \`workspace_watcher_update\` action "save_plan" (todo_id=${planSaveTarget} + expected_updated_at from \`todo_show\` + plan_markdown).`,
      '   That tool is a real CAS write and never sets plan.approvedAt.',
      '2) NEVER set plan.approvedAt — only a human approves a plan. Do not start implementation.',
      '3) Append a short note about the draft (for example by moving the todo status if the schema needs it) and end your turn.',
      '4) End now. The watcher will not start another plan cycle until the human approves.',
    );
  } else if (policy.requirePlanApproval !== false) {
    lines.push(
      '1) Read the todo and its approved plan. If approval is missing, stop and wait for human approval.',
      '   The plan gate is closed only by policy `requirePlanApproval`; never approve it yourself.',
      '2) Use `model_pick` with role "implement" (respect the allowed/limit lists above), then `delegation_start` the implementation.',
      '3) When the implementer finishes, run a `review` delegation. Fix only findings that block the task.',
      '4) After independent review PASS, mark this todo done with `todo_update` (patch.status + expected_updated_at from `todo_show`).',
      '   If review fails, record its findings hash AND summary text with `workspace_watcher_update` action "record_findings" (pass `findings_text`) and report the blocker.',
    );
  } else {
    lines.push(
      '1) Read the todo and plan as needed, then proceed directly to implementation; this workspace does not require plan approval.',
      '2) Use `model_pick` with role "implement" (respect the allowed/limit lists above), then `delegation_start` the implementation.',
      '3) When the implementer finishes, run a `review` delegation. Fix only findings that block the task.',
      '4) After independent review PASS, mark this todo done with `todo_update` (patch.status + expected_updated_at from `todo_show`).',
      '   If review fails, record its findings hash AND summary text with `workspace_watcher_update` action "record_findings" (pass `findings_text`) and report the blocker.',
    );
  }
  lines.push(
    '',
    'Progress: record steps with `todo_update` (a status change appends a changelog note) and keep the todo status honest.',
    'Never mark a todo done before the review PASS, and never mark a parent done while its descendants are open.',
    '',
    'Workspace memory: before you report, record the durable facts the next cycle must not rediscover with',
    '`workspace_memory_add` — type decision (with rationale), pattern, finding, blocker, or context. Keep each',
    'value short and use `ttl_ms` for facts that should expire (for example a codebase pattern from the last 30 days).',
    'If a WORKSPACE MEMORY section appears above, it is what earlier cycles left for you; use `workspace_memory_list` for the full list.',
    '',
    'End the cycle with a durable report (the watcher reads it back to update failures/cycleCount):',
    '`workspace_watcher_update` action "report" with:',
    `  outcome: "success" | "blocked" | "failure"`,
    `  todo_ids: ["${todoId || '<todo-id>'}"]`,
    input.cycleId ? `  cycle_id: "${input.cycleId}"` : '  cycle_id: "<the active cycle id from workspace_watcher_show>"',
    `  report_id: "${reportId || '<cycle-id>'}"`,
    '  message: one line: what was done / what is blocked / what comes next.',
    '',
    'Hard rules:',
    '- One cycle = exactly this chat run. Never spawn another watcher cycle — the watcher does that.',
    '- Never overwrite a todo that is doing/done outside this cycle.',
    '- Report blockers in the todo changelog and in the cycle report instead of failing silently.',
  );
  return lines.join('\n');
}
