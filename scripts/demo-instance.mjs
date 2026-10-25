#!/usr/bin/env node
/**
 * Starts a throw-away Cretli instance with fictional data, for screenshots and
 * demos that must not show a real environment (no real chats, workspaces,
 * settings, hostnames or paths).
 *
 *   node scripts/demo-instance.mjs                  # http://127.0.0.1:3099
 *   node scripts/demo-instance.mjs --port 3100 --dir /tmp/my-demo
 *   node scripts/demo-instance.mjs --seed-only      # prepare files, do not start
 *
 * Everything lives under one directory (default: a fresh temp dir): the Cretli
 * data dir, three fictional projects and a `.code-workspace` file that lists
 * them. The instance binds to 127.0.0.1 over plain HTTP with the password
 * `demo-password` and is stopped with Ctrl-C. Chats are not seeded: they need a
 * configured harness, so create two or three short ones by hand in the demo
 * workspace before taking the screenshot.
 *
 * Docker variant: see docker-compose.demo.yml (same data, container isolation).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'demo-password';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}

const port = Number.parseInt(arg('port', '3099'), 10);
const dir = path.resolve(arg('dir', fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-demo-'))));
const seedOnly = process.argv.includes('--seed-only');
const dataDir = path.join(dir, 'data');
const projects = path.join(dir, 'projects');

const PROJECTS = {
  'acme-shop': 'A small online shop front end.\n',
  'acme-api': 'The shop backend API.\n',
  notes: 'Meeting notes and ideas.\n',
};

const TODOS = [
  { title: 'Fix failing login test', status: 'doing', body: 'The login form test fails on a clean checkout.' },
  { title: 'Add dark mode toggle', status: 'ready', body: 'Respect the system setting, allow a manual override.' },
  { title: 'Document the REST endpoints', status: 'ready', body: 'List routes, request bodies and error codes.' },
  { title: 'Speed up product search', status: 'idea', body: 'Measure first, then add an index.' },
  { title: 'Update dependencies', status: 'done', body: 'All minor updates applied, tests green.' },
];

function seedFiles() {
  fs.mkdirSync(dataDir, { recursive: true });
  for (const [name, readme] of Object.entries(PROJECTS)) {
    const folder = path.join(projects, name);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'README.md'), `# ${name}\n\n${readme}`);
  }
  const workspaceFile = path.join(dir, 'acme.code-workspace');
  fs.writeFileSync(workspaceFile, `${JSON.stringify({ folders: Object.keys(PROJECTS).map((name) => ({ name, path: path.join('projects', name) })) }, null, 2)}\n`);
  return workspaceFile;
}

/**
 * @param {string} base
 * @param {string} method
 * @param {string} route
 * @param {{ body?: unknown, cookie?: string, csrf?: string }} [options]
 */
async function request(base, method, route, { body, cookie, csrf } = {}) {
  const res = await fetch(`${base}${route}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
      ...(csrf ? { 'x-cretli-csrf': csrf } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { res, json };
}

async function waitUp(base) {
  for (let i = 0; i < 120; i += 1) {
    try {
      const { res } = await request(base, 'GET', '/api/auth-status');
      if (res.ok) return;
    } catch { /* not listening yet */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Demo instance did not start on ${base}`);
}

async function seedTodos(base, workspaceFolder) {
  const { res, json } = await request(base, 'POST', '/api/setup', { body: { password: PASSWORD } });
  if (!res.ok || !json?.csrfToken) throw new Error(`Setup failed: ${res.status} ${JSON.stringify(json)}`);
  const cookie = (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
  const query = `?workspaceFolder=${encodeURIComponent(workspaceFolder)}`;
  for (const todo of TODOS) {
    const created = await request(base, 'POST', `/api/todos${query}`, { body: { ...todo, workspaceFolder, idempotencyKey: `demo-${todo.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` }, cookie, csrf: json.csrfToken });
    if (!created.res.ok) console.error(`[demo] todo "${todo.title}" not seeded: ${created.res.status}`);
  }
}

const workspaceFile = seedFiles();
console.log(`[demo] files in ${dir}`);
if (seedOnly) process.exit(0);

const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  stdio: ['ignore', 'inherit', 'inherit'],
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: 'production',
    PORT: String(port),
    CRETLI_BIND: '127.0.0.1',
    USE_HTTPS: '0',
    CRETLI_DATA_DIR: dataDir,
    WORKSPACE_FILE: workspaceFile,
  },
});
child.on('exit', (code) => process.exit(code ?? 0));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(/** @type {NodeJS.Signals} */ (signal)));

try {
  await waitUp(base);
  await seedTodos(base, path.join(projects, 'acme-shop'));
  console.log(`[demo] ready: ${base}  (password: ${PASSWORD})`);
  console.log('[demo] create 2-3 short chats in the demo workspace, then take the screenshots. Ctrl-C to stop.');
} catch (err) {
  console.error(`[demo] ${err.message}`);
  child.kill('SIGTERM');
  process.exitCode = 1;
}
