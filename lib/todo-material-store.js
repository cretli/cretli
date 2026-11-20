/**
 * Content-addressed store for todo `leafMaterial` (docs/todo-scalable-architecture.md, section 3.5).
 *
 * Layout under `<dataDir>/todo-material/`:
 *   <aa>/<sha256 hex>            content (JSON text), sharded by the first two hex characters
 *   <aa>/<sha256 hex>.deleting   content marked by GC; never referenced, about to be unlinked
 *   pins/<hex>.<epoch>.pin       writer pin (epoch, lease) written BEFORE the content exists
 *
 * Exclusion. Every todo document writer already runs under the cross-process workspace file lock
 * (`withWorkspaceWatchersFileLock`, a SQLite write transaction on a private lock database). The kernel drops
 * that lock when its holder dies and it has no lease, so it gives true mutual exclusion. This store reuses it
 * and invents no lock of its own:
 *   - a writer validates its pins, writes the document durably and consumes the pins inside the lock
 *     (`commit`); it already holds the lock when it comes from `persist()`;
 *   - GC and recovery take the SAME lock around each destructive step (one candidate hash, one expired pin),
 *     re-reading references and pins inside it, and never hold it across a whole scan;
 *   - pin leases only expire abandoned publications. Expiry removal happens inside the lock and a writer
 *     validates its pin inside the lock, so a writer that was paused past its lease and comes back after
 *     recovery removed the pin fails validation and republishes.
 * The lock is a single per-data-directory lock, so no ordering between several locks is ever needed.
 *
 * Publication protocol (JSON phase):
 *   1. write the pin file, fsync the pins directory (every new directory is fsynced in its parent);
 *   2. write the content to a temp file in its shard, fsync it, rename to the hash name, fsync the shard;
 *   3. `commit()` re-validates pins and content, runs the caller's durable document write and only then
 *      consumes the pins.
 * GC deletes a hash only when it is unreferenced, has no live pin and is older than the grace period, by
 * renaming it to `.deleting` first and re-checking pins and references after the rename.
 *
 * Every fs operation goes through the injectable `ops` helpers and every protocol boundary reports to
 * `hooks.step(name)`, so tests can simulate a crash at each step.
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { withWorkspaceWatchersFileLock } from './persist/workspace-watchers-persist.js';
import { guardJsonShrink } from './backup/shrink-guard.js';

export const TODO_MATERIAL_DIR = 'todo-material';
export const TODO_MATERIAL_REF_PREFIX = 'sha256:';
export const DEFAULT_PIN_LEASE_MS = 10 * 60 * 1000;
export const DEFAULT_GC_GRACE_MS = 24 * 60 * 60 * 1000;
const HEX_RE = /^[0-9a-f]{64}$/;
const REF_RE = /^sha256:([0-9a-f]{64})$/;
const DELETING_SUFFIX = '.deleting';

/**
 * @typedef {{ $ref: string, bytes: number }} TodoMaterialRef
 * @typedef {{ pinId: string, hash: string, epoch: string, leaseUntil: number }} PinRecord
 */

export class TodoMaterialError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'TodoMaterialError';
    this.code = code;
    this.details = details;
  }
}

/**
 * @param {unknown} value
 * @returns {value is TodoMaterialRef}
 */
export function isTodoMaterialRef(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && typeof /** @type {any} */ (value).$ref === 'string' && REF_RE.test(/** @type {any} */ (value).$ref);
}

/**
 * @param {TodoMaterialRef} ref
 * @returns {string} hex hash
 */
export function refHash(ref) {
  const match = isTodoMaterialRef(ref) ? REF_RE.exec(ref.$ref) : null;
  if (!match) throw new TodoMaterialError('TODO_MATERIAL_REF_INVALID', 'Invalid leafMaterial reference');
  return match[1];
}

