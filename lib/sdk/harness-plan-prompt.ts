/**
 * Plan-mode prompt decorations shared by non-SDK harnesses.
 */
import crypto from 'node:crypto';
import { tryRecordContextSend } from '../context/context-send-manifest.ts';
import { resolveHarnessPlanPolicy } from '../agent-harness/harness-plan-policy.ts';
import { buildChatPlanPromptContext } from '../chat-plan-persist.js';
import { collectDelegationReportsForPrompt } from '../delegation-report-context.js';
import { buildSkillPromptBlocks } from '../skills/skill-context.js';
import { resolveChatContextProfile } from '../context/delegation-context-profile.ts';
import { buildAgentsMdBlockForTurn, resolveInstructionDeliveryForTurn } from '../context/context-settings-runtime.ts';
import { instructionEpochKey } from '../context/instruction-epoch.ts';
import { summarizeSkillSelection } from '../skills/skill-selection.js';
import {
  buildSharedAlwaysApplyRulesPrompt,
  buildWorkspaceAlwaysApplyRulesPrompt,
} from './shared-cursor-context.ts';
import { buildAgentTitleHint } from '../chat-title-agent.js';
import { isAskSdkMode } from './sdk-mode.ts';
import { getContextRestartForChat } from '../usage/context-restarts.ts';
import {
  PROMPT_DECORATION_BLOCK,
  PROMPT_DECORATION_STATIC_MODE,
  PROMPT_DECORATION_VOLATILE_ORDER,
  decidePromptDecoration,
  logPromptDecorationMeasurement,
  readPromptDecorationState,
  writePromptDecorationState,
} from './prompt-decoration.ts';

// Derived from the reader so this stays in sync with prompt-decoration.ts.
type PromptDecorationState = NonNullable<ReturnType<typeof readPromptDecorationState>>;
type DecorationBlocks = {
  staticBlock: string;
  legacyStaticBlock: string;
  skillsBlock: string;
  selection: ReturnType<typeof summarizeSkillSelection>;
  /** Pasted AGENTS.md chain ('' unless Cretli itself delivers it). Part of `staticBlock`. */
  agentsMdBlock?: string;
  /** `staticBlock` without the AGENTS.md block (the legacy baseline shape). */
  coreStaticBlock?: string;
  agentsMdWarnings?: string[];
};

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
  'zai',
  'mimo',
]);

const ALWAYS_STATIC_TRANSPORTS = new Set(PROMPT_DECORATION_ALWAYS_STATIC_TRANSPORTS);

/**
 * Build the decoration blocks for the non-SDK harnesses.
 *
 * The skills catalog is stable across turns, so it stays in the static block
 * together with the rules. The body of the skills this turn invokes is returned
 * separately: it changes with the request and must reach the model on every
 * invocation, while the catalog keeps its hash and is deduped.
 *
 * `legacyStaticBlock` is the pre-split composition (catalog + selected skills +
 * rules) used by callers without a session identity, so their output is
 * unchanged.
 *
 * The SDK variant handles workspace rules through
 * `settingSources: ['project']`, so it uses `includeWorkspaceRules: false`.
 *
 * @param {{
 *   cwd?: string,
 *   prompt?: string,
 *   includeWorkspaceRules?: boolean,
 *   includeSharedRules?: boolean,
 *   taskKind?: string,
 *   fileTypes?: string[],
 *   skillOptions?: { additionalDirs?: string[], appRoot?: string, homeDir?: string },
 *   selection?: unknown,
 *   sharedDirs?: string[],
 *   agentsMd?: { text: string, warnings?: string[] },
 * }} input
 * @returns {{ staticBlock: string, legacyStaticBlock: string, skillsBlock: string, selection: ReturnType<typeof summarizeSkillSelection> }}
 */
