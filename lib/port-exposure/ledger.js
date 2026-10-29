/**
 * Exposure ledger in `data/port-exposures.json` (store.port-exposures in
 * docs/storage-registry.json). Only entries recorded here may ever be closed or
 * reconciled; a rule that is not in the ledger is foreign.
 *
 * Entry: { port, backend, owner: 'user'|'chat:<id>'|'app:<id>', createdBy, reason,
 *          createdAt, expiresAt?, state: 'pending_manual'|'active'|'drift'|'close_pending'|'closed',
 *          targetIp?, commands?, closeRequestedAt?, closeRequestedBy?, closedAt?, closedBy?, closeReason? }
 * `close_pending`: a close was requested but Cretli could not remove the rule itself; the entry
 * stays open until diagnostics confirm the rule is gone, then it becomes `closed`.
 * Closed entries stay as a short audit trail (the actor of every close).
 */

import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../persist/atomic-write.js';
import { resolveDataPath } from '../runtime-paths.js';

export const LEDGER_FILE = 'port-exposures.json';
export const LEDGER_SCHEMA_VERSION = 1;
export const MAX_CLOSED_HISTORY = 100;

/** @param {{ file?: string }} [options] */
export function createExposureLedger(options = {}) {
  const file = options.file || resolveDataPath(LEDGER_FILE);
  /** @type {any[] | null} */
  let cache = null;

  function load() {
    if (cache) return cache;
    cache = [];
    try {
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(doc?.entries)) cache = doc.entries.filter((e) => e && Number.isInteger(e.port));
    } catch { /* A missing or corrupt ledger starts empty; nothing is then considered Cretli-owned. */ }
    return cache;
  }

  function persist() {
    const entries = load();
    const open = entries.filter((e) => e.state !== 'closed');
    const closed = entries.filter((e) => e.state === 'closed').slice(-MAX_CLOSED_HISTORY);
    cache = [...closed, ...open];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeJsonAtomic(file, { schemaVersion: LEDGER_SCHEMA_VERSION, entries: cache });
  }

  return {
    /** Open (non-closed) entries. */
    open() { return load().filter((e) => e.state !== 'closed').map((e) => ({ ...e })); },
    history() { return load().filter((e) => e.state === 'closed').map((e) => ({ ...e })); },
    get(port) {
      const e = load().find((x) => x.port === port && x.state !== 'closed');
      return e ? { ...e } : null;
    },
    put(entry) {
      const entries = load();
      const idx = entries.findIndex((x) => x.port === entry.port && x.state !== 'closed');
      if (idx >= 0) entries[idx] = { ...entry }; else entries.push({ ...entry });
      persist();
      return { ...entry };
    },
    patch(port, patch) {
      const entries = load();
      const idx = entries.findIndex((x) => x.port === port && x.state !== 'closed');
      if (idx < 0) return null;
      const next = { ...entries[idx], ...patch };
      for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
      entries[idx] = next;
      persist();
      return { ...next };
    },
  };
}