/** @param {string | Buffer} bytes @returns {string} */
export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Real fs primitives; tests replace individual entries. */
export const defaultOps = Object.freeze({
  mkdirSync: (/** @type {string} */ dir) => fs.mkdirSync(dir, { mode: 0o700 }),
  /** Exclusive-create + fsync; refuses to replace anything. */
  writeFileDurable: (/** @type {string} */ file, /** @type {string | Buffer} */ content) => {
    const fd = fs.openSync(file, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, content);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  },
  fsyncFile: (/** @type {string} */ file) => {
    const fd = fs.openSync(file, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  },
  fsyncDir: (/** @type {string} */ dir) => {
    const fd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  },
  renameSync: (/** @type {string} */ from, /** @type {string} */ to) => fs.renameSync(from, to),
  unlinkSync: (/** @type {string} */ file) => fs.unlinkSync(file),
  readFileSync: (/** @type {string} */ file) => fs.readFileSync(file),
  readdirSync: (/** @type {string} */ dir) => fs.readdirSync(dir),
  statSync: (/** @type {string} */ file) => fs.statSync(file),
  existsSync: (/** @type {string} */ file) => fs.existsSync(file),
});

/**
 * @param {{ dataDir: string, ops?: Partial<typeof defaultOps>, hooks?: { step?: (name: string, info?: any) => void },
 *   now?: () => number, leaseMs?: number, lockTimeoutMs?: number,
 *   withLock?: <T>(work: () => T) => T }} options `withLock` replaces the workspace file lock (tests only)
 */
export function createTodoMaterialStore(options) {
  const root = path.join(path.resolve(options.dataDir), TODO_MATERIAL_DIR);
  const pinsDir = path.join(root, 'pins');
  const ops = { ...defaultOps, ...(options.ops || {}) };
  const now = options.now || Date.now;
  const leaseMs = options.leaseMs || DEFAULT_PIN_LEASE_MS;
  const epoch = `${process.pid}-${randomBytes(6).toString('hex')}`;
  /** @type {Map<string, PinRecord>} */
  const pending = new Map();
  /** @param {string} name @param {any} [info] */
  const step = (name, info) => { if (options.hooks?.step) options.hooks.step(name, info); };

  /** @param {string} hash */
  const shardDir = (hash) => path.join(root, hash.slice(0, 2));
  /** @param {string} hash */
  const contentPath = (hash) => path.join(shardDir(hash), hash);
  /** @param {string} hash */
  const deletingPath = (hash) => contentPath(hash) + DELETING_SUFFIX;
  /** @param {string} hash */
  const pinPathFor = (hash) => path.join(pinsDir, `${hash}.${epoch}.pin`);

  /**
   * Create a directory chain and fsync the parent of every directory that gained an entry, so the
   * new entries themselves are durable (fsyncing a child never persists its entry in the parent).
   *
   * @param {string} dir
   */
  function ensureDir(dir) {
    /** @type {string[]} */
    const missing = [];
    for (let cur = dir; !ops.existsSync(cur);) {
      missing.push(cur);
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    for (const created of missing.reverse()) {
      try { ops.mkdirSync(created); } catch (error) { if (/** @type {any} */ (error)?.code !== 'EEXIST') throw error; }
      ops.fsyncDir(path.dirname(created));
    }
  }

  /** @returns {Array<{ file: string, pin: PinRecord | null }>} */
  function listPins() {
    if (!ops.existsSync(pinsDir)) return [];
    return ops.readdirSync(pinsDir).filter((n) => n.endsWith('.pin')).map((name) => {
      const file = path.join(pinsDir, name);
      let pin = null;
      try {
        const parsed = JSON.parse(String(ops.readFileSync(file)));
        if (parsed && HEX_RE.test(parsed.hash) && typeof parsed.epoch === 'string' && Number.isFinite(parsed.leaseUntil)) pin = parsed;
      } catch { /* unreadable pin = no valid pin */ }
      return { file, pin };
    });
  }

  /** @param {string} hash @param {number} at */
  function hasLivePin(hash, at) {
    return listPins().some(({ pin }) => pin && pin.hash === hash && pin.leaseUntil > at);
  }

  /**
   * Run `work` under the workspace file lock (re-entrant in this process, released by the kernel if the
   * holder dies). Keep critical sections short: one candidate, one pin, one commit.
   *
   * @template T
   * @param {() => T} work
   * @returns {T}
   */
  function locked(work) {
    if (options.withLock) return options.withLock(work);
    const lockOptions = { dataDir: options.dataDir, ...(options.lockTimeoutMs !== undefined ? { lockTimeoutMs: options.lockTimeoutMs } : {}) };
    return withWorkspaceWatchersFileLock(work, lockOptions);
  }

  // ---- publication ------------------------------------------------------------------------------

  /**
   * Step 1 + 2 of the protocol. Returns the reference; the pin stays until the commit consumes it.
   *
   * @param {unknown} material JSON-serializable material
   * @returns {TodoMaterialRef}
   */
  function publish(material) {
    return publishBuffer(Buffer.from(JSON.stringify(material), 'utf8'));
  }

  /**
   * Publish already serialized content (rollback import). The caller guarantees the bytes are what the hash names.
   *
   * @param {Buffer} buffer
   * @param {string} [expectedHash] refuse when the bytes hash differently
   * @returns {TodoMaterialRef}
   */
  function publishBuffer(buffer, expectedHash) {
    const hash = sha256Hex(buffer);
    if (expectedHash && expectedHash !== hash) throw new TodoMaterialError('TODO_MATERIAL_CORRUPT', 'Imported material does not match its hash', { hash: expectedHash });
    const ref = { $ref: TODO_MATERIAL_REF_PREFIX + hash, bytes: buffer.length };
    ensureDir(pinsDir);
    const pinFile = pinPathFor(hash);
    /** @type {PinRecord} */
    const record = { pinId: path.basename(pinFile), hash, epoch, leaseUntil: now() + leaseMs };
    // A pin of this writer for the same hash may exist from an earlier publish: replace it with a fresh lease.
    if (ops.existsSync(pinFile)) ops.unlinkSync(pinFile);
    ops.writeFileDurable(pinFile, JSON.stringify(record));
    step('pin-written', { hash });
    ops.fsyncDir(pinsDir);
    step('pin-synced', { hash });
    writeContent(hash, buffer);
    pending.set(hash, record);
    return ref;
  }

  /**
   * @param {string} hash
   * @param {Buffer} buffer
   */
  function writeContent(hash, buffer) {
    const dir = shardDir(hash);
    ensureDir(dir);
    const target = contentPath(hash);
    // Lock-free fast path: intact content needs no change. Nothing destructive happens here, and our pin (written
    // and fsynced before this point) keeps GC away from the hash until commit validates it under the lock.
    if (readVerified(target, hash)) {
      // An earlier writer may have crashed between rename and directory fsync.
      ops.fsyncDir(dir);
      return;
    }
    // Replacement material is prepared outside the lock; every decision about the target is made inside it.
    const temp = path.join(dir, `${hash}.${randomBytes(6).toString('hex')}.tmp`);
    ops.writeFileDurable(temp, buffer);
    step('temp-written', { hash });
    try {
      locked(() => {
        // A `.deleting` mark can only be a crashed GC's leftover here (GC marks and unlinks inside one critical
        // section). Our pin protects the hash, so put the content back before judging it.
        if (ops.existsSync(deletingPath(hash))) {
          if (ops.existsSync(target)) ops.unlinkSync(deletingPath(hash));
          else ops.renameSync(deletingPath(hash), target);
        }
        // Re-validate after acquiring the lock: another publisher may have restored the hash meanwhile.
        if (readVerified(target, hash)) {
          ops.unlinkSync(temp);
          return;
        }
        // Absent or corrupt: an atomic rename replaces the target, which is never unlinked first.
        ops.renameSync(temp, target);
        step('renamed', { hash });
      });
    } catch (error) {
      try { ops.unlinkSync(temp); } catch { /* already renamed or removed */ }
      throw error;
    }
    ops.fsyncDir(dir);
    step('dir-synced', { hash });
  }

  /**
   * @param {string} file
   * @param {string} hash
   * @returns {boolean} true when the file exists and hashes to `hash`; a missing file is simply absent
   */
  function readVerified(file, hash) {
    try {
      return sha256Hex(/** @type {Buffer} */ (ops.readFileSync(file))) === hash;
    } catch (error) {
      if (/** @type {any} */ (error)?.code === 'ENOENT') return false;
      throw error;
    }
  }

  /**
   * Check, without consuming, that the pin of a published reference is still valid and its content is in place.
   *
   * @param {TodoMaterialRef} ref
   */
  function assertPublished(ref) {
    const hash = refHash(ref);
    assertPin(hash);
    if (!ops.existsSync(contentPath(hash))) {
      throw new TodoMaterialError('TODO_MATERIAL_MISSING', 'Published material vanished before its reference was committed', { hash });
    }
  }

  /** @param {string} hash @returns {string} pin file */
  function assertPin(hash) {
    const held_ = pending.get(hash);
    const file = pinPathFor(hash);
    let current = null;
    try { current = JSON.parse(String(ops.readFileSync(file))); } catch { current = null; }
    if (!held_ || !current || current.epoch !== held_.epoch || current.hash !== hash || !(current.leaseUntil > now())) {
      throw new TodoMaterialError('TODO_MATERIAL_PIN_LOST', 'Material pin expired or was removed; republish', { hash });
    }
    return file;
  }

  /**
   * Standalone pin release (valid pin required). Prefer `commit`, which does this inside the fence.
   *
   * @param {TodoMaterialRef} ref
   */
  function consumePin(ref) {
    const hash = refHash(ref);
    const file = assertPin(hash);
    ops.unlinkSync(file);
    ops.fsyncDir(pinsDir);
    pending.delete(hash);
    step('pin-consumed', { hash });
  }

  /**
   * Commit references under the workspace lock: validate every pin and content file, run `write` (which must
   * durably publish the document carrying the references), then consume the pins. GC and recovery take the same
   * lock for every destructive step, so nothing can remove a validated pin or its content in between. A writer
   * whose pin expired and was discarded fails here before anything is written and must republish.
   *
   * @template T
   * @param {TodoMaterialRef[]} refs
   * @param {() => T} write
   * @returns {T}
   */
  function commit(refs, write) {
    return locked(() => {
      for (const ref of refs) assertPublished(ref);
      step('fence-validated');
      const result = write();
      step('document-committed');
      // Still inside the lock, so recovery cannot have removed the pins: release them without a lease check
      // (the lease may have run out during a slow write).
      for (const hash of new Set(refs.map(refHash))) {
        try { ops.unlinkSync(pinPathFor(hash)); } catch (error) { if (/** @type {any} */ (error)?.code !== 'ENOENT') throw error; }
        pending.delete(hash);
      }
      if (refs.length) ops.fsyncDir(pinsDir);
      step('pin-consumed');
      return result;
    });
  }

  /**
   * Durably replace a todos document that carries references: serialize, write a temp file, fsync it, rename it
   * over the document and fsync the parent directory, so a power loss never exposes a partial replacement.
   *
   * @param {string} filePath
   * @param {unknown} data
   */
  function writeDocumentDurable(filePath, data) {
    const text = JSON.stringify(data);
    guardJsonShrink(filePath, data);
    const temp = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      ops.writeFileDurable(temp, text);
      step('document-temp-synced');
      ops.renameSync(temp, filePath);
      step('document-renamed');
    } catch (error) {
      try { ops.unlinkSync(temp); } catch { /* never created or already renamed */ }
      throw error;
    }
    ops.fsyncDir(path.dirname(filePath));
    step('document-dir-synced');
  }

  /**
   * @param {TodoMaterialRef} ref
   * @returns {any} parsed material
   */
  function read(ref) {
    const hash = refHash(ref);
    let bytes;
    try {
      bytes = /** @type {Buffer} */ (ops.readFileSync(contentPath(hash)));
    } catch (error) {
      if (/** @type {any} */ (error)?.code === 'ENOENT') {
        throw new TodoMaterialError('TODO_MATERIAL_MISSING', `Referenced leafMaterial file is missing (${hash.slice(0, 12)})`, { hash });
      }
      throw error;
    }
    if (sha256Hex(bytes) !== hash || (Number.isFinite(ref.bytes) && bytes.length !== ref.bytes)) {
      throw new TodoMaterialError('TODO_MATERIAL_CORRUPT', `Referenced leafMaterial file failed hash verification (${hash.slice(0, 12)})`, { hash });
    }
    try {
      return JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new TodoMaterialError('TODO_MATERIAL_CORRUPT', `Referenced leafMaterial file is not valid JSON (${hash.slice(0, 12)})`, { hash });
    }
  }

  /** @returns {Array<{ hash: string, file: string, deleting: boolean, mtimeMs: number }>} */
  function listContent() {
    const out = [];
    if (!ops.existsSync(root)) return out;
    for (const shard of ops.readdirSync(root)) {
      if (!/^[0-9a-f]{2}$/.test(shard)) continue;
      const dir = path.join(root, shard);
      for (const name of ops.readdirSync(dir)) {
        const deleting = name.endsWith(DELETING_SUFFIX);
        const hash = deleting ? name.slice(0, -DELETING_SUFFIX.length) : name;
        if (!HEX_RE.test(hash)) continue;
        const file = path.join(dir, name);
        out.push({ hash, file, deleting, mtimeMs: ops.statSync(file).mtimeMs });
      }
    }
    return out;
  }

  /** @param {Set<string> | (() => Set<string>) | undefined} liveRefs */
  const resolveLive = (liveRefs) => {
    if (liveRefs === undefined) return collectLiveHashes(options.dataDir);
    return typeof liveRefs === 'function' ? liveRefs() : liveRefs;
  };

  /**
   * Delete unreferenced, unpinned, old content. A lock-free pre-pass picks candidates; each candidate is then
   * handled in its own short critical section under the workspace lock that re-reads references (a fresh scan of
   * the todos documents when `liveRefs` is not supplied) and pins, marks `.deleting`, re-checks, and unlinks.
   * An unreadable document aborts the run before anything is deleted.
   *
   * @param {{ liveRefs?: Set<string> | (() => Set<string>), now?: number, graceMs?: number, dryRun?: boolean }} [params]
   * @returns {{ deleted: string[], skipped: Array<{ hash: string, reason: string }> }}
   */
  function gc(params = {}) {
    const at = params.now ?? now();
    const graceMs = params.graceMs ?? DEFAULT_GC_GRACE_MS;
    const deleted = [];
    const skipped = [];
    const hint = resolveLive(params.liveRefs);
    for (const entry of listContent()) {
      const { hash } = entry;
      if (entry.deleting) continue;
      if (hint.has(hash)) { skipped.push({ hash, reason: 'referenced' }); continue; }
      if (hasLivePin(hash, at)) { skipped.push({ hash, reason: 'pinned' }); continue; }
      if (at - entry.mtimeMs < graceMs) { skipped.push({ hash, reason: 'young' }); continue; }
      if (params.dryRun) { deleted.push(hash); continue; }
      const verdict = locked(() => {
        if (!ops.existsSync(entry.file)) return 'gone';
        // Everything is re-read inside the critical section; the pre-pass above was only a filter.
        if (resolveLive(params.liveRefs).has(hash)) return 'referenced';
        if (hasLivePin(hash, at)) return 'pinned';
        ops.renameSync(entry.file, deletingPath(hash));
        step('gc-marked', { hash });
        // A pin may be written without the lock (publish step 1); re-check after the mark and roll back.
        if (resolveLive(params.liveRefs).has(hash) || hasLivePin(hash, at)) {
          ops.renameSync(deletingPath(hash), entry.file);
          return 'appeared';
        }
        ops.unlinkSync(deletingPath(hash));
        ops.fsyncDir(path.dirname(entry.file));
        step('gc-unlinked', { hash });
        return 'deleted';
      });
      if (verdict === 'deleted') deleted.push(hash); else if (verdict !== 'gone') skipped.push({ hash, reason: verdict });
    }
    return { deleted, skipped };
  }

  /**
   * Restart recovery: expired pins, stale temp files and an interrupted GC (`.deleting` leftovers). Each
   * destructive step runs in its own critical section under the workspace lock, conditions re-checked inside it.
   *
   * @param {{ liveRefs?: Set<string> | (() => Set<string>), now?: number, graceMs?: number }} [params]
   * @returns {{ removedPins: string[], restored: string[], removedDeleting: string[], removedTemp: string[] }}
   */
  function recover(params = {}) {
    const at = params.now ?? now();
    const graceMs = params.graceMs ?? DEFAULT_GC_GRACE_MS;
    const out = { removedPins: /** @type {string[]} */ ([]), restored: /** @type {string[]} */ ([]), removedDeleting: /** @type {string[]} */ ([]), removedTemp: /** @type {string[]} */ ([]) };
    if (!ops.existsSync(root)) return out;
    for (const { file, pin } of listPins()) {
      if (pin && pin.leaseUntil > at) continue;
      locked(() => {
        let current = null;
        try { current = JSON.parse(String(ops.readFileSync(file))); } catch (error) {
          if (/** @type {any} */ (error)?.code === 'ENOENT') return;
          current = null;
        }
        if (current && Number.isFinite(current.leaseUntil) && current.leaseUntil > at) return;
        ops.unlinkSync(file);
        ops.fsyncDir(pinsDir);
        out.removedPins.push(path.basename(file));
      });
    }
    for (const shard of ops.readdirSync(root)) {
      if (!/^[0-9a-f]{2}$/.test(shard)) continue;
      const dir = path.join(root, shard);
      for (const name of ops.readdirSync(dir)) {
        const file = path.join(dir, name);
        if (name.endsWith('.tmp')) {
          locked(() => {
            if (ops.existsSync(file) && at - ops.statSync(file).mtimeMs >= graceMs) { ops.unlinkSync(file); out.removedTemp.push(name); }
          });
        } else if (name.endsWith(DELETING_SUFFIX)) {
          const hash = name.slice(0, -DELETING_SUFFIX.length);
          locked(() => {
            if (!ops.existsSync(file)) return;
            // Without a reference set the safe action is to restore: nothing is lost by keeping it.
            const live = params.liveRefs ? resolveLive(params.liveRefs) : null;
            if (live && !live.has(hash) && !hasLivePin(hash, at)) {
              ops.unlinkSync(file);
              out.removedDeleting.push(hash);
            } else if (ops.existsSync(path.join(dir, hash))) {
              ops.unlinkSync(file);
            } else {
              ops.renameSync(file, path.join(dir, hash));
              out.restored.push(hash);
            }
          });
        }
      }
    }
    return out;
  }

  return {
    root, pinsDir, epoch, publish, publishBuffer, assertPublished, consumePin, commit, writeDocumentDurable,
    read, gc, recover, listContent, listPins, contentPath,
  };
}

/** @type {Map<string, ReturnType<typeof createTodoMaterialStore>>} */
const sharedStores = new Map();

/**
 * Process-wide store for a data directory (one writer epoch per process).
 *
 * @param {string} dataDir
 */
export function getTodoMaterialStore(dataDir) {
  const key = path.resolve(dataDir);
  let store = sharedStores.get(key);
  if (!store) {
    store = createTodoMaterialStore({ dataDir: key });
    sharedStores.set(key, store);
  }
  return store;
}

/**
 * Test seam: use a store built with injected ops/hooks for a data directory.
 *
 * @param {string} dataDir
 * @param {ReturnType<typeof createTodoMaterialStore>} store
 */
export function registerTodoMaterialStore(dataDir, store) {
  sharedStores.set(path.resolve(dataDir), store);
}

/** Test seam: forget cached stores. */
export function resetTodoMaterialStores() {
  sharedStores.clear();
}

/** @returns {boolean} true when new done-leaf material is written as references */
export function isTodoMaterialExternalEnabled() {
  return process.env.CRETLI_TODO_MATERIAL_EXTERNAL === '1';
}

/**
 * Every `$ref` under `leafMaterial` of the todos documents in `<dataDir>/todos/`.
 *
 * @param {string} dataDir
 * @returns {Array<{ file: string, itemId: string, ref: TodoMaterialRef }>}
 */
export function collectMaterialRefs(dataDir) {
  const dir = path.join(path.resolve(dataDir), 'todos');
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir).sort()) {
    // Documents and their shrink-guard copies; anything else in the directory cannot carry live references.
    if (!/^[0-9a-f]{64}\.json(\.pre-shrink-.*)?$/.test(name)) continue;
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    } catch (error) {
      // Fail closed: skipping a document would let GC delete content that document still references.
      throw new TodoMaterialError('TODO_MATERIAL_DOCS_UNREADABLE', `Cannot read todos document ${name}; refusing to enumerate references`, { file: name, cause: String(/** @type {any} */ (error)?.message || error) });
    }
    if (!doc || typeof doc !== 'object' || !Array.isArray(doc.items)) {
      throw new TodoMaterialError('TODO_MATERIAL_DOCS_UNREADABLE', `Todos document ${name} has no items array; refusing to enumerate references`, { file: name });
    }
    for (const item of doc.items) {
      if (isTodoMaterialRef(item?.leafMaterial)) out.push({ file: name, itemId: String(item?.id), ref: item.leafMaterial });
    }
  }
  return out;
}

