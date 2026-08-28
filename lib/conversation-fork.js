const FORK_CONTEXT_START = '[CONVERSATION FORK CONTEXT]';
const FORK_CONTEXT_END = '[/CONVERSATION FORK CONTEXT]';

export function buildConversationForkPrompt(sourceText, message) {
  const context = typeof sourceText === 'string' ? sourceText.trim() : '';
  const nextMessage = typeof message === 'string' ? message.trim() : '';
  if (!context) return nextMessage;
  return [
    FORK_CONTEXT_START,
    'Below is the full conversation inherited from the source chat.',
    context,
    FORK_CONTEXT_END,
    '',
    'Continue the conversation from this point. New user message:',
    nextMessage,
  ].join('\n');
}
