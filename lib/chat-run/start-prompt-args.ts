/**
 * Positional argument layouts of each harness's `room.startPrompt` runner.
 *
 * The runners grew different signatures (Claude has `alreadyPersisted` before the
 * skill selection, the SDK runner has `clientSentAt` and `onAccepted`), so a
 * caller that starts a prompt on behalf of the server (delegation, watcher,
 * queue) must not guess the index of the selection. Each harness declares its
 * layout on the room (`room.startPromptArgs`); rooms without a declaration use
 * the standard layout.
 */

export interface StartPromptInput {
  text: string;
  mode: string;
  displayText?: string;
  /** Normalized skill selection. */
  selection?: unknown;
  origin?: { kind: string, subtype?: string, clientId?: string, clientName?: string, sourceChatId?: string, sourceChatTitle?: string };
  requestId?: string;
  /** Only used by layouts that take it. */
  onAccepted?: ((run: any) => void) | undefined;
}

/** `(text, mode, fromQueue, displayText, selection, origin, requestId)`: standard kernel runners. */
export const STANDARD_START_PROMPT_ARGS = Object.freeze(
  (input: StartPromptInput) => [input.text, input.mode, false, input.displayText || '', input.selection, input.origin, input.requestId],
);

/** `(text, mode, fromQueue, displayText, alreadyPersisted, selection, origin, requestId)`: Claude. */
export const CLAUDE_START_PROMPT_ARGS = Object.freeze(
  (input: StartPromptInput) => [input.text, input.mode, false, input.displayText || '', false, input.selection, input.origin, input.requestId],
);

/** `(text, mode, fromQueue, clientSentAt, displayText, onAccepted, selection, origin, requestId)`: SDK. */
export const SDK_START_PROMPT_ARGS = Object.freeze(
  (input: StartPromptInput) => [input.text, input.mode, false, null, input.displayText || '', input.onAccepted, input.selection, input.origin, input.requestId],
);

export function buildStartPromptArgs(room: any, input: StartPromptInput): unknown[] {
  const layout = typeof room?.startPromptArgs === 'function' ? room.startPromptArgs : STANDARD_START_PROMPT_ARGS;
  return layout(input);
}
