/**
 * Pure helpers of the Development plans panel (docs/development-plans.md). No DOM, no network: everything the
 * panel decides that is worth testing lives here.
 */

export const HORIZONS = Object.freeze(['now', 'next', 'later']);
export const STATUSES = Object.freeze(['draft', 'exploring', 'planned', 'active', 'paused', 'achieved', 'dropped']);
export const PRIORITIES = Object.freeze(['unknown', 'low', 'normal', 'high', 'urgent']);
export const SCOPE_SIZES = Object.freeze(['unknown', 'S', 'M', 'L', 'XL']);
export const RESEARCH_KINDS = Object.freeze(['observed', 'hypothesis', 'unknown']);
export const RELATION_TYPES = Object.freeze(['contributes_to', 'requires', 'supports', 'alternative_to']);

const PRIORITY_RANK = Object.freeze({ urgent: 0, high: 1, normal: 2, low: 3, unknown: 4 });
const DRAFT_PREFIX = 'cretli-initiative-draft:';

/** Fields the editor owns; the draft is a plain copy of them. */
export const DRAFT_FIELDS = Object.freeze([
  'kind', 'title', 'desiredOutcome', 'rationale', 'baseline', 'successCriteria', 'openQuestions', 'scopeSize', 'priority', 'horizon', 'status', 'targetDate',
]);

/**
 * Groups initiatives by horizon. Status never moves an initiative out of its horizon (an achieved or Todo-complete
 * initiative stays visible), so every record lands in exactly one group. Order: priority, then newest update.
 *
 * @param {Array<Record<string, any>>} items
 * @param {{ includeArchived?: boolean }} [options]
 */
export function groupByHorizon(items, { includeArchived = false } = {}) {
  /** @type {Record<string, Array<Record<string, any>>>} */
  const groups = { now: [], next: [], later: [] };
  for (const item of Array.isArray(items) ? items : []) {
    if (item?.archivedAt && !includeArchived) continue;
    const horizon = HORIZONS.includes(item?.horizon) ? item.horizon : 'later';
    groups[horizon].push(item);
  }
  for (const key of HORIZONS) {
    groups[key].sort((a, b) => (PRIORITY_RANK[a.priority] ?? 4) - (PRIORITY_RANK[b.priority] ?? 4)
      || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  }
  return groups;
}

/**
 * Splits research entries into evidence, hypotheses and unknowns, keeping only the newest version of a lineage.
 * Older versions are counted so the UI can say a claim was revised.
 *
 * @param {Array<Record<string, any>>} entries
 */
export function partitionResearch(entries) {
  const latest = new Map();
  const versions = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const lineage = entry.lineageId || entry.id;
    versions.set(lineage, (versions.get(lineage) || 0) + 1);
    const prior = latest.get(lineage);
    if (!prior || (entry.version || 0) >= (prior.version || 0)) latest.set(lineage, entry);
  }
  const out = { observed: [], hypothesis: [], unknown: [] };
  for (const [lineage, entry] of latest) {
    const bucket = out[entry.kind] || out.unknown;
    bucket.push({ ...entry, revisions: versions.get(lineage) || 1 });
  }
  for (const key of Object.keys(out)) out[key].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return out;
}

