/**
 * Plan-mode prompt decorations shared by non-SDK harnesses.
 */
import { resolveHarnessPlanPolicy } from '../agent-harness/harness-plan-policy.js';
import { buildChatPlanPromptContext } from '../chat-plan-persist.js';
import { collectDelegationReportsForPrompt } from '../delegation-report-context.js';
import { buildAvailableSkillsPrompt } from '../skills/skill-context.js';
import {
  buildSharedAlwaysApplyRulesPrompt,
  buildWorkspaceAlwaysApplyRulesPrompt,
} from './shared-cursor-context.js';
import { buildAgentTitleHint } from '../chat-title-agent.js';
import { isAskSdkMode } from './sdk-mode.js';
import { getContextRestartForChat } from '../usage/context-restarts.js';
import {
  PROMPT_DECORATION_BLOCK,
  PROMPT_DECORATION_STATIC_MODE,
  PROMPT_DECORATION_VOLATILE_ORDER,
  decidePromptDecoration,
  logPromptDecorationMeasurement,
  readPromptDecorationState,
  writePromptDecorationState,
} from './prompt-decoration.js';

export const HARNESS_PLAN_MODE_HINT =
  'You are in plan mode. Analyze and propose changes only; do not run mutating tools until the user confirms. A question-UI approval (implement / yes) or Cretli Build plan is confirmation — then implement; Cretli switches to agent mode and lifts write restrictions. Do not write plan files, todos, or scratch markdown — Cretli persists your plan after this turn.';

export const HARNESS_ASK_MODE_HINT =
  'You are in Ask mode. Answer questions and analyze the codebase using read-only tools. Do not edit files, run mutating commands, write plans, create todos, start implementations, or treat a user "yes" as approval to apply changes. If the user wants changes, tell them to switch to Agent mode.';

/**
 * Harnesses whose "session" is only the room's in-memory conversation, rebuilt
 * from persisted history when the room is created. They expose no external
 * CLI/runtime session identity to observe, so there is no reliable signal that a
 * rebuild dropped the earlier static block. Safe fallback: never dedupe the
 * static skills/rules block for them (re-emit it every turn) rather than risk
 * silently losing it. Harnesses with a real session identity (qwen's CLI session,
 * codex/claude/deepseek/opencode/codebuddy runtimes) keep the token-saving dedupe
 * and record a context restart when that identity changes.
 */
export const PROMPT_DECORATION_ALWAYS_STATIC_TRANSPORTS = Object.freeze([
  'openrouter',
  'mistral',
]);

const ALWAYS_STATIC_TRANSPORTS = new Set(PROMPT_DECORATION_ALWAYS_STATIC_TRANSPORTS);

/**
 * Build the static block (skills catalog + workspace/shared rules) for the
 * non-SDK harnesses. The SDK variant handles workspace rules through
 * `settingSources: ['project']`, so it uses `includeWorkspaceRules: false`.
 *
 * @param {{
 *   cwd?: string,
 *   prompt?: string,
 *   includeWorkspaceRules?: boolean,
 *   includeSharedRules?: boolean,
 * }} input
 * @returns {string}
 */
function buildStaticDecorationBlock(input) {
  const cwd = input.cwd || process.cwd();
  const parts = [];
  const skills = buildAvailableSkillsPrompt(cwd, {}, input.prompt || '');
  if (skills) parts.push(skills);
  if (input.includeWorkspaceRules !== false) {
    const workspaceRules = buildWorkspaceAlwaysApplyRulesPrompt(cwd);
    if (workspaceRules) parts.push(workspaceRules);
  }
  if (input.includeSharedRules !== false) {
    const sharedRules = buildSharedAlwaysApplyRulesPrompt();
    if (sharedRules) parts.push(sharedRules);
  }
  return parts.join('\n\n');
}

/**
 * Mode hint kept byte-identical to the previous behaviour.
 *
 * @param {{ skipPlanHint?: boolean, mode?: unknown, transport?: unknown }} input
 * @returns {string}
 */
function buildModeHint(input) {
  if (input.skipPlanHint === true) return '';
  const mode = String(input.mode || '').trim().toLowerCase();
  if (isAskSdkMode(mode)) return HARNESS_ASK_MODE_HINT;
  const policy = resolveHarnessPlanPolicy(input.transport);
  if (mode === 'plan' && policy.promptHint) return HARNESS_PLAN_MODE_HINT;
  return '';
}

