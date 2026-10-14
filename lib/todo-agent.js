/**
 * Initial prompt and HTTP callback for the agent linked to a Todo item.
 */

import { resolveEffectivePhases } from './watcher-phases.js';
import { formatTodoRef } from './todo-ref.js';
import { TODO_EXECUTION_WORKFLOW } from './todo-execution-prompt.js';

function buildCurlCommand(url, payloadTemplate, options = {}) {
  const callbackToken =
    options && typeof options.callbackToken === 'string' ? options.callbackToken.trim() : '';
  const insecureTls = !!(options && options.insecureTls);
  const curlParts = ['curl', '-sS', '-X', 'POST', url];
  if (insecureTls) curlParts.push('-k');
  if (callbackToken) curlParts.push('-H', `"X-Agent-Token: ${callbackToken}"`);
  curlParts.push('-H', '"Content-Type: application/json"');
  curlParts.push('-d', `'${payloadTemplate}'`);
  return curlParts.join(' ');
}

/**
 * @param {{ id: string, title?: string, body?: string, status?: string, plan?: { markdown?: string } }} todo
 * @param {string} chatId
 * @param {string} baseUrl
 * @param {{ callbackToken?: string, insecureTls?: boolean, hasChildren?: boolean, previousChats?: Array<{ id?: string, title?: string, roles?: string[] }> }} [options]
 * @returns {string}
 */
export function buildTodoAgentInitialPrompt(todo, chatId, baseUrl, options = {}) {
  const todoId = todo?.id || '';
  const title = todo?.title != null ? String(todo.title) : '';
  const body = todo?.body != null ? String(todo.body) : '';
  const status = todo?.status != null ? String(todo.status) : 'idea';
  const planMarkdown =
    todo?.plan && typeof todo.plan === 'object' && typeof todo.plan.markdown === 'string'
      ? todo.plan.markdown.trim()
      : '';
  const url = (baseUrl || '').replace(/\/$/, '') + '/api/set-todo-from-agent';
  const curlCommand = buildCurlCommand(
    url,
    `{"todoId":"${todoId}","chatId":"${chatId}","status":"doing","plan":{"markdown":"PLAN_MARKDOWN"}}`,
    options
  );
  const todoRef = formatTodoRef(todoId);
  const previousChats = Array.isArray(options.previousChats) ? options.previousChats : [];
  const previousChatLines = previousChats
    .map((chat) => {
      const id = String(chat?.id || '').trim();
      if (!id) return '';
      const chatTitle = String(chat?.title || '').trim() || '(untitled)';
      const roles = Array.isArray(chat?.roles) ? chat.roles.filter(Boolean).join(', ') : '';
      return `- ${id} · ${chatTitle}${roles ? ` · roles: ${roles}` : ''}`;
    })
    .filter(Boolean);
  const previousChatsBlock = previousChatLines.length
    ? 'PREVIOUS CHATS for this todo (newest first — read any with MCP chat_show({ chat: "<id>" }) ' +
      'or chat_history when you need the earlier context):\n' +
      `${previousChatLines.join('\n')}\n\n`
    : '';
  const hasChildren = options.hasChildren === true;

  return (
    'You are an agent working on a Todo item in Cretli.\n\n' +
    `TODO (id: ${todoId}):\n` +
    `Title: ${title}\n` +
    `Status: ${status}\n` +
    'Description / notes:\n' +
    `${body || '(none)'}\n\n` +
    (planMarkdown
      ? 'PERSISTED PLAN (source of truth — extend or implement this):\n' +
        `${planMarkdown}\n\n`
      : '') +
    (hasChildren ? `${TODO_EXECUTION_WORKFLOW}\n\n` : 'WORKFLOW:\n' +
    '1. If no persisted plan exists, prepare a DETAILED PLAN first (steps, files, risks). Do not implement yet.\n' +
    '2. Present the plan and wait for user approval (e.g. "approve", "ok", "implement").\n' +
    '3. After approval, implement and update Todo via API.\n' +
    '4. Save the plan markdown to Todo after planning (plan field) and append changelog entries for major steps.\n\n') +
    `LINKED CHAT: ${chatId}\n` +
    (todoRef ? `TODO REFERENCE (paste this line to load the todo elsewhere):\n${todoRef}\n` : '') +
    '\n' +
    previousChatsBlock +
    'TODO API (scope = current server workspace):\n' +
    '- GET /api/todos — list all items\n' +
    `- PATCH /api/todos/${todoId} — JSON: { "status", "title", "body", "plan": { "markdown" }, "appendChangelog": { "kind", "text" } }\n\n` +
    'Statuses: idea, ready, doing, done.\n' +
    'Subtasks run sequentially by default in sibling order; parallel requires an explicit parent setting.\n' +
    'When splitting a plan into sibling leaves, add a `## Leaf scope` section on each leaf listing every file/module it may touch. Propose `run_mode: parallel` on the parent only when every sibling scope is disjoint; a human still approves run_mode and the plan.\n' +
    'Parent status follows its children at every depth. Complete every descendant before the parent; reopening a child reopens its ancestors.\n' +
    'After plan approval set status to "doing". When finished set "done".\n\n' +
    'CALLBACK (preferred — curl from agent terminal):\n' +
    `${curlCommand}\n\n` +
    (hasChildren ? 'Start by loading the subtree and orchestrating its unfinished descendants.' : planMarkdown
      ? 'Continue from the persisted plan above or ask what changed.'
      : 'Start by preparing a plan for the task above.')
  );
}