/** Turns source lines (`https://…` or free text) into the research source shape. */
export function parseSources(text) {
  return String(text || '').split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 20)
    .map((ref) => ({ type: /^https?:\/\//i.test(ref) ? 'url' : 'note', ref, accessedAt: '' }));
}

/** @param {Array<{ ref?: string }>} sources */
export const sourcesToText = (sources) => (Array.isArray(sources) ? sources.map((s) => s.ref).filter(Boolean).join('\n') : '');

/**
 * Classifies a failed request. Network loss and aborted fetches are `offline`: the draft stays and a retry is offered.
 *
 * @param {unknown} error
 * @returns {{ kind: 'offline' | 'conflict' | 'cycle' | 'stale_cursor' | 'validation' | 'forbidden' | 'not_found' | 'workspace' | 'unavailable' | 'error', code: string, status: number, message: string, details: Record<string, any> }}
 */
export function classifyError(error) {
  const e = /** @type {any} */ (error) || {};
  const status = Number(e.status) || 0;
  const code = String(e.code || '');
  const base = { code, status, message: String(e.message || ''), details: e.details || {} };
  if (!status && !code) return { ...base, kind: 'offline', code: 'offline' };
  if (code === 'initiative_relation_cycle') return { ...base, kind: 'cycle' };
  if (code === 'revision_conflict' || code === 'archived' || code === 'operation_conflict') return { ...base, kind: 'conflict' };
  if (code === 'cursor_stale') return { ...base, kind: 'stale_cursor' };
  if (code === 'workspace_required') return { ...base, kind: 'workspace' };
  if (code === 'validation' || status === 400) return { ...base, kind: 'validation' };
  if (code === 'forbidden' || status === 403) return { ...base, kind: 'forbidden' };
  if (code === 'not_found' || status === 404) return { ...base, kind: 'not_found' };
  if (status === 503 || code === 'storage_unavailable') return { ...base, kind: 'unavailable' };
  return { ...base, kind: 'error' };
}

/** Builds the query string for the canonical workspace; falls back to the per-tab view-context query. */
export function scopeQuery(workspaceUuid, viewQuery = '') {
  if (workspaceUuid) return `workspaceUuid=${encodeURIComponent(workspaceUuid)}`;
  return String(viewQuery || '').replace(/^\?/, '');
}

/** Storage key of a draft: separate per workspace scope and per initiative (or `new`). */
export function draftKey(scopeKey, id) {
  return `${DRAFT_PREFIX}${scopeKey || 'default'}:${id || 'new'}`;
}

/** @param {Record<string, any>} source */
export function draftFromInitiative(source) {
  const src = source || {};
  return {
    kind: src.kind || 'initiative', title: src.title || '', desiredOutcome: src.desiredOutcome || '', rationale: src.rationale || '',
    baseline: src.baseline || '', successCriteria: [...(src.successCriteria || [])], openQuestions: [...(src.openQuestions || [])],
    scopeSize: src.scopeSize || 'unknown', priority: src.priority || 'unknown', horizon: src.horizon || 'later', status: src.status || 'draft',
    targetDate: src.targetDate || '',
  };
}

/** Fields whose draft value differs from the base record (the patch sent on save). */
export function draftPatch(draft, base) {
  const ref = draftFromInitiative(base);
  const patch = /** @type {Record<string, any>} */ ({});
  for (const key of DRAFT_FIELDS) {
    if (JSON.stringify(draft[key]) !== JSON.stringify(ref[key])) patch[key] = draft[key];
  }
  return patch;
}

/** Fields changed both locally and remotely since the draft's base: a true conflict the user must resolve. */
export function conflictingFields(draft, base, remote) {
  const local = draftPatch(draft, base);
  const theirs = draftPatch(draftFromInitiative(remote), base);
  return Object.keys(local).filter((key) => key in theirs && JSON.stringify(local[key]) !== JSON.stringify(theirs[key]));
}

/** @param {Storage | null | undefined} storage */
export function saveDraft(storage, key, draft, baseRevision) {
  try { storage?.setItem(key, JSON.stringify({ draft, baseRevision, savedAt: Date.now() })); } catch { /* quota or disabled storage */ }
}

/** @param {Storage | null | undefined} storage */
export function loadDraft(storage, key) {
  try {
    const raw = storage?.getItem(key);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed.draft !== 'object' || !parsed.draft) return null;
    return { draft: draftFromInitiative(parsed.draft), baseRevision: Number(parsed.baseRevision) || 0 };
  } catch { return null; }
}

/** @param {Storage | null | undefined} storage */
export function clearDraft(storage, key) {
  try { storage?.removeItem(key); } catch { /* ignore */ }
}

/**
 * Link rows with the live state of their Todo. A done Todo is shown as such; it never changes the initiative.
 *
 * @param {Array<Record<string, any>>} links
 * @param {Array<Record<string, any>>} todos
 */
export function linkRows(links, todos) {
  const byId = new Map((Array.isArray(todos) ? todos : []).map((todo) => [String(todo.id), todo]));
  return (Array.isArray(links) ? links : []).map((link) => {
    const todo = link.kind === 'todo' ? byId.get(String(link.targetId)) : null;
    return { ...link, kind: link.kind, name: link.snapshot?.name || link.targetId, todoStatus: todo ? String(todo.status || '') : '', todoMissing: link.kind === 'todo' && !todo };
  });
}

/** Todos that are not linked yet and match the filter text (id or title). */
export function linkableTodos(todos, links, filter = '') {
  const linked = new Set((links || []).filter((l) => l.kind === 'todo').map((l) => String(l.targetId)));
  const needle = String(filter || '').trim().toLowerCase();
  return (todos || []).filter((todo) => !linked.has(String(todo.id))
    && (!needle || String(todo.title || '').toLowerCase().includes(needle) || String(todo.id).startsWith(needle))).slice(0, 50);
}

/** Cursor-stale-safe merge of pages: replaces by id so a restarted read never duplicates a record. */
export function mergePages(pages) {
  const byId = new Map();
  for (const page of pages) for (const item of page) byId.set(item.id, item);
  return [...byId.values()];
}

// ---- map view (same records and relations as the list; nothing is copied or persisted) -----------------------------

/** Most nodes drawn at once; a larger match set must be narrowed by the filter and says so. */
export const MAP_MAX_NODES = 60;
/** Relation types that must stay acyclic on the server; `supports` and `alternative_to` may loop. */
export const MAP_EDGE_STYLES = Object.freeze({
  requires: { dash: '', marker: 'solid' },
  contributes_to: { dash: '8 3 2 3', marker: 'dashdot' },
  supports: { dash: '6 4', marker: 'dashed' },
  alternative_to: { dash: '2 4', marker: 'dotted' },
});
const SIZE_HEIGHT = Object.freeze({ unknown: 56, S: 56, M: 68, L: 80, XL: 92 });
const NODE_W = 220;
const COL_GAP = 80;
const ROW_GAP = 24;
const PAD = 24;
const CLOSED = new Set(['achieved', 'dropped']);

/** Achieved and dropped initiatives are closed: still on the map, with their history one selection away. */
export const isClosed = (item) => CLOSED.has(item?.status);

/**
 * Keeps the records matching the map filter. Empty fields match everything.
 *
 * @param {Array<Record<string, any>>} items
 * @param {{ query?: string, horizon?: string, status?: string, hideClosed?: boolean }} [filter]
 */
export function filterForMap(items, filter = {}) {
  const q = String(filter.query || '').trim().toLowerCase();
  return (Array.isArray(items) ? items : []).filter((item) => (!filter.horizon || item.horizon === filter.horizon)
    && (!filter.status || item.status === filter.status)
    && (!filter.hideClosed || !isClosed(item))
    && (!q || `${item.title} ${item.desiredOutcome || ''}`.toLowerCase().includes(q)));
}

/**
 * Lays the filtered records out in one column per horizon (rows ordered by priority, then newest) and keeps the
 * relations whose two ends are both drawn. The result never hides anything silently: `hiddenNodes` counts matches
 * beyond `maxNodes` and `hiddenEdges` counts relations that lost an end to the filter or the limit.
 *
 * @param {Array<Record<string, any>>} matched records already passed through filterForMap
 * @param {Array<Record<string, any>>} relations graph-slice edges (id, type, fromId, toId)
 * @param {{ maxNodes?: number }} [options]
 */
export function buildMapModel(matched, relations, { maxNodes = MAP_MAX_NODES } = {}) {
  const groups = groupByHorizon(matched, { includeArchived: true });
  const drawn = [];
  let budget = Math.max(0, maxNodes);
  const columns = HORIZONS.map((horizon) => {
    const take = groups[horizon].slice(0, budget);
    budget -= take.length;
    drawn.push(...take.map((item) => ({ item, horizon })));
    return { horizon, total: groups[horizon].length, shown: take.length };
  });
  const nodes = [];
  columns.forEach((col, ci) => {
    let y = PAD + 28;
    drawn.filter((d) => d.horizon === col.horizon).forEach((d, row) => {
      const height = SIZE_HEIGHT[d.item.scopeSize] || SIZE_HEIGHT.unknown;
      nodes.push({ id: d.item.id, item: d.item, horizon: col.horizon, col: ci, row, x: PAD + ci * (NODE_W + COL_GAP), y, width: NODE_W, height });
      y += height + ROW_GAP;
    });
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const seen = new Set();
  const edges = [];
  let hiddenEdges = 0;
  for (const rel of Array.isArray(relations) ? relations : []) {
    if (!rel || seen.has(rel.id)) continue;
    seen.add(rel.id);
    const from = byId.get(rel.fromId);
    const to = byId.get(rel.toId);
    if (from && to && MAP_EDGE_STYLES[rel.type]) edges.push({ id: rel.id, type: rel.type, from, to, loop: from.id === to.id });
    else hiddenEdges += 1;
  }
  const width = PAD * 2 + HORIZONS.length * NODE_W + (HORIZONS.length - 1) * COL_GAP;
  const height = Math.max(160, ...nodes.map((n) => n.y + n.height + PAD));
  return { nodes, edges, columns, width, height, hiddenNodes: matched.length - nodes.length, hiddenEdges, columnWidth: NODE_W, columnGap: COL_GAP, pad: PAD };
}

/**
 * Gathers the complete relations of a set of records. Each record's own relation read returns every edge touching it,
 * so a pair that sits on different graph-slice pages still shows up. Results are de-duplicated by relation id; a failed
 * read marks the result incomplete instead of dropping edges silently.
 *
 * @param {string[]} ids
 * @param {(id: string) => Promise<{ items: Array<Record<string, any>> }>} fetchOne
 * @param {{ concurrency?: number }} [options]
 */
export async function collectRelations(ids, fetchOne, { concurrency = 6 } = {}) {
  const byId = new Map();
  let complete = true;
  const queue = [...new Set(ids)];
  const worker = async () => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      try {
        for (const rel of (await fetchOne(id)).items || []) byId.set(rel.id, rel);
      } catch (error) {
        if (/** @type {any} */ (error)?.status === 0 || !/** @type {any} */ (error)?.status) throw error;
        complete = false;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return { relations: [...byId.values()], complete };
}

/**
 * Latest-request-wins guard for overlapping async reads. A request key (like a node set) cannot tell two requests for
 * the same key apart, so each start takes a fresh monotonically increasing sequence number and only the newest may apply.
 */
export function createLatestGuard() {
  let latest = 0;
  return { begin: () => { latest += 1; return latest; }, isLatest: (seq) => seq === latest };
}

/** Text outline of every relation touching one record, for the list-equivalent view and the node description. */
export function relationsOf(id, relations, nameOf) {
  const out = [];
  for (const rel of Array.isArray(relations) ? relations : []) {
    if (rel.fromId === id) out.push({ id: rel.id, type: rel.type, direction: 'out', otherId: rel.toId, otherName: nameOf(rel.toId) });
    else if (rel.toId === id) out.push({ id: rel.id, type: rel.type, direction: 'in', otherId: rel.fromId, otherName: nameOf(rel.fromId) });
  }
  return out;
}

/**
 * Client-side mirror of the server rule: adding `from -> to` of an acyclic type is a cycle when `to` already reaches
 * `from`. The server stays authoritative (`initiative_relation_cycle`); this only lets the UI explain before sending.
 */
export function wouldCloseCycle(relations, type, fromId, toId) {
  if (type !== 'requires' && type !== 'contributes_to') return false;
  if (fromId === toId) return true;
  const next = new Map();
  for (const rel of relations || []) if (rel.type === type) next.set(rel.fromId, [...(next.get(rel.fromId) || []), rel.toId]);
  const stack = [toId];
  const visited = new Set();
  while (stack.length) {
    const cur = stack.pop();
    if (cur === fromId) return true;
    if (visited.has(cur)) continue;
    visited.add(cur);
    stack.push(...(next.get(cur) || []));
  }
  return false;
}

/** Spatial keyboard navigation between nodes: arrows move to the nearest node in that direction, or stay put. */
export function neighborNode(nodes, currentId, key) {
  const cur = nodes.find((n) => n.id === currentId);
  if (!cur) return nodes[0]?.id || '';
  const dir = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] }[key];
  if (!dir) return currentId;
  let best = null;
  let bestScore = Infinity;
  for (const n of nodes) {
    if (n === cur) continue;
    const dx = n.x - cur.x;
    const dy = n.y - cur.y;
    const along = dx * dir[0] + dy * dir[1];
    if (along <= 0) continue;
    const score = along + Math.abs(dx * dir[1] + dy * dir[0]) * 2;
    if (score < bestScore) { best = n; bestScore = score; }
  }
  return best ? best.id : currentId;
}

/** Clamped zoom/pan state transitions of the map viewport. */
export const MAP_ZOOM_MIN = 0.4;
export const MAP_ZOOM_MAX = 3;
export function zoomView(view, factor) {
  const zoom = Math.min(MAP_ZOOM_MAX, Math.max(MAP_ZOOM_MIN, view.zoom * factor));
  return { ...view, zoom: Math.round(zoom * 1000) / 1000 };
}
export const panView = (view, dx, dy) => ({ ...view, x: view.x + dx, y: view.y + dy });
export const MAP_HOME_VIEW = Object.freeze({ zoom: 1, x: 0, y: 0 });