/**
 * Resolve the volatile decoration blocks for the non-SDK harnesses.
 *
 * @param {Record<string, any>} input
 * @returns {Record<string, string>}
 */
function buildVolatileDecorationBlocks(input) {
  const hasReportContext = Object.prototype.hasOwnProperty.call(input, 'reportContext');
  return {
    [PROMPT_DECORATION_BLOCK.PAGE_CONTEXT]: '',
    [PROMPT_DECORATION_BLOCK.MODE_HINT]: buildModeHint(input),
    [PROMPT_DECORATION_BLOCK.CHAT_PLAN]: buildChatPlanPromptContext({
      cwd: input.cwd,
      chatId: input.chatId,
    }),
    [PROMPT_DECORATION_BLOCK.DELEGATION_REPORTS]: hasReportContext
      ? String(input.reportContext || '')
      : collectDelegationReportsForPrompt(input.chatId).text,
    [PROMPT_DECORATION_BLOCK.TITLE_HINT]: buildAgentTitleHint({
      chatId: input.chatId,
      mode: input.mode,
    }),
  };
}

/**
 * @param {string[]} parts
 * @param {string} prompt
 * @returns {string}
 */
function composeDecoratedPrompt(parts, prompt) {
  const filtered = parts.filter(Boolean);
  if (filtered.length === 0) return prompt;
  return `${filtered.join('\n\n')}\n\n${prompt}`;
}

/**
 * Resolve how the static block is emitted for this turn. An explicit
 * `input.staticMode` wins; otherwise harnesses with no observable session
 * identity fall back to re-emitting it every turn.
 *
 * @param {Record<string, any>} input
 * @returns {string}
 */
function resolveDecorationStaticMode(input) {
  if (input.staticMode === PROMPT_DECORATION_STATIC_MODE.ALWAYS) {
    return PROMPT_DECORATION_STATIC_MODE.ALWAYS;
  }
  const transport = String(input.transport || '').trim().toLowerCase();
  if (transport && ALWAYS_STATIC_TRANSPORTS.has(transport)) {
    return PROMPT_DECORATION_STATIC_MODE.ALWAYS;
  }
  return PROMPT_DECORATION_STATIC_MODE.DEDUPE;
}

/**
 * Run the slim/dedup decision for one turn. Kept separate so both the non-SDK
 * and SDK entry points share the exact same policy.
 *
 * @param {string} prompt
 * @param {Record<string, any>} input
 * @param {string} staticBlock
 * @param {Record<string, string>} volatile
 * @returns {string}
 */
function applyDecorationDecision(prompt, input, staticBlock, volatile) {
  const sessionKey = String(input.sessionKey || '').trim();
  // Without a session identity the caller opted out of dedup: keep the legacy
  // full-block behaviour so existing callers and tests are byte-identical.
  if (!sessionKey) {
    const parts = [staticBlock, ...PROMPT_DECORATION_VOLATILE_ORDER.map((key) => volatile[key])];
    return composeDecoratedPrompt(parts, prompt);
  }
  const previous = Object.prototype.hasOwnProperty.call(input, 'previousState')
    ? input.previousState
    : readPromptDecorationState(sessionKey);
  const decision = decidePromptDecoration(previous, {
    sessionKey,
    staticBlock,
    staticMode: resolveDecorationStaticMode(input),
    volatile,
  });
  if (typeof input.onState === 'function') input.onState(decision.state);
  else writePromptDecorationState(sessionKey, decision.state);
  logPromptDecorationMeasurement(decision.measurement, {
    harness: input.transport || '',
    chatId: input.chatId || '',
    sessionKey,
    turn: decision.state.turns,
  });
  return composeDecoratedPrompt(decision.parts, prompt);
}

/**
 * Session identity used to key the prompt-decoration state. It combines the
 * room session key with the number of recorded context restarts for the chat,
 * so a harness rebuild (model/mode/MCP/system-prompt change) automatically
 * invalidates the cached static block and the next turn re-sends it.
 *
 * @param {any} room
 * @returns {string}
 */
export function resolvePromptDecorationSessionKey(room) {
  const base = String(room?.sessionKey || room?.chatId || '').trim();
  if (!base) return '';
  const chatId = String(room?.chatId || '').trim();
  if (!chatId) return base;
  const restarts = Number(getContextRestartForChat(chatId)?.count) || 0;
  return `${base}#g${restarts}`;
}

