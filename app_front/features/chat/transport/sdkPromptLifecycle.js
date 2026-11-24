export function handleSdkPromptLifecycleMessage(chat, msg, helpers) {
  if (msg.type === 'promptSuggestion') {
    chat._promptSuggestionChip?.set(msg.text
      ? { text: msg.text, turnRunId: msg.turnRunId }
      : null);
    return true;
  }
  if (msg.type === 'sdkRoomState' && Object.prototype.hasOwnProperty.call(msg, 'promptSuggestion')) {
    chat._promptSuggestionChip?.set(msg.promptSuggestion);
  }
  const text = msg.text || '';
  if (msg.type === 'sdkQueued') {
    chat._sdkLastLiveEventAt = Date.now();
    delete chat._sdkLastRunStatus;
    chat._sdkServerBusy = true;
    chat._sdkServerQueuedCount = Math.max(Number(chat._sdkServerQueuedCount) || 0, Number(msg.position) || 1);
    helpers.setAgentState(chat, 'active');
    if (helpers.consumeOptimisticSdkQueuedPrompt(chat, text)) {
      helpers.renderChatTerminalState(chat);
      return true;
    }
    if (helpers.consumeOptimisticSdkPrompt(chat, text)) {
      chat._sdkRichView?.markUserPromptQueued?.(text);
      helpers.renderChatTerminalState(chat);
      return true;
    }
    helpers.appendSdkQueuedPromptLine(chat, text, msg.position || 1);
    helpers.renderChatTerminalState(chat);
    return true;
  }
  if (msg.type === 'sdkQueueReordered') {
    chat._sdkRichView?.reorderQueuedPrompts?.(Array.isArray(msg.order) ? msg.order : []);
    return true;
  }
  if (msg.type === 'sdkQueueRemoved') {
    chat._sdkServerQueuedCount = Math.max(0, (Number(chat._sdkServerQueuedCount) || 1) - 1);
    helpers.removeSdkQueuedPromptLine(chat, text);
    helpers.renderChatTerminalState(chat);
    return true;
  }
  if (msg.type !== 'sdkPromptStarted') return false;

  chat._sdkLastLiveEventAt = Date.now();
  chat._sdkServerBusy = true;
  chat._sdkServerQueuedCount = Math.max(0, Number(msg.remaining) || 0);
  helpers.logSdkVerbose('sdk-run', 'prompt started', {
    chatId: chat.id,
    fromQueue: msg.fromQueue === true,
    remaining: Number.isFinite(msg.remaining) ? msg.remaining : null,
  });
  if (msg.followUp === true) {
    helpers.setAgentState(chat, 'active');
    return true;
  }
  const promptOpts = {
    origin: msg.origin && typeof msg.origin === 'object' ? msg.origin : null,
    requestId: typeof msg.requestId === 'string' ? msg.requestId : '',
  };
  if (msg.fromQueue === true) {
    helpers.consumeOptimisticSdkQueuedPrompt(chat, text);
    helpers.promoteSdkQueuedPromptLine(chat, text, promptOpts);
  } else {
    if (!msg.origin && helpers.consumeOptimisticSdkPrompt(chat, text)) {
      helpers.setAgentState(chat, 'active');
      return true;
    }
    if (!msg.origin && helpers.consumeOptimisticSdkQueuedPrompt(chat, text)) {
      helpers.promoteSdkQueuedPromptLine(chat, text);
      helpers.setAgentState(chat, 'active');
      return true;
    }
    helpers.appendSdkUserPromptLine(chat, text, promptOpts);
  }
  helpers.setAgentState(chat, 'active');
  return true;
}
