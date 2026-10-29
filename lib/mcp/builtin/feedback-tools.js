/**
 * Builtin Cretli MCP `cretli_feedback` tool: a create-only channel for clients
 * to report a bug, a missing tool, an idea or a docs gap.
 *
 * Registered in `catalog.js` and opened by name in every mode
 * (`MCP_PLAN_MODE_OPEN_TOOLS`): it writes only a new report through a
 * create-only store, rate limited and with secrets redacted.
 */

import { submitFeedback, FEEDBACK_KINDS, FEEDBACK_LIMITS, FEEDBACK_SEVERITIES } from '../../persist/feedback-store.js';
import fs from 'node:fs';
import path from 'node:path';
import { createSlidingWindowLimiter } from '../mcp-external-audit.js';
import { listAllMcpSecretValues } from '../mcp-secrets.js';
import { resolveDataPath } from '../../runtime-paths.js';
import { getBuiltinMcpRuntimeDeps } from './runtime-deps.js';
import { mcpToolResult } from './result.js';
import { CretliMcpToolError, MCP_BUILTIN_ERROR_CODES } from './errors.js';

/**
 * @returns {string}
 */
function feedbackDataDir() {
  return String(getBuiltinMcpRuntimeDeps()?.dataDir || '').trim() || resolveDataPath();
}

/** Internal agents: per chat. External MCP clients: per client. */
export const FEEDBACK_RATE_LIMITS = Object.freeze({
  internal: Object.freeze({ limit: 10, windowMs: 10 * 60_000 }),
  external: Object.freeze({ limit: 20, windowMs: 60 * 60_000 }),
});
export const FEEDBACK_AUDIT_FILE = 'mcp-feedback-audit.jsonl';

const internalLimiter = createSlidingWindowLimiter(() => FEEDBACK_RATE_LIMITS.internal.limit, FEEDBACK_RATE_LIMITS.internal.windowMs);
const externalLimiter = createSlidingWindowLimiter(() => FEEDBACK_RATE_LIMITS.external.limit, FEEDBACK_RATE_LIMITS.external.windowMs);

/** Reset the in-memory windows (tests). */
export function resetFeedbackRateLimits() {
  internalLimiter.clear();
  externalLimiter.clear();
}

/**
 * Argument-free audit: client, time, outcome and report id only — never report text.
 *
 * @param {{ client: string, at: string, outcome: string, id?: string }} entry
 */
function auditFeedbackCall(entry) {
  try {
    const file = path.join(feedbackDataDir(), FEEDBACK_AUDIT_FILE);
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch (err) {
    console.warn(`[mcp-feedback] audit write failed: ${err instanceof Error ? err.message : err}`);
  }
}

/** @returns {string[]} */
function storedSecretValues() {
  try {
    return listAllMcpSecretValues();
  } catch {
    return [];
  }
}

/**
 * Metadata is collected by the server from the session, never taken from args.
 *
 * @param {Record<string, any>} session
 * @param {Record<string, any>} [client]
 */
function collectSource(session, client) {
  return {
    harness: String(session?.harness || '').trim(),
    client: String(client?.name || client?.clientName || session?.clientName || '').trim(),
    mode: String(session?.mode || '').trim(),
    workspace: String(session?.workspaceFolder || process.env.CRETLI_MCP_WORKSPACE || '').trim(),
    chatId: String(session?.chatId || '').trim(),
    at: new Date().toISOString(),
  };
}

export const FEEDBACK_MCP_TOOL = Object.freeze({
  name: 'cretli_feedback',
  readOnly: false,
  description: 'Report a bug, a missing tool, an idea or a docs gap to the Cretli maintainers. Creates (or bumps a duplicate of) an idea in the "Zgłoszenia z MCP" backlog. Create-only: it cannot read or change any other todo.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      kind: { type: 'string', enum: [...FEEDBACK_KINDS], description: 'Report type.' },
      tool: { type: 'string', maxLength: FEEDBACK_LIMITS.tool, description: 'Related tool name, if any.' },
      summary: { type: 'string', maxLength: FEEDBACK_LIMITS.summary, description: 'One-line summary.' },
      details: { type: 'string', maxLength: FEEDBACK_LIMITS.details, description: 'What happened / what is needed.' },
      repro: { type: 'string', maxLength: FEEDBACK_LIMITS.repro, description: 'Steps to reproduce.' },
      severity: { type: 'string', enum: [...FEEDBACK_SEVERITIES], description: 'Impact.' },
    },
    required: ['kind', 'summary'],
  },
  /**
   * @param {Record<string, any>} args
   * @param {{ session?: Record<string, any>, client?: Record<string, any>, now?: number }} [ctx] `now` injects the clock
   */
  async handler(args, { session = {}, client, now = Date.now() } = {}) {
    const source = collectSource(session, client);
    // The runtime always passes a (possibly empty) builtin client object, so its mere presence says
    // nothing: external callers are recognised by a named client or the `external:<id>` session.
    const sessionId = String(session?.sessionId || '');
    const externalSession = sessionId.startsWith('external:');
    const external = Boolean(client?.name || client?.clientName) || externalSession;
    const who = external
      ? source.client || (externalSession ? sessionId.slice('external:'.length) : '') || 'external'
      : source.chatId || 'unknown';
    const auditClient = `${external ? 'client' : 'chat'}:${who}`;
    const limiter = external ? externalLimiter : internalLimiter;
    if (!limiter.consume(who, 1, now)) {
      auditFeedbackCall({ client: auditClient, at: source.at, outcome: 'rate_limited' });
      const cfg = external ? FEEDBACK_RATE_LIMITS.external : FEEDBACK_RATE_LIMITS.internal;
      throw new CretliMcpToolError(
        MCP_BUILTIN_ERROR_CODES.CONFLICT,
        `Feedback rate limit reached (${cfg.limit} reports per ${Math.round(cfg.windowMs / 60_000)} minutes); try again later`,
        { reason: 'feedback_rate_limit' },
      );
    }
    try {
      const result = await submitFeedback(feedbackDataDir(), args, source, { secrets: storedSecretValues() });
      auditFeedbackCall({ client: auditClient, at: source.at, outcome: result.action, id: result.id });
      const text = result.action === 'duplicate'
        ? `Duplicate of an open report ${result.id}; counter is now ${result.count}`
        : `Filed report ${result.id}${result.previousId ? ` (follows closed report ${result.previousId})` : ''}`;
      return mcpToolResult(text, { ok: true, ...result });
    } catch (err) {
      auditFeedbackCall({ client: auditClient, at: source.at, outcome: 'error' });
      const code = /** @type {any} */ (err)?.code;
      if (code === 'VALIDATION') {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, /** @type {Error} */ (err).message);
      }
      if (code === 'LIMIT') {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.CONFLICT, /** @type {Error} */ (err).message, { reason: 'feedback_limit' });
      }
      throw err;
    }
  },
});

export const FEEDBACK_MCP_TOOLS = Object.freeze([FEEDBACK_MCP_TOOL]);
