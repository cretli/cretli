import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadSettings } from '../../lib/persist/settings.js';
import { catalogEntriesFromModelIds, normalizeChatEnabledModels } from '../../lib/model-catalog.js';

const execFileAsync = promisify(execFile);

export function resolveAntigravityCli(env = process.env, settings = loadSettings()) {
  return String(env.ANTIGRAVITY_BIN || settings.antigravityBin || 'agy').trim();
}

export function isAntigravityCliFound(bin = resolveAntigravityCli(), env = process.env) {
  const names = process.platform === 'win32' ? ['', '.exe', '.cmd'] : [''];
  const dirs = bin.includes('/') || bin.includes('\\') ? [''] : String(env.PATH || '').split(path.delimiter);
  return dirs.some((dir) => names.some((suffix) => {
    try {
      const file = dir ? path.join(dir, bin + suffix) : bin + suffix;
      fs.accessSync(file, fs.constants.X_OK);
      return fs.statSync(file).isFile();
    } catch { return false; }
  }));
}

export function fallbackCatalog(settings = loadSettings()) {
  return catalogEntriesFromModelIds(['default', ...normalizeChatEnabledModels(settings.antigravityChatEnabledModels)]);
}

/** Parse the documented `agy models` slug/label table without inventing model ids. */
export function parseAntigravityModels(output) {
  // ANSI colour escapes are presentation only.
  // eslint-disable-next-line no-control-regex
  const clean = String(output).replace(/\x1b\[[0-9;]*m/g, '');
  return clean.split(/\r?\n/).flatMap((line) => {
    const match = line.trim().match(/^([a-z0-9]+(?:[._/-][a-z0-9]+)+)\s{2,}(.+)$/i);
    return match ? [{ id: match[1], name: match[2].trim() }] : [];
  });
}

export async function listAntigravityModels({ run = execFileAsync } = {}) {
  const { stdout } = await run(resolveAntigravityCli(), ['models'], { timeout: 20000, maxBuffer: 1024 * 1024, windowsHide: true });
  const models = parseAntigravityModels(stdout);
  const catalog = [{ value: 'default', label: 'Antigravity default', modelId: 'default' }, ...models.map((row) => ({ value: row.id, modelId: row.id, label: row.name }))];
  return { models: catalog.map((row) => ({ id: row.value, name: row.label })), catalog, modelsSource: 'cli' };
}
