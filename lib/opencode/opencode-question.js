/**
 * OpenCode question skill — normalize SSE events and reply via HTTP API.
 */

import { isOpenCodeEventForSession } from '../agent-harness/opencode-event-normalizer.js';
import { postOpenCodeInstanceWithFallback } from './opencode-instance-http.js';

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isOpenCodeSkillRecord(value) {
  if (!value || typeof value !== 'object') return false;
  const record = /** @type {Record<string, unknown>} */ (value);
  return typeof record.id === 'string'
    || typeof record.requestID === 'string'
    || typeof record.sessionID === 'string'
    || Array.isArray(record.questions);
}

/**
 * @param {unknown} event
 * @returns {Record<string, unknown> | null}
 */
export function readOpenCodeEventPayload(event) {
  if (!event || typeof event !== 'object') return null;
  const record = /** @type {Record<string, unknown>} */ (event);
  const properties = record.properties && typeof record.properties === 'object'
    ? /** @type {Record<string, unknown>} */ (record.properties)
    : null;
  const data = record.data && typeof record.data === 'object'
    ? /** @type {Record<string, unknown>} */ (record.data)
    : null;
  const propertiesOk = isOpenCodeSkillRecord(properties);
  const dataOk = isOpenCodeSkillRecord(data);
  if (propertiesOk && dataOk) return { ...properties, ...data };
  if (dataOk) return data;
  if (propertiesOk) return properties;
  if (properties) return properties;
  if (data) return data;
  return null;
}

/**
 * @param {Record<string, unknown>} payload
 * @returns {string}
 */
export function readOpenCodeRequestId(payload) {
  const id = typeof payload.id === 'string' ? payload.id.trim() : '';
  const requestID = typeof payload.requestID === 'string' ? payload.requestID.trim() : '';
  if (id && /^(per_|que_)/i.test(id)) return id;
  if (requestID) return requestID;
  return id;
}

/**
 * @param {unknown} raw
 * @returns {Array<Record<string, unknown>>}
 */
export function normalizeOpenCodeQuestionItems(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {Array<Record<string, unknown>>} */
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const question = typeof item.question === 'string' ? item.question.trim() : '';
    const header = typeof item.header === 'string' ? item.header.trim() : '';
    if (!question) continue;
    const options = Array.isArray(item.options)
      ? item.options
        .filter((option) => option && typeof option === 'object')
        .map((option) => {
          const row = /** @type {Record<string, unknown>} */ (option);
          return {
            label: typeof row.label === 'string' ? row.label.trim() : '',
            description: typeof row.description === 'string' ? row.description.trim() : '',
          };
        })
        .filter((option) => option.label)
      : [];
    out.push({
      question,
      header: header || question.slice(0, 30),
      options,
      multiple: item.multiple === true,
      custom: item.custom === true,
    });
  }
  return out;
}

/**
 * @param {unknown} event
 * @param {{ opencodeSessionId?: string }} [context]
 * @returns {Record<string, unknown> | null}
 */
export function buildOpenCodeQuestionSdkEvent(event, context = {}) {
  if (!event || typeof event !== 'object') return null;
  if (!isOpenCodeEventForSession(event, context.opencodeSessionId)) return null;
  const type = typeof event.type === 'string' ? event.type : '';
  if (type !== 'question.asked' && type !== 'question.v2.asked') return null;
  const payload = readOpenCodeEventPayload(event);
  if (!payload) return null;
  const sessionId = typeof payload.sessionID === 'string'
    ? payload.sessionID
    : typeof context.opencodeSessionId === 'string'
      ? context.opencodeSessionId
      : '';
  const requestId = readOpenCodeRequestId(payload);
  const questions = normalizeOpenCodeQuestionItems(payload.questions);
  if (!requestId || questions.length === 0) return null;
  return {
    type: 'opencode_question',
    requestId,
    sessionId,
    questions,
  };
}

/**
 * @param {unknown} event
 * @param {{ opencodeSessionId?: string }} [context]
 * @returns {string | null}
 */
export function resolveOpenCodeQuestionResolvedRequestId(event, context = {}) {
  if (!event || typeof event !== 'object') return null;
  if (!isOpenCodeEventForSession(event, context.opencodeSessionId)) return null;
  const type = typeof event.type === 'string' ? event.type : '';
  if (type !== 'question.replied' && type !== 'question.v2.replied' && type !== 'question.rejected' && type !== 'question.v2.rejected') {
    return null;
  }
  const payload = readOpenCodeEventPayload(event);
  if (!payload) return null;
  const requestId = readOpenCodeRequestId(payload);
  return requestId || null;
}

/**
 * @param {{
 *   baseUrl: string,
 *   requestId: string,
 *   sessionId?: string,
 *   directory?: string,
 *   answers?: Array<Array<string>>,
 *   reject?: boolean,
 * }} input
 */
export async function postOpenCodeQuestionResponse(input) {
  const baseUrl = String(input.baseUrl || '').replace(/\/$/, '');
  const requestId = String(input.requestId || '').trim();
  if (!baseUrl || !requestId) {
    throw new Error('Missing OpenCode question reply target');
  }
  const sessionId = String(input.sessionId || '').trim();
  const directory = String(input.directory || '').trim();
  const reject = input.reject === true;
  const action = reject ? 'reject' : 'reply';
  const globalPath = `/question/${encodeURIComponent(requestId)}/${action}`;
  const sessionPath = sessionId
    ? `/api/session/${encodeURIComponent(sessionId)}/question/${encodeURIComponent(requestId)}/${action}`
    : '';
  await postOpenCodeInstanceWithFallback({
    baseUrl,
    directory,
    sessionPath,
    globalPath,
    body: reject ? undefined : JSON.stringify({ answers: Array.isArray(input.answers) ? input.answers : [] }),
    errorLabel: `question ${action}`,
  });
}
