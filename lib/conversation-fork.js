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

export function buildConversationForkPrompt(sourceText, message) {
  const context = typeof sourceText === 'string' ? sourceText.trim() : '';
  const nextMessage = typeof message === 'string' ? message.trim() : '';
  if (!context) return nextMessage;
  if (!nextMessage) {
    return [
      FORK_CONTEXT_START,
      'Below is the full conversation inherited from the source chat.',
      context,
      FORK_CONTEXT_END,
      '',
      'Continue the conversation from this point.',
    ].join('\n');
  }
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

/**
 * Prompt for a new harness taking over unfinished work from another agent.
 *
 * @param {{
 *   sourceText?: string,
 *   fromHarness?: string,
 *   toHarness?: string,
 *   fromModel?: string,
 *   toModel?: string,
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
  const body = transcript
    ? ['Conversation so far:', transcript]
    : ['No conversation transcript was available. Ask the user what to continue.'];
  return [
    HANDOFF_CONTEXT_START,
    'You are taking over this task from another agent after a harness switch.',
    `Previous harness: ${fromLabel}`,
    `Your harness: ${toLabel}`,
    'Do not restart from scratch. Continue the unfinished work.',
    '',
    ...body,
    HANDOFF_CONTEXT_END,
    '',
    'Continue from where the previous agent left off.',
  ].join('\n');
}

/**
 * Prompt for a separate chat that diagnoses another agent (any harness).
 *
 * @param {string} [sourceText]
 * @param {string} [message]
 * @returns {string}
 */
export function buildAgentAnalysisPrompt(sourceText, message) {
  const context = typeof sourceText === 'string' ? sourceText.trim() : '';
  const nextMessage = typeof message === 'string' ? message.trim() : '';
  const lines = [
    ANALYSIS_CONTEXT_START,
    'This is a separate analytical chat about the agent in the source conversation.',
    'Diagnose that agent. Do not continue its work, take over the task, or trigger external actions.',
    '',
  ];
  if (context) {
    lines.push('Source conversation:', context);
  } else {
    lines.push('No source conversation transcript was available.');
  }
  lines.push(ANALYSIS_CONTEXT_END);
  const wrapped = lines.join('\n');
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
 * }} [params]
 * @returns {string}
 */
export function buildForkInitialPrompt(params = {}) {
  const fromHarness = normalizeAgentTransport(params.fromHarness);
  const toHarness = normalizeAgentTransport(params.toHarness);
  const nextMessage = typeof params.message === 'string' ? params.message.trim() : '';
  if (params.analyze === true) {
    return buildAgentAnalysisPrompt(params.sourceText, nextMessage);
  }
  if (fromHarness === toHarness) {
    return buildConversationForkPrompt(params.sourceText, nextMessage);
  }
  const handoff = buildHarnessHandoffPrompt({
    sourceText: params.sourceText,
    fromHarness,
    toHarness,
    fromModel: params.fromModel,
    toModel: params.toModel,
  });
  if (!nextMessage) return handoff;
  return `${handoff}\n\nNew user message:\n${nextMessage}`;
}
