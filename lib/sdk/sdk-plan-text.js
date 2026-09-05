/**
 * Extract CreatePlan / assistant Markdown from SDK stream events.
 */

import { isCompletePlanMarkdown, pickRicherPlanMarkdown } from '../chat-plan-markdown.js';
import { extractAssistantPlainText } from '../context-compression.js';

/**
 * @param {unknown} previous
 * @param {unknown} next
 * @returns {string}
 */
export function accumulateStreamText(previous, next) {
  const prev = String(previous || '');
  const incoming = String(next || '');
  if (!incoming) return prev;
  if (!prev) return incoming;
  if (incoming.startsWith(prev)) return incoming;
  if (prev.startsWith(incoming)) return prev;
  return `${prev}${incoming}`;
}

/**
 * @param {unknown} event
 * @returns {string}
 */
export function extractPlanTextFromSdkEvent(event) {
  if (!event || typeof event !== 'object') return '';
  const rec = /** @type {Record<string, unknown>} */ (event);
  const args = rec.args && typeof rec.args === 'object'
    ? /** @type {Record<string, unknown>} */ (rec.args)
    : null;
  if (args && typeof args.plan === 'string' && args.plan.trim()) return args.plan.trim();
  const result = rec.result;
  if (result && typeof result === 'object') {
    const row = /** @type {Record<string, unknown>} */ (result);
    if (typeof row.plan === 'string' && row.plan.trim()) return row.plan.trim();
    if (row.success && typeof row.success === 'object') {
      const success = /** @type {Record<string, unknown>} */ (row.success);
      if (typeof success.plan === 'string' && success.plan.trim()) return success.plan.trim();
    }
  }
  return '';
}

/**
 * Rebuild the latest CreatePlan Markdown (or last assistant turn) from persisted SDK events.
 *
 * @param {Array<{ seq?: number, rec?: unknown }>} events
 * @returns {string}
 */
export function extractLatestPlanMarkdownFromEvents(events) {
  if (!Array.isArray(events) || events.length === 0) return '';
  const sorted = [...events].sort((a, b) => (Number(a?.seq) || 0) - (Number(b?.seq) || 0));
  let lastCompletePlan = '';
  let turnPlan = '';
  let currentAssistant = '';
  for (const entry of sorted) {
    const rec = entry?.rec;
    if (!rec || typeof rec !== 'object') continue;
    const record = /** @type {Record<string, unknown>} */ (rec);
    if (record.kind === 'localUser') {
      lastCompletePlan = commitTurnPlan(lastCompletePlan, turnPlan, currentAssistant);
      turnPlan = '';
      currentAssistant = '';
      continue;
    }
    if (record.kind !== 'sdk' || !record.event || typeof record.event !== 'object') continue;
    const event = /** @type {Record<string, unknown>} */ (record.event);
    if (event.type === 'user') {
      lastCompletePlan = commitTurnPlan(lastCompletePlan, turnPlan, currentAssistant);
      turnPlan = '';
      currentAssistant = '';
      continue;
    }
    const fromTool = extractPlanTextFromSdkEvent(event);
    if (fromTool) turnPlan = pickRicherPlanMarkdown(turnPlan, fromTool);
    if (event.type !== 'assistant') continue;
    const assistantText = extractAssistantPlainText(event).trim();
    if (!assistantText) continue;
    currentAssistant = accumulateStreamText(currentAssistant, assistantText);
  }
  return commitTurnPlan(lastCompletePlan, turnPlan, currentAssistant);
}

/**
 * @param {string} previousComplete
 * @param {string} turnPlan
 * @param {string} assistantText
 * @returns {string}
 */
function commitTurnPlan(previousComplete, turnPlan, assistantText) {
  const turnText = pickRicherPlanMarkdown(turnPlan, assistantText);
  if (isCompletePlanMarkdown(turnText)) return turnText;
  return previousComplete;
}