/**
 * Prefix a harness prompt with the plan-mode hint and/or the persisted chat plan.
 *
 * Backward compatible: when `input.sessionKey` is absent this is the original
 * stateless full-block decoration. With a session key the static block is sent
 * once per session (and on hash change or session restart) while volatile blocks
 * are only sent when they change. Harnesses listed in
 * `PROMPT_DECORATION_ALWAYS_STATIC_TRANSPORTS` keep the full static block every
 * turn because they expose no session identity to observe.
 *
 * @param {unknown} text
 * @param {{
 *   cwd?: string,
 *   chatId?: string,
 *   mode?: string,
 *   transport?: string,
 *   skipPlanHint?: boolean,
 *   reportContext?: string,
 *   sessionKey?: string,
 *   staticMode?: 'dedupe' | 'always',
 *   previousState?: import('./prompt-decoration.js').PromptDecorationState | null,
 *   onState?: (state: import('./prompt-decoration.js').PromptDecorationState) => void,
 * }} [input]
 * @returns {string}
 */
export function applyHarnessOutboundPrompt(text, input = {}) {
  const prompt = String(text || '');
  const staticBlock = buildStaticDecorationBlock({
    cwd: input.cwd,
    prompt,
    includeWorkspaceRules: true,
    includeSharedRules: true,
  });
  const volatile = buildVolatileDecorationBlocks(input);
  return applyDecorationDecision(prompt, input, staticBlock, volatile);
}

/**
 * SDK harness variant: the SDK already loads workspace rules through its own
 * setting source, so its static block is skills + shared rules only, and the
 * automatic page context is a volatile block. Behaviour matches the previous
 * inline prefix in `cursor-agent-sdk-ws.js`.
 *
 * @param {unknown} text
 * @param {{
 *   cwd?: string,
 *   chatId?: string,
 *   mode?: string,
 *   pageContext?: string,
 *   reportContext?: string,
 *   sessionKey?: string,
 *   previousState?: import('./prompt-decoration.js').PromptDecorationState | null,
 *   onState?: (state: import('./prompt-decoration.js').PromptDecorationState) => void,
 * }} [input]
 * @returns {string}
 */
export function applySdkHarnessOutboundPrompt(text, input = {}) {
  const prompt = String(text || '');
  const staticBlock = buildStaticDecorationBlock({
    cwd: input.cwd,
    prompt,
    includeWorkspaceRules: false,
    includeSharedRules: true,
  });
  const hasReportContext = Object.prototype.hasOwnProperty.call(input, 'reportContext');
  const volatile = {
    [PROMPT_DECORATION_BLOCK.PAGE_CONTEXT]: String(input.pageContext || ''),
    // The SDK uses a native Plan/Ask mode; it has no textual mode hint.
    [PROMPT_DECORATION_BLOCK.MODE_HINT]: '',
    [PROMPT_DECORATION_BLOCK.CHAT_PLAN]: buildChatPlanPromptContext({
      cwd: input.cwd,
      chatId: input.chatId,
    }),
    [PROMPT_DECORATION_BLOCK.DELEGATION_REPORTS]: hasReportContext
      ? String(input.reportContext || '')
      : collectDelegationReportsForPrompt(input.chatId).text,
    [PROMPT_DECORATION_BLOCK.TITLE_HINT]: buildAgentTitleHint({
      chatId: input.chatId,
      mode: input.mode,
    }),
  };
  return applyDecorationDecision(prompt, input, staticBlock, volatile);
}

/**
 * @param {any} room
 * @param {unknown} text
 * @param {string} transport
 * @param {{ skipPlanHint?: boolean }} [options]
 * @returns {string}
 */
export function decorateHarnessPrompt(room, text, transport, options = {}) {
  const collected = collectDelegationReportsForPrompt(room?.chatId);
  if (room) room._delegationReportIdsInPrompt = collected.ids;
  const sessionKey = resolvePromptDecorationSessionKey(room);
  const baseInput = {
    cwd: room?.cwd,
    chatId: room?.chatId,
    mode: room?.sdkMode,
    transport,
    skipPlanHint: options.skipPlanHint === true,
    reportContext: collected.text,
  };
  if (!room || !sessionKey) {
    return applyHarnessOutboundPrompt(text, baseInput);
  }
  return applyHarnessOutboundPrompt(text, {
    ...baseInput,
    sessionKey,
    previousState: room._promptDecorationState || null,
    onState: (state) => {
      room._promptDecorationState = state;
    },
  });
}