/** @param {string} dataDir @returns {Set<string>} hex hashes referenced by documents */
export function collectLiveHashes(dataDir) {
  return new Set(collectMaterialRefs(dataDir).map(({ ref }) => refHash(ref)));
}

/**
 * @param {string} dataDir
 * @param {Array<{ file: string, itemId: string, ref: TodoMaterialRef }>} refs
 */
function checkRefs(dataDir, refs, options) {
  const store = getTodoMaterialStore(dataDir);
  const missing = [];
  const corrupt = [];
  for (const { file, itemId, ref } of refs) {
    const hash = refHash(ref);
    const where = { file, itemId, hash };
    if (!fs.existsSync(store.contentPath(hash))) { missing.push(where); continue; }
    if (options.verifyHash !== false) {
      try { store.read(ref); } catch (error) {
        if (/** @type {any} */ (error)?.code === 'TODO_MATERIAL_MISSING') missing.push(where); else corrupt.push(where);
      }
    }
  }
  return { refs: refs.length, missing, corrupt };
}

/**
 * Reference closure: every `$ref` in the documents has an intact file.
 *
 * @param {string} dataDir
 * @param {{ verifyHash?: boolean }} [options]
 * @returns {{ refs: number, missing: Array<{ file: string, itemId: string, hash: string }>, corrupt: Array<{ file: string, itemId: string, hash: string }> }}
 */
