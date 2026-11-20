/**
 * Qwen tool_result classification: denial / failure detection and text extraction
 * for the CLI's completed-with-error tool results.
 */

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
