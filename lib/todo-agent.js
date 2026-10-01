/**
 * Initial prompt and HTTP callback for the agent linked to a Todo item.
 */

import { formatTodoRef } from './todo-ref.js';

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
 * @param {{ callbackToken?: string, insecureTls?: boolean, previousChats?: Array<{ id?: string, title?: string, roles?: string[] }> }} [options]
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
    'WORKFLOW:\n' +
    '1. If no persisted plan exists, prepare a DETAILED PLAN first (steps, files, risks). Do not implement yet.\n' +
    '2. Present the plan and wait for user approval (e.g. "approve", "ok", "implement").\n' +
    '3. After approval, implement and update Todo via API.\n' +
    '4. Save the plan markdown to Todo after planning (plan field) and append changelog entries for major steps.\n\n' +
    `LINKED CHAT: ${chatId}\n` +
    (todoRef ? `TODO REFERENCE (paste this line to load the todo elsewhere):\n${todoRef}\n` : '') +
    '\n' +
    previousChatsBlock +
    'TODO API (scope = current server workspace):\n' +
    '- GET /api/todos — list all items\n' +
    `- PATCH /api/todos/${todoId} — JSON: { "status", "title", "body", "plan": { "markdown" }, "appendChangelog": { "kind", "text" } }\n\n` +
    'Statuses: idea, ready, doing, done.\n' +
    'After plan approval set status to "doing". When finished set "done".\n\n' +
    'CALLBACK (preferred — curl from agent terminal):\n' +
    `${curlCommand}\n\n` +
    (planMarkdown
      ? 'Continue from the persisted plan above or ask what changed.'
      : 'Start by preparing a plan for the task above.')
  );
}
