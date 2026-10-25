/**
 * Numeric-only context breakdown built from the Claude Agent SDK
 * `query.getContextUsage()` response. Only token counts and block counts are
 * kept; file paths, tool names and prompt text never leave this module.
 */

const BREAKDOWN_TIMEOUT_MS = 5000;

/** Loose view of `SDKControlGetContextUsageResponse` (only the fields read here). */
interface TokenEntry { tokens?: unknown; name?: unknown; kind?: unknown; isLoaded?: unknown }
interface ContextUsageResponse {
  categories?: unknown;
  messageBreakdown?: {
    assistantMessageTokens?: unknown;
    userMessageTokens?: unknown;
    attachmentTokens?: unknown;
    redirectedContextTokens?: unknown;
    unattributedTokens?: unknown;
    toolCallTokens?: unknown;
    toolResultTokens?: unknown;
  } | null;
  deferredBuiltinTools?: unknown;
  mcpTools?: unknown;
  systemPromptSections?: unknown[] | null;
  systemTools?: unknown[] | null;
  memoryFiles?: unknown[] | null;
  skills?: { tokens?: unknown; includedSkills?: number } | null;
  slashCommands?: { tokens?: unknown; includedCommands?: number } | null;
  agents?: unknown[] | null;
  totalTokens?: unknown;
  maxTokens?: unknown;
  model?: unknown;
}

export interface ClaudeContextBreakdownRow {
  id: string;
  tokens: number | null;
  count: number | null;
  estimated: boolean;
}

export interface ClaudeContextBreakdownResult {
  breakdown: object;
  totalTokens: number | null;
  contextWindowTokens: number | null;
  model: string;
}

function tokens(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function sumTokens(list: unknown): number | null {
  if (!Array.isArray(list) || !list.length) return null;
  return list.reduce((sum: number, item: TokenEntry | null | undefined) => sum + (tokens(item?.tokens) ?? 0), 0);
}

/** Some blocks are only exposed as a named category row; match them by name as a fallback. */
function sumNamed(categories: TokenEntry[], pattern: RegExp): number | null {
  const matching = categories.filter((entry) => typeof entry?.name === 'string' && pattern.test(String(entry.name)));
  return matching.length ? sumTokens(matching) : null;
}

function row(id: string, value: unknown, count: number | null | undefined = null): ClaudeContextBreakdownRow {
  const amount = tokens(value);
  return { id, tokens: amount, count: amount != null && count != null && count > 0 ? count : null, estimated: true };
}

/**
 * Map an SDK context usage response onto the shared breakdown categories.
 * @param usage `SDKControlGetContextUsageResponse`
 */
export function buildClaudeContextBreakdown(usage: ContextUsageResponse | null | undefined): ClaudeContextBreakdownResult | null {
  if (!usage || typeof usage !== 'object') return null;
  const categories: TokenEntry[] = Array.isArray(usage.categories) ? usage.categories : [];
  const sumKind = (kind: string): number | null => {
    const matching = categories.filter((entry) => entry?.kind === kind);
    return matching.length ? sumTokens(matching) : null;
  };
  const message = usage.messageBreakdown && typeof usage.messageBreakdown === 'object' ? usage.messageBreakdown : null;
  const plainMessages = message
    ? [message.assistantMessageTokens, message.userMessageTokens, message.attachmentTokens,
      message.redirectedContextTokens, message.unattributedTokens]
      .reduce((sum: number, value) => sum + (tokens(value) ?? 0), 0)
    : null;
  const deferredBuiltin = sumTokens(usage.deferredBuiltinTools);
  const deferredKind = sumKind('deferred');
  const loadedMcp = Array.isArray(usage.mcpTools) ? usage.mcpTools.filter((tool: TokenEntry | null) => tool?.isLoaded !== false) : [];
  const rows: ClaudeContextBreakdownRow[] = [
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
 */
export async function readClaudeContextBreakdown(
  query: { getContextUsage?: (options: { detail: string }) => unknown } | null | undefined,
): Promise<ClaudeContextBreakdownResult | null> {
  if (typeof query?.getContextUsage !== 'function') return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      query.getContextUsage({ detail: 'summary' }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), BREAKDOWN_TIMEOUT_MS); }),
    ]);
    return buildClaudeContextBreakdown(response as ContextUsageResponse | null | undefined);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
