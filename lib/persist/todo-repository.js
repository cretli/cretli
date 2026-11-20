/**
 * Row-level, async todo repository (docs/todo-scalable-architecture.md 3.1).
 *
 * Callers get bounded reads only: a point read (`getRow`, `getDetail`), keyset
 * pages (`listPage`, `listChildren`), counters (`counts`) and the revision token.
 * There is deliberately no `listAll`; every page is capped at `MAX_PAGE_LIMIT`.
 *
 * This is the JSON-backed implementation on top of the `store.todos` facade. It
 * keeps a small per-workspace index of LIGHT rows keyed by the committed
 * revision, so a page or a count never serializes the document and a point read
 * only touches the rows it needs. The interface (and the cursor/row shapes) are
 * storage-agnostic: a SQLite implementation can replace `createJsonTodoRepository`
 * without changing callers.
 *
 * Cursor semantics (accepted, documented): a cursor is a keyset position
 * `(sortKey, id)` bound to workspace + filter + sort and stamped with the
 * revision it was issued at. Each page is served from the CURRENT revision. A row
 * whose sort key changes between two page requests (for example `sort=updated`
 * after an edit) may therefore appear twice or be skipped; the page response
 * carries `revision`, and the client dedupes by id and refetches its visible
 * window when `revision` advances. `stale: true` flags a page read after the
 * cursor's revision. `sort=tree` uses keys derived from structure only
 * (`siblingIndex` ranks), so edits that do not move rows never disturb it.
 *
 * Memory: the cached index retains the COMPLETE raw items (heavy fields
 * included) of up to `INDEX_CACHE_WORKSPACES` workspaces, so memory is bounded
 * by the workspace count, not by heavy-field bytes. Rows handed to callers are
 * copies; light rows and raw items are never mutated after the build.
 */

import { createHash } from 'node:crypto';
import { getRevision, listTodos } from './todos-store.js';
import { todoReviewStateForSubject } from '../todo-review-state.js';
import { readTodoParentId } from '../todo-tree.js';
import { attachTodoIntegrationReadModels } from '../todo-integration-read.js';
import { todoReviewMatchesFilter } from '../todo-review-read.js';

export const MAX_PAGE_LIMIT = 200;
export const DEFAULT_PAGE_LIMIT = 50;
export const PREVIEW_CHARS = 400;
export const MIN_PREFIX_CHARS = 8;
/** Workspaces whose index is kept in memory at once (LRU). */
export const INDEX_CACHE_WORKSPACES = 4;

const SORTS = new Set(['updated', 'tree']);
const REVIEW_SUBJECTS = new Set(['code', 'plan', 'other']);

/** Scalar fields copied onto a light row; heavy fields are never listed here. */
const LIGHT_FIELDS = [
  'id', 'parentId', 'title', 'status', 'priority', 'siblingIndex', 'createdAt', 'updatedAt',
  'assignee', 'runMode', 'executionMode', 'nonBlocking', 'deferredUntil', 'deferredReason',
  'sourceTodoId', 'orchestratorChatId', 'claimedByChatId',
];

/**
 * @param {string} code
 * @param {string} message
 * @returns {Error & { code: string }}
 */
function repoError(code, message) {
  const err = /** @type {Error & { code: string }} */ (new Error(message));
  err.code = code;
  return err;
}

/** @param {unknown} value */
function text(value) {
  return value == null ? '' : String(value).trim();
}

/**
 * @param {Record<string, any>} item
 * @param {number} childCount
 * @returns {Record<string, any>}
 */
export function toLightRow(item, childCount) {
  /** @type {Record<string, any>} */
  const row = {};
  for (const key of LIGHT_FIELDS) if (item[key] !== undefined) row[key] = item[key];
  const body = typeof item.body === 'string' ? item.body : '';
  row.preview = body.trimStart().slice(0, PREVIEW_CHARS);
  const plan = item.plan && typeof item.plan === 'object' ? item.plan : null;
  row.hasPlan = Boolean(plan && text(plan.markdown));
  row.planApproved = Boolean(plan && text(plan.approvedAt));
  row.reviewCodeState = todoReviewStateForSubject(item, 'code');
  row.reviewPlanState = todoReviewStateForSubject(item, 'plan');
  row.childCount = childCount;
  return row;
}

