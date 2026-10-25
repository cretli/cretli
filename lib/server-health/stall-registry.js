// Dedupe registries for the stall watchdog: signature -> first-seen info.
import fs from 'node:fs';

export function createMemoryRegistry() {
  const seen = new Map();
  const pending = new Set();
  return {
    has: (sig) => seen.has(sig) || pending.has(sig),
    reserve: (sig) => {
      if (seen.has(sig) || pending.has(sig)) return false;
      pending.add(sig);
      return true;
    },
    release: (sig) => pending.delete(sig),
    add: (sig, info = {}) => {
      seen.set(sig, info);
      pending.delete(sig);
    },
    size: () => seen.size,
  };
}

/** JSON-file backed registry; tolerant of a missing or corrupt file. */
export function createFileRegistry(filePath) {
  let data = Object.create(null);
  const pending = new Set();
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      Object.assign(data, parsed);
    }
  } catch {
    data = Object.create(null);
  }
  return {
    has: (sig) => Object.prototype.hasOwnProperty.call(data, sig) || pending.has(sig),
    reserve: (sig) => {
      if (Object.prototype.hasOwnProperty.call(data, sig) || pending.has(sig)) return false;
      pending.add(sig);
      return true;
    },
    release: (sig) => pending.delete(sig),
    add: (sig, info = {}) => {
      data[sig] = info;
      pending.delete(sig);
      try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
      } catch {
        // Persisting is best effort; the in-memory copy still dedupes.
      }
    },
    size: () => Object.keys(data).length,
  };
}
