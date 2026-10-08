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
 *     (`watcher_update` action "report": success|blocked|failure),
 *   - previous cycle chats are linked so a fresh orchestrator can recover the
 *     earlier context instead of redoing it.
 */

import { harnessBlockerScopeKey, memoryEntryDedupKey } from './workspace-memory-key.js';

/**
 * Harness/model scopes that must not be picked in this cycle. A usage-limit row
 * without a model blocks the whole harness; one with a model blocks only that
 * model (`harness:model`), matching `isWorkspaceWatcherOrchestratorModelUsageLimited`
 * and never turning a model-scoped limit into a whole-harness ban. Expired rows
 * are ignored; an unparseable `resetAt` counts as active, exactly like the
 * resolver. The policy allow-list is a separate constraint rendered on its own
 * prompt line.
 *
 * @param {Array<{ harness?: string, model?: string, resetAt?: string }>} activeUsageLimits
 * @returns {string[]}
 */
function blockedUsageLimitScopesFor(activeUsageLimits) {
  const limits = Array.isArray(activeUsageLimits) ? activeUsageLimits : [];
  /** @type {string[]} */
  const scopes = [];
  const seen = new Set();
  for (const row of limits) {
    const harness = String(row?.harness ?? '').trim();
    if (!harness) continue;
    const resetAt = Date.parse(String(row?.resetAt ?? '').trim());
    if (Number.isFinite(resetAt) && resetAt <= Date.now()) continue;
    const model = String(row?.model ?? '').trim();
    const scope = model ? `${harness}:${model}` : harness;
    if (seen.has(scope)) continue;
    seen.add(scope);
    scopes.push(scope);
  }
  return scopes;
}

/** Non-relevant previous cycles kept next to every relevant one. */
const WORKSPACE_WATCHER_PREVIOUS_CHAT_REST_LIMIT = 3;

/**
 * Parse a cycle close time (`at`). Missing or invalid timestamps return `null`
 * so they can be sorted last instead of being treated as epoch 0.
 *
 * @param {{ at?: string }} chat
 * @returns {number|null}
 */
