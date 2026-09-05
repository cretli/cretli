import { ISOLATED_DATA_DIR, removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { attachWebSocketHandlers } from '../lib/ws/ws-router.js';
import {
  __clearSessionWebSocketRegistryForTest,
  __countSessionWebSocketsForTest,
  registerSessionWebSocket,
  unregisterSessionWebSocket,
} from '../lib/ws/ws-session-registry.js';

const auth = await import('../lib/auth.js');
const {
  setPassword,
  createSession,
  clearSession,
  getCsrfTokenForSessionToken,
} = auth;

setPassword('test-password-123');
const sessionToken = createSession();
const csrfToken = getCsrfTokenForSessionToken(sessionToken);
assert.ok(csrfToken);

function createMockWs() {
  const events = new Map();
  return {
    closed: [],
    close(code, reason) {
      this.closed.push({ code, reason });
    },
    on(event, handler) {
      const list = events.get(event) || [];
      list.push(handler);
      events.set(event, list);
    },
    once(event, handler) {
      this.on(event, handler);
    },
    off() {},
    emit(event, ...args) {
      for (const handler of events.get(event) || []) handler(...args);
    },
  };
}

function sessionIdFromToken(token) {
  return token.slice(0, token.indexOf('.'));
}

const sessionA = createSession();
const sessionB = createSession();
const idA = sessionIdFromToken(sessionA);
const idB = sessionIdFromToken(sessionB);
const wsA = createMockWs();
const wsB = createMockWs();
registerSessionWebSocket(idA, wsA);
registerSessionWebSocket(idB, wsB);
assert.equal(__countSessionWebSocketsForTest(idA), 1);
assert.equal(__countSessionWebSocketsForTest(idB), 1);

clearSession({
  headers: { cookie: `cr_session=${encodeURIComponent(sessionA)}` },
});
assert.equal(wsA.closed.length, 1);
assert.equal(wsA.closed[0].code, 4401);
assert.equal(wsB.closed.length, 0);
assert.equal(__countSessionWebSocketsForTest(idA), 0);
assert.equal(__countSessionWebSocketsForTest(idB), 1);

setPassword('other-password-456');
assert.equal(wsB.closed.length, 1);
assert.equal(__countSessionWebSocketsForTest(), 0);

setPassword('test-password-123');
const liveToken = createSession();
const liveId = sessionIdFromToken(liveToken);
const liveWs = createMockWs();
registerSessionWebSocket(liveId, liveWs);
unregisterSessionWebSocket(liveId, liveWs);
assert.equal(__countSessionWebSocketsForTest(liveId), 0);

const wss = new EventEmitter();
attachWebSocketHandlers(wss, {
  frontHotFallbackEnabled: false,
  widgetChatAccessScope: () => true,
  workspaceDirForAgent: () => '/tmp',
  agentCmd: 'agent',
  agentModel: 'auto',
  getCurrentCwd: () => '/tmp',
  getCurrentWorkspaceFile: () => null,
  isSessionSyncEnabled: () => false,
  terminalSessions: new Map(),
  agentSessions: new Map(),
  taskRuns: new Map(),
  agentRuns: new Map(),
  devBuildRunId: 'dev',
  getCurrentAgentRunResumeId: () => null,
  setCurrentAgentRunResumeId: () => {},
  getLastTerminalSessionId: () => null,
  setLastTerminalSessionId: () => {},
  randomSessionId: () => 'abcd',
  buildInteractivePtyEnv: () => ({}),
  loadCurrentTasks: () => null,
  buildTaskRunScopeSnapshot: () => ({ workspaceFile: '', cwd: '' }),
  isTaskRunInScope: () => true,
  loadAgentsSchedule: () => ({ schedules: [] }),
  dataDir: ISOLATED_DATA_DIR,
  useHttps: true,
});

const routerToken = createSession();
const routerWs = createMockWs();
wss.emit('connection', routerWs, {
  url: '/ws-server-logs',
  headers: {
    host: 'cretli.local:3011',
    origin: 'https://cretli.local:3011',
    cookie: `cr_session=${encodeURIComponent(routerToken)}`,
  },
});
assert.equal(routerWs.closed.length, 0);
assert.equal(__countSessionWebSocketsForTest(sessionIdFromToken(routerToken)), 1);
routerWs.emit('close');
assert.equal(__countSessionWebSocketsForTest(sessionIdFromToken(routerToken)), 0);

__clearSessionWebSocketRegistryForTest();
removeIsolatedDataDir();

console.log('All ws-session-revoke tests passed.');
