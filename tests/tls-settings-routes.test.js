import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import https from 'node:https';
import { X509Certificate } from 'node:crypto';
import express from 'express';
import { resolveServerTransport } from '../lib/server-tls.js';
import { describeCertificate, registerTlsSettingsRoutes } from '../lib/routes/tls-settings-routes.js';

const dir = mkdtempSync(path.join(tmpdir(), 'cretli-tls-settings-'));
const keyPath = path.join(dir, 'key.pem');
const certPath = path.join(dir, 'cert.pem');
function generate(name) {
  const key = path.join(dir, `${name}.key`);
  const cert = path.join(dir, `${name}.pem`);
  const result = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert, '-days', '3', '-subj', `/CN=${name}`,
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
  assert.equal(result.status, 0);
  return { key, cert, pem: readFileSync(cert, 'utf8') };
}
const first = generate('first');
const second = generate('second');
copyFileSync(first.key, keyPath);
copyFileSync(first.cert, certPath);
const app = express();
app.use(express.json());
// The production app uses requireAuth and the widget gate before these routes.
app.use((req, _res, next) => {
  if (req.headers['x-test-token'] === 'mcp') req.mcpIntegration = {};
  if (req.headers['x-test-token'] === 'widget') req.widgetAccess = {};
  next();
});
const transport = resolveServerTransport(app, { useHttpsEnv: '1', keyPath, certPath });
registerTlsSettingsRoutes(app, { server: transport.server, certificate: transport.tlsCertificate, keyPath, certPath });
await new Promise((resolve) => transport.server.listen(0, '127.0.0.1', resolve));
const port = transport.server.address().port;
function request(route = '', { method = 'GET', body, token } = {}) {
  return new Promise((resolve, reject) => {
    // This isolated fixture deliberately issues its own self-signed certificates.
    const req = https.request({ hostname: '127.0.0.1', port, path: `/api/settings/tls${route}`,
      method, rejectUnauthorized: false, agent: false,
      headers: { 'Content-Type': 'application/json', ...(token ? { 'x-test-token': token } : {}) },
    }, (res) => {
      const peer = res.socket.getPeerCertificate().fingerprint256;
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, peer,
        json: () => JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}
try {
  const original = describeCertificate(first.pem);
  const next = describeCertificate(second.pem);
  assert.equal(original.selfSigned, true);
  assert.equal(describeCertificate(first.pem, 0).status, 'notYetValid');
  assert.equal(describeCertificate(first.pem, Date.parse(original.validTo)).status, 'expired');
  assert.equal(describeCertificate(first.pem, Date.parse(original.validTo) - 1000).status, 'expiring');
  let response = await request();
  assert.equal(response.json().active.fingerprint, original.fingerprint);
  assert.equal(response.peer, original.fingerprint);
  assert.equal(response.json().pending, null);
  assert.equal(response.headers['cache-control'], 'no-store');
  for (const token of ['mcp', 'widget']) {
    assert.equal((await request('', { token })).status, 403);
    assert.equal((await request('/certificate', { token })).status, 403);
    assert.equal((await request('/reload', { method: 'POST', token })).status, 403);
  }
  copyFileSync(second.cert, certPath);
  response = await request();
  assert.equal(response.json().fileError, true, 'mismatched key is rejected');
  assert.equal(response.peer, original.fingerprint);
  assert.equal((await request('/reload', { method: 'POST', body: { revision: next.revision } })).status, 400);
  copyFileSync(second.key, keyPath);
  response = await request();
  assert.equal(response.json().pending.fingerprint, next.fingerprint);
  assert.equal(response.peer, original.fingerprint, 'disk changes do not silently activate');
  const download = await request('/certificate');
  assert.equal(new X509Certificate(download.text).fingerprint256, original.fingerprint);
  assert.doesNotMatch(download.text, /PRIVATE KEY/);
  response = await request('/reload', { method: 'POST', body: { revision: original.revision } });
  assert.equal(response.status, 409, 'applying requires the reviewed certificate');
  response = await request('/reload', { method: 'POST', body: { revision: next.revision } });
  assert.equal(response.status, 200);
  assert.equal(response.json().active.fingerprint, next.fingerprint);
  response = await request();
  assert.equal(response.peer, next.fingerprint, 'new HTTPS connections receive the new certificate');
  assert.equal(response.json().pending, null);
  assert.equal(new X509Certificate((await request('/certificate')).text).fingerprint256, next.fingerprint);
  writeFileSync(certPath, second.pem + first.pem);
  response = await request();
  assert.equal(response.json().pending.fingerprint, next.fingerprint, 'chain-only changes are detected');
  const chainRevision = response.json().pending.revision;
  assert.notEqual(chainRevision, next.revision);
  assert.equal((await request('/reload', { method: 'POST', body: { revision: next.revision } })).status, 409);
  assert.equal((await request('/reload', { method: 'POST', body: { revision: chainRevision } })).status, 200);
  assert.equal(((await request('/certificate')).text.match(/BEGIN CERTIFICATE/g) || []).length, 2);
  writeFileSync(certPath, 'invalid');
  assert.equal((await request('/reload', { method: 'POST', body: { revision: next.revision } })).status, 400);
  assert.equal((await request()).peer, next.fingerprint, 'bad replacement preserves working TLS');
} finally {
  await new Promise((resolve) => transport.server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
}
const httpApp = express();
const httpTransport = resolveServerTransport(httpApp, { useHttpsEnv: '0', keyPath, certPath });
registerTlsSettingsRoutes(httpApp, { server: httpTransport.server, certificate: httpTransport.tlsCertificate, keyPath, certPath });
await new Promise((resolve) => httpTransport.server.listen(0, '127.0.0.1', resolve));
try {
  const base = `http://127.0.0.1:${httpTransport.server.address().port}/api/settings/tls`;
  assert.deepEqual(await (await fetch(base)).json(), { ok: true, enabled: false });
  assert.equal((await fetch(`${base}/certificate`)).status, 409);
  assert.equal((await fetch(`${base}/reload`, { method: 'POST' })).status, 409);
} finally {
  await new Promise((resolve) => httpTransport.server.close(resolve));
}
console.log('tls-settings-routes: passed (live TLS replacement, validation, public download, token restrictions)');
