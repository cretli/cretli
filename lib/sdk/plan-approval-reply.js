/**
 * Detect when a question-UI reply is the user confirming a plan.
 * OpenCode Plan keeps a system hint and denied write permissions until Cretli
 * switches the chat to agent mode.
 */

const PLAN_QUESTION_RE =
  /\b(plan|wdraż|wdraz|implement|zatwierdz|approve|execute|wykonaj|build\s+plan)\b/i;

const DECLINE_ANSWER_RE =
  /\b(nie\b|no\b|later|potem|wait|cancel|odrzuć|odrzuc|don't implement|do not implement|nie wdraż|nie wdraz|stay in plan|only plan|just discuss|not yet)\b/i;

/**
 * @param {unknown} value
 * @returns {string}
 */
function asText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * @param {unknown} questionEvent
 * @returns {string}
 */
export function collectQuestionPromptText(questionEvent) {
  if (!questionEvent || typeof questionEvent !== 'object') return '';
  const record = /** @type {Record<string, unknown>} */ (questionEvent);
  const parts = [asText(record.header), asText(record.question)];
  const questions = Array.isArray(record.questions) ? record.questions : [];
  for (const item of questions) {
    if (!item || typeof item !== 'object') continue;
    const row = /** @type {Record<string, unknown>} */ (item);
    parts.push(asText(row.header), asText(row.question));
  }
  return parts.filter(Boolean).join('\n');
}

/**
 * @param {unknown} questionEvent
 * @returns {boolean}
 */
export function isPlanApprovalQuestion(questionEvent) {
  return PLAN_QUESTION_RE.test(collectQuestionPromptText(questionEvent));
}

/**
 * @param {unknown} answers
 * @returns {string[]}
 */
export function flattenQuestionAnswerLabels(answers) {
  if (!Array.isArray(answers)) return [];
  /** @type {string[]} */
  const labels = [];
  for (const row of answers) {
    if (typeof row === 'string') {
      const text = row.trim();
      if (text) labels.push(text);
      continue;
    }
    if (!Array.isArray(row)) continue;
    for (const entry of row) {
      const text = asText(entry);
      if (text) labels.push(text);
    }
  }
  return labels;
}

/**
 * True when the user chose to proceed, not to stay in Plan / decline.
 *
 * @param {unknown} answers
 * @returns {boolean}
 */
export function isPlanImplementAnswer(answers) {
  const labels = flattenQuestionAnswerLabels(answers);
  if (labels.length === 0) return false;
  return !labels.every((label) => DECLINE_ANSWER_RE.test(label));
}

/**
 * @param {{
 *   mode?: unknown,
 *   questionEvent?: unknown,
 *   answers?: unknown,
 *   reject?: boolean,
 * }} [input]
 * @returns {boolean}
 */
export function shouldExitPlanModeOnQuestionReply(input = {}) {
  if (String(input.mode || '').trim().toLowerCase() !== 'plan') return false;
  if (input.reject === true) return false;
  if (!isPlanApprovalQuestion(input.questionEvent)) return false;
  return isPlanImplementAnswer(input.answers);
}
