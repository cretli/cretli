import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Isolated data dir; must be set before the persist modules are imported.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-title-history-coalesced-'));
process.env.CRETLI_DATA_DIR = dataDir;

const {
  appendChatTitleHistory,
  deleteChatTitleHistory,
  getChatTitleHistory,
  setChatTitleHistorySeq,
} = await import('../lib/persist/chat-title-history-persist.js');
const {
  flushCoalescedWrites,
  getWriteStats,
  hasPendingCoalescedWrite,
  resetWriteStats,
} = await import('../lib/persist/atomic-write.js');

const FILE = path.join(dataDir, 'chat-title-history.json');

/** The renames a real session performs: entry first, history seq annotation right after. */
function runScenario() {
  for (let i = 0; i < 20; i += 1) {
    appendChatTitleHistory('chat-a', { title: `Title ${i}`, source: 'manual' });
    setChatTitleHistorySeq('chat-a', `Title ${i}`, i + 1);
    appendChatTitleHistory('chat-b', { title: `Other ${i}`, source: 'auto', reason: 'r' });
    // Re-sending the newest title is deduplicated and must not write.
    appendChatTitleHistory('chat-b', { title: `Other ${i}`, source: 'auto' });
  }
  deleteChatTitleHistory('chat-b');
}

/** Drop the wall-clock `at` stamps: they are the only run-dependent part. */
function readStable() {
  const doc = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  for (const list of Object.values(doc.chats)) for (const row of list) delete row.at;
  return doc;
}

const writesOf = () => getWriteStats().rows.find((r) => r.key === 'chat-title-history.json')?.writes ?? 0;

test('coalesced title history writes far fewer times and leaves identical file content', () => {
  const previous = process.env.CRETLI_COALESCED_WRITES;
  try {
    // Previous behaviour: every call hits the disk.
    process.env.CRETLI_COALESCED_WRITES = '0';
    resetWriteStats();
    runScenario();
    const immediateWrites = writesOf();
    const expected = readStable();
    fs.rmSync(FILE);

    // New behaviour.
    delete process.env.CRETLI_COALESCED_WRITES;
    resetWriteStats();
    runScenario();
    assert.equal(hasPendingCoalescedWrite(FILE), true);
    assert.equal(fs.existsSync(FILE), false, 'nothing reaches the disk before the flush');
    // A pending write is visible to readers and to the next read-modify-write.
    assert.equal(getChatTitleHistory('chat-a').length, 20);
    assert.equal(getChatTitleHistory('chat-a')[19].seq, 20);
    assert.equal(getChatTitleHistory('chat-b').length, 0);

    assert.deepEqual(flushCoalescedWrites(), { written: 1, failed: 0 });
    assert.equal(hasPendingCoalescedWrite(FILE), false);
    const coalescedWrites = writesOf();
    assert.ok(immediateWrites >= 60, `immediate mode wrote ${immediateWrites} times`);
    assert.equal(coalescedWrites, 1);
    assert.deepEqual(readStable(), expected);
  } finally {
    if (previous === undefined) delete process.env.CRETLI_COALESCED_WRITES;
    else process.env.CRETLI_COALESCED_WRITES = previous;
  }
});

test('a pending title history change is flushed on shutdown (flushCoalescedWrites)', () => {
  fs.rmSync(FILE, { force: true });
  appendChatTitleHistory('chat-shutdown', { title: 'Before exit', source: 'manual' });
  assert.equal(hasPendingCoalescedWrite(FILE), true);
  assert.equal(fs.existsSync(FILE), false);
  // server.js calls this from the SIGINT/SIGTERM path and from process.on('exit').
  assert.equal(flushCoalescedWrites().failed, 0);
  const onDisk = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  assert.equal(onDisk.v, 1);
  assert.equal(onDisk.chats['chat-shutdown'][0].title, 'Before exit');
});

test('server.js wires flushCoalescedWrites into the exit hook and the SIGINT/SIGTERM shutdown path', () => {
  const source = fs.readFileSync(path.resolve('server.js'), 'utf8');
  assert.match(source, /import \{[^}]*\bflushCoalescedWrites\b[^}]*\} from '\.\/lib\/persist\/atomic-write\.js'/);

  // The synchronous 'exit' event also covers direct process.exit() calls.
  const exitHook = source.match(/process\.on\('exit', \(\) => \{([\s\S]*?)\n\}\);/);
  assert.ok(exitHook, "server.js must register a process.on('exit') hook");
  assert.match(exitHook[1], /\bflushCoalescedWrites\(\)/);

  // Graceful shutdown: the function body must flush before process.exit().
  const start = source.indexOf('async function shutdownDelegationAndExit(');
  assert.ok(start >= 0, 'shutdownDelegationAndExit must exist');
  const rest = source.slice(start);
  const end = rest.search(/\n\}\n/);
  const body = rest.slice(0, end);
  const flushAt = body.indexOf('flushCoalescedWrites()');
  const exitAt = body.lastIndexOf('process.exit(');
  assert.ok(flushAt >= 0, 'shutdownDelegationAndExit must call flushCoalescedWrites()');
  assert.ok(exitAt > flushAt, 'the flush must run before the final process.exit()');

  // Both signals must route into that function.
  assert.match(source, /process\.on\('SIGTERM', \(\) => \{\s*void shutdownDelegationAndExit\('SIGTERM'\)/);
  assert.match(source, /process\.on\('SIGINT', \(\) => \{\s*void shutdownDelegationAndExit\('SIGINT'\)/);
});

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
