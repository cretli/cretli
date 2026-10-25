/**
 * Signals for the Todo list: tree expansion, bulk selection and list filters.
 * Values are immutable (every change swaps in a new Set) so a signal notifies
 * exactly when the data changed. DOM-free so it can be unit tested in Node.
 * Docs: docs/shared-state.md.
 */
import { signal } from '@lit-labs/signals';
import { probeSync } from '../lib/perfProbe.js';

/** @template T @param {Iterable<T> | null | undefined} values */
const toSet = (values) => new Set(values || []);

/**
 * @param {{ integrationDefault?: Iterable<string> }} [options]
 *   `integrationDefault`: the integration filter a fresh panel starts with.
 */
export function createTodoListState(options = {}) {
  const collapsed = signal(/** @type {Set<string>} */ (new Set()));
  const batchSelected = signal(/** @type {Set<string>} */ (new Set()));
  /** `null` = every status. */
  const rootStatus = signal(/** @type {Set<string> | null} */ (null));
  const review = signal(/** @type {'' | 'none' | 'stale'} */ (''));
  const integration = signal(/** @type {Set<string>} */ (toSet(options.integrationDefault)));

  /** Applies `mutate` to a copy and publishes it only when the membership changed. */
  function update(source, mutate) {
    const next = toSet(source.get());
    const before = next.size;
    const changed = mutate(next);
    if (changed === false) return false;
    if (next.size === before && changed !== true) return false;
    source.set(next);
    return true;
  }

  const api = {
    collapsed,
    batchSelected,
    rootStatus,
    review,
    integration,
    setCollapsed(ids) {
      collapsed.set(toSet(ids));
    },
    /** @returns {boolean} true when the branch is collapsed afterwards */
    toggleCollapsed(id) {
      const key = String(id);
      const next = toSet(collapsed.get());
      const nowCollapsed = !next.delete(key);
      if (nowCollapsed) next.add(key);
      collapsed.set(next);
      return nowCollapsed;
    },
    addCollapsed(id) {
      return update(collapsed, (set) => {
        if (set.has(String(id))) return false;
        set.add(String(id));
        return true;
      });
    },
    setBatchSelected(ids) {
      batchSelected.set(toSet(ids));
    },
    clearBatchSelected() {
      if (batchSelected.get().size) batchSelected.set(new Set());
    },
    setBatchChecked(id, checked) {
      const key = String(id);
      return update(batchSelected, (set) => {
        if (set.has(key) === !!checked) return false;
        if (checked) set.add(key);
        else set.delete(key);
        return true;
      });
    },
    toggleBatchSelected(id) {
      const key = String(id);
      return this.setBatchChecked(key, !batchSelected.get().has(key));
    },
    setRootStatus(value) {
      rootStatus.set(value ? toSet(value) : null);
    },
    setReview(value) {
      review.set(value === 'none' || value === 'stale' ? value : '');
    },
    setIntegration(values) {
      integration.set(toSet(values));
    },
    setIntegrationChecked(filter, checked) {
      return update(integration, (set) => {
        if (set.has(filter) === !!checked) return false;
        if (checked) set.add(filter);
        else set.delete(filter);
        return true;
      });
    },
  };
  // Time every mutator (the synchronous part of a signal publish; subscriber
  // effects run later and show up in their own steps).
  for (const key of Object.keys(api)) {
    const fn = api[key];
    if (typeof fn !== 'function') continue;
    api[key] = function timed(...args) {
      return probeSync(`todo.state.${key}`, () => fn.apply(api, args));
    };
  }
  return api;
}