function buildDecorationBlocks(input: {
  cwd?: string;
  prompt?: string;
  includeWorkspaceRules?: boolean;
  includeSharedRules?: boolean;
  taskKind?: string;
  fileTypes?: string[];
  skillOptions?: { additionalDirs?: string[]; appRoot?: string; homeDir?: string };
  selection?: unknown;
  sharedDirs?: string[];
  agentsMd?: { text: string; warnings?: string[] };
  profile?: { skillsCatalog?: boolean } | null;
}): DecorationBlocks {
  const cwd = input.cwd || process.cwd();
  const builtSkills = buildSkillPromptBlocks(cwd, input.skillOptions || {}, input.prompt || '', input.selection || null);
  // A delegation child does not inherit the global catalog; its explicitly
  // selected skills stay (see lib/context/delegation-context-profile.ts).
  const skills = input.profile?.skillsCatalog === false ? { ...builtSkills, catalog: '' } : builtSkills;
  const ruleParts: string[] = [];
  if (input.includeWorkspaceRules !== false) {
    const workspaceRules = buildWorkspaceAlwaysApplyRulesPrompt(cwd);
    if (workspaceRules) ruleParts.push(workspaceRules);
  }
  if (input.includeSharedRules !== false) {
    const sharedRules = buildSharedAlwaysApplyRulesPrompt(input.sharedDirs, {
      cwd,
      taskKind: input.taskKind,
      fileTypes: input.fileTypes,
    });
    if (sharedRules) ruleParts.push(sharedRules);
  }
  const combinedSkills = [skills.catalog, skills.selected].filter(Boolean).join('\n');
  // AGENTS.md sits after the catalog and before the rules; empty unless Cretli is the confirmed/forced channel.
  const agentsMdBlock = input.agentsMd?.text || '';
  const agentsPart = agentsMdBlock ? [agentsMdBlock] : [];
  return {
    staticBlock: [skills.catalog, ...agentsPart, ...ruleParts].filter(Boolean).join('\n\n'),
    legacyStaticBlock: [combinedSkills, ...agentsPart, ...ruleParts].filter(Boolean).join('\n\n'),
    coreStaticBlock: [skills.catalog, ...ruleParts].filter(Boolean).join('\n\n'),
    agentsMdBlock,
    agentsMdWarnings: input.agentsMd?.warnings || [],
    skillsBlock: skills.selected,
    selection: summarizeSkillSelection(skills.selectionResult, skills.selection),
  };
}

/**
 * Mode hint kept byte-identical to the previous behaviour.
 *
 * @param {{ skipPlanHint?: boolean, mode?: unknown, transport?: unknown }} input
 * @returns {string}
 */
