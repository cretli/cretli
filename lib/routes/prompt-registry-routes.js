import { PROMPT_BLOCKS } from '../prompts/blocks.js';
import {
  MAX_OVERRIDE_CHARS,
  getPromptBlock,
  isHardPromptBlock,
  listPromptOverrides,
  resetPromptOverride,
  setPromptOverride,
} from '../prompts/overrides.js';
import { loadPromptOverrides, savePromptOverrides } from '../prompts/overrides-store.js';
import { PROMPT_BUDGET_CHARS, renderPromptPreviews } from '../prompts/preview.js';
import {
  invalidateMcpOperatorGuideCache,
  LOCKED_SAFETY_RULES,
  mcpOperatorPromptRegistry,
  previewMcpOperatorPrompts,
  validateMcpOperatorInstructionOverride,
} from '../mcp/mcp-external-guide.js';
import {
  MCP_INSTRUCTIONS_MAX_CHARS,
  decideMcpOperatorPromptProposal,
  listMcpOperatorPromptHistory,
  listMcpOperatorPromptProposals,
  resetMcpOperatorPromptOverride,
  setMcpOperatorPromptOverride,
} from '../mcp/mcp-operator-prompt-store.js';
import { listOperatorNotes, listOperatorSessions, resolveOperatorNote } from '../persist/operator-journal-persist.js';

/**
 * Settings API for the agent prompt registry: list blocks, preview the rendered
 * prompts (with size vs budget), save an override of an editable block and
 * reset it to the default. Hard blocks are listed read-only and never writable.
 *
 * @param {import('express').Express} app
 * @param {{ dataDir?: string }} [ctx]
 */
