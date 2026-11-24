import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../persist/atomic-write.js';
import { resolveDataPath } from '../runtime-paths.js';

/** Records own their screenshot files; eviction removes both in the same operation. */
export function createRunHistory(options = {}) {
  const file = options.file || resolveDataPath('device-runs.json');
  const directory = options.directory || path.join(path.dirname(file), 'device-run-screenshots');
  const maxRecords = options.maxRecords ?? 200, maxBytes = options.maxBytes ?? 200 * 1024 * 1024;
  let records;
  function load() {
    if (records) return records;
    try { records = JSON.parse(fs.readFileSync(file, 'utf8')).runs; } catch { records = []; }
    if (!Array.isArray(records)) throw new Error('invalid-run-history');
    return records;
  }
  const ownedPath = (name) => /^[a-f0-9-]+-\d+\.png$/.test(name) ? path.join(directory, name) : null;
  function save() {
    const list = load();
    const size = (r) => (r.screenshots || []).reduce((sum, n) => { try { return sum + fs.statSync(ownedPath(n)).size; } catch { return sum; } }, 0);
    let bytes = list.reduce((sum, r) => sum + size(r), 0);
    while (list.length > maxRecords || bytes > maxBytes) {
      const oldest = list.shift(); bytes -= size(oldest);
      for (const name of oldest.screenshots || []) { const p = ownedPath(name); if (p) fs.rmSync(p, { force: true }); }
    }
    writeJsonAtomic(file, { schemaVersion: 1, runs: list });
  }
  return {
    file, directory,
    put(record) {
      const list = load(), index = list.findIndex((r) => r.id === record.id);
      if (index < 0) list.push(structuredClone(record)); else list[index] = structuredClone(record);
      save();
    },
    /** @param {{ workspace?: string, deviceId?: string }} [scope] */
    list({ workspace, deviceId } = {}) {
      return structuredClone(load().filter((r) => r.workspace === workspace && (!deviceId || r.deviceId === deviceId)));
    },
    get(id, workspace) { return this.list({ workspace }).find((r) => r.id === id) || null; },
    screenshot(id, name, workspace) {
      const run = this.get(id, workspace);
      return run?.screenshots?.includes(name) ? ownedPath(name) : null;
    },
    writeScreenshots(id, images = []) {
      if (!Array.isArray(images) || images.length > 20) throw new Error('invalid-screenshots');
      fs.mkdirSync(directory, { recursive: true });
      const names = [];
      try {
        for (const [index, image] of images.entries()) {
          if (typeof image !== 'string' || image.length > 16 * 1024 * 1024) throw new Error('invalid-screenshot');
          const name = id + '-' + index + '.png';
          fs.writeFileSync(path.join(directory, name), Buffer.from(image, 'base64')); names.push(name);
        }
      } catch (e) { for (const name of names) fs.rmSync(path.join(directory, name), { force: true }); throw e; }
      return names;
    },
    compare(beforeId, afterId, workspace) {
      const before = this.get(beforeId, workspace), after = this.get(afterId, workspace);
      if (!before || !after) return { ok: false, status: 404, error: 'run-not-found' };
      if (before.scriptPath !== after.scriptPath) return { ok: false, status: 400, error: 'script-mismatch' };
      const deltas = {};
      for (const key of new Set([...Object.keys(before.metrics || {}), ...Object.keys(after.metrics || {})])) {
        const a = before.metrics?.[key], b = after.metrics?.[key];
        deltas[key] = { before: a ?? null, after: b ?? null, delta: Number.isFinite(a) && Number.isFinite(b) ? b - a : null };
      }
      return { ok: true, before, after, deltas };
    },
  };
}
