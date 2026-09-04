/**
 * Qwen ask_user_question — map CLI tool input to the shared question UI
 * (`opencode_question`) and return answers through `canUseTool`.
 */

export const QWEN_CAN_USE_TOOL_TIMEOUT_MS = 600000;

/**
 * @param {unknown} name
 * @returns {boolean}
 */
export function isQwenAskUserQuestionTool(name) {
  const raw = String(name || '').trim().toLowerCase().replace(/_/g, '');
  return raw === 'askuserquestion';
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
function asRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * @param {unknown} raw
 * @returns {Array<Record<string, unknown>>}
 */
export function normalizeQwenQuestionItems(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {Array<Record<string, unknown>>} */
  const out = [];
  for (const item of raw) {
    const rec = asRecord(item);
    if (!rec) continue;
    const question = typeof rec.question === 'string' ? rec.question.trim() : '';
    if (!question) continue;
    const header = typeof rec.header === 'string' ? rec.header.trim() : '';
    const options = Array.isArray(rec.options)
      ? rec.options
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
      multiple: rec.multiple === true || rec.multiSelect === true,
      custom: rec.custom !== false,
    });
  }
  return out;
}

/**
 * @param {{ requestId?: string, questions?: unknown }} input
 * @returns {Record<string, unknown> | null}
 */
export function buildQwenQuestionSdkEvent(input) {
  const requestId = typeof input?.requestId === 'string' ? input.requestId.trim() : '';
  const questions = normalizeQwenQuestionItems(input?.questions);
  if (!requestId || questions.length === 0) return null;
  return {
    type: 'opencode_question',
    requestId,
    questions,
  };
}

/**
 * @param {unknown} questions
 * @param {unknown} uiAnswers
 * @returns {Record<string, string>}
 */
export function buildQwenQuestionAnswers(questions, uiAnswers) {
  const items = Array.isArray(questions) ? questions : [];
  const rows = Array.isArray(uiAnswers) ? uiAnswers : [];
  /** @type {Record<string, string>} */
  const answers = {};
  for (let i = 0; i < items.length; i += 1) {
    const row = Array.isArray(rows[i]) ? rows[i] : [];
    const labels = row
      .map((entry) => String(entry || '').trim())
      .filter(Boolean);
    if (labels.length === 0) continue;
    answers[String(i)] = labels.join(', ');
  }
  return answers;
}

/**
 * @param {unknown} result
 * @returns {boolean}
 */
export function isDeniedQwenToolResult(result) {
  const text = stringifyQwenToolResult(result);
  if (!text) return false;
  if (/\[Operation Cancelled\]/i.test(text)) return true;
  if (/Reason:\s*Denied/i.test(text)) return true;
  if (/permission was declined/i.test(text)) return true;
  if (/Cannot ask user questions/i.test(text)) return true;
  if (/User declined to answer/i.test(text)) return true;
  if (/Tool blocked by plan mode/i.test(text)) return true;
  return false;
}

/**
 * Tool finished with a failure payload (CLI still emits a completed tool_result).
 * Includes permission denials and Qwen FileReadCache / prior-read rejections.
 *
 * @param {unknown} result
 * @returns {boolean}
 */
export function isFailedQwenToolResult(result) {
  if (isDeniedQwenToolResult(result)) return true;
  const text = stringifyQwenToolResult(result);
  if (!text) return false;
  if (/has not been read in this session/i.test(text)) return true;
  if (/edit_requires_prior_read/i.test(text)) return true;
  return false;
}

/**
 * @param {unknown} result
 * @returns {string}
 */
export function stringifyQwenToolResult(result) {
  if (typeof result === 'string') return result;
  if (result == null) return '';
  if (Array.isArray(result)) {
    return result
      .map((block) => {
        if (typeof block === 'string') return block;
        const rec = asRecord(block);
        if (rec && typeof rec.text === 'string') return rec.text;
        try {
          return JSON.stringify(block);
        } catch {
          return String(block);
        }
      })
      .filter(Boolean)
      .join('\n');
  }
  const rec = asRecord(result);
  if (rec && typeof rec.text === 'string') return rec.text;
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

/**
 * @param {{
 *   behavior: 'allow' | 'deny',
 *   input?: Record<string, unknown> | null,
 *   answers?: Record<string, string>,
 *   message?: string,
 * }} input
 * @returns {{ behavior: 'allow', updatedInput: Record<string, unknown> } | { behavior: 'deny', message: string }}
 */
export function buildQwenCanUseToolResult(input) {
  if (input.behavior === 'deny') {
    return {
      behavior: 'deny',
      message: String(input.message || 'User declined to answer').trim() || 'User declined to answer',
    };
  }
  const base = asRecord(input.input) || {};
  return {
    behavior: 'allow',
    updatedInput: {
      ...base,
      answers: input.answers && typeof input.answers === 'object' ? input.answers : {},
    },
  };
}

/**
 * @param {{
 *   emitQuestion: (event: Record<string, unknown>) => void,
 *   waitForReply: (requestId: string, options?: { signal?: AbortSignal }) => Promise<{
 *     answers?: Array<Array<string>>,
 *     reject?: boolean,
 *     reason?: string,
 *   }>,
 *   generateId?: () => string,
 * }} deps
 * @returns {(toolName: string, input: Record<string, unknown>, options: { signal?: AbortSignal }) => Promise<{
 *   behavior: 'allow' | 'deny',
 *   updatedInput?: Record<string, unknown>,
 *   message?: string,
 * }>}
 */
export function createQwenCanUseTool(deps) {
  const emitQuestion = deps.emitQuestion;
  const waitForReply = deps.waitForReply;
  const generateId = typeof deps.generateId === 'function'
    ? deps.generateId
    : () => `qwen-q-${Date.now()}`;
  return async (toolName, input, options = {}) => {
    const toolInput = asRecord(input) || {};
    if (!isQwenAskUserQuestionTool(toolName)) {
      return { behavior: 'allow', updatedInput: toolInput };
    }
    const questions = normalizeQwenQuestionItems(toolInput.questions);
    if (questions.length === 0) {
      return buildQwenCanUseToolResult({
        behavior: 'deny',
        message: 'ask_user_question had no valid questions',
      });
    }
    const requestId = String(generateId() || '').trim() || `qwen-q-${Date.now()}`;
    const event = buildQwenQuestionSdkEvent({ requestId, questions });
    if (event) emitQuestion(event);
    const reply = await waitForReply(requestId, { signal: options.signal });
    if (!reply || reply.reject === true) {
      return buildQwenCanUseToolResult({
        behavior: 'deny',
        message: String(reply?.reason || 'User declined to answer').trim() || 'User declined to answer',
      });
    }
    return buildQwenCanUseToolResult({
      behavior: 'allow',
      input: toolInput,
      answers: buildQwenQuestionAnswers(questions, reply.answers),
    });
  };
}
