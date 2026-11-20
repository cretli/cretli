import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import express from 'express';
import {
  exitOnTlsFailure,
  isHttpsRequested,
  readTlsMaterials,
  resolveServerTransport,
  shouldGenerateDefaultTlsCerts,
} from '../lib/server-tls.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-server-tls-'));
const keyPath = path.join(tempDir, 'key.pem');
const certPath = path.join(tempDir, 'cert.pem');
const openssl = spawnSync('openssl', [
  'req', '-x509', '-newkey', 'rsa:2048',
  '-keyout', keyPath,
  '-out', certPath,
  '-days', '1',
  '-nodes',
  '-subj', '/CN=localhost',
], { stdio: 'ignore' });
assert.equal(openssl.status, 0, 'openssl must be available for server-tls-policy tests');

assert.equal(isHttpsRequested('1'), true);
assert.equal(isHttpsRequested('true'), true);
assert.equal(isHttpsRequested('0'), false);

const app = express();
const httpResolved = resolveServerTransport(app, {
  useHttpsEnv: '0',
  keyPath,
  certPath,
});
assert.equal(httpResolved.useHttps, false);

const httpsResolved = resolveServerTransport(app, {
  useHttpsEnv: '1',
  keyPath,
  certPath,
});
assert.equal(httpsResolved.useHttps, true);

const defaultKey = path.join(tempDir, 'key.pem');
const defaultCert = path.join(tempDir, 'cert.pem');
assert.equal(shouldGenerateDefaultTlsCerts({
  useHttpsEnv: '0',
  keyPath: defaultKey,
  certPath: defaultCert,
  defaultKeyPath: defaultKey,
  defaultCertPath: defaultCert,
}), false);
assert.equal(shouldGenerateDefaultTlsCerts({
  useHttpsEnv: '1',
  keyPath: defaultKey,
  certPath: defaultCert,
  defaultKeyPath: defaultKey,
  defaultCertPath: defaultCert,
}), true);
assert.equal(shouldGenerateDefaultTlsCerts({
  useHttpsEnv: '1',
  keyPath: path.join(tempDir, 'custom.key'),
  certPath: path.join(tempDir, 'custom.crt'),
  defaultKeyPath: defaultKey,
  defaultCertPath: defaultCert,
}), false);

const skipDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-skip-tls-'));
const skipGen = spawnSync(process.execPath, ['scripts/generate-ssl-cert.js', '--if-needed'], {
  cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
  env: {
    ...process.env,
    USE_HTTPS: '0',
    CRETLI_DATA_DIR: skipDir,
  },
  encoding: 'utf8',
});
assert.equal(skipGen.status, 0);
assert.match(String(skipGen.stdout || ''), /Skipping default TLS/);
assert.equal(fs.existsSync(path.join(skipDir, 'key.pem')), false);
fs.rmSync(skipDir, { recursive: true, force: true });

assert.throws(
  () => readTlsMaterials(path.join(tempDir, 'missing.key'), certPath),
  /TLS key not found/,
);

const badPemPath = path.join(tempDir, 'bad.pem');
fs.writeFileSync(badPemPath, 'not pem');
assert.throws(
  () => readTlsMaterials(badPemPath, badPemPath),
  /not valid PEM/,
);

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      probe.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

function isPortListening(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

const tlsPort = await getFreePort();
const tlsFailure = await new Promise((resolve) => {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      USE_HTTPS: '1',
      CRETLI_DATA_DIR: tempDir,
      SSL_KEY_PATH: path.join(tempDir, 'missing-key.pem'),
      SSL_CERT_PATH: certPath,
      PORT: String(tlsPort),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    resolve({ timedOut: true, code: null, stderr });
  }, 8000);
  child.on('exit', (code) => {
    clearTimeout(timer);
    resolve({ timedOut: false, code, stderr });
  });
});
assert.equal(tlsFailure.timedOut, false, 'TLS failure must exit without hanging');
assert.notEqual(tlsFailure.code, 0);
assert.match(tlsFailure.stderr, /HTTPS is enabled but TLS setup failed|TLS key not found/);
assert.equal(await isPortListening(tlsPort), false);

const customDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-custom-tls-'));
const customKey = path.join(customDir, 'custom.key');
const customCert = path.join(customDir, 'custom.crt');
fs.copyFileSync(keyPath, customKey);
fs.copyFileSync(certPath, customCert);
const noOpenSsl = spawnSync(process.execPath, ['scripts/generate-ssl-cert.js', '--if-needed'], {
  cwd: projectRoot,
  env: {
    ...process.env,
    USE_HTTPS: '1',
    CRETLI_DATA_DIR: customDir,
    SSL_KEY_PATH: customKey,
    SSL_CERT_PATH: customCert,
    PATH: path.join(customDir, 'empty-bin'),
    PREFIX: '',
  },
  encoding: 'utf8',
});
assert.equal(noOpenSsl.status, 0);
assert.match(String(noOpenSsl.stdout || ''), /Skipping default TLS/);
fs.rmSync(customDir, { recursive: true, force: true });

let caught = false;
const originalExit = process.exit;
process.exit = (code) => {
  caught = true;
  throw new Error(`exit:${code}`);
};
try {
  exitOnTlsFailure(new Error('test failure'));
} catch (err) {
  assert.match(String(err.message), /^exit:1$/);
}
process.exit = originalExit;
assert.equal(caught, true);

fs.rmSync(tempDir, { recursive: true, force: true });

console.log('All server-tls-policy tests passed.');
