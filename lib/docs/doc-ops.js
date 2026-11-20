import { DocsError } from './docs-state-store.js';

// Native filesystem errors include host paths; MCP must expose only domain messages.
const agentRead = (read) => async (svc, scope, args, chatId) => {
  try { return await read(svc, scope, args, chatId); }
  catch (error) {
    if (error instanceof DocsError) throw error;
    if (error.code === 'ENOENT') throw new DocsError('docs-not-found', 'Docs path does not exist', 404);
    throw new DocsError('docs-internal', 'Docs operation failed', 500);
  }
};

// Explicit argument projection keeps workspace selectors out of operation payloads.
const proposalOp = (kind) => ({
  run: agentRead((svc, scope, args, chatId) => svc.propose(scope, { kind, path: args.path, text: args.text, target: args.target }, 'agent', chatId)),
  http: (args) => ({ method: 'POST', path: `/api/docs/proposals/${kind}`, body: { path: args.path, text: args.text, target: args.target } }),
});
export const DOC_OPS = Object.freeze({
  propose_write: proposalOp('write'),
  propose_append: proposalOp('append'),
  propose_link: proposalOp('link'),
  list: {
    run: agentRead((svc, scope) => svc.tree(scope, 'agent')),
    http: () => ({ path: '/api/docs/tree', query: {} }),
  },
  read: {
    run: agentRead((svc, scope, a) => svc.read(scope, { path: a.path }, 'agent')),
    http: (a) => ({ path: '/api/docs/note', query: { path: a.path } }),
  },
  search: {
    run: agentRead((svc, scope, a) => svc.search(scope, { q: a.q, limit: a.limit }, 'agent')),
    http: (a) => ({ path: '/api/docs/search', query: { q: a.q, limit: a.limit } }),
  },
  backlinks: {
    run: agentRead((svc, scope, a) => svc.backlinks(scope, { path: a.path, target: a.target }, 'agent')),
    http: (a) => ({ path: '/api/docs/backlinks', query: { path: a.path, target: a.target } }),
  },
});
