import assert from 'node:assert/strict';
import {
  applyCodexTermuxNetworkEnv,
  buildCodexTermuxProotArgs,
  getCodexTermuxRequestErrorHint,
  isCodexDeviceAuthRequestError,
  resolveTermuxCaBundle,
} from '../lib/codex/codex-termux-net.js';

assert.equal(resolveTermuxCaBundle({
  PREFIX: '/data/data/com.termux/files/usr',
  existsFn: (p) => p === '/data/data/com.termux/files/usr/etc/tls/cert.pem',
}), '/data/data/com.termux/files/usr/etc/tls/cert.pem');

assert.equal(resolveTermuxCaBundle({
  PREFIX: '/nope',
  existsFn: () => false,
}), '');

const env = { PREFIX: '/data/data/com.termux/files/usr' };
applyCodexTermuxNetworkEnv(env, {
  platform: 'android',
  existsFn: (p) => p === '/data/data/com.termux/files/usr/etc/tls/cert.pem',
});
assert.equal(env.SSL_CERT_FILE, '/data/data/com.termux/files/usr/etc/tls/cert.pem');
assert.equal(env.CODEX_CA_CERTIFICATE, '/data/data/com.termux/files/usr/etc/tls/cert.pem');

const already = {
  PREFIX: '/data/data/com.termux/files/usr',
  SSL_CERT_FILE: '/custom/ca.pem',
};
applyCodexTermuxNetworkEnv(already, {
  platform: 'android',
  existsFn: (p) => p.endsWith('cert.pem'),
});
assert.equal(already.SSL_CERT_FILE, '/custom/ca.pem');

assert.deepEqual(buildCodexTermuxProotArgs({
  proot: '/data/data/com.termux/files/usr/bin/proot',
  resolv: '/tmp/resolv.conf',
  ca: '/tmp/cert.pem',
  bin: '/tmp/codex',
}), [
  '/data/data/com.termux/files/usr/bin/proot',
  '-b', '/tmp/resolv.conf:/etc/resolv.conf',
  '-b', '/tmp/cert.pem:/etc/ssl/certs/ca-certificates.crt',
  '/tmp/codex',
]);

const requestErr = 'Error logging in with device code: error sending request for url (https://auth.openai.com/api/accounts/deviceauth/usercode)';
assert.equal(isCodexDeviceAuthRequestError(requestErr), true);
assert.equal(isCodexDeviceAuthRequestError('device code ABCD-EFGHI'), false);
assert.match(getCodexTermuxRequestErrorHint(), /proot/);
assert.match(getCodexTermuxRequestErrorHint(), /ca-certificates/);

console.log('codex-termux-net.test.js OK');
