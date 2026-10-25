import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'jsonc-parser';

const config = parse(readFileSync(new URL('../tsconfig.strict.json', import.meta.url), 'utf8'));

test('strict tier lists the persist record and WebSocket typedef modules', () => {
  for (const file of ['lib/shared-types/persist-records.js', 'lib/shared-types/ws-protocol.js']) {
    assert.ok(config.files.includes(file), `${file} must be in tsconfig.strict.json`);
  }
});

test('every strict file exists and the list has no duplicates', () => {
  assert.equal(new Set(config.files).size, config.files.length);
  for (const file of config.files) {
    assert.ok(existsSync(new URL(`../${file}`, import.meta.url)), `${file} is missing`);
  }
});

test('typedef-only modules have no runtime exports', async () => {
  for (const file of ['persist-records', 'ws-protocol']) {
    const mod = await import(`../lib/shared-types/${file}.js`);
    assert.deepEqual(Object.keys(mod), []);
  }
});

/**
 * Message types a handler source puts on the wire. Only literals that open a
 * frame expression count (`JSON.stringify({ type: ... })`, `broadcastToClients(clients,
 * { type: ... })`) plus client messages it parses (`msg.type === '...'`); a `type:`
 * inside any other call, e.g. child-process registry metadata, is ignored by context.
 */
function extractFrameTypes(source) {
  // A frame first built as an object variable, then passed to JSON.stringify(variable).
  const built = new Set(
    [...source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)(?:\s*:[^=\n]+)?\s*=\s*\{\s*type:\s*'([A-Za-z_-]+)'/g)]
      .filter((m) => new RegExp(`JSON\\.stringify\\(\\s*${m[1].replace(/\$/g, '\\$')}\\s*[,)]`).test(source))
      .map((m) => m[2])
  );
  const frame = /(?:JSON\.stringify\(|broadcast(?:ToClients|Room)?\((?:[^,{()]+,)?|captureCursorSdkRunEnd\([^,]+,)\s*\{\s*type:\s*'([A-Za-z_-]+)'/g;
  const parsed = /\bmsg\.type === '([A-Za-z_-]+)'/g;
  return new Set([
    ...built,
    ...[...source.matchAll(frame)].map((m) => m[1]),
    ...[...source.matchAll(parsed)].map((m) => m[1]),
  ]);
}

test('extractFrameTypes flags frames by context, not by value', () => {
  const fakeFrame = "ws.send(JSON.stringify({ type: 'task-run' }));";
  assert.deepEqual([...extractFrameTypes(fakeFrame)], ['task-run']);
  const broadcast = "broadcastToClients(clients, { type: 'agent-pty', data: 'x' });";
  assert.deepEqual([...extractFrameTypes(broadcast)], ['agent-pty']);
  const metadata = "trackChildProcess(p, { type: 'task-run', label: 'x' });\nassertExecutorLaunchAllowed({ type: 'agent-run' });";
  assert.equal(extractFrameTypes(metadata).size, 0);
  const sdkBroadcast = "broadcastRoom(room, {\n  type: 'sdkBusy',\n});\nbroadcast({ type: 'sdkRunProgress' });";
  assert.deepEqual([...extractFrameTypes(sdkBroadcast)].sort(), ['sdkBusy', 'sdkRunProgress']);
});

test('extractFrameTypes detects a frame built as a variable before JSON.stringify', () => {
  const viaVariable = "const frame = { type: 'sdkNew', x: 1 };\nws.send(JSON.stringify(frame));";
  assert.deepEqual([...extractFrameTypes(viaVariable)], ['sdkNew']);
  const typed = "const payload: Foo = { type: 'sdkTyped' };\nws.send(JSON.stringify(payload));";
  assert.deepEqual([...extractFrameTypes(typed)], ['sdkTyped']);
  // A local object that is never serialized is not a frame.
  assert.equal(extractFrameTypes("const meta = { type: 'task-run' };\nuse(meta);").size, 0);
});

test('ws-protocol.js declares every message type the lib/ws handlers send or parse', () => {
  const protocol = readFileSync(new URL('../lib/shared-types/ws-protocol.js', import.meta.url), 'utf8');
  const declared = new Set([...protocol.matchAll(/type: '([A-Za-z_-]+)'/g)].map((m) => m[1]));
  const handlers = [
    'pty-ws-handler',
    'task-ws-handler',
    'agent-run-ws-handler',
    'front-build-ws',
    'server-log-ws',
  ];
  for (const name of handlers) {
    const source = readFileSync(new URL(`../lib/ws/${name}.ts`, import.meta.url), 'utf8');
    const types = extractFrameTypes(source);
    // Guard against the extractor silently matching nothing after a refactor.
    assert.ok(types.size > 0, `${name}.js: no frame types extracted`);
    for (const type of types) {
      assert.ok(declared.has(type), `${name}.js uses message type '${type}' missing from ws-protocol.js`);
    }
  }
});

test('ws-protocol.js declares every frame type of the /ws-agent-sdk handler', () => {
  const protocol = readFileSync(new URL('../lib/shared-types/ws-protocol.js', import.meta.url), 'utf8');
  const declared = new Set([...protocol.matchAll(/type: '([A-Za-z_-]+)'/g)].map((m) => m[1]));
  const source = readFileSync(new URL('../lib/sdk/cursor-agent-sdk-ws.ts', import.meta.url), 'utf8');
  const types = extractFrameTypes(source);
  assert.ok(types.size > 10, 'cursor-agent-sdk-ws.ts: too few frame types extracted');
  for (const type of types) {
    assert.ok(declared.has(type), `cursor-agent-sdk-ws.ts uses message type '${type}' missing from ws-protocol.js`);
  }
  // Fixture: an undeclared frame added to the handler must be reported.
  const withUndeclared = `${source}\nbroadcastRoom(room, { type: 'sdkUndeclaredFixture' });\nws.send(JSON.stringify({ type: 'sdkUndeclaredFixtureB' }));`;
  const missing = [...extractFrameTypes(withUndeclared)].filter((type) => !declared.has(type));
  assert.deepEqual(missing.sort(), ['sdkUndeclaredFixture', 'sdkUndeclaredFixtureB']);
});
