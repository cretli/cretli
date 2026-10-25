/**
 * Structural guards of the history caller conversion (stage 2b):
 *  1. no production module reads or writes chat history except through the async service/adapter
 *     (the legacy module is reachable only from the legacy backend);
 *  2. a call to any function that became asynchronous because of the conversion is never left as a bare
 *     expression, so a promise can never be mistaken for the object it will resolve to.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** @param {string} dir @returns {string[]} */
function listJs(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJs(full));
    else if (/\.(?:js|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const productionFiles = [...listJs(path.join(root, 'lib')), path.join(root, 'server.js')];
const relative = (file) => path.relative(root, file).split(path.sep).join('/');

/** Modules that may import the synchronous legacy module, with the reason. */
const LEGACY_IMPORT_ALLOWLIST = new Map([
  ['lib/persist/chat-history-backend-legacy.js', 'the legacy backend of the adapter (the only production path to the file store)'],
]);

/** Scripts (not server code) that build or measure the legacy store on purpose. */
const SCRIPT_ALLOWLIST = new Map([
  ['scripts/architecture-http-fixture.mjs', 'synthetic fixture for the HTTP benchmark; writes a temporary data dir'],
  ['scripts/storage-baseline-harness.mjs', 'JSON baseline of the storage benchmark; temporary directories only'],
]);

describe('no production bypass of the history adapter', () => {
  it('only the legacy backend imports the synchronous legacy history module', () => {
    const offenders = [];
    for (const file of productionFiles) {
      const text = fs.readFileSync(file, 'utf8');
      if (!/(?:from|import\()\s*['"][^'"]*chat-history-persist\.js['"]/.test(text)) continue;
      if (!LEGACY_IMPORT_ALLOWLIST.has(relative(file))) offenders.push(relative(file));
    }
    assert.deepEqual(offenders, [], 'these modules read/write history files directly; use lib/persist/chat-history-service.js');
  });

  it('scripts that touch the legacy module are explicitly allow-listed fixtures', () => {
    const offenders = [];
    for (const file of listJs(path.join(root, 'scripts'))) {
      const text = fs.readFileSync(file, 'utf8');
      if (!/chat-history-persist\.js/.test(text)) continue;
      if (!SCRIPT_ALLOWLIST.has(relative(file))) offenders.push(relative(file));
    }
    assert.deepEqual(offenders, []);
  });

  it('no module outside the legacy persist module resolves or opens the chat-history directory', () => {
    const offenders = [];
    for (const file of productionFiles) {
      const rel = relative(file);
      if (rel.startsWith('lib/storage/') || rel === 'lib/persist/chat-history-persist.js') continue;
      const text = fs.readFileSync(file, 'utf8');
      if (/resolveDataPath\(\s*['"]chat-history['"]/.test(text) && rel !== 'lib/sdk/sdk-context-stats.ts') offenders.push(rel);
    }
    assert.deepEqual(offenders, []);
  });

  it('the stats module only stats the legacy file when the legacy backend is active', () => {
    const text = fs.readFileSync(path.join(root, 'lib/sdk/sdk-context-stats.ts'), 'utf8');
    assert.match(text, /getChatHistoryBackendKind\(\) === 'legacy'[\s\S]{0,80}fsp\.stat\(historyPath\)/);
  });
});

/** Functions whose callers had to become asynchronous in stage 2b (service API + everything that awaits it). */
const ASYNC_NAMES = new Set([
  'loadChatHistory', 'appendChatHistoryEvents', 'appendChatNotice', 'getChatHistorySince', 'readChatHistoryFromHttpQuery',
  'readChatHistoryBatch', 'getChatHistoryEvent', 'getChatHistoryPage', 'copyChatHistory', 'copyChatHistoryUntil',
  'deleteChatHistory', 'listChatHistoryHeadSeqs', 'getChatHistoryUsage',
  'publishDelegationStatus', 'publishMailboxHistory', 'appendRelatedChatHistoryLinks', 'resolveHistoryMessageSource',
  'findChatHistoryMessage', 'collectChatHistoryContextStats', 'loadAllChatHistoryEvents', 'loadChatHistoryPlainText',
  'extractLatestAssistantTextFromChatHistory', 'extractLatestPlanMarkdownFromChatHistory', 'readCurrentRunAssistantText',
  'readCurrentRunPlanMarkdown', 'exportTodoPlanFromChat', 'syncTodoAfterSdkRunFinished', 'deleteChat',
  'ensureMimoRoom', 'ensureMistralRoom', 'ensureOpenRouterRoom', 'ensureZaiRoom', 'appendWorkspaceWatcherNotice',
]);

/** Callees that legitimately take a promise (the result is tracked, caught or awaited elsewhere). */
const PROMISE_SINKS = new Set(['trackScheduledHistoryTask', 'runDetached', 'Promise.all', 'Promise.race', 'Promise.allSettled', 'Promise.resolve']);

/** Local functions that are not the async ones above (same name, different module / object). */
const NAME_EXEMPT = new Map([
  // `deleteChat` of the MCP client and the remote API client are their own async methods defined in place.
  ['lib/mcp/mcp-inprocess-client.js', new Set(['deleteChat'])],
  ['lib/remote-api-client.js', new Set(['deleteChat'])],
  ['lib/storage/chat-history-store.js', new Set(['deleteChat', 'loadChatHistory'])],
]);

function walk(node, ancestors, visit) {
  visit(node, ancestors);
  ancestors.push(node);
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end') continue;
    const value = node[key];
    if (Array.isArray(value)) value.forEach((child) => child && typeof child.type === 'string' && walk(child, ancestors, visit));
    else if (value && typeof value.type === 'string') walk(value, ancestors, visit);
  }
  ancestors.pop();
}

describe('no silently missing await on a converted call', () => {
  it('every call of a converted function is awaited, returned, chained or handed to a promise sink', () => {
    const offenders = [];
    for (const file of productionFiles) {
      const rel = relative(file);
      if (rel.startsWith('lib/storage/') || rel.startsWith('lib/persist/chat-history-') || rel === 'lib/persist/history-room-flusher.js') continue;
      const text = fs.readFileSync(file, 'utf8');
      if (!Array.from(ASYNC_NAMES).some((name) => text.includes(name))) continue;
      const ast = acorn.parse(text, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true, allowAwaitOutsideFunction: true });
      const exempt = NAME_EXEMPT.get(rel) || new Set();
      walk(ast, [], (node, ancestors) => {
        if (node.type !== 'CallExpression') return;
        const callee = node.callee;
        const name = callee.type === 'Identifier' ? callee.name : (callee.type === 'MemberExpression' && !callee.computed ? callee.property.name : '');
        if (!ASYNC_NAMES.has(name) || exempt.has(name)) return;
        // Methods of unrelated objects that happen to share a name (`adapter.deleteChat`, `store.loadChatHistory`) are not ours.
        if (callee.type === 'MemberExpression' && !['service', 'delegationService', 'client'].includes(callee.object.name || '') && !/^(?:deps|input|options)$/.test(callee.object.name || '')) return;
        const parent = ancestors[ancestors.length - 1];
        const calleeName = (call) => (call.callee.type === 'Identifier' ? call.callee.name
          : call.callee.type === 'MemberExpression' ? `${call.callee.object.name || ''}.${call.callee.property.name || ''}` : '');
        const ok = parent.type === 'AwaitExpression'
          || parent.type === 'ReturnStatement'
          || (parent.type === 'ArrowFunctionExpression' && parent.body === node)
          || (parent.type === 'MemberExpression' && ['then', 'catch', 'finally'].includes(parent.property.name))
          || (parent.type === 'UnaryExpression' && parent.operator === 'void')
          || (parent.type === 'CallExpression' && parent.arguments.includes(node) && PROMISE_SINKS.has(calleeName(parent)))
          || (parent.type === 'ConditionalExpression' || parent.type === 'LogicalExpression' || parent.type === 'ArrayExpression');
        if (!ok) offenders.push(`${rel}:${text.slice(0, node.start).split('\n').length} ${name}()`);
      });
    }
    assert.deepEqual(offenders, []);
  });
});