export function verifyReferenceClosure(dataDir, options = {}) {
  return checkRefs(dataDir, collectMaterialRefs(dataDir), options);
}

/**
 * Same check for already parsed documents (migration source, rollback export), keyed by document name.
 *
 * @param {string} dataDir
 * @param {Record<string, { items?: any[] }>} docs
 * @param {{ verifyHash?: boolean }} [options]
 */
export function verifyDocsReferenceClosure(dataDir, docs, options = {}) {
  const refs = [];
  for (const [file, doc] of Object.entries(docs)) {
    for (const item of Array.isArray(doc?.items) ? doc.items : []) {
      if (isTodoMaterialRef(item?.leafMaterial)) refs.push({ file, itemId: String(item.id), ref: item.leafMaterial });
    }
  }
  return checkRefs(dataDir, refs, options);
}

/**
 * Hash of every content file in the store (name = expected sha256), for manifests.
 *
 * @param {string} dataDir
 * @returns {Array<{ hash: string, bytes: number }>} sorted by hash
 */
export function listMaterialFiles(dataDir) {
  const store = getTodoMaterialStore(dataDir);
  return store.listContent().filter((e) => !e.deleting)
    .map((e) => ({ hash: e.hash, bytes: fs.statSync(e.file).size }))
    .sort((a, b) => (a.hash < b.hash ? -1 : 1));
}
