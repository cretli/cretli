/**
 * Numeric-only context breakdown built from the Claude Agent SDK
 * `query.getContextUsage()` response. Only token counts and block counts are
 * kept; file paths, tool names and prompt text never leave this module.
 */

const BREAKDOWN_TIMEOUT_MS = 5000;

function tokens(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function sumTokens(list) {
  if (!Array.isArray(list) || !list.length) return null;
  return list.reduce((sum, item) => sum + (tokens(item?.tokens) ?? 0), 0);
}

/** Some blocks are only exposed as a named category row; match them by name as a fallback. */
function sumNamed(categories, pattern) {
  const matching = categories.filter((entry) => typeof entry?.name === 'string' && pattern.test(entry.name));
  return matching.length ? sumTokens(matching) : null;
}

function row(id, value, count = null) {
  const amount = tokens(value);
  return { id, tokens: amount, count: amount != null && count > 0 ? count : null, estimated: true };
}

/**
 * Map an SDK context usage response onto the shared breakdown categories.
 * @param {object|null|undefined} usage `SDKControlGetContextUsageResponse`
 * @returns {{ breakdown: object, totalTokens: number|null, contextWindowTokens: number|null, model: string }|null}
 */
export function buildClaudeContextBreakdown(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const categories = Array.isArray(usage.categories) ? usage.categories : [];
  const sumKind = (kind) => {
    const matching = categories.filter((entry) => entry?.kind === kind);
    return matching.length ? sumTokens(matching) : null;
  };
  const message = usage.messageBreakdown && typeof usage.messageBreakdown === 'object' ? usage.messageBreakdown : null;
  const plainMessages = message
    ? [message.assistantMessageTokens, message.userMessageTokens, message.attachmentTokens,
      message.redirectedContextTokens, message.unattributedTokens]
      .reduce((sum, value) => sum + (tokens(value) ?? 0), 0)
    : null;
  const deferredBuiltin = sumTokens(usage.deferredBuiltinTools);
  const deferredKind = sumKind('deferred');
  const loadedMcp = Array.isArray(usage.mcpTools) ? usage.mcpTools.filter((tool) => tool?.isLoaded !== false) : [];
  const rows = [
    row('messages', plainMessages, null),
    row('toolCalls', message?.toolCallTokens, null),
    row('toolResults', message?.toolResultTokens, null),
    row('systemPrompt', sumTokens(usage.systemPromptSections), usage.systemPromptSections?.length),
    row('systemTools', sumTokens(usage.systemTools), usage.systemTools?.length),
    row('mcpTools', sumTokens(loadedMcp), loadedMcp.length),
    row('memory', sumTokens(usage.memoryFiles), usage.memoryFiles?.length),
    row('skills', usage.skills?.tokens, usage.skills?.includedSkills),
    row('instructions', usage.slashCommands?.tokens, usage.slashCommands?.includedCommands),
    row('agents', sumTokens(usage.agents), usage.agents?.length),
    row('compactBuffer', sumKind('buffer'), null),
    row('deferredTools', deferredKind ?? deferredBuiltin, null),
    // Claude folds thinking into assistant messages, so there is no separate reasoning row.
    { id: 'reasoning', tokens: null, count: null, estimated: false },
    row('mcpInstructions', sumNamed(categories, /mcp.*instruction/i), null),
  ];
  return {
    breakdown: {
      version: 1, source: 'claude-sdk-context', scope: 'context-window',
      estimated: true, complete: true, caughtUp: true, observedAt: null, rows,
    },
    totalTokens: tokens(usage.totalTokens),
    contextWindowTokens: tokens(usage.maxTokens),
    model: typeof usage.model === 'string' ? usage.model : '',
  };
}

/**
 * Ask a live streaming query for its breakdown without ever blocking a run.
 * @param {{ getContextUsage?: Function }|null|undefined} query
 * @returns {Promise<ReturnType<typeof buildClaudeContextBreakdown>>}
 */
export async function readClaudeContextBreakdown(query) {
  if (typeof query?.getContextUsage !== 'function') return null;
  let timer;
  try {
    const response = await Promise.race([
      query.getContextUsage({ detail: 'summary' }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), BREAKDOWN_TIMEOUT_MS); }),
    ]);
    return buildClaudeContextBreakdown(response);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