/**
 * @typedef {{ id: string, key: string, pos: number, row: Record<string, any>, raw: Record<string, any>, hay: string, integration: Record<string, any>, fullHay?: string }} IndexEntry
 * @typedef {{
 *   revision: string,
 *   byId: Map<string, IndexEntry>,
 *   children: Map<string, string[]>,
 *   bySource: Map<string, string[]>,
 *   document: IndexEntry[],
 *   order: { updated: IndexEntry[], tree: IndexEntry[] },
 *   counts: { byStatus: Record<string, number>, byReviewCode: Record<string, number>, total: number },
 * }} WorkspaceIndex
 */

/** @param {number} n */
function pad(n) {
  return String(n).padStart(8, '0');
}

/**
 * Tree sort keys: a path of per-sibling ranks, so a parent sorts before its
 * children and siblings follow `siblingIndex` (document order breaks ties).
 *
 * @param {Record<string, any>[]} items
 * @param {Map<string, string[]>} children parent id -> child ids ('' = roots)
 * @param {Map<string, Record<string, any>>} rawById
 * @returns {Map<string, string>}
 */
function buildTreeKeys(items, children, rawById) {
  /** @type {Map<string, string>} */
  const keys = new Map();
  const position = new Map(items.map((item, i) => [item.id, i]));
  const rank = (/** @type {string} */ id) => {
    const v = rawById.get(id)?.siblingIndex;
    return Number.isInteger(v) && v >= 0 ? v : Number.MAX_SAFE_INTEGER;
  };
  const stack = [{ parent: '', prefix: '' }];
  while (stack.length) {
    const { parent, prefix } = /** @type {{ parent: string, prefix: string }} */ (stack.pop());
    const ids = (children.get(parent) || []).slice().sort((a, b) => (rank(a) - rank(b)) || ((position.get(a) || 0) - (position.get(b) || 0)));
    ids.forEach((id, i) => {
      if (keys.has(id)) return;
      const key = `${prefix}${pad(i)}.`;
      keys.set(id, key);
      stack.push({ parent: id, prefix: key });
    });
  }
  // Rows in a parent cycle are unreachable from a root; keep them listable.
  let tail = 0;
  for (const item of items) if (!keys.has(item.id)) keys.set(item.id, `~${pad(tail++)}.`);
  return keys;
}

/**
 * @param {{ items: Record<string, any>[] }} doc
 * @param {string} revision
 * @returns {WorkspaceIndex}
 */
function buildIndex(doc, revision) {
  const items = (doc.items || []).filter((item) => item && typeof item.id === 'string' && item.id);
  /** @type {Map<string, Record<string, any>>} */
  const rawById = new Map(items.map((item) => [item.id, item]));
  /** @type {Map<string, string[]>} */
  const children = new Map();
  for (const item of items) {
    const parent = readTodoParentId(item);
    const key = parent && rawById.has(parent) ? parent : '';
    const list = children.get(key);
    if (list) list.push(item.id);
    else children.set(key, [item.id]);
  }
  const treeKeys = buildTreeKeys(items, children, rawById);
  // Derived integration summaries are computed once per revision over the loaded
  // document (they depend on descendants and ancestor tree proofs), then served
  // per row, so a filtered read never recomputes them.
  const summaries = new Map(attachTodoIntegrationReadModels(items).map((row) => [row.id, row.integrationSummary]));
  /** @type {Map<string, string[]>} */
  const bySource = new Map();
  /** @type {Map<string, IndexEntry>} */
  const byId = new Map();
  const byStatus = {};
  const byReviewCode = {};
  let pos = 0;
  for (const item of items) {
    const row = toLightRow(item, (children.get(item.id) || []).length);
    const source = typeof item.sourceTodoId === 'string' ? item.sourceTodoId : '';
    if (source) {
      const list = bySource.get(source);
      if (list) list.push(item.id);
      else bySource.set(source, [item.id]);
    }
    byId.set(item.id, {
      id: item.id,
      key: treeKeys.get(item.id) || '',
      pos: pos++,
      integration: summaries.get(item.id) || {},
      row,
      raw: item,
      hay: `${text(item.title)}\n${row.preview}`.toLowerCase(),
    });
    const status = text(item.status) || 'idea';
    byStatus[status] = (byStatus[status] || 0) + 1;
    byReviewCode[row.reviewCodeState] = (byReviewCode[row.reviewCodeState] || 0) + 1;
  }
  const entries = [...byId.values()];
  const tree = entries.slice().sort((a, b) => cmpAsc(a.key, a.id, b.key, b.id));
  const updated = entries.slice().sort((a, b) => cmpAsc(updatedKey(b), b.id, updatedKey(a), a.id));
  return { revision, byId, children, bySource, document: entries, order: { updated, tree }, counts: { byStatus, byReviewCode, total: items.length } };
}

