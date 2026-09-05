import { ISOLATED_DATA_DIR, removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { attachWebSocketHandlers } from '../lib/ws/ws-router.js';
import {
  evaluateWidgetHandshake,
  requiresSessionAuth,
  resolveWidgetAccessToken,
} from '../lib/ws/ws-auth-boundary.js';
import { isWsOriginAllowed } from '../lib/ws/ws-origin.js';

const widgets = await import('../lib/widget/widget-installations.js');
const auth = await import('../lib/auth.js');

function createInstallation() {
  return widgets.createWidgetInstallation({
    name: 'Docs widget',
    workspaceFile: '/work/docs.code-workspace',
    workspaceFolder: '/work/docs',
    model: 'auto',
    allowedOrigins: ['https://docs.example.com', 'https://cretli.local:3011'],
    permissions: ['context', 'dom'],
    enabled: true,
  });
}

function issueToken(installationId, origin, pageSessionId = 'page-session-1') {
  return widgets.createWidgetAccessToken({
    installationId,
    origin,
    pageSessionId,
  });
}

function createMockWs() {
  const events = new Map();
  return {
    closed: [],
    send(data) {
      this.sent = this.sent || [];
      this.sent.push(data);
    },
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
    off(event, handler) {
      const list = events.get(event) || [];
      events.set(event, list.filter((item) => item !== handler));
    },
    emit(event, ...args) {
      for (const handler of events.get(event) || []) handler(...args);
    },
  };
}

const httpsOpts = { useHttps: true };
const installation = createInstallation();
const hostToken = issueToken(installation.id, 'https://docs.example.com');
const cretliToken = issueToken(installation.id, 'https://docs.example.com', 'iframe-session');

assert.throws(
  () => resolveWidgetAccessToken({
    headers: {
      origin: 'https://other.example',
      host: 'cretli.local:3011',
    },
  }, hostToken, httpsOpts),
  /origin does not match|Origin is not allowed|Invalid widget access token/,
);

const iframeAccess = resolveWidgetAccessToken({
  headers: {
    origin: 'https://cretli.local:3011',
    host: 'cretli.local:3011',
  },
}, cretliToken, httpsOpts);
assert.equal(iframeAccess.pageSessionId, 'iframe-session');

const httpIframeRejected = (() => {
  try {
    resolveWidgetAccessToken({
      headers: {
        origin: 'http://cretli.local:3011',
        host: 'cretli.local:3011',
      },
    }, cretliToken, httpsOpts);
    return false;
  } catch {
    return true;
  }
})();
assert.equal(httpIframeRejected, true);

const externalAccess = resolveWidgetAccessToken({
  headers: {
    origin: 'https://docs.example.com',
    host: 'cretli.local:3011',
  },
}, hostToken, httpsOpts);
assert.equal(externalAccess.origin, 'https://docs.example.com');

const proxyOpts = {
  useHttps: false,
  publicOrigin: 'https://cretli.example',
};
const proxyIframeAccess = resolveWidgetAccessToken({
  headers: {
    origin: 'https://cretli.example',
    host: '127.0.0.1:3011',
    'x-forwarded-proto': 'https',
    'x-forwarded-host': 'cretli.example',
  },
}, cretliToken, proxyOpts);
assert.equal(proxyIframeAccess.pageSessionId, 'iframe-session');

const extraOriginsAreNotIframe = (() => {
  try {
    resolveWidgetAccessToken({
      headers: {
        origin: 'https://cretli.example',
        host: '127.0.0.1:3011',
      },
    }, cretliToken, { useHttps: false, extraOrigins: ['https://cretli.example'] });
    return false;
  } catch {
    return true;
  }
})();
assert.equal(extraOriginsAreNotIframe, true);

const stolenTokenRejected = (() => {
  try {
    resolveWidgetAccessToken({
      headers: {
        origin: 'https://evil.example',
        host: '127.0.0.1:3011',
      },
    }, cretliToken, proxyOpts);
    return false;
  } catch {
    return true;
  }
})();
assert.equal(stolenTokenRejected, true);

const badTokenDecision = evaluateWidgetHandshake({
  headers: {
    origin: 'https://cretli.local:3011',
    host: 'cretli.local:3011',
    'sec-websocket-protocol': 'cretli-widget, not-a-real-token',
  },
}, '/ws-agent-sdk', httpsOpts);
assert.equal(badTokenDecision.action, 'reject');
assert.equal(requiresSessionAuth(badTokenDecision), true);

const wrongPathDecision = evaluateWidgetHandshake({
  headers: {
    origin: 'https://docs.example.com',
    host: 'cretli.local:3011',
    'sec-websocket-protocol': `cretli-widget, ${hostToken}`,
  },
}, '/ws-server-logs', httpsOpts);
assert.equal(wrongPathDecision.action, 'reject');

auth.setPassword('test-password-123');
const sessionToken = auth.createSession();

const terminalBypassReq = {
  url: '/ws',
  headers: {
    origin: 'https://evil.example',
    host: 'cretli.local:3011',
    cookie: `cr_session=${encodeURIComponent(sessionToken)}`,
    'sec-websocket-protocol': `cretli-widget, ${hostToken}`,
  },
};
assert.equal(isWsOriginAllowed(terminalBypassReq, '/ws', httpsOpts), false);

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
  randomSessionId: () => crypto.randomBytes(4).toString('hex'),
  buildInteractivePtyEnv: () => ({}),
  loadCurrentTasks: () => null,
  buildTaskRunScopeSnapshot: () => ({ workspaceFile: '', cwd: '' }),
  isTaskRunInScope: () => true,
  loadAgentsSchedule: () => ({ schedules: [] }),
  dataDir: ISOLATED_DATA_DIR,
  useHttps: true,
});

const terminalWs = createMockWs();
wss.emit('connection', terminalWs, terminalBypassReq);
assert.equal(terminalWs.closed.length, 1);
assert.equal(terminalWs.closed[0].code, 4403);

const pageBridgeWs = createMockWs();
wss.emit('connection', pageBridgeWs, {
  url: '/ws-page-bridge',
  headers: {
    origin: 'https://docs.example.com',
    host: 'cretli.local:3011',
  },
});
assert.equal(pageBridgeWs.closed.length, 0);
pageBridgeWs.emit('message', Buffer.from(JSON.stringify({ type: 'not-auth' })));
assert.equal(pageBridgeWs.closed.length, 1);
assert.equal(pageBridgeWs.closed[0].code, 4403);

const badPageSessionWs = createMockWs();
wss.emit('connection', badPageSessionWs, {
  url: '/ws-page-bridge',
  headers: {
    origin: 'https://docs.example.com',
    host: 'cretli.local:3011',
  },
});
badPageSessionWs.emit('message', Buffer.from(JSON.stringify({
  type: 'auth',
  token: hostToken,
  pageSessionId: 'wrong-session',
})));
assert.equal(badPageSessionWs.closed.length, 1);
assert.equal(badPageSessionWs.closed[0].code, 4403);

removeIsolatedDataDir();

console.log('All ws-auth-boundary tests passed.');