function previousCycleCloseTime(chat) {
  const at = String(chat?.at ?? '').trim();
  if (!at) return null;
  const parsed = Date.parse(at);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Newest-first comparator by close time (`at`, never `startedAt`). Missing or
 * invalid close times sort last; an id tie-break keeps equal timestamps stable.
 *
 * @param {{ id?: string, at?: string }} a
 * @param {{ id?: string, at?: string }} b
 * @returns {number}
 */
function comparePreviousCyclesNewest(a, b) {
  const timeA = previousCycleCloseTime(a);
  const timeB = previousCycleCloseTime(b);
  if (timeA === null && timeB === null) return String(b?.id || '').localeCompare(String(a?.id || ''));
  if (timeA === null) return 1;
  if (timeB === null) return -1;
  if (timeA !== timeB) return timeB - timeA;
  return String(b?.id || '').localeCompare(String(a?.id || ''));
}

/**
 * True when a closed cycle touched one of the cycle-context ids (the picked
 * todo, its ancestors or the plan target). Ids compare case-insensitively and a
 * shared 8-char prefix counts as the same todo, mirroring memory relevance.
 *
 * @param {{ todoIds?: string[] }} chat
 * @param {string[]} contextIds
 * @returns {boolean}
 */
function previousCycleMatchesTodoIds(chat, contextIds) {
  const chatIds = Array.isArray(chat?.todoIds) ? chat.todoIds : [];
  for (const rawChatId of chatIds) {
    const chatId = String(rawChatId || '').trim().toLowerCase();
    if (!chatId) continue;
    for (const rawContextId of contextIds) {
      const contextId = String(rawContextId || '').trim().toLowerCase();
      if (!contextId) continue;
      if (chatId === contextId) return true;
      if (chatId.length >= 8 && contextId.length >= 8 && chatId.slice(0, 8) === contextId.slice(0, 8)) return true;
    }
  }
  return false;
}

/**
 * One rendered previous-cycle row. `[relevance]` marks a cycle that touched the
 * current todo/ancestors/plan target so the fresh orchestrator knows which chats
 * to load first with `chat_show`.
 *
 * @param {{ id?: string, todoIds?: string[], at?: string, outcome?: string }} chat
 * @param {boolean} relevant
 * @returns {string}
 */
function formatPreviousCycleRow(chat, relevant) {
  const id = String(chat?.id || '').trim();
  const todos = Array.isArray(chat?.todoIds) ? chat.todoIds.filter(Boolean).map((t) => String(t).slice(0, 8)) : [];
  const outcome = String(chat?.outcome || '').trim();
  const at = String(chat?.at || '').trim();
  return `- ${relevant ? '[relevance] ' : ''}${id} · todo=${todos.join(',') || '-'}${outcome ? ` · outcome=${outcome}` : ''}${at ? ` · ${at}` : ''}`;
}

/**
 * Human-readable "previous cycles" block. Cycles for the current todo, its
 * ancestors and the plan target are always candidates; from the rest only the
 * newest `WORKSPACE_WATCHER_PREVIOUS_CHAT_REST_LIMIT` are kept. The result is
 * sorted newest first by close time `at`, with relevant rows marked
 * `[relevance]`. When `options.maxChars` is set the oldest rows are dropped and
 * a mandatory footer reports how many were omitted, so the block can never eat
 * the whole prompt budget and the omission is never silent.
 *
 * @param {Array<{ id?: string, cycleId?: string, todoIds?: string[], at?: string, outcome?: string }>} chats
 * @param {{ maxChars?: number, todoIds?: string[], relevantIds?: string[] }} [options]
 * @returns {string}
 */
export function buildWorkspaceWatcherPreviousChatsBlock(chats, options = {}) {
  const maxChars = Number.isFinite(Number(options.maxChars)) && Number(options.maxChars) > 0
    ? Math.floor(Number(options.maxChars))
    : 0;
  const contextIds = Array.isArray(options.todoIds) ? options.todoIds : (options.relevantIds || []);
  // Deduplicate by chat id; a repeated id keeps its newest close time.
  /** @type {Map<string, object>} */
  const byId = new Map();
  for (const chat of Array.isArray(chats) ? chats : []) {
    const id = String(chat?.id || '').trim();
    if (!id) continue;
    const previous = byId.get(id);
    if (!previous || comparePreviousCyclesNewest(chat, previous) < 0) byId.set(id, { ...chat, id });
  }
  const all = [...byId.values()];
  if (all.length === 0) return '';
  const relevant = [];
  const rest = [];
  for (const chat of all) {
    if (previousCycleMatchesTodoIds(chat, contextIds)) relevant.push(chat);
    else rest.push(chat);
  }
  rest.sort(comparePreviousCyclesNewest);
  const candidates = [...relevant, ...rest.slice(0, WORKSPACE_WATCHER_PREVIOUS_CHAT_REST_LIMIT)]
    .sort(comparePreviousCyclesNewest)
    .map((chat) => ({ line: formatPreviousCycleRow(chat, previousCycleMatchesTodoIds(chat, contextIds)) }));
  const header = [
    'PREVIOUS CYCLES for this workspace (newest first by close time; `[relevance]` marks a cycle for',
    'this todo/ancestor/plan target — load one with MCP `chat_show({ chat: "<id>" })` or `chat_history`):',
  ].join('\n');
  const footerFor = (count) => `(${count} older/lower-priority previous cycle(s) omitted; call \`chat_list\` for the rest.)`;
  if (!maxChars) {
    const block = [header, ...candidates.map((row) => row.line)].join('\n');
    const omitted = all.length - candidates.length;
    return omitted > 0 ? `${block}\n${footerFor(omitted)}` : block;
  }
  // The footer must survive the trim, so every candidate prefix is measured
  // together with the footer that its own omission would require.
  let rendered = 0;
  for (let count = candidates.length; count >= 1; count -= 1) {
    const parts = [header, ...candidates.slice(0, count).map((row) => row.line)];
    const omitted = all.length - count;
    if (omitted > 0) parts.push(footerFor(omitted));
    if (parts.join('\n').length <= maxChars) {
      rendered = count;
      break;
    }
  }
  if (rendered === 0) return '';
  const shown = candidates.slice(0, rendered).map((row) => row.line);
  const block = [header, ...shown].join('\n');
  const omitted = all.length - rendered;
  return omitted > 0 ? `${block}\n${footerFor(omitted)}` : block;
}

/**
 * Whole-prompt hard cap. The cycle contract plus the optional previous-cycles
 * and workspace-memory sections must fit here; a contract that cannot fit is
 * refused instead of being silently shortened.
 */
export const WORKSPACE_WATCHER_PROMPT_CHAR_BUDGET = 7000;
/** At most this many characters go to the previous-cycles section. */
export const WORKSPACE_WATCHER_PROMPT_HISTORY_CHAR_BUDGET = 1000;
/**
 * The memory section is capped as a whole (header + entries + footer), not only
 * per entry: durable facts must never push the cycle contract out of the prompt.
 */
export const WORKSPACE_MEMORY_PROMPT_CHAR_BUDGET = 3000;
/** Longer values are shortened at a sentence/word boundary; the full text stays in `wmem_list`. */
export const WORKSPACE_MEMORY_PROMPT_ENTRY_VALUE_CHARS = 300;
/** Most facts one memory section may render; the rest is reachable via `wmem_list`. */
export const WORKSPACE_MEMORY_PROMPT_ENTRY_LIMIT = 8;

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
 * @param {string} value
 * @returns {string}
 */
function escapeMemoryRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Newest-first time of an entry, preferring `updatedAt` and falling back to
 * `createdAt`. Missing/invalid timestamps sort oldest.
 *
 * @param {{ updatedAt?: string, createdAt?: string }} entry
 * @returns {number}
 */
function memoryEntryTime(entry) {
  const updated = Date.parse(String(entry?.updatedAt || ''));
  if (Number.isFinite(updated)) return updated;
  const created = Date.parse(String(entry?.createdAt || ''));
  return Number.isFinite(created) ? created : 0;
}

/**
 * Newest-first comparator with a stable id tie-break.
 *
 * @param {{ id?: string, updatedAt?: string, createdAt?: string }} a
 * @param {{ id?: string, updatedAt?: string, createdAt?: string }} b
 * @returns {number}
 */
function compareMemoryEntriesNewest(a, b) {
  const timeA = memoryEntryTime(a);
  const timeB = memoryEntryTime(b);
  if (timeA !== timeB) return timeB - timeA;
  return String(b?.id || '').localeCompare(String(a?.id || ''));
}

/**
 * True when `haystack` references `identifier` as a whole identifier: a full
 * uuid or an 8-char prefix bounded by non-alphanumeric characters. Matching is
 * case-insensitive but never occurs inside a longer hex/alphanumeric word.
 *
 * @param {string} haystack
 * @param {string} identifier
 * @returns {boolean}
 */
function referencesIdentifier(haystack, identifier) {
  const needle = String(identifier || '').trim();
  if (!needle) return false;
  const re = new RegExp(`(^|[^0-9A-Za-z])${escapeMemoryRegExp(needle)}(?![0-9A-Za-z])`, 'i');
  return re.test(haystack);
}

/**
 * Shorten a value to `maxChars`, cutting at the last sentence end that fits;
 * when no sentence fits, at the last word boundary. A truncation is always
 * marked with an ellipsis.
 *
 * @param {string} value
 * @param {number} maxChars
 * @returns {string}
 */
function clipMemoryValue(value, maxChars) {
  const text = collapseMemoryWhitespace(value);
  const limit = Math.max(1, Math.floor(Number(maxChars) || 0));
  if (text.length <= limit) return text;
  const slice = text.slice(0, Math.max(1, limit - 1));
  let sentenceEnd = -1;
  for (const match of slice.matchAll(/[.!?](?=\s|$)/g)) sentenceEnd = (match.index ?? 0) + 1;
  if (sentenceEnd > 0) return `${slice.slice(0, sentenceEnd).trimEnd()}…`;
  const lastSpace = slice.lastIndexOf(' ');
  if (lastSpace > 0) return `${slice.slice(0, lastSpace).trimEnd()}…`;
  return `${slice.trimEnd()}…`;
}

/**
 * @param {number} count
 * @returns {string}
 */
function memoryOmittedFooter(count) {
  return `(${count} older/lower-priority fact(s) omitted to stay within the memory budget; call \`wmem_list\` for the rest.)`;
}

/**
 * Order live entries for the prompt:
 *   1. facts referencing the current todo / its ancestors / the plan target,
 *      in that id order,
 *   2. global harness/model blockers (newest per harness+model only),
 *   3. the remaining facts by type priority and recency.
 * Duplicate topics (same normalized key, or the same recognized blocker scope +
 * cause) collapse to the newest entry.
 *
 * @param {object[]} entries
 * @param {string[]} todoIds ordered: current todo first, then ancestors/plan target
 * @returns {object[]}
 */
function orderMemoryEntries(entries, todoIds) {
  // Each id matches either as a full uuid or as its 8-char prefix. Two needles
  // per id keep the id order (both needles of id0 precede id1), so the first
  // matching needle still ranks "current todo before ancestor before plan target".
  const ids = (Array.isArray(todoIds) ? todoIds : [])
    .map((id) => String(id || '').trim())
    .filter(Boolean);
  /** @type {string[]} */
  const needles = [];
  const seenNeedles = new Set();
  for (const id of ids) {
    for (const needle of [id, id.length > 8 ? id.slice(0, 8) : '']) {
      if (!needle || seenNeedles.has(needle)) continue;
      seenNeedles.add(needle);
      needles.push(needle);
    }
  }
  /** @type {Map<string, object>} */
  const newestByTopic = new Map();
  for (const entry of entries) {
    const topic = memoryEntryDedupKey(entry);
    const previous = newestByTopic.get(topic);
    if (!previous || compareMemoryEntriesNewest(entry, previous) < 0) newestByTopic.set(topic, entry);
  }
  const scored = [...newestByTopic.values()].map((entry) => {
    const haystack = `${entry.key} ${entry.value}`;
    let matchIndex = -1;
    for (let i = 0; i < needles.length; i += 1) {
      if (referencesIdentifier(haystack, needles[i])) {
        matchIndex = i;
        break;
      }
    }
    return { entry, matchIndex };
  });
  const todoRelevant = scored
    .filter((row) => row.matchIndex >= 0)
    .sort((a, b) => (a.matchIndex - b.matchIndex) || compareMemoryEntriesNewest(a.entry, b.entry));
  const rest = scored.filter((row) => row.matchIndex < 0);
  /** @type {object[]} */
  const globalBlockers = [];
  const seenScope = new Set();
  for (const entry of rest
    .map((row) => row.entry)
    .filter((entry) => harnessBlockerScopeKey(entry))
    .sort(compareMemoryEntriesNewest)) {
    const scope = harnessBlockerScopeKey(entry);
    if (seenScope.has(scope)) continue;
    seenScope.add(scope);
    globalBlockers.push(entry);
  }
  const globalIds = new Set(globalBlockers.map((entry) => entry.id));
  const remaining = rest
    .map((row) => row.entry)
    .filter((entry) => !globalIds.has(entry.id))
    .sort((a, b) => (WORKSPACE_MEMORY_TYPE_PRIORITY[a.type] ?? 9) - (WORKSPACE_MEMORY_TYPE_PRIORITY[b.type] ?? 9)
      || compareMemoryEntriesNewest(a, b));
  return [...todoRelevant.map((row) => row.entry), ...globalBlockers, ...remaining];
}

/**
 * Render durable workspace facts as the "WORKSPACE MEMORY" prompt section.
 *
 * Expired entries are ignored. Entries are ordered by relevance to `todoIds`
 * (current todo, ancestors, plan target), then global harness/model blockers,
 * then the remaining facts; duplicate topics collapse to the newest entry. The
 * section renders at most `WORKSPACE_MEMORY_PROMPT_ENTRY_LIMIT` facts and at
 * most `maxChars` characters in total (header, separators, footer and ellipsis
 * included). For a budget too small for a useful first line the section is
 * dropped (empty string) instead of overflowing.
 *
 * @param {Array<{ type?: string, key?: string, value?: string, createdAt?: string, updatedAt?: string, expiresAt?: string }>} entries
 * @param {{ now?: number, maxChars?: number, todoIds?: string[], relevantIds?: string[] }} [options]
 * @returns {string}
 */
export function buildWorkspaceMemoryPromptBlock(entries, options = {}) {
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const configuredMax = Number(options.maxChars);
  const maxChars = Number.isFinite(configuredMax) && configuredMax > 0
    ? Math.floor(configuredMax)
    : WORKSPACE_MEMORY_PROMPT_CHAR_BUDGET;
  const todoIds = options.todoIds || options.relevantIds;
  const live = (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && typeof entry === 'object')
    .filter((entry) => {
      const expiresAt = String(entry.expiresAt || '').trim();
      if (!expiresAt) return true;
      const parsed = Date.parse(expiresAt);
      return !Number.isFinite(parsed) || parsed > now;
    })
    .map((entry) => ({
      id: String(entry.id || '').trim(),
      type: String(entry.type || 'context').trim().toLowerCase(),
      key: String(entry.key || '').trim(),
      value: collapseMemoryWhitespace(entry.value),
      createdAt: String(entry.createdAt || '').trim(),
      updatedAt: String(entry.updatedAt || '').trim(),
    }))
    .filter((entry) => entry.key && entry.value);
  if (live.length === 0) return '';
  const ordered = orderMemoryEntries(live, todoIds);
  if (ordered.length === 0) return '';
  const header = 'WORKSPACE MEMORY (durable facts from earlier cycles — treat as prior decisions; do not redo them):';
  const minimal = `${header}\n- [${ordered[0].type}] ${ordered[0].key}: …`;
  if (maxChars < minimal.length) return '';
  /** @type {string[]} */
  const lines = [header];
  let used = header.length;
  let omitted = 0;
  for (const entry of ordered) {
    if (lines.length - 1 >= WORKSPACE_MEMORY_PROMPT_ENTRY_LIMIT) {
      omitted += 1;
      continue;
    }
    const prefix = `- [${entry.type}] ${entry.key}: `;
    const room = maxChars - used - 1 - prefix.length;
    if (room < 8) {
      omitted += 1;
      continue;
    }
    const line = prefix + clipMemoryValue(entry.value, Math.min(WORKSPACE_MEMORY_PROMPT_ENTRY_VALUE_CHARS, room));
    if (used + 1 + line.length > maxChars) {
      omitted += 1;
      continue;
    }
    lines.push(line);
    used += 1 + line.length;
  }
  if (lines.length <= 1) return '';
  let block = lines.join('\n');
  if (omitted > 0) {
    // The omitted-count footer is mandatory; drop trailing entries until it fits
    // rather than overflowing the section budget.
    while (lines.length > 1 && lines.join('\n').length + 1 + memoryOmittedFooter(omitted).length > maxChars) {
      lines.pop();
      omitted += 1;
    }
    block = lines.length > 1 ? `${lines.join('\n')}\n${memoryOmittedFooter(omitted)}` : '';
  }
  if (!block || block.length > maxChars) return '';
  return block;
}

/**
 * Build the cycle prompt plus the deterministic budget allocation for its
 * optional sections. `tooLong` is true only when the fixed contract cannot fit
 * within `maxChars`; the caller must then refuse the start instead of sending a
 * shortened contract.
 *
 * @param {{
 *   workspaceFolder: string,
 *   watcher: object,
 *   decision: object,
 *   todo: object | null,
 *   orchestrator: { harness?: string, model?: string, source?: string },
 *   activeUsageLimits?: object[],
 *   previousChats?: Array<object>,
 *   memory?: Array<object>,
 *   workspaceMemory?: Array<object>,
 *   todoIds?: string[],
 *   relevantIds?: string[],
 *   cycleId?: string,
 *   chatId?: string,
 *   maxChars?: number,
 * }} [input]
 * @returns {{
 *   prompt: string,
 *   tooLong: boolean,
 *   contractChars: number,
 *   promptLength: number,
 *   maxChars: number,
 *   historyChars: number,
 *   memoryChars: number,
 * }}
 */
export function buildWorkspaceWatcherCyclePromptPlan(input = {}) {
  const configuredMax = Number(input.maxChars);
  const maxChars = Number.isFinite(configuredMax) && configuredMax > 0
    ? Math.floor(configuredMax)
    : WORKSPACE_WATCHER_PROMPT_CHAR_BUDGET;
  const workspaceFolder = String(input.workspaceFolder || '');
  const todo = input.todo || {};
  const todoId = String(todo.id || '');
  const planOnly = input.decision?.planOnly === true || input.decision?.kind === 'plan_gate';
  const planTargetId = String(input.decision?.planTargetId || '').trim();
  const policy = input.watcher?.policy || {};
  const allowed = Array.isArray(policy.allowedHarnesses) ? policy.allowedHarnesses : [];
  const limits = Array.isArray(input.activeUsageLimits) ? input.activeUsageLimits : [];
  const blocked = blockedUsageLimitScopesFor(limits);
  const pickRoles = Array.isArray(policy.pickRoles) && policy.pickRoles.length
    ? policy.pickRoles.join(', ')
    : 'plan, implement, review';
  const reportId = String(input.cycleId || '').trim();

  /** @type {string[]} */
  const headLines = [
    'You are the Workspace Watcher orchestrator for exactly ONE cycle. Do the work, report it, and stop.',
    'Do not start another cycle. Do not commit or push. Do not merge.',
    '',
    `Workspace: ${workspaceFolder}`,
    `Todo: ${todoId || '(none)'} — ${String(todo.title || '(untitled)')}`,
    'Snapshot: call `watcher_show` (watcher snapshot) and `todo_show` (todo + plan) before acting.',
  ];
  if (todoId) headLines.push(`cretli-ref todo=${todoId}`);
  headLines.push(
    `Orchestrator executor: ${input.orchestrator?.harness || 'default'}${input.orchestrator?.model ? `:${input.orchestrator.model}` : ''} (${input.orchestrator?.source || 'default'})`,
    `Pick roles: ${pickRoles}`,
    `Allowed harnesses: ${allowed.length ? allowed.join(', ') : '(no restriction)'}`,
    `Harness/model usage limits (do NOT pick these; a bare harness blocks all its models, a harness:model entry only that model): ${blocked.length ? blocked.join(', ') : '(none)'}`,
    '',
    'MCP contract (blocking precondition): before touching the todo, confirm you can actually call `delegation_start` and `watcher_update`.',
    'If either tool is missing or a call fails, do NOT implement the work yourself, do NOT read or edit files under `data/`, and end this turn with a short blockage report (harness, missing tool, what a human must fix).',
  );

  /** @type {string[]} */
  const tailLines = ['Required loop (cretli-multi-harness skill):'];
  if (planOnly) {
    const planSaveTarget = planTargetId || todoId;
    const planSaveNote = planTargetId && planTargetId !== todoId
      ? `\n   Target for the plan is the SUBTREE ROOT ${planTargetId} (not the individual leaf ${todoId}).\n   Call \`todo_show\` on ${planTargetId} to read its context, then save the plan on ${planTargetId}.`
      : '';
    tailLines.push(
      `1) PLAN ONLY. Read the todo and snapshot, then save the draft plan markdown with${planSaveNote}`,
      `   \`watcher_update\` action "save_plan" (todo_id=${planSaveTarget} + expected_updated_at from \`todo_show\` + plan_markdown).`,
      '   That tool is a real CAS write and never sets plan.approvedAt.',
      '2) NEVER set plan.approvedAt — only a human approves a plan. Do not start implementation.',
      '3) Append a short note about the draft (for example by moving the todo status if the schema needs it) and end your turn.',
      '4) End now. The watcher will not start another plan cycle until the human approves.',
    );
  } else if (policy.requirePlanApproval !== false) {
    tailLines.push(
      '1) Read the todo and its approved plan. If approval is missing, stop and wait for human approval.',
      '   The plan gate is closed only by policy `requirePlanApproval`; never approve it yourself.',
      '2) Use `model_pick` with role "implement" (respect the allowed/limit lists above), then `delegation_start` the implementation.',
      '   Forward the `pickId` returned by `model_pick` as `pick_id` on the matching `delegation_start` (one pick -> one start).',
      '   Never re-pick or match the proposal by time: the server validates the link at start and records auto/manual/unknown origin.',
      '3) When the implementer finishes, run a `review` delegation. Fix only findings that block the task.',
      '4) After independent review PASS, mark this todo done with `todo_update` (patch.status + expected_updated_at from `todo_show`).',
      '   If review fails, record its findings hash AND summary text with `watcher_update` action "record_findings" (pass `findings_text`) and report the blocker.',
      '   The recorded findings feed the fix-loop [REGRESSION GATE]: the next review must re-check them, so a fix that regresses one gets FAIL.',
      '   After every delegation child finishes, persist loop state with `workflow_update`: role = this step (plan|implement|review|fix), round = the 1-based number of the current implement/fix cycle since the last review PASS (a fresh leaf starts at 1 and you increment it before every new implement or fix; the server resets it on PASS), plus last_verdict, report_text, material_revision and a stable idempotency_key per review.',
      '   After FAIL→fix→PASS, rate the review job that issued FAIL with `delegation_rate` score 5 and the tag `caught_bug` — never `missed_bug` at score 5, because a correct finding is praise and a critical tag is only accepted at score 1-3. When rejecting a report, rate it down instead. Your own rating is telemetry only: `model_pick` raises observed model quality from `user` ratings, never from yours.',
      '   After reading a report, call `delegation_ack` on that job so the report is marked reviewed and `unverified` does not stay set on the cycles jobs.',
    );
  } else {
    tailLines.push(
      '1) Read the todo and plan as needed, then proceed directly to implementation; this workspace does not require plan approval.',
      '2) Use `model_pick` with role "implement" (respect the allowed/limit lists above), then `delegation_start` the implementation.',
      '   Forward the `pickId` returned by `model_pick` as `pick_id` on the matching `delegation_start` (one pick -> one start).',
      '   Never re-pick or match the proposal by time: the server validates the link at start and records auto/manual/unknown origin.',
      '3) When the implementer finishes, run a `review` delegation. Fix only findings that block the task.',
      '4) After independent review PASS, mark this todo done with `todo_update` (patch.status + expected_updated_at from `todo_show`).',
      '   If review fails, record its findings hash AND summary text with `watcher_update` action "record_findings" (pass `findings_text`) and report the blocker.',
      '   The recorded findings feed the fix-loop [REGRESSION GATE]: the next review must re-check them, so a fix that regresses one gets FAIL.',
      '   After every delegation child finishes, persist loop state with `workflow_update`: role = this step (plan|implement|review|fix), round = the 1-based number of the current implement/fix cycle since the last review PASS (a fresh leaf starts at 1 and you increment it before every new implement or fix; the server resets it on PASS), plus last_verdict, report_text, material_revision and a stable idempotency_key per review.',
      '   After FAIL→fix→PASS, rate the review job that issued FAIL with `delegation_rate` score 5 and the tag `caught_bug` — never `missed_bug` at score 5, because a correct finding is praise and a critical tag is only accepted at score 1-3. When rejecting a report, rate it down instead. Your own rating is telemetry only: `model_pick` raises observed model quality from `user` ratings, never from yours.',
      '   After reading a report, call `delegation_ack` on that job so the report is marked reviewed and `unverified` does not stay set on the cycles jobs.',
    );
  }
  tailLines.push(
    '',
    'Progress: record steps with `todo_update` (a status change appends a changelog note) and keep the todo status honest.',
    'Never mark a todo done before the review PASS, and never mark a parent done while its descendants are open.',
    '',
    'Workspace memory: record with `wmem_add` only what the next cycle cannot re-read from the todo or its changelog —',
    'a decision (with rationale), a reusable pattern, a finding, or a blocker. Never store a bare "todo X is done" note.',
    'Blocker keys follow `blocker:todo:<todoId>:<cause>` / `blocker:harness:<harness>:<model|*>:<cause>`; the causes',
    'quota, rate_limit, slot_busy and model_unavailable default to a 24 h TTL — pass `ttl_ms` for another lifetime,',
    '`permanent: true` for a genuinely permanent blocker, or `ttl_ms` for other temporary facts. Re-adding the same',
    'type+key updates the entry in place.',
    'If a WORKSPACE MEMORY section appears above, it is what earlier cycles left for you; use `wmem_list` for the full list.',
    '',
    'End the cycle with a durable report (the watcher reads it back to update failures/cycleCount):',
    '`watcher_update` action "report" with:',
    `  outcome: "success" | "blocked" | "failure"`,
    `  todo_ids: ["${todoId || '<todo-id>'}"]`,
    input.cycleId ? `  cycle_id: "${input.cycleId}"` : '  cycle_id: "<the active cycle id from watcher_show>"',
    `  report_id: "${reportId || '<cycle-id>'}"`,
    '  message: one line: what was done / what is blocked / what comes next.',
    '',
    'Hard rules:',
    '- One cycle = exactly this chat run. Never spawn another watcher cycle — the watcher does that.',
    '- Without `delegation_start` and `watcher_update` you cannot run a cycle: stop and report the blockage; never implement the work yourself and never touch files under `data/`.',
    '- Never overwrite a todo that is doing/done outside this cycle.',
    '- Report blockers in the todo changelog and in the cycle report instead of failing silently.',
  );

  const headText = headLines.join('\n');
  const tailText = tailLines.join('\n');
  const contractText = `${headText}\n\n${tailText}`;
  if (contractText.length > maxChars) {
    // Never send a shortened contract: the caller refuses the start instead.
    return {
      prompt: contractText,
      tooLong: true,
      contractChars: contractText.length,
      promptLength: contractText.length,
      maxChars,
      historyChars: 0,
      memoryChars: 0,
    };
  }

  let prompt = contractText;
  let historyChars = 0;
  let memoryChars = 0;
  const historyBudget = Math.min(
    WORKSPACE_WATCHER_PROMPT_HISTORY_CHAR_BUDGET,
    Math.max(0, maxChars - prompt.length - 2),
  );
  const historyBlock = historyBudget > 0
    ? buildWorkspaceWatcherPreviousChatsBlock(input.previousChats, {
      maxChars: historyBudget,
      todoIds: input.todoIds || input.relevantIds,
    })
    : '';
  if (historyBlock) {
    prompt = `${headText}\n\n${historyBlock}\n\n${tailText}`;
    historyChars = historyBlock.length;
  }
  const memoryBudget = Math.min(
    WORKSPACE_MEMORY_PROMPT_CHAR_BUDGET,
    Math.max(0, maxChars - prompt.length - 2),
  );
  const memoryBlock = memoryBudget > 0
    ? buildWorkspaceMemoryPromptBlock(input.memory || input.workspaceMemory, {
      maxChars: memoryBudget,
      todoIds: input.todoIds || input.relevantIds,
    })
    : '';
  if (memoryBlock) {
    const middle = historyBlock ? `${historyBlock}\n\n${memoryBlock}` : memoryBlock;
    prompt = `${headText}\n\n${middle}\n\n${tailText}`;
    memoryChars = memoryBlock.length;
  }
  return {
    prompt,
    tooLong: false,
    contractChars: contractText.length,
    promptLength: prompt.length,
    maxChars,
    historyChars,
    memoryChars,
  };
}

/**
 * Backwards-compatible string form of {@link buildWorkspaceWatcherCyclePromptPlan}.
 *
 * @param {Parameters<typeof buildWorkspaceWatcherCyclePromptPlan>[0]} input
 * @returns {string}
 */
export function buildWorkspaceWatcherCyclePrompt(input) {
  return buildWorkspaceWatcherCyclePromptPlan(input).prompt;
}
