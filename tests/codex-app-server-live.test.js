import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CodexAppServer } from '../lib/codex/codex-app-server.ts';
import { createCodexSteering } from '../lib/codex/codex-steer.ts';
import { resolveCodexCli } from '../lib/codex/codex-cli.ts';
import { DEFAULT_CODEX_MODEL } from '../lib/codex/codex-models.ts';

// Live proofs against a real `codex app-server`. They spend model tokens, so they
// run only with CRETLI_CODEX_LIVE=1, a codex CLI, and a CODEX_HOME holding auth.json
// (CRETLI_CODEX_LIVE_HOME or CODEX_HOME). Otherwise every test is skipped.
const cli = resolveCodexCli() || 'codex';
const home = process.env.CRETLI_CODEX_LIVE_HOME || process.env.CODEX_HOME || '';
const hasCli = spawnSync(cli, ['--version'], { stdio: 'ignore' }).status === 0;
const hasAuth = Boolean(home) && fs.existsSync(path.join(home, 'auth.json'));
const skip = process.env.CRETLI_CODEX_LIVE !== '1' ? 'set CRETLI_CODEX_LIVE=1 to run live Codex tests'
  : !hasCli ? 'codex CLI not available' : !hasAuth ? 'no auth.json in CRETLI_CODEX_LIVE_HOME / CODEX_HOME' : false;
const model = process.env.CRETLI_CODEX_LIVE_MODEL || DEFAULT_CODEX_MODEL;
const TURN_MS = 180000;

async function open(t, { sandboxMode, threadId = null, cwd }) {
  const client = new CodexAppServer({ cli, env: { ...process.env, CODEX_HOME: home }, requestTimeoutMs: 60000 });
  t.after(() => client.close());
  const id = await client.initialize({ workingDirectory: cwd, model, approvalPolicy: 'never', sandboxMode }, threadId);
  return { client, id };
}

/** Run one turn and collect agent text. */
async function turn(client, prompt, observe = () => {}) {
  let text = '';
  const done = await client.run(prompt, (event) => {
    observe(event);
    const item = event.params?.item;
    if (event.method === 'item/completed' && item?.type === 'agentMessage') text += item.text || '';
  });
  return { text, done };
}

const WRITE_PROMPT = (file) => `Create the file ${file} containing the word hello using a shell command or apply_patch. `
  + 'Then reply with exactly WROTE if it succeeded or DENIED if it failed.';

for (const [mode, sandboxMode, allowed] of [['plan/review/Scout', 'read-only', false], ['agent', 'danger-full-access', true]]) {
  test(`live sandbox ${mode}: write ${allowed ? 'allowed' : 'rejected'}`, { skip, timeout: TURN_MS }, async (t) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-codex-live-'));
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    const file = path.join(cwd, 'probe.txt');
    const { client } = await open(t, { sandboxMode, cwd });
    const { text } = await turn(client, WRITE_PROMPT(file));
    // The filesystem is the source of truth, not the model's self-report.
    assert.equal(fs.existsSync(file), allowed, `probe.txt existence in ${sandboxMode} (reply: ${text})`);
  });
}

test('live resume: second turn on same codexThreadId sees first turn context', { skip, timeout: TURN_MS * 2 }, async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-codex-live-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const first = await open(t, { sandboxMode: 'read-only', cwd });
  await turn(first.client, 'Remember the secret word ZEBRAFISH-4711. Reply with OK only.');
  first.client.close();
  const second = await open(t, { sandboxMode: 'read-only', cwd, threadId: first.id });
  assert.equal(second.id, first.id);
  const { text } = await turn(second.client, 'What secret word did I ask you to remember? Reply with the word only.');
  console.log(`# resume proof: thread=${first.id} answer=${JSON.stringify(text)}`);
  assert.match(text, /ZEBRAFISH-4711/);
});

test('live steer through a room: message lands in current turn; cancel requeues unseen once', { skip, timeout: TURN_MS * 2 }, async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-codex-live-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const { client } = await open(t, { sandboxMode: 'read-only', cwd });
  const queued = [], acks = [];
  const room = { busy: true, currentRun: { id: 'live' }, _appServer: client, cancelled: false };
  const steering = createCodexSteering({ room, enqueue: (text) => queued.push(text), delivered() {}, broadcast: (a) => acks.push(a) });
  let started;
  const turnStarted = new Promise((resolve) => { started = resolve; });
  const run = turn(client, 'Write a detailed 400-word essay about the history of lighthouses.', (event) => {
    steering.observe(event);
    if (event.method === 'turn/started') started();
  });
  await turnStarted;
  await steering.steer('Also end your reply with the exact token STEERED-OK.');
  assert.equal(acks.at(-1).outcome, 'complete_delivered');
  const { text } = await run;
  assert.match(text, /STEERED-OK/);
  assert.deepEqual(queued, [], 'accepted and seen steer must not be re-queued');

  // Cancel path: steer then cancel immediately; the unseen steer is re-queued exactly once.
  let started2;
  const turnStarted2 = new Promise((resolve) => { started2 = resolve; });
  // Stop feeding the tracker before the steer is sent, so its user item can never be
  // marked seen and the unseen path is deterministic.
  let forward = true;
  const run2 = turn(client, 'Write a detailed 800-word essay about the history of bridges.', (event) => {
    if (forward) steering.observe(event);
    if (event.method === 'turn/started') started2();
  });
  const settled = run2.catch((error) => error);
  await turnStarted2;
  forward = false;
  await steering.steer('Unseen steer text QUEUE-ME.');
  assert.equal(acks.at(-1).outcome, 'complete_delivered', 'steer must be accepted by the live turn');
  assert.deepEqual(queued, [], 'accepted steer is not queued before cancel');
  room.cancelled = true;
  steering.cancel();
  const countQueued = () => queued.filter((text) => text.includes('QUEUE-ME')).length;
  assert.equal(countQueued(), 1, 'unseen accepted steer is re-queued exactly once after cancel');
  steering.cancel();
  await client.interrupt().catch(() => {});
  await settled;
  assert.equal(countQueued(), 1, 'second cancel stays idempotent');
  assert.equal(queued.length, 1);
});
