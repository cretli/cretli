export function clearClaudePromptSuggestions(
  rooms: Iterable<Record<string, any>>,
  broadcast: (room: Record<string, any>, payload: Record<string, unknown>) => void,
): number {
  let cleared = 0;
  for (const room of rooms) {
    if (!room?.promptSuggestion) continue;
    room.promptSuggestion = null;
    broadcast(room, {
      type: 'promptSuggestion',
      chatId: String(room.chatId || ''),
      text: '',
      turnRunId: '',
    });
    cleared += 1;
  }
  return cleared;
}

export function shouldAcceptClaudePromptSuggestion(input: {
  enabled: boolean;
  busy: boolean;
  pendingPromptCount: number;
  sessionId: string;
  expectedSessionId: string;
  resultStatus: string;
  runMode: string;
  apiError?: boolean;
}): boolean {
  return input.enabled
    && !input.busy
    && input.pendingPromptCount === 0
    && input.resultStatus !== 'error'
    && !input.apiError
    && input.runMode !== 'plan'
    && !!input.expectedSessionId
    && input.sessionId === input.expectedSessionId;
}