/** @param {IndexEntry} entry */
function updatedKey(entry) {
  return text(entry.row.updatedAt);
}

/**
 * @param {string} ak @param {string} ai @param {string} bk @param {string} bi
 * @returns {number}
 */
function cmpAsc(ak, ai, bk, bi) {
  if (ak !== bk) return ak < bk ? -1 : 1;
  if (ai !== bi) return ai < bi ? -1 : 1;
  return 0;
}

/**
 * Position in the sort order: negative when (ak, ai) comes before (bk, bi).
 *
 * @param {'updated'|'tree'} sort
 */
function cmpSort(sort, ak, ai, bk, bi) {
  return sort === 'updated' ? cmpAsc(bk, bi, ak, ai) : cmpAsc(ak, ai, bk, bi);
}

/** @param {'updated'|'tree'} sort @param {IndexEntry} entry */
function sortKeyOf(sort, entry) {
  return sort === 'updated' ? updatedKey(entry) : entry.key;
}

/**
 * @typedef {{ status?: string, review?: string, parentId?: string, q?: string }} TodoFilter
 */

/**
 * @param {TodoFilter} [filter]
 * @returns {{ statuses: Set<string> | null, reviewSubject: string, reviewState: string, parentId: string | null, q: string }}
 */
function normalizeFilter(filter = {}) {
  const statuses = text(filter.status)
    ? new Set(text(filter.status).split(',').map((s) => s.trim()).filter(Boolean))
    : null;
  let reviewSubject = 'code';
  let reviewState = '';
  const review = text(filter.review);
  if (review) {
    const [a, b] = review.includes(':') ? review.split(':') : ['code', review];
    reviewSubject = text(a);
    reviewState = text(b);
    if (!REVIEW_SUBJECTS.has(reviewSubject)) throw repoError('VALIDATION', `Unknown review subject: ${reviewSubject}`);
  }
  const parentRaw = filter.parentId == null ? '' : text(filter.parentId);
  return {
    statuses,
    reviewSubject,
    reviewState,
    // 'root' selects top-level rows; an empty value means "no parent filter".
    parentId: parentRaw ? parentRaw : null,
    q: text(filter.q).toLowerCase(),
  };
}

/**
 * @param {ReturnType<typeof normalizeFilter>} f
 * @param {IndexEntry} entry
 */
function matches(f, entry) {
  if (f.statuses && !f.statuses.has(text(entry.raw.status) || 'idea')) return false;
  if (f.reviewState) {
    const state = f.reviewSubject === 'code' ? entry.row.reviewCodeState
      : f.reviewSubject === 'plan' ? entry.row.reviewPlanState
        : todoReviewStateForSubject(entry.raw, f.reviewSubject);
    if (state !== f.reviewState) return false;
  }
  if (f.parentId !== null) {
    const parent = readTodoParentId(entry.raw);
    if (f.parentId === 'root' ? parent !== '' : parent !== f.parentId) return false;
  }
  if (f.q && !entry.hay.includes(f.q)) return false;
  return true;
}


