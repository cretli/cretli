import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createFixture, EXT_ID, OWNER } from './helpers/chrome-ext-fixture.js';
import { createChromeExtStore, sha256Hex } from '../lib/browser/chrome-ext-store.js';

test('pairing code: 8 chars, 120 s TTL, single use', async () => {
  let t = 1_000_000;
  const fx = await createFixture({ now: () => t });
  try {
    const { code, ttlMs } = fx.store.createPairingCode(OWNER);
    assert.match(code, /^[A-Z2-9]{8}$/);
    assert.equal(ttlMs, 120_000);
    assert.equal(fx.store.redeemPairingCode(code, { extensionId: EXT_ID }).ok, true);
    assert.equal(fx.store.redeemPairingCode(code, { extensionId: EXT_ID }).ok, false);
    const stale = fx.store.createPairingCode(OWNER).code;
    t += 120_001;
    assert.equal(fx.store.redeemPairingCode(stale, { extensionId: EXT_ID }).ok, false);
  } finally { await fx.close(); }
});

test('five wrong attempts invalidate the live code', async () => {
  const fx = await createFixture();
  try {
    const { code } = fx.store.createPairingCode(OWNER);
    for (let i = 0; i < 5; i += 1) assert.equal(fx.store.redeemPairingCode('WRONG123', { extensionId: EXT_ID }).ok, false);
    assert.equal(fx.store.redeemPairingCode(code, { extensionId: EXT_ID }).ok, false);
  } finally { await fx.close(); }
});

test('the token is stored only as a sha256 hash and the install is bound to the owner', async () => {
  const fx = await createFixture();
  try {
    const client = await fx.pairedClient();
    const { token, installId } = client.paired;
    const raw = fs.readFileSync(path.join(fx.store.dir, 'installs.json'), 'utf8');
    assert.ok(!raw.includes(token));
    assert.ok(raw.includes(sha256Hex(token)));
    const install = fx.store.getInstallForOwner(OWNER);
    assert.equal(install.installId, installId);
    assert.equal(install.extensionId, EXT_ID);
    assert.equal(fx.store.getInstallForOwner('someone-else'), null);
    // Persistent across store instances (restart).
    assert.ok(createChromeExtStore({ dir: fx.store.dir }).authenticate(installId, token, EXT_ID));
    assert.equal(createChromeExtStore({ dir: fx.store.dir }).authenticate(installId, `${token}x`, EXT_ID), null);
    await client.close();
  } finally { await fx.close(); }
});

test('pairing requires the claimed extension id to equal the Origin id', async () => {
  const fx = await createFixture();
  try {
    const client = fx.client();
    await client.open();
    client.json({ type: 'pair', code: fx.store.createPairingCode(OWNER).code, extensionId: 'b'.repeat(32) });
    assert.equal((await client.closed).code, 4403);
    assert.equal(fx.store.getInstallForOwner(OWNER), null);
  } finally { await fx.close(); }
});

test('an install token is useless from another extension id', async () => {
  const fx = await createFixture();
  try {
    const first = await fx.pairedClient();
    const { token, installId } = first.paired;
    const other = fx.client({ extensionId: 'c'.repeat(32) });
    await other.open();
    other.json({ type: 'auth', installId, token });
    assert.equal((await other.closed).code, 4403);
    await first.close();
  } finally { await fx.close(); }
});

test('revoking closes the socket with 4403 and deletes the token hash', async () => {
  const fx = await createFixture();
  try {
    const client = await fx.pairedClient();
    assert.equal(fx.bridge.revoke(OWNER), true);
    assert.deepEqual((await client.closed).code, 4403);
    assert.equal(fx.store.getInstallForOwner(OWNER), null);
    const again = fx.client();
    await again.open();
    again.json({ type: 'auth', installId: client.paired.installId, token: client.paired.token });
    assert.equal((await again.closed).code, 4403);
  } finally { await fx.close(); }
});

test('a second authenticated connection replaces the first with 4409', async () => {
  const fx = await createFixture();
  try {
    const first = await fx.pairedClient();
    const second = fx.client();
    await second.open();
    second.json({ type: 'auth', installId: first.paired.installId, token: first.paired.token });
    await second.next('authed');
    assert.equal((await first.closed).code, 4409);
    assert.equal(fx.bridge.status(OWNER).connected, true);
    await second.close();
  } finally { await fx.close(); }
});
