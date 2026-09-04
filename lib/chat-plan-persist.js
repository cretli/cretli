/**
 * Persist Plan-mode output to a workspace file the next agent turn can read.
 * CreatePlan artifacts are virtual and not glob-able in the local SDK.
 */

import fs from 'fs';
import path from 'path';
import { pickRicherPlanMarkdown, stripChatPlanComment } from './chat-plan-markdown.js';

export { pickRicherPlanMarkdown, stripChatPlanComment };

export const CHAT_PLAN_DIR = '.cursor/plans';
const CHAT_PLAN_MAX_MARKDOWN_LEN = 32000;

/**
 * @param {unknown} chatId
 * @returns {string}
 */
export function sanitizeChatPlanFileId(chatId) {
  const safeId = String(chatId || '').trim().replace(/[^a-zA-Z0-9._-]/g, '');
  if (!safeId || safeId.includes('..')) return '';
  return safeId;
}

/**
 * @param {unknown} chatId
 * @returns {string}
 */
export function buildChatPlanRelativePath(chatId) {
  const safeId = sanitizeChatPlanFileId(chatId);
  if (!safeId) return '';
  return `${CHAT_PLAN_DIR}/cretli-${safeId}.md`;
}

/**
 * @param {unknown} cwd
 * @param {unknown} chatId
 * @returns {string}
 */
export function resolveChatPlanAbsolutePath(cwd, chatId) {
  const relativePath = buildChatPlanRelativePath(chatId);
  const root = String(cwd || '').trim();
  if (!relativePath || !root) return '';
  return path.join(root, relativePath);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function truncatePlanMarkdown(value) {
  const text = String(value || '').trim();
  if (text.length <= CHAT_PLAN_MAX_MARKDOWN_LEN) return text;
  return `${text.slice(0, CHAT_PLAN_MAX_MARKDOWN_LEN - 1)}…`;
}

/**
 * @param {{ cwd: string, chatId: string, title?: string, markdown: string }} input
 * @returns {string} relative workspace path, or empty on skip/failure
 */
export function writeChatPlanFile(input) {
  const incoming = stripChatPlanComment(truncatePlanMarkdown(input.markdown));
  const relativePath = buildChatPlanRelativePath(input.chatId);
  const absolutePath = resolveChatPlanAbsolutePath(input.cwd, input.chatId);
  if (!incoming || !relativePath || !absolutePath) return '';
  const existing = stripChatPlanComment(readChatPlanFile({
    cwd: input.cwd,
    chatId: input.chatId,
  }));
  if (existing.length > incoming.length) return relativePath;
  const title = String(input.title || '').trim() || 'Chat plan';
  const body = `# ${title}\n\n<!-- cretli-chat-plan:${sanitizeChatPlanFileId(input.chatId)} -->\n\n${incoming}\n`;
  try {
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, body, 'utf8');
    return relativePath;
  } catch {
    return '';
  }
}

/**
 * @param {{ cwd: string, chatId: string }} input
 * @returns {string}
 */
export function readChatPlanFile(input) {
  const absolutePath = resolveChatPlanAbsolutePath(input.cwd, input.chatId);
  if (!absolutePath) return '';
  try {
    if (!fs.existsSync(absolutePath)) return '';
    return fs.readFileSync(absolutePath, 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * Prompt prefix so the next turn does not hunt for a missing CreatePlan file.
 *
 * @param {{ cwd: string, chatId: string }} input
 * @returns {string}
 */
export function buildChatPlanPromptContext(input) {
  const relativePath = buildChatPlanRelativePath(input.chatId);
  const markdown = readChatPlanFile(input);
  if (!relativePath || !markdown) return '';
  return [
    '[CURRENT CHAT PLAN]',
    `The latest plan for this chat is in \`${relativePath}\`. Read that file; do not search for CreatePlan artifacts.`,
    markdown,
  ].join('\n\n');
}