/**
 * @typedef {{ status?: string, review?: { subject?: string, state?: string }, integration?: string, text?: string }} ToolFilter
 */

/** Lowercase `title body` text of a row, built once per entry on first use (bodies are persistence-capped). */
function fullText(/** @type {IndexEntry} */ entry) {
  if (entry.fullHay === undefined) entry.fullHay = `${entry.raw.title || ''} ${entry.raw.body || ''}`.toLowerCase();
  return entry.fullHay;
}

/**
 * Predicate of the MCP `todo_list` contract: exact status, review state (a
 * container never matches a review filter), derived integration state/detail
 * and a `title body` substring.
 *
 * @param {ToolFilter} f
 * @param {IndexEntry} entry
 * @param {boolean} isContainer
 */
function toolMatches(f, entry, isContainer) {
  if (f.status && entry.raw.status !== f.status) return false;
  if (!todoReviewMatchesFilter(entry.raw, isContainer, f.review || {})) return false;
  if (f.integration && entry.integration?.state !== f.integration && entry.integration?.detail !== f.integration) return false;
  if (f.text && !fullText(entry).includes(f.text)) return false;
  return true;
}

/** @param {unknown} limit */
function clampLimit(limit) {
  const n = Number(limit);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_PAGE_LIMIT;
  return Math.min(MAX_PAGE_LIMIT, Math.floor(n));
}

/**
 * @param {{ dataDir: string }} deps
 */
