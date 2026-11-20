/**
 * Registry of live MCP connection owners (chat rooms), reported per harness.
 *
 * Each harness registers a source returning its live `[sessionId, room]` pairs,
 * so the MCP runtime never imports the harness adapters. A room object's
 * identity is its generation: reopening the same sessionId creates a new room
 * and therefore a new generation. This is observation only; it is not a
 * liveness proof by itself and nothing here closes a connection.
 */

/** @type {Map<string, () => Iterable<[string, object]>>} */
const sources = new Map();
/** @type {WeakMap<object, number>} */
const generations = new WeakMap();
let nextGeneration = 1;

/**
 * @param {string} harness
 * @param {() => Iterable<[string, object]>} getRooms
 */
export function registerMcpOwnerSource(harness, getRooms) {
  const name = String(harness || '').trim();
  if (name && typeof getRooms === 'function') sources.set(name, getRooms);
}

/** @param {object} room */
function generationOf(room) {
  let generation = generations.get(room);
  if (!generation) {
    generation = nextGeneration;
    nextGeneration += 1;
    generations.set(room, generation);
  }
  return generation;
}

/**
 * @returns {{ harness: string, sessionId: string, generation: number }[]}
 */
export function listLiveOwners() {
  const out = [];
  for (const [harness, getRooms] of sources) {
    try {
      for (const [sessionId, room] of getRooms()) {
        if (room && typeof room === 'object') out.push({ harness, sessionId: String(sessionId), generation: generationOf(room) });
      }
    } catch {
      // A failing source only hides its owners; classification then says unknown.
    }
  }
  return out;
}

/**
 * Current generation of a live session, or 0 when no reporting harness owns it.
 *
 * @param {string} sessionId
 * @returns {number}
 */
export function currentOwnerGeneration(sessionId) {
  const wanted = String(sessionId || '');
  const found = listLiveOwners().find((owner) => owner.sessionId === wanted);
  return found ? found.generation : 0;
}

/**
 * `live`: the session is reported with the same generation. `ownerless`: its
 * harness reports sessions and none matches (or the generation moved on).
 * `unknown`: no source covers the harness, or the entry has no session.
 *
 * @param {{ sessionId?: string, harness?: string, ownerGeneration?: number }} entry
 * @param {{ harness: string, sessionId: string, generation: number }[]} [owners]
 * @returns {'live' | 'ownerless' | 'unknown'}
 */
export function classifyOwner(entry, owners = listLiveOwners()) {
  const sessionId = String(entry?.sessionId || '');
  const harness = String(entry?.harness || '');
  if (!sessionId || !harness || !sources.has(harness)) return 'unknown';
  const match = owners.find((owner) => owner.sessionId === sessionId && owner.harness === harness);
  if (!match) return 'ownerless';
  if (entry.ownerGeneration && entry.ownerGeneration !== match.generation) return 'ownerless';
  return 'live';
}

export function resetMcpOwnerRegistryForTests() {
  sources.clear();
}