/**
 * Initial prompt for a chat that only reviews and refines the plan of a Todo
 * with the `cretli-todo-refine-loop` skill. It never asks for implementation.
 *
 * @param {{ id: string, title?: string, status?: string, plan?: { markdown?: string } }} todo
 * @param {string} chatId
 * @param {{
 *   previousChats?: Array<{ id?: string, title?: string, roles?: string[] }>,
 *   planReviewerSession?: { id?: string, cooperationMode?: string },
 * }} [options]
 * @returns {string}
 */
export function buildTodoRefineInitialPrompt(todo, chatId, options = {}) {
  const todoId = todo?.id || '';
  const title = todo?.title != null ? String(todo.title) : '';
  const status = todo?.status != null ? String(todo.status) : 'idea';
  const hasPlan = !!(todo?.plan && typeof todo.plan === 'object' && String(todo.plan.markdown || '').trim());
  const todoRef = formatTodoRef(todoId);
  const mode = String(options.planReviewerSession?.cooperationMode || 'independent').trim() || 'independent';
  const hasPreviousChats = Array.isArray(options.previousChats) && options.previousChats.length > 0;
  return (
    'You are refining the plan of a Cretli Todo. Do not implement it.\n\n' +
    `TODO (id: ${todoId}):\n` +
    `Title: ${title}\n` +
    `Status: ${status}\n` +
    `Plan: ${hasPlan ? 'saved on the todo' : 'none yet; the todo body is the starting point'}\n` +
    (todoRef ? `${todoRef}\n` : '') +
    `LINKED CHAT: ${chatId}\n\n` +
    'Run the skill @cretli-todo-refine-loop on this todo as the root; if its text is not included ' +
    'above, read its listed SKILL.md first.\n\n' +
    `Cooperation mode: ${mode}. After saving the plan and after every rewrite, call reviewer_session ` +
    'with this mode and use the returned session id.\n\n' +
    'Limits: do not start any leaf, do not change the todo status, never set plan approval ' +
    '(only a human approves), do not commit or push.\n\n' +
    (hasPreviousChats
      ? 'Earlier chats are listed by todo_show; read one with chat_show (8-char prefix ok; chat_event ' +
        'needs the full id from its output).\n\n'
      : '') +
    'Finish with the final report the skill describes.'
  );
}

/**
 * Initial prompt for the per-todo "do everything" orchestrator (`mode: 'full'`):
 * plan refine -> human approval gate -> implement/review/fix -> integration
 * preparation. The phase preamble is derived from the persisted plan; the
 * shared execution workflow follows it unchanged.
 *
 * @param {{ id: string, title?: string, status?: string, plan?: { markdown?: string, approvedAt?: string }, review?: { plan?: { state?: string } } }} todo
 * @param {string} chatId
 * @param {{ previousChats?: Array<{ id?: string, title?: string, roles?: string[] }>, phases?: object }} [options]
 *   `phases` is the effective phase map from `lib/watcher-phases.js`.
 * @returns {string}
 */
