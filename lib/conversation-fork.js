import { normalizeAgentTransport } from './agent-transport.js';

const FORK_CONTEXT_START = '[CONVERSATION FORK CONTEXT]';
const FORK_CONTEXT_END = '[/CONVERSATION FORK CONTEXT]';
const HANDOFF_CONTEXT_START = '[HARNESS HANDOFF CONTEXT]';
const HANDOFF_CONTEXT_END = '[/HARNESS HANDOFF CONTEXT]';
const ANALYSIS_CONTEXT_START = '[AGENT ANALYSIS CONTEXT]';
const ANALYSIS_CONTEXT_END = '[/AGENT ANALYSIS CONTEXT]';
const HANDOFF_TRUNCATED_PREFIX = '[Earlier conversation truncated]\n';
const NEW_USER_MESSAGE_PREFIX = 'New user message:';

/** Max transcript characters kept in a harness-switch handoff prompt (tail). */
export const HARNESS_HANDOFF_MAX_CHARS = 24000;

/**
 * @param {string} sourceText
 * @returns {string}
 */
function clipHandoffTranscript(sourceText) {
  const context = typeof sourceText === 'string' ? sourceText.trim() : '';
  if (!context) return '';
  if (context.length <= HARNESS_HANDOFF_MAX_CHARS) return context;
  return `${HANDOFF_TRUNCATED_PREFIX}${context.slice(-HARNESS_HANDOFF_MAX_CHARS)}`;
}

/**
 * @param {unknown} value
 * @param {string} fallback
 * @returns {string}
 */
function labelOrFallback(value, fallback) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || fallback;
}

/**
 * Append a user follow-up to an inherited fork/handoff prompt.
 *
 * @param {string} prompt
 * @param {string} message
 * @returns {string}
 */
export function withInheritedFollowUp(prompt, message) {
  const base = typeof prompt === 'string' ? prompt.trim() : '';
  const next = typeof message === 'string' ? message.trim() : '';
  if (!base) return next;
  if (!next) return base;
  return `${base}\n\n${NEW_USER_MESSAGE_PREFIX}\n${next}`;
}

/**
 * Resolve the first send after a quiet conversation fork.
 *
 * @param {string} pendingPrompt
 * @param {string} pendingDisplayText
 * @param {string} userText
 * @returns {{ payloadText: string, displayText: string } | null}
 */
export function resolvePendingInheritedSend(pendingPrompt, pendingDisplayText, userText) {
  const pending = typeof pendingPrompt === 'string' ? pendingPrompt.trim() : '';
  if (!pending) return null;
  const defaultDraft = typeof pendingDisplayText === 'string' ? pendingDisplayText.trim() : '';
  const next = typeof userText === 'string' ? userText.trim() : '';
  if (!next || next === defaultDraft) {
    return { payloadText: pending, displayText: defaultDraft || next };
  }
  return {
    payloadText: withInheritedFollowUp(pending, next),
    displayText: next,
  };
}

function forkSourceMetaLines(options = {}) {
  const sourceChatId = String(options.sourceChatId || '').trim();
  const sourceChatTitle = String(options.sourceChatTitle || '').trim();
  const copiedThroughSeq = Number(options.copiedThroughSeq) || 0;
  const lines = [];
  if (sourceChatId) {
    const titleBit = sourceChatTitle ? `"${sourceChatTitle}" ` : '';
    lines.push(`Source chat: ${titleBit}${sourceChatId}`);
  }
  if (copiedThroughSeq > 0 && options.partial === true) {
    lines.push(`Copied history is partial: only through event seq ${copiedThroughSeq}. Do not continue past that cutoff.`);
  } else if (copiedThroughSeq > 0) {
    lines.push(`Copied history through event seq ${copiedThroughSeq}.`);
  }
  return lines;
}

function forkHistoryAccessRules() {
  return [
    'Continue that source chat only. Do not choose a previous agent from the newest transcript file on disk.',
    'Do not glob, grep, or read agent-transcripts, data/chat-history, data/runtime-home, or sdk-agent-store.',
    'If this prompt is missing context, call Cretli MCP chat_show or chat_history with the source chat id (or this fork id).',
  ];
}