function buildModeHint(input: { skipPlanHint?: boolean; mode?: unknown; transport?: unknown }): string {
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
export function buildVolatileDecorationBlocks(input: Record<string, any>, skillsBlock: string = ''): Record<string, string> {
  const hasReportContext = Object.prototype.hasOwnProperty.call(input, 'reportContext');
  return {
    [PROMPT_DECORATION_BLOCK.SKILLS]: String(skillsBlock || ''),
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
function composeDecoratedPrompt(parts: string[], prompt: string): string {
  const filtered = parts.filter(Boolean);
  if (filtered.length === 0) return prompt;
  return `${filtered.join('\n\n')}\n\n${prompt}`;
}

/**
 * Resolve how the static block is emitted for this turn. Delivery on every
 * turn is the fallback: `dedupe` needs an explicit `input.staticMode` (which
 * the send paths only set for adapters with a retention proof, see
 * `resolveInstructionDeliveryForTurn`), and harnesses without an observable
 * session identity can never dedupe.
 *
 * @param {Record<string, any>} input
 * @returns {string}
 */
function resolveDecorationStaticMode(input: Record<string, any>): 'dedupe' | 'always' {
  const transport = String(input.transport || '').trim().toLowerCase();
  if (transport && ALWAYS_STATIC_TRANSPORTS.has(transport)) {
    return PROMPT_DECORATION_STATIC_MODE.ALWAYS;
  }
  if (input.staticMode === PROMPT_DECORATION_STATIC_MODE.DEDUPE) {
    return PROMPT_DECORATION_STATIC_MODE.DEDUPE;
  }
  return PROMPT_DECORATION_STATIC_MODE.ALWAYS;
}

/**
 * Run the slim/dedup decision for one turn. Kept separate so both the non-SDK
 * and SDK entry points share the exact same policy.
 *
 * @param {string} prompt
 * @param {Record<string, any>} input
 * @param {{ staticBlock: string, legacyStaticBlock: string, skillsBlock: string }} blocks
 * @param {Record<string, string>} volatile
 * @returns {string}
 */
function applyDecorationDecision(
  prompt: string,
  input: Record<string, any>,
  blocks: DecorationBlocks,
  volatile: Record<string, string>
): string {
  const sessionKey = String(input.sessionKey || '').trim();
  // Without a session identity the caller opted out of dedup: keep the legacy
  // full-block behaviour so existing callers and tests are byte-identical.
  if (!sessionKey) {
    return composeStatelessDecoratedPrompt(blocks, volatile, prompt);
  }
  const previous = Object.prototype.hasOwnProperty.call(input, 'previousState')
    ? input.previousState
    : readPromptDecorationState(sessionKey);
  const decision = decidePromptDecoration(previous, {
    sessionKey,
    staticBlock: blocks.staticBlock,
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
export function resolvePromptDecorationSessionKey(room: any): string {
  const base = String(room?.sessionKey || room?.chatId || '').trim();
  if (!base) return '';
  const chatId = String(room?.chatId || '').trim();
  if (!chatId) return base;
  const restarts = Number(getContextRestartForChat(chatId)?.count) || 0;
  // The instruction epoch advances on new session, failed resume, reset,
  // compaction and trim, so each of those is a new decoration session.
  return `${base}#g${restarts}#${instructionEpochKey(room)}`;
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
 *   selection?: unknown,
 *   sessionKey?: string,
 *   staticMode?: 'dedupe' | 'always',
 *   previousState?: import('./prompt-decoration.ts').PromptDecorationState | null,
 *   onState?: (state: import('./prompt-decoration.ts').PromptDecorationState) => void,
 * }} [input]
 * @returns {string}
 */
export function applyHarnessOutboundPrompt(
  text: unknown,
  input: {
    cwd?: string;
    chatId?: string;
    mode?: string;
    transport?: string;
    skipPlanHint?: boolean;
    reportContext?: string;
    selection?: unknown;
    sessionKey?: string;
    staticMode?: 'dedupe' | 'always';
    previousState?: PromptDecorationState | null;
    onState?: (state: PromptDecorationState) => void;
  } = {}
): string {
  const prompt = String(text || '');
  const { blocks, volatile } = buildHarnessDecorationParts(prompt, input);
  return applyDecorationDecision(prompt, input, blocks, volatile);
}

/**
 * Exact decoration blocks the non-SDK send path builds for one turn: static
 * block (skills catalog + workspace rules + shared rules), the selected skills
 * and the volatile blocks. Exposed so the comparison mode can diff the
 * registry-based assembler against what is actually sent.
 *
 * @param {unknown} text
 * @param {Record<string, any>} [input] Same fields as `applyHarnessOutboundPrompt`,
 *   plus optional `skillOptions` / `sharedDirs` to pin the scanned roots.
 * @returns {{
 *   blocks: { staticBlock: string, legacyStaticBlock: string, skillsBlock: string },
 *   volatile: Record<string, string>,
 * }}
 */
export function buildHarnessDecorationParts(
  text: unknown,
  input: Record<string, any> = {}
): { blocks: DecorationBlocks; volatile: Record<string, string> } {
  const blocks = buildDecorationBlocks({
    cwd: input.cwd,
    prompt: String(text || ''),
    includeWorkspaceRules: true,
    includeSharedRules: true,
    taskKind: input.taskKind,
    fileTypes: input.fileTypes,
    skillOptions: input.skillOptions,
    selection: input.selection,
    sharedDirs: input.sharedDirs,
    profile: input.profile !== undefined ? input.profile : resolveChatContextProfile(input.chatId),
    agentsMd: buildAgentsMdBlockForTurn({
      cwd: input.cwd,
      chatId: input.chatId,
      transport: input.transport,
      projectRoot: input.projectRoot,
      contextSettings: input.contextSettings,
    }),
  });
  return { blocks, volatile: buildVolatileDecorationBlocks(input, blocks.skillsBlock) };
}

/**
 * Stateless (no session key) payload for given blocks: the legacy full-block
 * composition. This is what `apply*OutboundPrompt` returns without a session.
 *
 * @param {{ legacyStaticBlock: string }} blocks
 * @param {Record<string, string>} volatile
 * @param {string} prompt
 * @returns {string}
 */
export function composeStatelessDecoratedPrompt(
  blocks: { legacyStaticBlock: string },
  volatile: Record<string, string>,
  prompt: string
): string {
  const parts = [blocks.legacyStaticBlock, ...PROMPT_DECORATION_VOLATILE_ORDER.map((key) => volatile[key])];
  return composeDecoratedPrompt(parts, prompt);
}

/**
 * SDK harness variant: the SDK already loads workspace rules through its own
 * setting source, so its static block is skills + shared rules only, and the
 * automatic page context is a volatile block. Behaviour matches the previous
 * inline prefix in `cursor-agent-sdk-ws.ts`.
 *
 * @param {unknown} text
 * @param {{
 *   cwd?: string,
 *   chatId?: string,
 *   mode?: string,
 *   pageContext?: string,
 *   reportContext?: string,
 *   selection?: unknown,
 *   sessionKey?: string,
 *   previousState?: import('./prompt-decoration.ts').PromptDecorationState | null,
 *   onState?: (state: import('./prompt-decoration.ts').PromptDecorationState) => void,
 * }} [input]
 * @returns {string}
 */
export function applySdkHarnessOutboundPrompt(
  text: unknown,
  input: {
    cwd?: string;
    chatId?: string;
    mode?: string;
    pageContext?: string;
    reportContext?: string;
    selection?: unknown;
    sessionKey?: string;
    staticMode?: 'dedupe' | 'always';
    previousState?: PromptDecorationState | null;
    onState?: (state: PromptDecorationState) => void;
  } = {}
): string {
  const prompt = String(text || '');
  const { blocks, volatile } = buildSdkDecorationParts(prompt, input);
  return applyDecorationDecision(prompt, input, blocks, volatile);
}

/**
 * Volatile blocks of the SDK send path (see `buildSdkDecorationParts`).
 *
 * @param {Record<string, any>} input
 * @param {string} [skillsBlock]
 * @returns {Record<string, string>}
 */
export function buildSdkVolatileDecorationBlocks(input: Record<string, any>, skillsBlock: string = ''): Record<string, string> {
  const hasReportContext = Object.prototype.hasOwnProperty.call(input, 'reportContext');
  return {
    [PROMPT_DECORATION_BLOCK.SKILLS]: String(skillsBlock || ''),
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
}

/**
 * Exact decoration blocks the SDK send path builds for one turn. Kept separate
 * from `buildHarnessDecorationParts`: the SDK adds no workspace rules (its
 * setting source loads them) and no textual mode hint, but does add the
 * automatic page context.
 *
 * @param {unknown} text
 * @param {Record<string, any>} [input] Same fields as `applySdkHarnessOutboundPrompt`,
 *   plus optional `skillOptions` / `sharedDirs` to pin the scanned roots.
 * @returns {{
 *   blocks: { staticBlock: string, legacyStaticBlock: string, skillsBlock: string },
 *   volatile: Record<string, string>,
 * }}
 */
export function buildSdkDecorationParts(
  text: unknown,
  input: Record<string, any> = {}
): { blocks: DecorationBlocks; volatile: Record<string, string> } {
  const blocks = buildDecorationBlocks({
    cwd: input.cwd,
    prompt: String(text || ''),
    includeWorkspaceRules: false,
    includeSharedRules: true,
    taskKind: input.taskKind,
    fileTypes: input.fileTypes,
    skillOptions: input.skillOptions,
    selection: input.selection,
    sharedDirs: input.sharedDirs,
    profile: input.profile !== undefined ? input.profile : resolveChatContextProfile(input.chatId),
    agentsMd: buildAgentsMdBlockForTurn({
      cwd: input.cwd,
      chatId: input.chatId,
      transport: input.transport || 'sdk',
      projectRoot: input.projectRoot,
      contextSettings: input.contextSettings,
    }),
  });
  return { blocks, volatile: buildSdkVolatileDecorationBlocks(input, blocks.skillsBlock) };
}

/**
 * @param {any} room
 * @param {unknown} text
 * @param {string} transport
 * @param {{ skipPlanHint?: boolean, selection?: unknown }} [options] `selection`
 *   carries the explicit skill IDs / mention policy of this turn (see
 *   `lib/skills/skill-selection.js`); without it no skill is activated.
 * @returns {string}
 */
export function decorateHarnessPrompt(
  room: any,
  text: unknown,
  transport: string,
  options: { skipPlanHint?: boolean; selection?: unknown } = {}
): string {
  const collected = collectDelegationReportsForPrompt(room?.chatId);
  if (room) room._delegationReportIdsInPrompt = collected.ids;
  const sessionKey = resolvePromptDecorationSessionKey(room);
  const delivery = resolveInstructionDeliveryForTurn({
    room,
    cwd: room?.cwd,
    chatId: room?.chatId,
    transport,
  });
  const baseInput = {
    cwd: room?.cwd,
    chatId: room?.chatId,
    mode: room?.sdkMode,
    transport,
    skipPlanHint: options.skipPlanHint === true,
    reportContext: collected.text,
    // Without an explicit selection the turn uses the one stored on the room by
    // the runner (set per run, so a queued or retried prompt keeps its own).
    selection: options.selection ?? room?._activeSelection ?? null,
  };
  const sent = !room || !sessionKey
    ? applyHarnessOutboundPrompt(text, baseInput)
    : applyHarnessOutboundPrompt(text, {
      ...baseInput,
      sessionKey,
      staticMode: delivery.staticMode,
      previousState: room._promptDecorationState || null,
      onState: (state: PromptDecorationState) => {
        room._promptDecorationState = state;
      },
    });
  const recorded = recordOutboundContextManifest(
    { ...baseInput, prompt: String(text || ''), staticDelivery: delivery },
    'harness',
    sent
  );
  // Kept for the hard-window error message: sizes of what Cretli added last turn.
  if (room && recorded?.budget) room._lastContextBudget = recorded.budget;
  return sent;
}

/**
 * Record the context manifest of a real send (best effort, content-free).
 *
 * @param {Record<string, any>} input Assembler context of the send.
 * @param {'sdk' | 'harness'} adapterId
 * @param {string} sentPayload What actually went out.
 */
export function recordOutboundContextManifest(
  input: Record<string, any>,
  adapterId: 'sdk' | 'harness',
  sentPayload: string
): Record<string, any> | null {
  if (!input.chatId || !input.cwd) return null;
  return tryRecordContextSend({
    chatId: String(input.chatId),
    sendId: crypto.randomUUID(),
    context: input,
    adapterId,
    sentPayload,
  });
}
