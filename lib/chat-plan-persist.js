/**
 * Persist Plan-mode output to a workspace file the next agent turn can read.
 * CreatePlan artifacts are virtual and not glob-able in the local SDK.
 */

import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  pickRicherPlanMarkdown,
  resolvePlanCommit,
  stripChatPlanComment,
} from './chat-plan-markdown.js';
import { formatChatPlanMarker, parseChatPlanMeta } from './chat-plan-meta.js';
import {
  buildChatPlanRelativePath,
  sanitizeChatPlanFileId,
} from './chat-plan-path.js';

export { pickRicherPlanMarkdown, stripChatPlanComment, resolvePlanCommit };
export {
  CHAT_PLAN_DIR,
  buildApprovedPlanImplementPrompt,
  buildChatPlanRelativePath,
  sanitizeChatPlanFileId,
} from './chat-plan-path.js';

const CHAT_PLAN_MAX_MARKDOWN_LEN = 32000;

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
 * @param {unknown} value
 * @returns {string}
 */
export function hashPlanMarkdown(value) {
  const text = stripChatPlanComment(value);
  if (!text) return '';
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

/**
 * @param {{ cwd: string, chatId: string }} input
 * @returns {{
 *   relativePath: string,
 *   markdown: string,
 *   body: string,
 *   title: string,
 *   revision: number,
 *   sourceTurnId: string,
 *   updatedAt: string,
 *   contentHash: string,
 * }}
 */
export function readChatPlanDocument(input) {
  const relativePath = buildChatPlanRelativePath(input.chatId);
  const markdown = readChatPlanFile(input);
  const meta = parseChatPlanMeta(markdown);
  const body = stripChatPlanComment(markdown);
  const titleMatch = markdown.match(/^#\s+(.+)$/m);
  return {
    relativePath,
    markdown,
    body,
    title: titleMatch ? titleMatch[1].trim() : '',
    revision: meta.revision,
    sourceTurnId: meta.sourceTurnId,
    updatedAt: meta.updatedAt,
    contentHash: meta.contentHash || hashPlanMarkdown(body),
  };
}

/**
 * @param {{
 *   cwd: string,
 *   chatId: string,
 *   title?: string,
 *   markdown: string,
 *   sourceTurnId?: string,
 *   runStatus?: string,
 * }} input
 * @returns {string} relative workspace path, or empty on skip/failure
 */
export function writeChatPlanFile(input) {
  const incoming = stripChatPlanComment(truncatePlanMarkdown(input.markdown));
  const relativePath = buildChatPlanRelativePath(input.chatId);
  const absolutePath = resolveChatPlanAbsolutePath(input.cwd, input.chatId);
  if (!incoming || !relativePath || !absolutePath) return '';
  const existingDoc = readChatPlanDocument({
    cwd: input.cwd,
    chatId: input.chatId,
  });
  const decision = input.force === true
    ? { action: 'write', body: incoming, bumpRevision: true }
    : resolvePlanCommit({
      existingBody: existingDoc.body,
      incomingBody: incoming,
      existingTurnId: existingDoc.sourceTurnId,
      incomingTurnId: input.sourceTurnId,
      runStatus: input.runStatus,
    });
  if (decision.action !== 'write') return existingDoc.body ? relativePath : '';
  const nextRevision = decision.bumpRevision
    ? Math.max(1, existingDoc.revision + 1)
    : Math.max(1, existingDoc.revision || 1);
  const title = String(input.title || '').trim() || existingDoc.title || 'Chat plan';
  const updatedAt = new Date().toISOString();
  const contentHash = hashPlanMarkdown(decision.body);
  const marker = formatChatPlanMarker({
    chatId: sanitizeChatPlanFileId(input.chatId),
    revision: nextRevision,
    sourceTurnId: String(input.sourceTurnId || existingDoc.sourceTurnId || '').trim(),
    updatedAt,
    contentHash,
  });
  const fileBody = `# ${title}\n\n${marker}\n\n${decision.body}\n`;
  try {
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, fileBody, 'utf8');
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