export function buildConversationForkPrompt(sourceText, message, options = {}) {
  const context = typeof sourceText === 'string' ? sourceText.trim() : '';
  const nextMessage = typeof message === 'string' ? message.trim() : '';
  if (!context) return nextMessage;
  const intro = options.partial === true
    ? 'Below is the conversation inherited from the source chat, up to the fork point.'
    : 'Below is the full conversation inherited from the source chat.';
  const meta = forkSourceMetaLines(options);
  const rules = forkHistoryAccessRules();
  const wrapped = [
    FORK_CONTEXT_START,
    ...meta,
    intro,
    context,
    '',
    ...rules,
    FORK_CONTEXT_END,
  ];
  if (!nextMessage) {
    return [...wrapped, '', 'Continue the conversation from this point.'].join('\n');
  }
  return [...wrapped, '', 'Continue the conversation from this point. New user message:', nextMessage].join('\n');
}

/**
 * Prompt for a new harness taking over unfinished work from another agent.
 *
 * @param {{
 *   sourceText?: string,
 *   fromHarness?: string,
 *   toHarness?: string,
 *   fromModel?: string,
 *   toModel?: string,
 *   partial?: boolean,
 *   sourceChatId?: string,
 *   sourceChatTitle?: string,
 *   copiedThroughSeq?: number,
 * }} [params]
 * @returns {string}
 */
export function buildHarnessHandoffPrompt(params = {}) {
  const fromHarness = labelOrFallback(params.fromHarness, 'unknown');
  const toHarness = labelOrFallback(params.toHarness, 'unknown');
  const fromModel = labelOrFallback(params.fromModel, '');
  const toModel = labelOrFallback(params.toModel, '');
  const transcript = clipHandoffTranscript(params.sourceText || '');
  const fromLabel = fromModel ? `${fromHarness} (${fromModel})` : fromHarness;
  const toLabel = toModel ? `${toHarness} (${toModel})` : toHarness;
  const transcriptIntro = params.partial === true
    ? 'Conversation so far (up to the fork point):'
    : 'Conversation so far:';
  const body = transcript
    ? [transcriptIntro, transcript]
    : ['No conversation transcript was available. Ask the user what to continue, or load it with Cretli MCP chat_history.'];
  return [
    HANDOFF_CONTEXT_START,
    'You are taking over this task from another agent after a harness switch.',
    `Previous harness: ${fromLabel}`,
    `Your harness: ${toLabel}`,
    ...forkSourceMetaLines(params),
    'Do not restart from scratch. Continue the unfinished work of the source chat named above.',
    '',
    ...body,
    '',
    ...forkHistoryAccessRules(),
    HANDOFF_CONTEXT_END,
    '',
    'Continue the unfinished work of the source chat. Missing context comes from MCP, not from transcript files.',
  ].join('\n');
}

/**
 * Prompt for a sub-chat that diagnoses another agent.
 * Does not inherit the parent transcript — only the snapshot in `message`
 * (chat id and live status).
 *
 * @param {string} [message]
 * @returns {string}
 */
export function buildAgentAnalysisPrompt(message) {
  const nextMessage = typeof message === 'string' ? message.trim() : '';
  const wrapped = [
    ANALYSIS_CONTEXT_START,
    'This is a new sub-chat with its own empty history.',
    'Analyze the parent chat identified below. Do not continue its work, take over the task, or trigger external actions.',
    'Use the parent chat id and the live status snapshot. Do not assume a copied conversation.',
    ANALYSIS_CONTEXT_END,
  ].join('\n');
  if (!nextMessage) return wrapped;
  return `${wrapped}\n\n${NEW_USER_MESSAGE_PREFIX}\n${nextMessage}`;
}

/**
 * @param {string} raw
 * @param {string} start
 * @param {string} end
 * @returns {{ after: string } | null}
 */
function extractWrappedSection(raw, start, end) {
  const startIdx = raw.indexOf(start);
  if (startIdx < 0) return null;
  const innerStart = startIdx + start.length;
  const endIdx = raw.indexOf(end, innerStart);
  if (endIdx < 0) return null;
  return { after: raw.slice(endIdx + end.length) };
}

