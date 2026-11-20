/**
 * Initiatives service: workspace scoping, actor policy and the Todo/Decision bridge on top of the worker store
 * (lib/storage/initiatives-store.js). Routes and MCP tools are thin wrappers over this module.
 *
 * Authority stays where it is: linking a Todo or Decision never changes its parent, status, plan or review, and
 * the only Todo the service creates is an `idea` through the dedicated create-from-initiative operation.
 */
import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson } from '../storage/command-receipts.js';
import { openInitiativesRuntime } from '../persist/initiatives-runtime.js';
import {
  ACTORS, AGENT_STATUSES, InitiativeError, LINK_KINDS, RELATION_TYPES, RESEARCH_KINDS, STRATEGIC_FIELDS, normalizeInitiativeFields,
  requiresSignal,
} from './constants.js';

/** Relation types an agent may add; hard dependencies and hierarchy are direction decisions. */
const AGENT_RELATION_TYPES = Object.freeze(['supports', 'alternative_to']);

/** @param {unknown} value */
const digestOf = (value) => createHash('sha256').update(canonicalJson(value)).digest('hex');

/** @param {unknown} actor */
function assertActor(actor) {
  if (!ACTORS.includes(/** @type {any} */ (actor))) throw new InitiativeError('validation', 'Unknown actor');
  return /** @type {string} */ (actor);
}

/** Maps a worker refusal to a typed domain error; anything else is rethrown. */
function mapStoreError(error) {
  const kind = error?.details?.conflictKind;
  if (typeof kind === 'string' && kind.startsWith('initiative_')) {
    const code = kind.slice('initiative_'.length);
    throw new InitiativeError(code === 'not_found' ? 'not_found' : code, `Initiatives: ${code}`, error.details);
  }
  throw error;
}

/**
 * Default workspace resolver: server-side settings + registry, never a free-form workspaceId from the payload.
 * Returns `{ workspaceUuid, homeFolder }`; an unregistered folder or an ambiguous one is `workspace_required`.
 *
 * @param {string} dataDir
 * @param {Record<string, any>} input
 */
export async function resolveInitiativeScopeDefault(dataDir, input) {
  const [{ resolveTodoHomeFromSettings }, { resolveWorkspaceRef }] = await Promise.all([
    import('../todo-home.js'), import('../persist/workspaces-store.js'),
  ]);
  const ref = String(input?.workspaceUuid || input?.workspaceId || '').trim();
  const home = resolveTodoHomeFromSettings({
    workspaceId: ref || String(input?.workspaceFile || ''), workspaceFolder: ref ? '' : String(input?.workspaceFolder || ''),
  });
  if (!home.ok || home.source !== 'workspace' || !home.workspaceId) {
    throw new InitiativeError('workspace_required', 'A registered workspace is required', { cause: home.ok ? 'unregistered-folder' : /** @type {any} */ (home).code });
  }
  const resolved = resolveWorkspaceRef(dataDir, home.workspaceId);
  if (!resolved) throw new InitiativeError('workspace_required', 'Workspace is not in the registry');
  return { workspaceUuid: resolved.uuid, homeFolder: home.homeFolder };
}

/**
 * @param {{
 *   dataDir: string,
 *   controlDir?: string,
 *   resolveScope?: (dataDir: string, input: Record<string, any>) => Promise<{ workspaceUuid: string, homeFolder: string }>,
 *   todoApi?: { getTodo: Function, listTodos: Function, addTodo: Function },
 *   decisionApi?: { getDecision: Function },
 *   now?: () => string,
 *   hostOptions?: Record<string, unknown>,
 * }} options
 */