export function buildTodoFullOrchestratorPrompt(todo, chatId, options = {}) {
  const todoId = todo?.id || '';
  const title = todo?.title != null ? String(todo.title) : '';
  const status = todo?.status != null ? String(todo.status) : 'idea';
  const plan = todo?.plan && typeof todo.plan === 'object' ? todo.plan : null;
  const hasPlan = !!(plan && String(plan.markdown || '').trim());
  const isApproved = hasPlan && !!String(plan.approvedAt || '').trim();
  const reviewState = String(todo?.review?.plan?.state || '').trim();
  const isReviewPassed = reviewState === 'passed' || reviewState === 'manual';
  const todoRef = formatTodoRef(todoId);
  const previousChats = (Array.isArray(options.previousChats) ? options.previousChats : [])
    .map((chat) => {
      const id = String(chat?.id || '').trim();
      if (!id) return '';
      return `- ${id} · ${String(chat?.title || '').trim() || '(untitled)'}`;
    })
    .filter(Boolean);
  const phases = resolveEffectivePhases({ phases: options.phases }, []);
  let phase;
  if (!isApproved && !phases.plan) {
    phase = [
      'CURRENT PHASE: planning, but the `plan` phase is disabled for this todo.',
      'Do not run plan refinement. Report `phase_disabled:plan` and STOP; only a human approves a plan.',
    ];
  } else if (!isApproved) {
    phase = [
      'CURRENT PHASE: planning / approval gate.',
      !phases.review
        ? '1. Plan refinement: the `review` phase is disabled; write or update the plan draft without starting plan reviews.'
        : !hasPlan || !isReviewPassed
        ? '1. Plan refinement: the plan is missing or its plan review has not passed. Run the skill @cretli-todo-refine-loop on this todo as the root (read its listed SKILL.md if the text is not included) until the plan review passes or a stop rule fires. Use reviewer_session after every plan rewrite.'
        : '1. Plan refinement: the plan review already passed; do not repeat it.',
      '2. Approval gate: when the plan is saved and reviewed but not yet approved, STOP and report `ready for human approval`. Only a human approves a plan, in the UI. Never approve it yourself and never start a leaf before approval.',
    ];
  } else if (!phases.implement) {
    phase = [
      'CURRENT PHASE: execution, but the `implement` phase is disabled for this todo.',
      'Do not start implement/review/fix delegations. Report `ready: implement phase disabled` (phase_disabled:implement) and STOP.',
    ];
  } else {
    phase = [
      'CURRENT PHASE: execution (the plan is approved by a human).',
      '3. Implementation: run the TODO EXECUTION WORKFLOW below on the whole subtree — implement, review and fix every leaf until all descendants are done.',
      phases.integrate
        ? '4. Integration (prepare only): once every leaf is done, prepare integration only through the existing worktree integration path (lib/workspace-watcher-integration.js, lib/worktree/git-worktree.js) so it reaches state `awaiting`, then STOP. Never apply or merge into the project folder. Confirming integration is a human attestation: never call todo_integration with action confirm. If integration cannot be prepared, report the blocker.'
        : '4. Integration is disabled for this run: once every leaf is done, STOP. Never call todo_integration with action confirm.',
    ];
  }
  return (
    'You are the per-todo orchestrator ("do everything") for a Cretli Todo. You delegate work to child chats and do not implement in this chat.\n\n' +
    `TODO (id: ${todoId}):\n` +
    `Title: ${title}\n` +
    `Status: ${status}\n` +
    `Plan: ${hasPlan ? (isApproved ? 'saved and approved' : 'saved, not approved') : 'none yet; the todo body is the starting point'}\n` +
    (todoRef ? `${todoRef}\n` : '') +
    `LINKED CHAT: ${chatId}\n\n` +
    (previousChats.length
      ? `PREVIOUS CHATS (read with chat_show when you need earlier context):\n${previousChats.join('\n')}\n\n`
      : '') +
    `${phase.join('\n')}\n\n` +
    'Limits: never commit, push or merge; never set plan approval; never confirm integration. Resume = the user starts this orchestrator again; the user can stop this run by cancelling this chat, and child runs with delegation_cancel.\n\n' +
    `${TODO_EXECUTION_WORKFLOW}\n\n` +
    'Finish with a final report: phase reached, leaves done/open, blockers.'
  );
}