/**
 * @param {string} after
 * @returns {string}
 */
function extractFollowUpMessage(after) {
  const text = typeof after === 'string' ? after.trim() : '';
  if (!text) return '';
  const idx = text.lastIndexOf(NEW_USER_MESSAGE_PREFIX);
  if (idx < 0) return '';
  return text.slice(idx + NEW_USER_MESSAGE_PREFIX.length).trim();
}

/**
 * Detect a fork/handoff/analysis wrapper so the UI can hide the duplicated transcript.
 *
 * @param {unknown} text
 * @returns {{ wrapped: boolean, kind: 'fork' | 'handoff' | 'analyze' | '', followUp: string }}
 */
export function parseInheritedPrompt(text) {
  const raw = typeof text === 'string' ? text : '';
  const analysis = extractWrappedSection(raw, ANALYSIS_CONTEXT_START, ANALYSIS_CONTEXT_END);
  if (analysis) {
    return {
      wrapped: true,
      kind: 'analyze',
      followUp: extractFollowUpMessage(analysis.after),
    };
  }
  const fork = extractWrappedSection(raw, FORK_CONTEXT_START, FORK_CONTEXT_END);
  if (fork) {
    return { wrapped: true, kind: 'fork', followUp: extractFollowUpMessage(fork.after) };
  }
  const handoff = extractWrappedSection(raw, HANDOFF_CONTEXT_START, HANDOFF_CONTEXT_END);
  if (handoff) {
    return {
      wrapped: true,
      kind: 'handoff',
      followUp: extractFollowUpMessage(handoff.after),
    };
  }
  return { wrapped: false, kind: '', followUp: '' };
}

/**
 * Visible user-bubble text for a fork/handoff/analysis wrapper.
 *
 * @param {unknown} text
 * @param {{ fork?: string, handoff?: string, analyze?: string }} [labels]
 * @returns {string}
 */
export function resolveInheritedPromptEcho(text, labels = {}) {
  const inherited = parseInheritedPrompt(text);
  if (!inherited.wrapped) {
    return typeof text === 'string' ? text : '';
  }
  if (inherited.kind === 'analyze') {
    return labels.analyze || 'Analyze the current agent state from the source chat.';
  }
  if (inherited.followUp) return inherited.followUp;
  if (inherited.kind === 'handoff') {
    return labels.handoff || "Continue the previous agent's work.";
  }
  return labels.fork || 'Continue from the forked conversation.';
}

/**
 * @param {{
 *   sourceText?: string,
 *   message?: string,
 *   fromHarness?: string,
 *   toHarness?: string,
 *   fromModel?: string,
 *   toModel?: string,
 *   analyze?: boolean,
 *   partial?: boolean,
 *   sourceChatId?: string,
 *   sourceChatTitle?: string,
 *   copiedThroughSeq?: number,
 * }} [params]
 * @returns {string}
 */
export function buildForkInitialPrompt(params = {}) {
  const fromHarness = normalizeAgentTransport(params.fromHarness);
  const toHarness = normalizeAgentTransport(params.toHarness);
  const nextMessage = typeof params.message === 'string' ? params.message.trim() : '';
  const sourceOptions = {
    partial: params.partial === true,
    sourceChatId: params.sourceChatId,
    sourceChatTitle: params.sourceChatTitle,
    copiedThroughSeq: params.copiedThroughSeq,
  };
  if (params.analyze === true) {
    return buildAgentAnalysisPrompt(nextMessage);
  }
  if (fromHarness === toHarness) {
    return buildConversationForkPrompt(params.sourceText, nextMessage, sourceOptions);
  }
  const handoff = buildHarnessHandoffPrompt({
    sourceText: params.sourceText,
    fromHarness,
    toHarness,
    fromModel: params.fromModel,
    toModel: params.toModel,
    ...sourceOptions,
  });
  if (!nextMessage) return handoff;
  return `${handoff}\n\nNew user message:\n${nextMessage}`;
}
