/**
 * Read-only app suggestions. Nothing here writes a file: the user accepts a
 * suggestion explicitly, which then goes through the normal "add app" path.
 *
 * Sources: tasks (`.vscode/tasks.json` via lib/tasks.js), `package.json` scripts and
 * `ports:` of `docker-compose*.yml`.
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { loadTasks } from '../tasks.js';

const SCRIPT_NAMES = Object.freeze(['dev', 'start', 'serve', 'preview', 'watch']);
const COMPOSE_FILE_RE = /^(docker-)?compose([.-][\w.-]+)?\.ya?ml$/i;

/** @param {string} text */
export function slugify(text) {
  const slug = String(text).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return slug || 'app';
}

/** @param {string} workspaceDir */
function readPackageJson(workspaceDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(workspaceDir, 'package.json'), 'utf8'));
    return pkg && typeof pkg === 'object' ? pkg : null;
  } catch {
    return null;
  }
}

/**
 * @param {unknown} entry  one compose `ports:` item (short string or long-form object)
 * @returns {{ port: number, bind: string } | null} host side of the mapping
 */
export function parseComposePort(entry) {
  if (entry && typeof entry === 'object') {
    const published = Number(/** @type {any} */ (entry).published);
    if (!Number.isInteger(published)) return null;
    return { port: published, bind: String(/** @type {any} */ (entry).host_ip || '0.0.0.0') };
  }
  const text = String(entry ?? '').trim().replace(/\/(tcp|udp)$/i, '');
  const parts = text.split(':');
  // "8080" (container only), "8080:80", "127.0.0.1:8080:80"
  if (parts.length === 1) return null;
  const bind = parts.length >= 3 ? parts.slice(0, parts.length - 2).join(':') : '0.0.0.0';
  const hostPart = parts[parts.length - 2];
  const port = Number(hostPart.split('-')[0]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { port, bind: bind.replace(/^\[|\]$/g, '') };
}

/**
 * @param {string} workspaceDir
 * @param {Array<{ id: string }>} [existing]  registered apps, skipped in the result
 */
export function buildSuggestions(workspaceDir, existing = []) {
  const dir = path.resolve(workspaceDir);
  const taken = new Set(existing.map((a) => a.id));
  const unique = (base) => {
    let id = base;
    for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
    taken.add(id);
    return id;
  };
  const suggestions = [];

  let tasks = [];
  try { tasks = loadTasks(dir)?.tasks || []; } catch { /* a broken tasks file only removes this source */ }
  for (const task of tasks) {
    suggestions.push({ source: 'task', app: {
      id: unique(slugify(task.label)), name: task.label, start: { taskLabel: task.label }, ports: [], exposure: 'local',
    } });
  }

  const scripts = readPackageJson(dir)?.scripts;
  if (scripts && typeof scripts === 'object') {
    for (const name of SCRIPT_NAMES) {
      if (typeof scripts[name] !== 'string') continue;
      suggestions.push({ source: 'package.json', app: {
        id: unique(slugify(`npm-${name}`)), name: `npm run ${name}`,
        start: { command: 'npm', args: ['run', name] }, ports: [], exposure: 'local',
      } });
    }
  }

  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => COMPOSE_FILE_RE.test(f)).sort(); } catch { /* unreadable folder */ }
  for (const file of files) {
    let doc;
    try { doc = yaml.load(fs.readFileSync(path.join(dir, file), 'utf8')); } catch { continue; }
    const services = doc && typeof doc === 'object' ? /** @type {any} */ (doc).services : null;
    if (!services || typeof services !== 'object') continue;
    for (const [service, def] of Object.entries(services)) {
      const rawPorts = def && typeof def === 'object' && Array.isArray(/** @type {any} */ (def).ports) ? /** @type {any} */ (def).ports : [];
      const ports = [];
      for (const entry of rawPorts) {
        const parsed = parseComposePort(entry);
        if (parsed && !ports.some((p) => p.port === parsed.port)) ports.push({ ...parsed, role: 'other' });
      }
      if (!ports.length) continue;
      suggestions.push({ source: 'compose', file, app: {
        id: unique(slugify(`compose-${service}`)), name: `${service} (${file})`,
        start: { command: 'docker', args: ['compose', '-f', file, 'up', service] }, ports, exposure: 'local',
      } });
    }
  }
  return suggestions;
}
