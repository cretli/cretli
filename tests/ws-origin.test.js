import assert from 'node:assert/strict';
import {
  getDirectRequestHost,
  hasWidgetProtocol,
  isCretliPublicOrigin,
  isOwnCretliBrowserOrigin,
  isOriginInExtraAllowlist,
  isSameHostOrigin,
  isValidOriginHeader,
  isWsOriginAllowed,
  normalizeOrigin,
  originHost,
  parseExtraWsOrigins,
  parseWebSocketProtocols,
  readCretliPublicOrigin,
} from '../lib/ws/ws-origin.js';

assert.deepEqual(parseExtraWsOrigins('https://a.example, https://b.example'), [
  'https://a.example',
  'https://b.example',
]);

assert.equal(originHost('https://docs.example.com:443/path'), 'docs.example.com');
assert.equal(normalizeOrigin('https://docs.example.com'), 'https://docs.example.com:443');
assert.equal(normalizeOrigin('https://docs.example.com:8443'), 'https://docs.example.com:8443');
assert.equal(normalizeOrigin('null'), null);
assert.equal(normalizeOrigin('ftp://docs.example.com'), null);
assert.equal(isValidOriginHeader('null'), false);

const sameHostReq = {
  headers: {
    origin: 'https://cretli.local:3011',
    host: 'cretli.local:3011',
  },
};
assert.equal(isWsOriginAllowed(sameHostReq, '/ws', { useHttps: true }), true);
assert.equal(isSameHostOrigin(sameHostReq, 'https://cretli.local:3011', { useHttps: true }), true);
assert.equal(isSameHostOrigin(sameHostReq, 'http://cretli.local:3011', { useHttps: true }), false);
assert.equal(isSameHostOrigin(sameHostReq, 'https://cretli.local:3011', { useHttps: false }), false);
assert.equal(isWsOriginAllowed(sameHostReq, '/ws', { useHttps: false }), false);

const noOriginReq = { headers: { host: 'cretli.local:3011' } };
assert.equal(isWsOriginAllowed(noOriginReq, '/ws'), true);
assert.equal(isWsOriginAllowed(noOriginReq, '/ws-agent-sdk', {
  extraOrigins: [],
}), true);

const foreignReq = {
  headers: {
    origin: 'https://evil.example',
    host: 'cretli.local:3011',
  },
};
assert.equal(isWsOriginAllowed(foreignReq, '/ws'), false);
assert.equal(
  isWsOriginAllowed(foreignReq, '/ws', { extraOrigins: ['https://evil.example'] }),
  true,
);
assert.equal(
  isWsOriginAllowed(foreignReq, '/ws', { extraOrigins: ['https://evil.example:443'] }),
  true,
);
assert.equal(
  isWsOriginAllowed(foreignReq, '/ws', { extraOrigins: ['evil.example'] }),
  false,
);

const proxyHttpsReq = {
  headers: {
    origin: 'https://app.example:8443',
    host: '127.0.0.1:3011',
  },
};
assert.equal(
  isWsOriginAllowed(proxyHttpsReq, '/ws', {
    useHttps: false,
    extraOrigins: ['https://app.example:8443'],
  }),
  true,
);
assert.equal(
  isWsOriginAllowed(proxyHttpsReq, '/ws', {
    useHttps: false,
    extraOrigins: ['http://app.example:8443'],
  }),
  false,
);

const forwardedHostReq = {
  headers: {
    origin: 'https://evil.example',
    host: 'cretli.local:3011',
    'x-forwarded-host': 'evil.example',
  },
};
assert.equal(getDirectRequestHost(forwardedHostReq), 'cretli.local:3011');
assert.equal(isWsOriginAllowed(forwardedHostReq, '/ws'), false);

const widgetTerminalReq = {
  headers: {
    origin: 'https://evil.example',
    host: 'cretli.local:3011',
    'sec-websocket-protocol': 'cretli-widget, token-value',
  },
};
assert.equal(isWsOriginAllowed(widgetTerminalReq, '/ws'), false);
assert.equal(isWsOriginAllowed(widgetTerminalReq, '/ws-server-logs'), false);
assert.equal(isWsOriginAllowed(widgetTerminalReq, '/ws-task'), false);

const substringProtocolReq = {
  headers: {
    origin: 'https://evil.example',
    host: 'cretli.local:3011',
    'sec-websocket-protocol': 'prefix-cretli-widget-suffix, token',
  },
};
assert.equal(hasWidgetProtocol(parseWebSocketProtocols(substringProtocolReq)), false);
assert.equal(isWsOriginAllowed(substringProtocolReq, '/ws'), false);

const widgetChatReq = {
  headers: {
    origin: 'https://docs.example.com',
    host: 'cretli.local:3011',
    'sec-websocket-protocol': 'cretli-widget, token',
  },
};
assert.equal(isWsOriginAllowed(widgetChatReq, '/ws-agent-sdk'), true);
assert.equal(isWsOriginAllowed(widgetChatReq, '/ws'), false);

const pageBridgeReq = {
  headers: {
    origin: 'https://docs.example.com',
    host: 'cretli.local:3011',
  },
};
assert.equal(isWsOriginAllowed(pageBridgeReq, '/ws-page-bridge'), true);
assert.equal(isWsOriginAllowed({ headers: { host: 'cretli.local:3011' } }, '/ws-page-bridge'), false);

assert.equal(
  isOriginInExtraAllowlist('https://proxy.example:8443', ['https://proxy.example:8443']),
  true,
);
assert.equal(
  isOriginInExtraAllowlist('http://proxy.example:8080', ['https://proxy.example:8443']),
  false,
);

const publicOrigin = 'https://cretli.example';
const proxyIframeReq = {
  headers: {
    origin: publicOrigin,
    host: '127.0.0.1:3011',
    'x-forwarded-proto': 'https',
    'x-forwarded-host': 'cretli.example',
  },
};
assert.equal(isCretliPublicOrigin(publicOrigin, publicOrigin), true);
assert.equal(isOwnCretliBrowserOrigin(proxyIframeReq, publicOrigin, {
  useHttps: false,
  publicOrigin,
}), true);
assert.equal(isWsOriginAllowed(proxyIframeReq, '/ws', {
  useHttps: false,
  publicOrigin,
}), true);
assert.equal(isOwnCretliBrowserOrigin(proxyIframeReq, publicOrigin, {
  useHttps: false,
  extraOrigins: [publicOrigin],
}), false);
assert.equal(readCretliPublicOrigin('not-an-origin'), null);
assert.equal(readCretliPublicOrigin('https://cretli.example/path'), null);

console.log('All ws-origin tests passed.');
