import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-widgets-'));
process.env.CURSOR_REMOTE_TEST_DATA_DIR = tempDir;

const widgets = await import('../lib/widget/widget-installations.js');
const dataFile = path.join(tempDir, 'widget-installations.json');

after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.CURSOR_REMOTE_TEST_DATA_DIR;
});

function validInput(overrides = {}) {
  return {
    name: 'Docs widget',
    workspaceFile: '/work/docs.code-workspace',
    workspaceFolder: '/work/docs',
    model: 'auto',
    allowedOrigins: ['https://docs.example.com', 'http://localhost:3000'],
    permissions: ['context', 'dom'],
    enabled: true,
    ...overrides,
  };
}

test('validates and compares exact origins', () => {
  const installation = widgets.createWidgetInstallation(validInput());

  assert.equal(widgets.isOriginAllowed(installation, 'https://docs.example.com'), true);
  assert.equal(widgets.isOriginAllowed(installation, 'https://docs.example.com:443'), true);
  assert.equal(widgets.isOriginAllowed(installation, 'https://docs.example.com.evil.test'), false);
  assert.equal(widgets.isOriginAllowed(installation, 'https://docs.example.com/path'), false);
  assert.equal(widgets.isOriginAllowed(installation, 'http://localhost:3000'), true);
  assert.equal(widgets.isOriginAllowed(installation, 'http://192.168.1.10:91'), false);

  const lanInstallation = widgets.createWidgetInstallation(validInput({
    allowedOrigins: ['http://192.168.1.10:91'],
  }));
  assert.equal(widgets.isOriginAllowed(lanInstallation, 'http://192.168.1.10:91'), true);

  assert.throws(
    () => widgets.createWidgetInstallation(validInput({
      allowedOrigins: ['http://docs.example.com'],
    })),
    /HTTP origins are allowed only for localhost and local network addresses/,
  );
  assert.throws(
    () => widgets.createWidgetInstallation(validInput({
      allowedOrigins: ['https://docs.example.com/path'],
    })),
    /Invalid origin/,
  );
  assert.throws(
    () => widgets.createWidgetInstallation(validInput({
      permissions: ['context', 'filesystem'],
    })),
    /Unsupported permission/,
  );
  const storageInstallation = widgets.createWidgetInstallation(validInput({
    permissions: ['context', 'storage'],
  }));
  assert.deepEqual(storageInstallation.permissions, ['context', 'storage']);
});

test('supports persistent CRUD without exposing its token secret', () => {
  const created = widgets.createWidgetInstallation(validInput({ name: 'CRUD widget' }));
  assert.match(created.id, /^[0-9a-f-]{36}$/i);
  assert.equal(widgets.getWidgetInstallation(created.id).name, 'CRUD widget');
  assert.ok(widgets.listWidgetInstallations().some(({ id }) => id === created.id));

  const updated = widgets.updateWidgetInstallation(created.id, {
    name: 'Updated widget',
    permissions: ['screenshot'],
    enabled: false,
  });
  assert.equal(updated.name, 'Updated widget');
  assert.deepEqual(updated.permissions, ['screenshot']);
  assert.equal(updated.enabled, false);
  assert.equal(updated.model, 'auto');
  assert.equal(updated.createdAt, created.createdAt);

  const document = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  assert.equal(typeof document.tokenSecret, 'string');
  assert.ok(document.tokenSecret.length >= 32);
  assert.equal(Object.hasOwn(updated, 'tokenSecret'), false);

  assert.equal(widgets.deleteWidgetInstallation(created.id).id, created.id);
  assert.throws(() => widgets.getWidgetInstallation(created.id), /not found/);
});

test('creates signed short-lived tokens and rejects tampering or expiry', () => {
  const installation = widgets.createWidgetInstallation(validInput({
    name: 'Token widget',
    permissions: ['context', 'network'],
  }));
  const token = widgets.createWidgetAccessToken({
    installationId: installation.id,
    origin: 'https://docs.example.com',
    pageSessionId: 'page-token-test',
  });
  const payload = widgets.verifyWidgetAccessToken(token, {
    origin: 'https://docs.example.com',
  });

  assert.equal(payload.installationId, installation.id);
  assert.equal(payload.pageSessionId, 'page-token-test');
  assert.equal(payload.origin, 'https://docs.example.com');
  assert.deepEqual(payload.permissions, ['context', 'network']);
  assert.equal(payload.workspaceFile, installation.workspaceFile);
  assert.equal(payload.workspaceFolder, installation.workspaceFolder);
  assert.equal(payload.model, installation.model);
  assert.ok(payload.exp - payload.iat <= 30 * 24 * 60 * 60 * 1000);
  assert.ok(payload.exp > Date.now());
  assert.ok(widgets.getWidgetInstallation(installation.id).lastUsedAt);
  assert.throws(
    () => widgets.verifyWidgetAccessToken(token, { origin: 'https://other.example.com' }),
    /origin does not match/,
  );

  const [encoded, signature] = token.split('.');
  const changedSignature = `${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`;
  assert.throws(
    () => widgets.verifyWidgetAccessToken(`${encoded}.${changedSignature}`),
    /signature/,
  );

  const document = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const expiredPayload = { ...payload, exp: Date.now() - 1 };
  const expiredEncoded = Buffer.from(JSON.stringify(expiredPayload)).toString('base64url');
  const expiredSignature = crypto
    .createHmac('sha256', document.tokenSecret)
    .update(expiredEncoded)
    .digest('base64url');
  assert.throws(
    () => widgets.verifyWidgetAccessToken(`${expiredEncoded}.${expiredSignature}`),
    /expired/,
  );

  assert.equal(fs.readFileSync(dataFile, 'utf8').includes(token), false);
});
