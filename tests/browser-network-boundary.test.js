import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveBrowserNetworkBoundary } from '../lib/browser/network-boundary.js';

test('browser network boundary defaults to honest MVP defense in depth', () => {
  const result = resolveBrowserNetworkBoundary({});
  assert.deepEqual(result, {
    mode: 'mvp-defense-in-depth',
    proxyServer: '',
    configured: true,
    error: '',
  });
});

test('proxy and required boundaries fail closed without an explicit proxy', () => {
  for (const mode of ['proxy', 'required']) {
    const result = resolveBrowserNetworkBoundary({ CRETLI_BROWSER_NETWORK_BOUNDARY: mode });
    assert.equal(result.mode, mode);
    assert.equal(result.configured, false);
    assert.match(result.error, /CRETLI_BROWSER_PROXY_SERVER/);
  }
});

test('proxy boundary reports the configured server without claiming proxy ownership', () => {
  const result = resolveBrowserNetworkBoundary({
    CRETLI_BROWSER_NETWORK_BOUNDARY: 'required',
    CRETLI_BROWSER_PROXY_SERVER: 'http://127.0.0.1:8080',
  });
  assert.equal(result.configured, true);
  assert.equal(result.proxyServer, 'http://127.0.0.1:8080');
});

test('unknown boundary fails closed', () => {
  const result = resolveBrowserNetworkBoundary({ CRETLI_BROWSER_NETWORK_BOUNDARY: 'unbounded' });
  assert.equal(result.configured, false);
  assert.equal(result.mode, 'mvp-defense-in-depth');
  assert.match(result.error, /Unsupported network boundary/);
});
