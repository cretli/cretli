import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import test from 'node:test';
import { createUsageEvent } from '../lib/usage/usage-event.js';
import { recordUsage } from '../lib/usage/usage-ledger.js';
import { resolveUsageDataDir } from '../lib/persist/usage-persist.js';
import { registerUsageRoutes } from '../lib/routes/usage-routes.js';

const FORBIDDEN_KEYS = [
  'prompt',
  'response',
  'report',
  'content',
  'messages',
  'text',
  'transcript',
  'history',
  'reply',
  'completion',
  'system',
  'filePath',
  'path',
];

const SECRET = 'SECRET-PROMPT-REPORT-PATH-DO-NOT-PERSIST';

/**
 * @param {string} dataDir
 * @returns {string} the concatenated day journal (the event day is "now")
 */
function readJournal(dataDir) {
  const dir = resolveUsageDataDir(dataDir);
  let names = [];
  try {
    names = readdirSync(dir).filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name));
  } catch {
    return '';
  }
  return names.map((name) => readFileSync(path.join(dir, name), 'utf8')).join('\n');
}

test('createUsageEvent drops prompt/response/report/path fields and client usd', () => {
  const event = createUsageEvent({
    provider: 'openai',
    feature: 'chat',
    tokens: { textInput: 10, textOutput: 5 },
    prompt: SECRET,
    response: SECRET,
    report: SECRET,
    filePath: SECRET,
    messages: [{ role: 'user', content: SECRET }],
    // A client must never be able to set a cost; the ledger prices server-side.
    usd: 999,
  });
  assert.equal(event.usd, null);
  assert.equal(Object.prototype.hasOwnProperty.call(event, 'prompt'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(event, 'response'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(event, 'report'), false);
  for (const key of FORBIDDEN_KEYS) {
    assert.equal(Object.prototype.hasOwnProperty.call(event, key), false, `event must not carry ${key}`);
  }
  assert.equal(JSON.stringify(event).includes(SECRET), false);
});

test('recordUsage never writes conversation content or source paths to the journal', () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'cretli-usage-privacy-'));
  recordUsage(
    {
      at: '2026-06-01T10:00:00.000Z',
      provider: 'openai',
      feature: 'chat',
      model: 'gpt-4o-mini',
      tokens: { textInput: 12, textOutput: 3 },
      prompt: SECRET,
      response: SECRET,
      report: SECRET,
      filePath: SECRET,
    },
    { dataDir }
  );
  const journal = readJournal(dataDir);
  assert.equal(journal.includes(SECRET), false);
  for (const key of ['"prompt"', '"response"', '"report"', '"filePath"']) {
    assert.equal(journal.includes(key), false, `journal must not carry ${key}`);
  }
});

function createFakeApp() {
  /** @type {Map<string, Function>} */
  const routes = new Map();
  return {
    get: (route, handler) => routes.set(`GET ${route}`, handler),
    post: (route, handler) => routes.set(`POST ${route}`, handler),
    routes,
  };
}

/**
 * @param {object} body
 * @param {string} dataDir
 * @returns {Promise<{ statusCode: number, body: object }>}
 */
async function postUsageEvent(body, dataDir) {
  const app = createFakeApp();
  registerUsageRoutes(app, { dataDir });
  const handler = app.routes.get('POST /api/usage/events');
  assert.ok(handler, 'POST /api/usage/events must be registered');
  const res = {
    statusCode: 200,
    body: null,
    status(code) { res.statusCode = code; return res; },
    json(payload) { res.body = payload; return res; },
  };
  await handler({ body, query: {} }, res);
  return res;
}

test('telemetry endpoint rejects a client-supplied usd field', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'cretli-usage-privacy-'));
  const res = await postUsageEvent(
    { provider: 'openai', feature: 'chat', tokens: { textInput: 1 }, usd: 12.5 },
    dataDir
  );
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /usd/i);
});

test('telemetry endpoint drops prompt/report/path fields from the request', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'cretli-usage-privacy-'));
  const res = await postUsageEvent(
    {
      provider: 'openai',
      feature: 'chat',
      model: 'gpt-4o-mini',
      tokens: { textInput: 4, textOutput: 2 },
      prompt: SECRET,
      report: SECRET,
      filePath: SECRET,
    },
    dataDir
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  // The returned cost is server-priced; a client value must never survive.
  assert.equal(res.body.event.usd === 999, false);
  assert.equal(Number.isFinite(res.body.event.usd), true);
  const journal = readJournal(dataDir);
  assert.equal(journal.includes(SECRET), false);
  assert.equal(journal.includes('"prompt"'), false);
  assert.equal(journal.includes('"report"'), false);
  assert.equal(journal.includes('"filePath"'), false);
});

test('telemetry endpoint still records the documented token bag', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'cretli-usage-privacy-'));
  const res = await postUsageEvent(
    { provider: 'openai', feature: 'chat', tokens: { textInput: 4, textOutput: 2 } },
    dataDir
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.event.tokens.textInput, 4);
  assert.equal(res.body.event.tokens.textOutput, 2);
});
