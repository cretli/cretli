/**
 * Maps OpenRouter / agent-loop events to SDK-shaped chat events for rich view + history.
 */

/**
 * Pure token/chunk increment — append to the current assistant item.
 *
 */
export function buildAssistantDeltaEvent(delta: string): Record<string, unknown> {
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
 */
export function buildAssistantSnapshotEvent(fullText: string): Record<string, unknown> {
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

export function buildAssistantFullEvent(fullText: string): Record<string, unknown> {
  return buildAssistantSnapshotEvent(fullText);
}

export interface ToolCallEventInput {
  callId: string;
  name: string;
  status: string;
  args?: Record<string, unknown>;
  result?: unknown;
}

export function buildToolCallEvent(input: ToolCallEventInput): Record<string, unknown> {
  const event: Record<string, unknown> = {
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

export function buildUserEvent(text: string): Record<string, unknown> {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
    },
  };
}
