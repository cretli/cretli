/** Claude transcript retention. Never rewrite settings outside Cretli-owned homes. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveDataPath } from '../runtime-paths.js';
import { listClaudeSubscriptionConfigCandidates } from './claude-subscription.ts';
import { getUsageSettings, parseClaudeTranscriptRetentionDays } from '../usage/usage-settings.ts';

type Status = 'managed' | 'user' | 'external' | 'invalid' | 'unwritable';
type Row = { directory: string; status: Status; cleanupPeriodDays: unknown; projectsBytes: number | null };
type Options = { dataDir?: string; candidates?: string[]; io?: typeof fs; warn?: (message: string) => void };
const snapshots = new Map<string, Row[]>();
const inspectedAt = new Map<string, number>();
const inspections = new Set<string>();
const sizes = new Map<string, { bytes: number | null; expires: number; pending: boolean }>();
let queue: Promise<unknown> = Promise.resolve();

function locations(options: Options) {
  const dataDir = options.dataDir || resolveDataPath();
  const owned = ['claude-home', 'claude-api-home'].map(name => path.join(dataDir, name));
  const candidates = options.candidates ?? (path.resolve(dataDir) !== resolveDataPath() ? [] : listClaudeSubscriptionConfigCandidates());
  return { dataDir, owned, directories: [...new Set([...owned, ...candidates].map(dir => path.resolve(dir)))] };
}

async function readJson(io: typeof fs, file: string) {
  try {
    const stat = await io.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe settings file');
    const text = await io.readFile(file, 'utf8');
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object');
    return { text, value };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { text: null, value: {} };
    throw error;
  }
}

async function atomicWrite(io: typeof fs, file: string, value: unknown, beforeRename?: () => Promise<boolean>) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await io.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    if (beforeRename && !await beforeRename()) return false;
    await io.rename(temp, file);
    return true;
  } finally {
    await io.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function directoryBytes(directory: string): Promise<number> {
  let total = 0;
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; }
  // Sequential traversal bounds open descriptors; symlinks are never followed.
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(file);
    else if (entry.isFile()) total += (await fs.lstat(file)).size;
  }
  return total;
}

function cachedSize(directory: string): number | null {
  let cached = sizes.get(directory);
  if (!cached) { cached = { bytes: null, expires: 0, pending: false }; sizes.set(directory, cached); }
  if (!cached.pending && cached.expires <= Date.now()) {
    cached.pending = true;
    const target = cached;
    void fs.lstat(path.join(directory, 'projects')).then(stat => {
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Unsafe projects directory');
      return directoryBytes(path.join(directory, 'projects'));
    }).then(bytes => { target.bytes = bytes; }).catch(error => {
      target.bytes = error.code === 'ENOENT' ? 0 : null;
    }).finally(() => { target.pending = false; target.expires = Date.now() + 3600_000; });
  }
  return cached.bytes;
}

async function inspect(days: number, options: Options, write: boolean): Promise<Row[]> {
  const io = options.io || fs;
  const warn = options.warn || (message => console.warn(message));
  const { dataDir, owned, directories } = locations(options);
  const stateFile = path.join(dataDir, 'claude-retention-state.json');
  const canonical = new Set<string>();
  const ownedErrors = new Map<string, unknown>();
  const rows: Row[] = [];
  for (const dir of owned) {
    try {
      if (write) await io.mkdir(dir, { recursive: true });
      if (!(await io.lstat(dir)).isSymbolicLink()) canonical.add(await io.realpath(dir));
    } catch (error) { ownedErrors.set(dir, error); }
  }
  for (const directory of directories) {
    const row: Row = { directory, status: 'external', cleanupPeriodDays: null, projectsBytes: null };
    try {
      if (write && ownedErrors.has(directory)) throw ownedErrors.get(directory);
      const real = await io.realpath(directory).catch(error => {
        if (error.code === 'ENOENT') return directory;
        throw error;
      });
      const isOwned = canonical.has(real);
      const file = path.join(real, 'settings.json');
      let current = await readJson(io, file);
      row.cleanupPeriodDays = current.value.cleanupPeriodDays ?? null;
      if (isOwned) {
        row.status = 'managed';
        for (let attempt = 0; attempt < 2; attempt++) {
          const state = await readJson(io, stateFile);
          const history: unknown[] = Array.isArray(state.value[real]) ? state.value[real] : [];
          const value = current.value.cleanupPeriodDays;
          if (Object.hasOwn(current.value, 'cleanupPeriodDays') && !history.includes(value)) {
            row.status = 'user';
            break;
          }
          if (!write || value === days) break;
          // Persist ownership before settings: a failed rename remains recoverable.
          if (!history.includes(days)) {
            state.value[real] = [...history, days];
            await atomicWrite(io, stateFile, state.value);
          }
          let latest = current;
          const written = await atomicWrite(io, file, { ...current.value, cleanupPeriodDays: days }, async () => {
            latest = await readJson(io, file);
            return latest.text === current.text;
          });
          if (written) { row.cleanupPeriodDays = days; break; }
          current = latest;
          row.cleanupPeriodDays = current.value.cleanupPeriodDays ?? null;
          if (attempt === 1) { row.status = 'unwritable'; warn('[claude-retention] Settings changed repeatedly; retry on next apply'); }
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      row.status = ['EACCES', 'EPERM', 'EROFS'].includes(code || '') ? 'unwritable' : 'invalid';
      warn(`[claude-retention] ${row.status} (${code || 'invalid JSON or unsafe file'})`);
    }
    rows.push(row);
  }
  snapshots.set(dataDir, rows);
  inspectedAt.set(dataDir, Date.now());
  return rows;
}

/** Serialized writes preserve per-home ownership history across concurrent settings saves. */
export function ensureClaudeTranscriptRetention(days: unknown = getUsageSettings().claudeTranscriptRetentionDays, options: Options = {}): Promise<Row[]> {
  const validated = parseClaudeTranscriptRetentionDays(days);
  if (validated === null) return Promise.reject(new Error('Claude retention must be an integer from 30 to 3650'));
  const result = queue.then(() => inspect(validated, options, true));
  queue = result.catch(() => {});
  return result;
}

/** Return cached metadata immediately; neither inspection nor size traversal blocks HTTP. */
export function getClaudeTranscriptRetentionStatus(options: Options = {}): Row[] {
  const { dataDir, directories } = locations(options);
  const rows = snapshots.get(dataDir);
  if (!inspections.has(dataDir) && (!rows || Date.now() - (inspectedAt.get(dataDir) || 0) >= 60_000)) {
    inspections.add(dataDir);
    const pending = queue.then(() => inspect(365, options, false));
    queue = pending.catch(() => {}).finally(() => inspections.delete(dataDir));
  }
  return (rows || directories.map(directory => ({ directory, status: 'external' as Status, cleanupPeriodDays: null, projectsBytes: null })))
    .map(row => ({ ...row, projectsBytes: cachedSize(row.directory) }));
}