export function createJsonTodoRepository(deps) {
  const { dataDir } = deps;
  /** @type {Map<string, WorkspaceIndex>} */
  const cache = new Map();
  /** @type {Map<string, Promise<WorkspaceIndex>>} */
  const inflight = new Map();
  /** Diagnostics: number of index builds (document loads) performed. */
  const stats = { builds: 0 };

  /**
   * @param {string} ws
   * @returns {Promise<WorkspaceIndex>}
   */
  async function indexFor(ws) {
    // Revision first: if the file changes after this read the entry is simply
    // rebuilt on the next call, never served as newer than it is.
    const revision = await getRevision(dataDir, ws);
    const cached = cache.get(ws);
    if (revision && cached && cached.revision === revision) {
      cache.delete(ws);
      cache.set(ws, cached);
      return cached;
    }
    const flightKey = `${ws}\u0000${revision}`;
    if (revision && inflight.has(flightKey)) return /** @type {Promise<WorkspaceIndex>} */ (inflight.get(flightKey));
    const build = (async () => {
      stats.builds += 1;
      const doc = await listTodos(dataDir, ws);
      const index = buildIndex(doc, revision);
      if (revision) {
        cache.delete(ws);
        cache.set(ws, index);
        while (cache.size > INDEX_CACHE_WORKSPACES) cache.delete(/** @type {string} */ (cache.keys().next().value));
      }
      return index;
    })();
    if (revision) {
      inflight.set(flightKey, build);
      build.then(() => inflight.delete(flightKey), () => inflight.delete(flightKey));
    }
    return build;
  }

  /**
   * @param {WorkspaceIndex} index
   * @param {string} id exact id or unique prefix of at least 8 characters
   * @returns {IndexEntry | null}
   */
  function resolve(index, id) {
    const wanted = text(id);
    if (!wanted) return null;
    const exact = index.byId.get(wanted);
    if (exact) return exact;
    if (wanted.length < MIN_PREFIX_CHARS) return null;
    /** @type {IndexEntry[]} */
    const hits = [];
    for (const entry of index.byId.values()) if (entry.id.startsWith(wanted)) hits.push(entry);
    if (hits.length > 1) throw repoError('AMBIGUOUS', `Ambiguous todo id prefix "${wanted}" (${hits.length} matches)`);
    return hits[0] || null;
  }

  /**
   * @param {string} ws @param {'updated'|'tree'} sort @param {string} filterHash
   */
  function cursorBinding(ws, sort, filterHash) {
    return createHash('sha1').update(`${dataDir}\u0000${ws}\u0000${sort}\u0000${filterHash}`).digest('base64url').slice(0, 16);
  }

  /** @param {string} cursor @param {string} binding */
  function decodeCursor(cursor, binding) {
    let parsed;
    try {
      parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    } catch {
      throw repoError('VALIDATION', 'Invalid cursor');
    }
    if (!parsed || parsed.v !== 1 || typeof parsed.k !== 'string' || typeof parsed.i !== 'string') {
      throw repoError('VALIDATION', 'Invalid cursor');
    }
    if (parsed.b !== binding) throw repoError('VALIDATION', 'Cursor does not match this workspace, filter or sort');
    return /** @type {{ k: string, i: string, r: string }} */ (parsed);
  }

  /**
   * First index in `list` strictly after the cursor position.
   *
   * @param {IndexEntry[]} list @param {'updated'|'tree'} sort @param {{ k: string, i: string }} pos
   */
  function firstAfter(list, sort, pos) {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cmpSort(sort, sortKeyOf(sort, list[mid]), list[mid].id, pos.k, pos.i) <= 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * @param {string} ws
   * @param {TodoFilter & { sort?: string, cursor?: string, limit?: number }} [opts]
   */
  async function listPage(ws, opts = {}) {
    const sort = /** @type {'updated'|'tree'} */ (opts.sort || 'updated');
    if (!SORTS.has(sort)) throw repoError('VALIDATION', `Unknown sort: ${String(opts.sort)}`);
    const f = normalizeFilter(opts);
    const filterHash = createHash('sha1').update(JSON.stringify([
      f.statuses ? [...f.statuses].sort() : null, f.reviewSubject, f.reviewState, f.parentId, f.q,
    ])).digest('base64url').slice(0, 12);
    const binding = cursorBinding(ws, sort, filterHash);
    const limit = clampLimit(opts.limit);
    const cursor = opts.cursor ? decodeCursor(String(opts.cursor), binding) : null;
    const index = await indexFor(ws);
    const list = index.order[sort];
    let at = cursor ? firstAfter(list, sort, cursor) : 0;
    /** @type {IndexEntry[]} */
    const picked = [];
    for (; at < list.length && picked.length <= limit; at++) {
      if (matches(f, list[at])) picked.push(list[at]);
    }
    const hasMore = picked.length > limit;
    if (hasMore) picked.pop();
    const last = picked[picked.length - 1];
    const nextCursor = hasMore && last
      ? Buffer.from(JSON.stringify({ v: 1, b: binding, k: sortKeyOf(sort, last), i: last.id, r: index.revision })).toString('base64url')
      : null;
    return {
      rows: picked.map((entry) => ({ ...entry.row })),
      nextCursor,
      revision: index.revision,
      ...(cursor && cursor.r !== index.revision ? { stale: true } : {}),
    };
  }

  return {
    /** Light row of one todo (id or unique >=8-char prefix); null when absent. */
    async getRow(ws, id) {
      const entry = resolve(await indexFor(ws), id);
      return entry ? { ...entry.row } : null;
    },

    /**
     * Full item (heavy fields included) with the caller's read-model enrichment
     * applied to just the rows that enrichment can depend on: the item, its
     * ancestors and its subtree (plus the full subtree of any ancestor that
     * holds tree-scoped integration evidence, whose fingerprint covers it).
     * Siblings and unrelated branches are never loaded.
     *
     * @param {string} ws
     * @param {string} id
     * @param {{ enrich?: (items: Record<string, any>[]) => Promise<Record<string, any>[]> | Record<string, any>[] }} [options]
     * @returns {Promise<Record<string, any> | null>}
     */
    async getDetail(ws, id, options = {}) {
      const index = await indexFor(ws);
      const entry = resolve(index, id);
      if (!entry) return null;
      /** @type {Map<string, Record<string, any>>} */
      const closure = new Map();
      // Membership (closure) and traversal are tracked apart: an ancestor can be a
      // member without its subtree having been walked yet, and must still expand.
      const traversed = new Set();
      const addSubtree = (/** @type {string} */ rootId) => {
        const stack = [rootId];
        while (stack.length) {
          const cur = /** @type {string} */ (stack.pop());
          if (traversed.has(cur)) continue;
          const e = index.byId.get(cur);
          if (!e) continue;
          traversed.add(cur);
          closure.set(cur, e.raw);
          for (const child of index.children.get(cur) || []) stack.push(child);
        }
      };
      addSubtree(entry.id);
      const seen = new Set([entry.id]);
      let parent = readTodoParentId(entry.raw);
      while (parent && !seen.has(parent) && index.byId.has(parent)) {
        seen.add(parent);
        const ancestor = /** @type {IndexEntry} */ (index.byId.get(parent));
        if (ancestor.raw.integration?.evidence?.scope === 'tree') addSubtree(ancestor.id);
        else closure.set(ancestor.id, ancestor.raw);
        parent = readTodoParentId(ancestor.raw);
      }
      const rows = [...closure.values()].map((row) => ({ ...row }));
      const enriched = options.enrich ? await options.enrich(rows) : rows;
      return enriched.find((row) => row?.id === entry.id) || null;
    },


    /**
     * Document-order window over the rows that satisfy the MCP list contract.
     * One pass over light entries: no document read, no serialization; `total`
     * is the exact filtered count. Entries carry the raw (read-only) item.
     *
     * @param {string} ws
     * @param {ToolFilter} [filter]
     * @param {{ offset?: number, limit?: number }} [window]
     */
    async listWindow(ws, filter = {}, window = {}) {
      const index = await indexFor(ws);
      const offset = Math.max(0, Math.floor(Number(window.offset) || 0));
      const limit = Math.max(0, Math.floor(Number(window.limit) || 0));
      /** @type {{ raw: Record<string, any>, integrationSummary: Record<string, any>, isContainer: boolean }[]} */
      const entries = [];
      let total = 0;
      for (const entry of index.document) {
        const isContainer = (index.children.get(entry.id) || []).length > 0;
        if (!toolMatches(filter, entry, isContainer)) continue;
        if (total >= offset && entries.length < limit) entries.push({ raw: entry.raw, integrationSummary: entry.integration, isContainer });
        total += 1;
      }
      return { entries, total, revision: index.revision };
    },

    /**
     * Raw item for an exact id or unique prefix (>= 8 chars); `ignoreCase`
     * matches the prefix case-insensitively. Ambiguity returns the candidates.
     *
     * @param {string} ws @param {string} id @param {{ ignoreCase?: boolean }} [options]
     * @returns {Promise<{ item: Record<string, any> | null, matches: Record<string, any>[] }>}
     */
    async resolveItem(ws, id, options = {}) {
      const index = await indexFor(ws);
      const wanted = text(id);
      if (!wanted) return { item: null, matches: [] };
      const exact = index.byId.get(wanted);
      if (exact) return { item: exact.raw, matches: [] };
      if (wanted.length < MIN_PREFIX_CHARS) return { item: null, matches: [] };
      const needle = options.ignoreCase ? wanted.toLowerCase() : wanted;
      /** @type {Record<string, any>[]} */
      const hits = [];
      for (const entry of index.document) {
        if ((options.ignoreCase ? entry.id.toLowerCase() : entry.id).startsWith(needle)) hits.push(entry.raw);
      }
      return hits.length === 1 ? { item: hits[0], matches: [] } : { item: null, matches: hits };
    },

    /**
     * Context rows around one item for the show read model: direct children
     * (sibling order), follow-ups (`sourceTodoId` back-references), derived
     * integration summaries, and whether each child is a container.
     *
     * @param {string} ws @param {string} id exact id
     */
    async readNeighbours(ws, id) {
      const index = await indexFor(ws);
      const entry = index.byId.get(id);
      if (!entry) return null;
      const wrap = (/** @type {string} */ childId) => {
        const e = /** @type {IndexEntry} */ (index.byId.get(childId));
        return { raw: e.raw, integrationSummary: e.integration, isContainer: (index.children.get(e.id) || []).length > 0 };
      };
      const children = (index.children.get(id) || []).map(wrap)
        .sort((a, b) => (a.raw.siblingIndex ?? 0) - (b.raw.siblingIndex ?? 0));
      const followUps = (index.bySource.get(id) || []).map(wrap);
      return { self: wrap(id), children, followUps, revision: index.revision };
    },

    /**
     * Raw rows the plan-gate / execution-state logic reads for `ids`: each row,
     * its ancestors, one child of every chain node (container check), and the
     * `sourceTodoId` row of every chain node with its ancestors. Document order.
     *
     * @param {string} ws @param {string[]} ids
     * @returns {Promise<Record<string, any>[]>}
     */
    async gateClosure(ws, ids) {
      const index = await indexFor(ws);
      const picked = new Set();
      const addChain = (/** @type {string} */ start, /** @type {boolean} */ withExtras) => {
        const seen = new Set();
        let cur = index.byId.get(start);
        while (cur && !seen.has(cur.id)) {
          seen.add(cur.id);
          picked.add(cur.id);
          if (withExtras) {
            const firstChild = (index.children.get(cur.id) || [])[0];
            if (firstChild) picked.add(firstChild);
            const source = typeof cur.raw.sourceTodoId === 'string' ? cur.raw.sourceTodoId : '';
            if (source && index.byId.has(source)) addChain(source, false);
          }
          cur = index.byId.get(readTodoParentId(cur.raw));
        }
      };
      for (const id of ids) addChain(id, true);
      return [...picked].map((id) => /** @type {IndexEntry} */ (index.byId.get(id))).sort((a, b) => a.pos - b.pos).map((e) => e.raw);
    },

    listPage,

    /**
     * Direct children of `parentId` in tree order.
     *
     * @param {string} ws @param {string} parentId @param {{ cursor?: string, limit?: number }} [opts]
     */
    async listChildren(ws, parentId, opts = {}) {
      const parent = resolve(await indexFor(ws), parentId);
      if (!parent) throw repoError('NOT_FOUND', 'Item not found');
      return listPage(ws, { parentId: parent.id, sort: 'tree', cursor: opts.cursor, limit: opts.limit });
    },

    /**
     * Counters for the workspace, or for a filtered subset. Unfiltered counts are
     * maintained with the index; a filter is answered by one pass over light rows.
     *
     * @param {string} ws @param {{ filter?: TodoFilter }} [opts]
     */
    async counts(ws, opts = {}) {
      const index = await indexFor(ws);
      const filter = opts.filter || {};
      if (!text(filter.status) && !text(filter.review) && !text(filter.parentId) && !text(filter.q)) {
        const { byStatus, byReviewCode, total } = index.counts;
        return { byStatus: { ...byStatus }, byReviewCode: { ...byReviewCode }, total, revision: index.revision };
      }
      const f = normalizeFilter(filter);
      /** @type {Record<string, number>} */
      const byStatus = {};
      /** @type {Record<string, number>} */
      const byReviewCode = {};
      let total = 0;
      for (const entry of index.byId.values()) {
        if (!matches(f, entry)) continue;
        total += 1;
        const status = text(entry.raw.status) || 'idea';
        byStatus[status] = (byStatus[status] || 0) + 1;
        byReviewCode[entry.row.reviewCodeState] = (byReviewCode[entry.row.reviewCodeState] || 0) + 1;
      }
      return { byStatus, byReviewCode, total, revision: index.revision };
    },

    /** Diagnostics for tests: counters of this repository instance. */
    stats,

    /** Opaque revision token; equality only. */
    async revision(ws) {
      return getRevision(dataDir, ws);
    },
  };
}

/** @type {Map<string, ReturnType<typeof createJsonTodoRepository>>} */
const repositories = new Map();

/**
 * Shared repository per data dir (the index cache lives inside it).
 *
 * @param {string} dataDir
 */
export function getTodoRepository(dataDir) {
  let repo = repositories.get(dataDir);
  if (!repo) {
    repo = createJsonTodoRepository({ dataDir });
    repositories.set(dataDir, repo);
  }
  return repo;
}
