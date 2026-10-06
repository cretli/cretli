/**
 * Maps OpenRouter / agent-loop events to SDK-shaped chat events for rich view + history.
 */

/**
 * Pure token/chunk increment — append to the current assistant item.
 *
 * @param {string} delta
 * @returns {Record<string, unknown>}
 */
export function buildAssistantDeltaEvent(delta) {
  const text = typeof delta === 'string' ? delta : '';
  return {
    type: 'assistant',
    streamTextMode: 'delta',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
  };
}

/**
 * Full text so far for one assistant item — replace/grow via snapshot merge.
 *
 * @param {string} fullText
 * @returns {Record<string, unknown>}
 */
export function buildAssistantSnapshotEvent(fullText) {
  const text = typeof fullText === 'string' ? fullText : '';
  return {
    type: 'assistant',
    streamTextMode: 'snapshot',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
  };
}

/**
 * @param {string} fullText
 * @returns {Record<string, unknown>}
 */
export function buildAssistantFullEvent(fullText) {
  return buildAssistantSnapshotEvent(fullText);
}

/**
 * @param {{
 *   callId: string,
 *   name: string,
 *   status: string,
 *   args?: Record<string, unknown>,
 *   result?: unknown,
 * }} input
 * @returns {Record<string, unknown>}
 */
export function buildToolCallEvent(input) {
  const event = {
    type: 'tool_call',
    name: input.name,
    status: input.status,
    call_id: input.callId,
  };
  if (input.args && typeof input.args === 'object') {
    event.args = input.args;
  }
  if (input.result !== undefined) {
    event.result = input.result;
  }
  return event;
}

/**
 * @param {string} text
 * @returns {Record<string, unknown>}
 */
export function buildUserEvent(text) {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
    },
  };
}