export function createInitiativesService(options) {
  const { dataDir } = options;
  const resolveScope = options.resolveScope || resolveInitiativeScopeDefault;
  const now = options.now || (() => new Date().toISOString());
  let opening = null;
  const runtime = () => {
    if (!opening) {
      opening = openInitiativesRuntime({ dataDir, controlDir: options.controlDir, hostOptions: options.hostOptions });
      opening.catch(() => { opening = null; });
    }
    return opening;
  };
  const store = async () => (await runtime()).store;
  const todoApi = async () => options.todoApi || (await import('../persist/todos-store.js'));
  const decisionApi = async () => options.decisionApi || (await import('../decisions/decision-store.js'));
  const cmd = (prefix) => `${prefix}-${randomUUID()}`;

  /** @param {Record<string, any>} input */
  async function scopeOf(input) {
    return resolveScope(dataDir, input || {});
  }

  /** Runs a store call and maps refusals; a CAS miss becomes a typed `revision_conflict`. */
  async function guarded(fn) {
    try { return await fn(); } catch (error) { return mapStoreError(error); }
  }

  /** @param {Record<string, any>} result */
  function casResult(result) {
    if (result.row) return result.row;
    throw new InitiativeError(result.conflict === 'archived' ? 'archived' : 'revision_conflict', 'Initiative changed or is archived', { current: result.current });
  }

  async function mustGet(workspaceUuid, id) {
    const { row } = await (await store()).get({ workspaceUuid, id });
    if (!row) throw new InitiativeError('not_found', 'Initiative not found', { id });
    return row;
  }

  return {
    resolveScope: scopeOf,
    runtime,

    async create(scopeInput, input, { actor, idempotencyKey } = /** @type {Record<string, any>} */ ({})) {
      assertActor(actor);
      if (!idempotencyKey || typeof idempotencyKey !== 'string') throw new InitiativeError('validation', 'idempotencyKey is required');
      const { workspaceUuid } = await scopeOf(scopeInput);
      const fields = normalizeInitiativeFields(input, { full: true });
      if (actor === 'agent') {
        if (!AGENT_STATUSES.includes(fields.status)) throw new InitiativeError('forbidden', 'An agent may only create draft or exploring initiatives');
      }
      const id = randomUUID();
      const result = await guarded(async () => (await store()).create({
        commandId: cmd('init-create'), workspaceUuid, actor, now: now(), id, idempotencyKey: idempotencyKey.slice(0, 200), digest: digestOf(fields), fields,
      }));
      return { initiative: result.row, created: result.created, workspaceRevision: result.revision };
    },

    async get(scopeInput, id) {
      const { workspaceUuid } = await scopeOf(scopeInput);
      return mustGet(workspaceUuid, id);
    },

    async list(scopeInput, query = {}) {
      const { workspaceUuid } = await scopeOf(scopeInput);
      return guarded(async () => (await store()).list({ workspaceUuid, ...query }));
    },

    async update(scopeInput, id, patch, { expectedRevision, actor, reason } = /** @type {Record<string, any>} */ ({})) {
      assertActor(actor);
      const { workspaceUuid } = await scopeOf(scopeInput);
      const fields = normalizeInitiativeFields(patch, { full: false });
      if (Object.keys(fields).length === 0) throw new InitiativeError('validation', 'Empty patch');
      if (actor === 'agent') {
        const current = await mustGet(workspaceUuid, id);
        const strategic = Object.keys(fields).filter((k) => STRATEGIC_FIELDS.includes(k));
        const accepted = !AGENT_STATUSES.includes(current.status);
        if ((strategic.length && accepted) || (fields.status && !AGENT_STATUSES.includes(fields.status))) {
          throw new InitiativeError('forbidden', 'An agent proposes strategic changes; a human applies them', { fields: strategic });
        }
      }
      const result = await guarded(async () => (await store()).update({
        commandId: cmd('init-update'), workspaceUuid, actor, now: now(), id, expectedRevision, patch: fields, reason,
      }));
      return { initiative: casResult(result), workspaceRevision: result.revision };
    },

    async archive(scopeInput, id, { expectedRevision, archived = true, actor } = /** @type {Record<string, any>} */ ({})) {
      if (assertActor(actor) !== 'human') throw new InitiativeError('forbidden', 'Archiving is a human action');
      const { workspaceUuid } = await scopeOf(scopeInput);
      const result = await guarded(async () => (await store()).archive({
        commandId: cmd('init-archive'), workspaceUuid, actor, now: now(), id, expectedRevision, archived: archived !== false,
      }));
      return { initiative: casResult(result), workspaceRevision: result.revision };
    },

    async history(scopeInput, id, query = {}) {
      const { workspaceUuid } = await scopeOf(scopeInput);
      return guarded(async () => (await store()).history({ workspaceUuid, initiativeId: id, ...query }));
    },

    async addRelation(scopeInput, { type, fromId, toId }, { actor } = /** @type {Record<string, any>} */ ({})) {
      assertActor(actor);
      if (!RELATION_TYPES.includes(type)) throw new InitiativeError('validation', 'Unknown relation type');
      if (actor === 'agent' && !AGENT_RELATION_TYPES.includes(type)) throw new InitiativeError('forbidden', 'An agent may only add supports / alternative_to');
      const { workspaceUuid } = await scopeOf(scopeInput);
      return guarded(async () => (await store()).addRelation({
        commandId: cmd('init-rel'), workspaceUuid, actor, now: now(), relationId: randomUUID(), type, fromId, toId,
      }));
    },

    async removeRelation(scopeInput, relationId, { actor } = /** @type {Record<string, any>} */ ({})) {
      if (assertActor(actor) !== 'human') throw new InitiativeError('forbidden', 'Removing a relation is a human action');
      const { workspaceUuid } = await scopeOf(scopeInput);
      return guarded(async () => (await store()).removeRelation({ commandId: cmd('init-relrm'), workspaceUuid, actor, now: now(), relationId }));
    },

    async relations(scopeInput, id) {
      const { workspaceUuid } = await scopeOf(scopeInput);
      return guarded(async () => (await store()).relations({ workspaceUuid, initiativeId: id }));
    },

    /** Planning signal of `requires` edges; `unknown` when a required record cannot be read. */
    async requiresSignalOf(scopeInput, id) {
      const { workspaceUuid } = await scopeOf(scopeInput);
      const s = await store();
      const { items } = await s.relations({ workspaceUuid, initiativeId: id });
      const deps = [];
      for (const rel of items.filter((r) => r.type === 'requires' && r.fromId === id)) {
        deps.push((await s.get({ workspaceUuid, id: rel.toId })).row);
      }
      return requiresSignal(deps);
    },

    async graphSlice(scopeInput, query = {}) {
      const { workspaceUuid } = await scopeOf(scopeInput);
      return guarded(async () => (await store()).graphSlice({ workspaceUuid, ...query }));
    },

    /**
     * Links an existing Todo / Decision / research / Git outcome. Todo and Decision targets are read through their own
     * facades in the same logical workspace; an unreadable or foreign target is refused without revealing it.
     */
    async addLink(scopeInput, id, { kind, targetId, snapshot } = /** @type {Record<string, any>} */ ({}), { actor } = /** @type {Record<string, any>} */ ({})) {
      assertActor(actor);
      if (!LINK_KINDS.includes(kind) || typeof targetId !== 'string' || !targetId.trim()) throw new InitiativeError('validation', 'Invalid link');
      const scope = await scopeOf(scopeInput);
      /** @type {Record<string, any>} */
      let snap = snapshot && typeof snapshot === 'object' ? { name: String(snapshot.name || '').slice(0, 300) } : {};
      if (kind === 'todo') {
        const todo = await (await todoApi()).getTodo(dataDir, scope.homeFolder, targetId);
        if (!todo) throw new InitiativeError('link_unavailable', 'Todo is not available in this workspace');
        snap = { name: String(todo.title || '').slice(0, 300), kind: 'todo' };
      } else if (kind === 'decision') {
        const row = await (await decisionApi()).getDecision(dataDir, targetId);
        if (!row || row.workspaceFolder !== scope.homeFolder) throw new InitiativeError('link_unavailable', 'Decision is not available in this workspace');
        snap = { name: String(row.title || '').slice(0, 300), kind: String(row.kind || 'decision') };
      }
      return guarded(async () => (await store()).addLink({
        commandId: cmd('init-link'), workspaceUuid: scope.workspaceUuid, actor, now: now(), linkId: randomUUID(), initiativeId: id, kind, targetId: targetId.trim(), snapshot: snap,
      }));
    },

    async removeLink(scopeInput, linkId, { actor } = /** @type {Record<string, any>} */ ({})) {
      assertActor(actor);
      const { workspaceUuid } = await scopeOf(scopeInput);
      return guarded(async () => (await store()).removeLink({ commandId: cmd('init-linkrm'), workspaceUuid, actor, now: now(), linkId }));
    },

    async links(scopeInput, id) {
      const { workspaceUuid } = await scopeOf(scopeInput);
      return guarded(async () => (await store()).links({ workspaceUuid, initiativeId: id }));
    },

    async addResearch(scopeInput, id, entry = /** @type {Record<string, any>} */ ({}), { actor, supersedesId } = /** @type {Record<string, any>} */ ({})) {
      assertActor(actor);
      if (!RESEARCH_KINDS.includes(entry.kind) || typeof entry.claim !== 'string' || !entry.claim.trim()) throw new InitiativeError('validation', 'Invalid research entry');
      const { workspaceUuid } = await scopeOf(scopeInput);
      const clean = {
        kind: entry.kind, claim: entry.claim.trim().slice(0, 4000),
        sources: (Array.isArray(entry.sources) ? entry.sources : []).slice(0, 20).map((s) => ({
          type: String(s?.type || '').slice(0, 40), ref: String(s?.ref || '').slice(0, 500), accessedAt: String(s?.accessedAt || '').slice(0, 40),
        })),
        limitations: String(entry.limitations || '').slice(0, 2000), observedAt: String(entry.observedAt || '').slice(0, 40),
      };
      return guarded(async () => (await store()).addResearch({
        commandId: cmd('init-res'), workspaceUuid, actor, now: now(), entryId: randomUUID(), initiativeId: id, entry: clean, supersedesId,
      }));
    },

    async research(scopeInput, id) {
      const { workspaceUuid } = await scopeOf(scopeInput);
      return guarded(async () => (await store()).research({ workspaceUuid, initiativeId: id }));
    },

    /**
     * Explicit user action: create one `idea` Todo from an initiative. The intent (operation id + payload digest) is
     * stored first; the Todo carries a server-side origin, so a repeat after a crash finds the same Todo and only
     * repairs the link. No plan approval, claim, start or parent change happens here.
     */
    async createTodo(scopeInput, id, { operationId, title, body } = /** @type {Record<string, any>} */ ({}), { actor } = /** @type {Record<string, any>} */ ({})) {
      if (assertActor(actor) !== 'human') throw new InitiativeError('forbidden', 'Creating a Todo from an initiative is a human action');
      if (typeof operationId !== 'string' || !operationId.trim()) throw new InitiativeError('validation', 'operationId is required');
      const scope = await scopeOf(scopeInput);
      const initiative = await mustGet(scope.workspaceUuid, id);
      const payload = {
        title: String(title || initiative.title).trim().slice(0, 300),
        body: String(body ?? `Outcome: ${initiative.desiredOutcome}`).slice(0, 8000),
      };
      const digest = digestOf(payload);
      const s = await store();
      const begun = await guarded(() => s.todoIntentBegin({
        commandId: cmd('init-intent'), workspaceUuid: scope.workspaceUuid, actor, now: now(), operationId: operationId.trim(), initiativeId: id, digest, payload,
      }));
      const intent = begun.intent;
      if (intent.state === 'created') {
        const todo = await (await todoApi()).getTodo(dataDir, scope.homeFolder, intent.todoId);
        return { todoId: intent.todoId, created: false, todoAvailable: Boolean(todo) };
      }
      const origin = { workspaceUuid: scope.workspaceUuid, operationId: intent.operationId, digest };
      let added;
      try {
        added = await (await todoApi()).addTodo(dataDir, scope.homeFolder, {
          title: intent.payload.title, body: intent.payload.body, status: 'idea', strictStatus: true, initiativeOrigin: origin,
        });
      } catch (error) {
        if (error?.code === 'CONFLICT') throw new InitiativeError('operation_conflict', 'Operation id was reused with a different payload');
        throw error;
      }
      const todoId = String(added.item.id);
      const done = await guarded(() => s.todoIntentComplete({
        commandId: cmd('init-intent-done'), workspaceUuid: scope.workspaceUuid, actor, now: now(), operationId: intent.operationId, todoId, linkId: randomUUID(),
        snapshot: { name: intent.payload.title, kind: 'todo' },
      }));
      return { todoId, created: !added.replayed, link: done.link, todoAvailable: true };
    },

    /** Repairs intents whose Todo exists but whose link is missing (crash between the two writes). */
    async recoverPendingTodoIntents(scopeInput) {
      const scope = await scopeOf(scopeInput);
      const s = await store();
      const { items } = await s.pendingIntents({ workspaceUuid: scope.workspaceUuid });
      const repaired = [];
      const { items: todos } = await (await todoApi()).listTodos(dataDir, scope.homeFolder);
      for (const intent of items) {
        const todo = todos.find((t) => t.initiativeOrigin?.workspaceUuid === scope.workspaceUuid && t.initiativeOrigin?.operationId === intent.operationId);
        if (!todo || todo.initiativeOrigin.digest !== intent.digest) continue;
        await guarded(() => s.todoIntentComplete({
          commandId: cmd('init-intent-fix'), workspaceUuid: scope.workspaceUuid, actor: 'system', now: now(), operationId: intent.operationId,
          todoId: todo.id, linkId: randomUUID(), snapshot: { name: intent.payload.title, kind: 'todo' },
        }));
        repaired.push(intent.operationId);
      }
      return { repaired };
    },

    async close() {
      const current = opening;
      opening = null;
      if (current) await current.then((r) => r.close(), () => {});
    },
  };
}

/** One service per data directory (the server process opens its worker lazily on first use). */
const services = new Map();

/** @param {string} dataDir @param {Record<string, any>} [overrides] */
export function getInitiativesService(dataDir, overrides) {
  if (!services.has(dataDir)) services.set(dataDir, createInitiativesService({ dataDir, ...overrides }));
  return services.get(dataDir);
}

/** Closes every opened initiatives worker (tests, shutdown). */
export async function closeInitiativesServices() {
  const all = [...services.values()];
  services.clear();
  await Promise.all(all.map((s) => s.close()));
}
