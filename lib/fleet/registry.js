/** Fleet credentials are plaintext at rest, protected by mode 0600 like mcp-secrets.json. */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { resolveDataPath } from '../runtime-paths.js';

export class FleetRegistryError extends Error {
  constructor(code) { super(code); this.code = code; }
}
function invalid() { throw new FleetRegistryError('fleetInvalidInstance'); }
export function validateFleetUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) invalid();
  let url;
  try { url = new URL(value); } catch { invalid(); }
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash) invalid();
  return url.href.replace(/\/+$/, '');
}
function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid();
  const { name, token, ownerLabel = '' } = input;
  if (typeof name !== 'string' || !name.trim() || name.length > 200 || typeof ownerLabel !== 'string' || ownerLabel.length > 200 || typeof token !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(token)) invalid();
  return { id: input.id, name: name.trim(), url: validateFleetUrl(input.url), ownerLabel: ownerLabel.trim(), token };
}
function publicEntry({ id, name, url, ownerLabel }) { return { id, name, url, ownerLabel }; }

export class FleetRegistry extends EventEmitter {
  #entries = new Map();
  #file;
  constructor({ dataDir = resolveDataPath() } = {}) {
    super();
    this.#file = path.join(dataDir, 'fleet-instances.json');
    try {
      const rows = JSON.parse(fs.readFileSync(this.#file, 'utf8'));
      if (!Array.isArray(rows)) invalid();
      for (const row of rows) {
        if (typeof row?.id !== 'string' || !/^[a-f0-9-]{36}$/.test(row.id) || this.#entries.has(row.id)) invalid();
        this.#entries.set(row.id, validate(row));
      }
      fs.chmodSync(this.#file, 0o600);
    } catch (err) {
      if (err.code !== 'ENOENT') throw new FleetRegistryError('fleetStorageUnavailable');
    }
  }
  list() { return [...this.#entries.values()].map(publicEntry); }
  get(id) { const entry = this.#entries.get(id); return entry ? publicEntry(entry) : null; }
  /** Internal polling boundary; routes must use list/get, which omit credentials. */
  credentials(id) { const entry = this.#entries.get(id); return entry ? { ...entry } : null; }
  #save(next) {
    const temporary = `${this.#file}.${randomUUID()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.#file), { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify([...next.values()]), { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, this.#file);
    } catch {
      try { fs.unlinkSync(temporary); } catch { /* The temporary file may not have been created. */ }
      throw new FleetRegistryError('fleetStorageUnavailable');
    }
    this.#entries = next;
  }
  create(input) {
    const entry = validate({ ...input, id: randomUUID() });
    this.#save(new Map(this.#entries).set(entry.id, entry));
    this.emit('change', entry.id);
    return publicEntry(entry);
  }
  update(id, input) {
    const old = this.#entries.get(id);
    if (!old) throw new FleetRegistryError('fleetInstanceNotFound');
    if (!input || typeof input !== 'object' || Array.isArray(input)) invalid();
    const entry = validate({ ...old, ...input, id });
    this.#save(new Map(this.#entries).set(id, entry));
    this.emit('change', id);
    return publicEntry(entry);
  }
  remove(id) {
    if (!this.#entries.has(id)) throw new FleetRegistryError('fleetInstanceNotFound');
    const next = new Map(this.#entries);
    next.delete(id);
    this.#save(next);
    this.emit('change', id);
  }
}