export function registerPromptRegistryRoutes(app, ctx = {}) {
  if (ctx.dataDir) loadPromptOverrides(ctx.dataDir);
  const persist = () => { if (ctx.dataDir) savePromptOverrides(ctx.dataDir); };

  app.get('/api/prompt-registry', (_req, res) => {
    const overrides = listPromptOverrides();
    const blocks = Object.entries(PROMPT_BLOCKS).map(([key, defaultText]) => ({
      key,
      hard: isHardPromptBlock(key),
      defaultText,
      text: getPromptBlock(key),
      overridden: Object.hasOwn(overrides, key),
    }));
    res.json({ ok: true, blocks, budget: PROMPT_BUDGET_CHARS, maxOverrideChars: MAX_OVERRIDE_CHARS });
  });

  app.get('/api/prompt-registry/preview', (_req, res) => {
    try {
      res.json({ ok: true, budget: PROMPT_BUDGET_CHARS, prompts: renderPromptPreviews() });
    } catch (err) {
      res.status(500).json({ ok: false, code: 'PREVIEW_FAILED', error: String(err?.message || err) });
    }
  });

  app.put('/api/prompt-registry/blocks/:key', (req, res) => {
    const result = /** @type {{ ok: boolean, status?: number, code?: string, error?: string }} */ (
      setPromptOverride(String(req.params?.key || ''), req.body?.text)
    );
    if (!result.ok) return res.status(result.status || 400).json({ ok: false, code: result.code, error: result.error });
    persist();
    return res.json({ ok: true, key: req.params.key, text: getPromptBlock(req.params.key) });
  });

  app.delete('/api/prompt-registry/blocks/:key', (req, res) => {
    const result = resetPromptOverride(String(req.params?.key || ''));
    if (!result.ok) return res.status(result.status).json({ ok: false, code: result.code, error: result.error });
    persist();
    return res.json({ ok: true, key: req.params.key, text: getPromptBlock(req.params.key) });
  });

  const workspaceOf = (req) => String(req.query?.workspaceFolder || req.body?.workspaceFolder || '').trim();
  const fail = (res, error) => {
    const code = error?.code || 'INTERNAL_ERROR';
    const status = code === 'NOT_FOUND' ? 404 : code === 'CONFLICT' ? 409 : code === 'VALIDATION_ERROR' ? 400 : 500;
    return res.status(status).json({ ok: false, code, error: String(error?.message || error) });
  };

  app.get('/api/prompt-registry/mcp-operator', (req, res) => {
    try {
      const workspaceFolder = workspaceOf(req);
      res.json({
        ok: true,
        workspaceFolder,
        blocks: mcpOperatorPromptRegistry(workspaceFolder, { dataDir: ctx.dataDir }),
        lockedSafetyRules: LOCKED_SAFETY_RULES,
        previews: previewMcpOperatorPrompts(workspaceFolder, { dataDir: ctx.dataDir }),
        history: listMcpOperatorPromptHistory(workspaceFolder, { dataDir: ctx.dataDir }),
        proposals: listMcpOperatorPromptProposals(workspaceFolder, { dataDir: ctx.dataDir }),
        maxInstructionsChars: MCP_INSTRUCTIONS_MAX_CHARS,
        journal: listOperatorNotes(workspaceFolder, { dataDir: ctx.dataDir }),
        operatorSessions: listOperatorSessions(workspaceFolder, { dataDir: ctx.dataDir }),
      });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/prompt-registry/mcp-operator/notes/:id/resolve', (req, res) => {
    try {
      const workspaceFolder = workspaceOf(req);
      const note = listOperatorNotes(workspaceFolder, { dataDir: ctx.dataDir }).find((row) => row.id === req.params.id);
      if (!note || note.kind !== 'question') return res.status(404).json({ ok: false, code: 'NOT_FOUND', error: 'Open operator question not found' });
      return res.json({ ok: true, note: resolveOperatorNote(workspaceFolder, req.params.id, { dataDir: ctx.dataDir }) });
    } catch (error) { return fail(res, error); }
  });

  app.put('/api/prompt-registry/mcp-operator/:key', (req, res) => {
    try {
      const workspaceFolder = workspaceOf(req);
      const key = String(req.params?.key || '');
      const validation = validateMcpOperatorInstructionOverride(workspaceFolder, key, req.body?.text, { dataDir: ctx.dataDir });
      if (!validation.ok) return res.status(400).json({ ok: false, code: 'VALIDATION_ERROR', error: validation.error });
      const result = setMcpOperatorPromptOverride(workspaceFolder, key, req.body?.text, { dataDir: ctx.dataDir });
      invalidateMcpOperatorGuideCache(workspaceFolder);
      return res.json({ ok: true, ...result });
    } catch (error) {
      return fail(res, error);
    }
  });

  app.delete('/api/prompt-registry/mcp-operator/:key', (req, res) => {
    try {
      const workspaceFolder = workspaceOf(req);
      const result = resetMcpOperatorPromptOverride(workspaceFolder, String(req.params?.key || ''), { dataDir: ctx.dataDir });
      invalidateMcpOperatorGuideCache(workspaceFolder);
      return res.json({ ok: true, ...result });
    } catch (error) {
      return fail(res, error);
    }
  });

  app.post('/api/prompt-registry/mcp-operator/proposals/:id/decision', (req, res) => {
    try {
      const workspaceFolder = workspaceOf(req);
      const proposal = listMcpOperatorPromptProposals(workspaceFolder, { dataDir: ctx.dataDir }).find((row) => row.id === req.params.id);
      if (!proposal) return res.status(404).json({ ok: false, code: 'NOT_FOUND', error: 'Proposal not found' });
      if (req.body?.approve === true) {
        const validation = validateMcpOperatorInstructionOverride(workspaceFolder, proposal.promptKey, proposal.text, { dataDir: ctx.dataDir });
        if (!validation.ok) return res.status(400).json({ ok: false, code: 'VALIDATION_ERROR', error: validation.error });
      }
      const result = decideMcpOperatorPromptProposal(workspaceFolder, String(req.params.id || ''), req.body?.approve === true, { dataDir: ctx.dataDir });
      invalidateMcpOperatorGuideCache(workspaceFolder);
      return res.json({ ok: true, ...result });
    } catch (error) {
      return fail(res, error);
    }
  });
}
