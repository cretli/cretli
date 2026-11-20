/**
 * Scoped terminal WS (navigation plan stage 2, review round 5 — F1).
 *
 * A tab that owns an explicit `ws`/`folder` context must never get a PTY in the
 * server's shared settings cwd. The client declares that it is scoped
 * (`scoped=1`); the handler then refuses an empty per-tab selector instead of
 * falling back, while a request from a client that never learned the protocol
 * (an old bundle, embed, a manual socket) keeps today's behavior.
 *
 * The refusal is asserted behaviourally against the real handler — with
 * `process.env.SHELL` pointed at `/bin/true`, the "would have spawned" branch
 * can never run an interactive shell — and the branch matrix is pinned on the
 * exported scope resolver itself.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import * as ptyHandler from '../lib/ws/pty-ws-handler.ts';

const GLOBAL_CWD = os.tmpdir();
const SCOPED_FOLDER = '/ws/alpha/app';

/**
 * @returns {{ socket: object, closes: Array<[number, string]> }}
 */
function fakeSocket() {
  const closes = [];
  const socket = {
    readyState: 1,
    OPEN: 1,
    sent: [],
    closes,
    send(payload) { this.sent.push(String(payload)); },
    close(code, reason) {
      closes.push([code, reason]);
      this.readyState = 3;
    },
    on() {},
  };
  return { socket, closes };
}

/**
 * @param {{ randomSessionId?: () => string, onSessionId?: (id: string) => void }} [overrides]
 */
function fakeCtx(spy = {}) {
  const terminalSessions = new Map();
  const agentSessions = new Map();
  return {
    terminalSessions,
    agentSessions,
    calls: spy,
    ctx: {
      agentCmd: '/bin/true',
      agentModel: 'auto',
      getCurrentCwd: () => GLOBAL_CWD,
      workspaceDirForAgent: () => '',
      terminalSessions,
      agentSessions,
      getLastTerminalSessionId: () => null,
      setLastTerminalSessionId: () => {},
      randomSessionId: () => {
        spy.sessionIds = (spy.sessionIds || 0) + 1;
        return 'sess-scoped-guard';
      },
      buildInteractivePtyEnv: (overrides = {}) => ({
        PATH: process.env.PATH || '/usr/bin:/bin',
        HOME: process.env.HOME || '/tmp',
        ...overrides,
      }),
    },
  };
}

/**
 * @param {() => unknown} fn
 */
function withoutShell(fn) {
  const previousShell = process.env.SHELL;
  process.env.SHELL = '/bin/true';
  try {
    return fn();
  } finally {
    if (previousShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = previousShell;
  }
}

test('a scoped connect without a folder is refused before any PTY session exists', () => {
  const spy = {};
  const { ctx } = fakeCtx(spy);
  const { socket, closes } = fakeSocket();
  withoutShell(() => ptyHandler.handlePtyConnection(
    socket,
    false,
    null,
    null,
    '',
    null,
    null,
    false,
    ctx,
    true,
  ));
  assert.equal(closes.length, 1, 'the scoped request must be closed, never opened in the global cwd');
  assert.equal(closes[0][0], 4000, 'reuse the existing unsupported-request close code');
  const reason = String(closes[0][1] || '');
  assert.ok(reason.length > 0 && reason.length <= 123, 'the close reason fits the ws 123-byte limit');
  assert.doesNotMatch(reason, /\/|\.\./, 'the close reason must not leak filesystem locations');
  assert.equal(spy.sessionIds || 0, 0, 'no terminal session may be created');
  assert.equal(ctx.terminalSessions.size, 0, 'nothing registered in the shared session map');
});

test('a legacy connect without the scoped marker still opens in the shared cwd (compat lock)', () => {
  const spy = {};
  const { ctx } = fakeCtx(spy);
  const { socket, closes } = fakeSocket();
  withoutShell(() => ptyHandler.handlePtyConnection(
    socket,
    false,
    null,
    null,
    null,
    null,
    null,
    false,
    ctx,
    false,
  ));
  assert.deepEqual(closes, [], 'a non-scoped client keeps the previous behavior');
  assert.equal(spy.sessionIds || 0, 1, 'the legacy terminal session is created as before');
});

test('resolvePtyScopedCwd branch matrix', () => {
  const resolve = ptyHandler.resolvePtyScopedCwd;
  assert.equal(typeof resolve, 'function', 'the handler must export one scope resolver');
  const scoped = { scopedSelector: true, getCurrentCwd: () => GLOBAL_CWD };
  const legacy = { scopedSelector: false, getCurrentCwd: () => GLOBAL_CWD };
  assert.deepEqual(resolve({ ...scoped, workspaceFolder: SCOPED_FOLDER }), { ok: true, cwd: SCOPED_FOLDER });
  assert.deepEqual(resolve({ ...legacy, workspaceFolder: SCOPED_FOLDER }), { ok: true, cwd: SCOPED_FOLDER });
  assert.deepEqual(resolve({ ...legacy, workspaceFolder: '  ' }), { ok: true, cwd: GLOBAL_CWD },
    'an old bundle without the marker keeps falling back to the shared cwd');
  const refused = resolve({ ...scoped, workspaceFolder: undefined });
  assert.equal(refused.ok, false, 'an explicit per-tab selector may not open the global cwd');
  assert.equal(refused.reason, 'scoped-selector-missing');
  assert.equal(refused.cwd, '', 'a refusal carries no cwd');
});
