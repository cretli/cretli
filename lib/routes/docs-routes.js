import { isAgentSessionRequest } from '../auth.js';
import { isHumanDecisionRequest } from './decisions-routes.js';
import { DocsError } from '../docs/docs-state-store.js';
import { getDocsService } from '../docs/docs-service.js';

function scopeOf(req, actor) {
  if (actor === 'agent') {
    // Login agent cookies carry no workspace binding; query parameters cannot supply one.
    const bound = req.mcpIntegration;
    if (!bound || !(bound.workspaceId || bound.workspaceFile || bound.workspaceFolder)) {
      throw new DocsError('docs-agent-scope-required', 'A workspace-bound MCP session is required', 403);
    }
    return { workspaceId: bound.workspaceId || '', workspaceFile: bound.workspaceFile || '', workspaceFolder: bound.workspaceFolder || '' };
  }
  return Object.fromEntries(['workspaceUuid', 'workspaceId', 'workspaceFile', 'workspaceFolder']
    .map((key) => [key, String(req.query?.[key] || req.body?.[key] || '').trim()]));
}

export function registerDocsRoutes(app, { dataDir }) {
  const svc = () => getDocsService(dataDir);
  const wrap = (mutating, handler) => async (req, res) => {
    try {
      if (mutating === true && !isHumanDecisionRequest(req)) throw new DocsError('docs-human-required', 'A human session is required', 403);
      if (mutating === 'proposal' && (!req.mcpIntegration?.chatId || req.widgetAccess)) throw new DocsError('docs-agent-required', 'A workspace-bound agent chat is required', 403);
      const actor = req.mcpIntegration || req.widgetAccess || isAgentSessionRequest(req) ? 'agent' : 'human';
      const args = mutating ? { ...req.body, ...req.params } : req.query || {};
      return res.json({ ok: true, ...await handler(svc(), scopeOf(req, actor), args, actor, req.mcpIntegration?.chatId) });
    } catch (error) {
      if (error instanceof DocsError) return res.status(error.status).json({ ok: false, code: error.code, error: error.message, details: error.details });
      if (error.code === 'ENOENT') return res.status(404).json({ ok: false, code: 'docs-not-found', error: 'Docs path does not exist' });
      if (error.code === 'EEXIST') return res.status(409).json({ ok: false, code: 'docs-exists', error: 'Docs path already exists' });
      return res.status(500).json({ ok: false, code: 'docs-internal', error: 'Docs operation failed' });
    }
  };
  app.get('/api/docs/proposals', wrap(false, (s, scope, _args, actor) => s.proposals(scope, actor)));
  for (const kind of ['write', 'append', 'link']) {
    app.post(`/api/docs/proposals/${kind}`, wrap('proposal', (s, scope, args, actor, chatId) =>
      s.propose(scope, { kind, path: args.path, text: args.text, target: args.target }, actor, chatId)));
  }
  app.get('/api/docs/config', wrap(false, (s, scope, _args, actor) => s.config(scope, actor)));
  app.put('/api/docs/config', wrap(true, (s, scope, args, actor) => s.setConfig(scope, args, actor)));
  app.post('/api/docs/consent', wrap(true, (s, scope, args, actor) => s.consent(scope, args, actor)));
  app.delete('/api/docs/consent', wrap(true, (s, scope, args, actor) => s.consent(scope, args, actor, true)));
  app.get('/api/docs/tree', wrap(false, (s, scope, _args, actor) => s.tree(scope, actor)));
  app.get('/api/docs/note', wrap(false, (s, scope, args, actor) => s.read(scope, args, actor)));
  app.get('/api/docs/search', wrap(false, (s, scope, args, actor) => s.search(scope, args, actor)));
  app.get('/api/docs/backlinks', wrap(false, (s, scope, args, actor) => s.backlinks(scope, args, actor)));
  app.get('/api/docs/links', wrap(false, (s, scope, args, actor) => s.links(scope, args, actor)));
  app.post('/api/docs/links', wrap(true, (s, scope, args, actor) => s.addLink(scope, args, actor)));
  app.delete('/api/docs/links/:id', wrap(true, (s, scope, args, actor) => s.changeLink(scope, args, actor)));
  app.post('/api/docs/links/:id/resolve', wrap(true, (s, scope, args, actor) => s.changeLink(scope, args, actor, true)));
  app.post('/api/docs/note', wrap(true, (s, scope, args, actor) => s.write(scope, args, actor, true)));
  app.put('/api/docs/note', wrap(true, (s, scope, args, actor) => s.write(scope, args, actor)));
  app.post('/api/docs/note/rename', wrap(true, (s, scope, args, actor) => s.rename(scope, args, actor)));
  app.delete('/api/docs/note', wrap(true, (s, scope, args, actor) => s.remove(scope, args, actor)));
}
