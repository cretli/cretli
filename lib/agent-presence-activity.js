/**
 * Compact sidebar activity: allowlisted tool names and a basename only.
 */

const ACTIVITY_ARG_MAX = 24;

const TOOL_ACTIVITY_KEYS = {
  read: 'read',
  readfile: 'read',
  grep: 'grep',
  glob: 'search',
  search: 'search',
  bash: 'bash',
  shell: 'bash',
  write: 'write',
  edit: 'edit',
  strreplace: 'edit',
};

/**
 * @param {string} raw
 * @returns {string}
 */
export function sanitizePresenceActivityArg(raw) {
  const value = String(raw || '').trim().replace(/\\/g, '/');
  if (!value) return '';
  const base = value.split('/').filter(Boolean).pop() || '';
  const clean = base.replace(/[^\w.-]+/g, '').slice(0, ACTIVITY_ARG_MAX);
  return clean;
}

/**
 * @param {string} toolName
 * @returns {string}
 */
export function resolvePresenceActivityKey(toolName) {
  const normalized = String(toolName || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  return TOOL_ACTIVITY_KEYS[normalized] || '';
}

/**
 * @param {Record<string, unknown> | null | undefined} rec
 * @returns {{ activityKey: string, activityArg: string } | null}
 */
export function parseToolPresenceActivity(rec) {
  if (!rec || typeof rec !== 'object') return null;
  const name = typeof rec.name === 'string'
    ? rec.name
    : (typeof rec.tool === 'string' ? rec.tool : '');
  const activityKey = resolvePresenceActivityKey(name);
  if (!activityKey) return null;
  const pathish = typeof rec.path === 'string'
    ? rec.path
    : (typeof rec.file === 'string' ? rec.file : (typeof rec.target === 'string' ? rec.target : ''));
  return {
    activityKey,
    activityArg: sanitizePresenceActivityArg(pathish),
  };
}

/**
 * @param {object | null | undefined} row
 * @returns {string}
 */
export function fingerprintAgentPresence(row) {
  if (!row || row.state === 'idle') return '';
  return [
    row.state || '',
    row.delegationId || '',
    row.attention === true ? '1' : '0',
    String(row.waitingAgentCount || 0),
    row.activityKey || '',
    row.activityArg || '',
  ].join('|');
}

/**
 * @param {object | null | undefined} row
 * @param {{ activityKey?: string, activityArg?: string } | null} [activity]
 * @returns {object | null}
 */
export function mergePresenceActivity(row, activity) {
  if (!row || row.state === 'idle') return row || null;
  if (!activity?.activityKey) {
    const copy = { ...row };
    delete copy.activityKey;
    delete copy.activityArg;
    return copy;
  }
  return {
    ...row,
    activityKey: activity.activityKey,
    activityArg: activity.activityArg || '',
  };
}

/**
 * Widget sockets only receive rows for allowlisted chat ids.
 *
 * @param {Record<string, object>} states
 * @param {string[]} cleared
 * @param {{ kind?: string, chatIds?: Iterable<string> }} [scope]
 * @returns {{ states: Record<string, object>, cleared: string[] }}
 */
export function filterPresenceForScope(states, cleared, scope = {}) {
  if (scope.kind !== 'widget') {
    return {
      states: states && typeof states === 'object' ? states : {},
      cleared: Array.isArray(cleared) ? cleared : [],
    };
  }
  const allowed = new Set(
    [...(scope.chatIds || [])].map((id) => String(id || '').trim()).filter(Boolean)
  );
  /** @type {Record<string, object>} */
  const nextStates = {};
  for (const [id, row] of Object.entries(states && typeof states === 'object' ? states : {})) {
    if (!allowed.has(id)) continue;
    nextStates[id] = row;
  }
  return {
    states: nextStates,
    cleared: (Array.isArray(cleared) ? cleared : []).filter((id) => allowed.has(id)),
  };
}
