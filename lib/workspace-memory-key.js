/**
 * Shared key convention for durable workspace-memory blocker facts.
 *
 * A blocker recorded by one watcher cycle must be recognizable by every later
 * reader (prompt relevance/dedup here, default TTL in the 30830470 leaf), so the
 * key format is a tiny contract instead of free-form text:
 *
 *   blocker:todo:<todoId>:<cause>
 *   blocker:harness:<harness>:<model-or-*>:<cause>
 *
 * `model` is percent-encoded so a model id may contain the `:` separator;
 * `*` means "any model of this harness". Unknown/legacy keys are not parsed and
 * are deduplicated by exact normalized key only — historical entries are never
 * migrated by force.
 */

/** Blocker causes that are considered temporary. */
export const WORKSPACE_MEMORY_TRANSIENT_CAUSES = Object.freeze([
  'quota',
  'rate_limit',
  'slot_busy',
  'model_unavailable',
]);

/**
 * Normalized key: trim only, case is preserved (model ids and causes are
 * case-sensitive identifiers, not prose).
 *
 * @param {unknown} key
 * @returns {string}
 */
export function normalizeMemoryKey(key) {
  return String(key ?? '').trim();
}

/**
 * @param {unknown} todoId
 * @param {unknown} cause
 * @returns {string} empty string when an argument is missing
 */
export function buildTodoBlockerKey(todoId, cause) {
  const id = String(todoId ?? '').trim();
  const reason = String(cause ?? '').trim();
  if (!id || !reason) return '';
  return `blocker:todo:${id}:${reason}`;
}

/**
 * @param {unknown} harness
 * @param {unknown} model `null`/empty means every model of the harness
 * @param {unknown} cause
 * @returns {string} empty string when an argument is missing
 */
export function buildHarnessBlockerKey(harness, model, cause) {
  const harnessId = String(harness ?? '').trim();
  const reason = String(cause ?? '').trim();
  if (!harnessId || !reason) return '';
  const modelId = String(model ?? '').trim();
  return `blocker:harness:${harnessId}:${modelId ? encodeURIComponent(modelId) : '*'}:${reason}`;
}

/**
 * Parse a blocker key of the documented convention.
 *
 * @param {unknown} key
 * @returns {{
 *   scope: 'todo',
 *   todoId: string,
 *   cause: string,
 *   identity: string,
 * } | {
 *   scope: 'harness',
 *   harness: string,
 *   model: string,
 *   cause: string,
 *   identity: string,
 * } | null}
 */
export function parseBlockerKey(key) {
  const raw = normalizeMemoryKey(key);
  const parts = raw.split(':');
  if (parts.length < 4 || parts[0] !== 'blocker') return null;
  if (parts[1] === 'todo') {
    const todoId = String(parts[2] ?? '').trim();
    const cause = String(parts.slice(3).join(':') ?? '').trim();
    if (!todoId || !cause) return null;
    return { scope: 'todo', todoId, cause, identity: `blocker:todo:${todoId}:${cause}` };
  }
  if (parts[1] === 'harness') {
    if (parts.length < 5) return null;
    const harness = String(parts[2] ?? '').trim();
    const encodedModel = String(parts[3] ?? '').trim();
    const cause = String(parts.slice(4).join(':') ?? '').trim();
    if (!harness || !encodedModel || !cause) return null;
    let model = '';
    if (encodedModel !== '*') {
      try {
        model = decodeURIComponent(encodedModel);
      } catch {
        return null;
      }
    }
    return {
      scope: 'harness',
      harness,
      model,
      cause,
      identity: `blocker:harness:${harness}:${encodedModel}:${cause}`,
    };
  }
  return null;
}

/**
 * @param {unknown} cause
 * @returns {boolean}
 */
export function isTransientBlockerCause(cause) {
  return WORKSPACE_MEMORY_TRANSIENT_CAUSES.includes(String(cause ?? '').trim());
}

/**
 * Deduplication identity of one memory entry. Two entries with the same identity
 * describe the same topic and only the newest should reach the prompt:
 *   - a recognized blocker collapses on scope + cause (so two causes of the same
 *     todo stay separate, and two models stay separate),
 *   - everything else (including legacy blocker keys) collapses on
 *     `type` + exact normalized key.
 *
 * @param {{ type?: unknown, key?: unknown }} entry
 * @returns {string}
 */
export function memoryEntryDedupKey(entry) {
  const type = String(entry?.type ?? 'context').trim().toLowerCase();
  const key = normalizeMemoryKey(entry?.key);
  if (type === 'blocker') {
    const parsed = parseBlockerKey(key);
    if (parsed) return parsed.identity;
  }
  return `${type}:${key}`;
}

/**
 * Harness/model scope of a recognized harness blocker (without the cause), used
 * to keep only the newest blocker per harness/model in the prompt.
 *
 * @param {{ type?: unknown, key?: unknown }} entry
 * @returns {string} empty string when the entry is not a harness blocker
 */
export function harnessBlockerScopeKey(entry) {
  const type = String(entry?.type ?? '').trim().toLowerCase();
  if (type !== 'blocker') return '';
  const parsed = parseBlockerKey(entry?.key);
  if (!parsed || parsed.scope !== 'harness') return '';
  return `${parsed.harness}\u0000${parsed.model}`;
}
