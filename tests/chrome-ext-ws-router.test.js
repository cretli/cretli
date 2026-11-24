import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixture, ctxFor, EXT_ID, OWNER } from './helpers/chrome-ext-fixture.js';

test('no first message within the auth timeout closes with 4401', async () => {
  const fx = await createFixture({ authTimeoutMs: 100 });
  try {
    const client = fx.client();
    await client.open();
    assert.equal((await client.closed).code, 4401);
  } finally { await fx.close(); }
});

test('wrong origin and missing origin are refused before any message', async () => {
  const fx = await createFixture();
  try {
    for (const origin of ['https://evil.example', 'null', `chrome-extension://${'z'.repeat(32)}`]) {
      const client = fx.client({ origin });
      await client.open();
      assert.equal((await client.closed).code, 4403, origin);
    }
  } finally { await fx.close(); }
});

test('bad token, binary first frame, unknown first message: 4403', async () => {
  const fx = await createFixture();
  try {
    const paired = await fx.pairedClient();
    const bad = fx.client();
    await bad.open();
    bad.json({ type: 'auth', installId: paired.paired.installId, token: 'nope' });
    assert.equal((await bad.closed).code, 4403);
    const binary = fx.client();
    await binary.open();
    binary.ws.send(Buffer.from([1, 2, 3]), { binary: true });
    assert.equal((await binary.closed).code, 4403);
    const unknown = fx.client();
    await unknown.open();
    unknown.json({ type: 'cmd' });
    assert.equal((await unknown.closed).code, 4403);
    assert.equal(fx.bridge.status(OWNER).connected, true);
    await paired.close();
  } finally { await fx.close(); }
});

test('malformed unauthenticated frame is closed safely and does not emit an unhandled server error', async () => {
  const fx = await createFixture();
  let fatal = null;
  const onFatal = (error) => { fatal = error; };
  process.on('uncaughtException', onFatal);
  try {
    const client = fx.client();
    await client.open();
    client.ws.send('{malformed');
    const result = await Promise.race([
      client.closed,
      new Promise((resolve) => setTimeout(() => resolve(null), 250)),
    ]);
    assert.equal(result?.code, 4403);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(fatal, null);
    assert.equal(fx.bridge.status(OWNER).connected, false);
  } finally {
    process.off('uncaughtException', onFatal);
    await fx.close();
  }
});

test('invalid UTF-8 in an unauthenticated text frame closes the transport safely', async () => {
  const fx = await createFixture();
  try {
    const client = fx.client();
    await client.open();
    client.ws.send(Buffer.from([0xc3, 0x28]), { binary: false });
    assert.equal((await client.closed).code, 1007);
    const healthy = await fx.pairedClient();
    assert.equal(fx.bridge.status(OWNER).connected, true);
    await healthy.close();
  } finally { await fx.close(); }
});

test('socket error before pairing is handled and cleaned up', async () => {
  const fx = await createFixture();
  try {
    const client = fx.client();
    await client.open();
    fx.serverSockets()[0].emit('error', new Error('simulated transport failure'));
    assert.equal((await client.closed).code, 1011);
    assert.equal(fx.bridge.status(OWNER).connected, false);
  } finally { await fx.close(); }
});

test('kill switch refuses commands with E_KILLED, closes the socket and refuses reconnects', async () => {
  const fx = await createFixture();
  try {
    const client = await fx.pairedClient();
    fx.bridge.setKilled(OWNER, true);
    assert.equal((await client.closed).code, 4403);
    const outcome = await fx.bridge.execute(ctxFor(), 'open_url', { url: 'https://shop.example.com' });
    assert.equal(outcome.error.code, 'E_KILLED');
    const again = fx.client();
    await again.open();
    again.json({ type: 'auth', installId: client.paired.installId, token: client.paired.token });
    assert.equal((await again.closed).code, 4403);
    // The kill switch deleted the token hash: turning it off does not revive the old token.
    assert.equal(fx.store.getInstallForOwner(OWNER), null);
    fx.bridge.setKilled(OWNER, false);
    const old = fx.client();
    await old.open();
    old.json({ type: 'auth', installId: client.paired.installId, token: client.paired.token });
    assert.equal((await old.closed).code, 4403);
    assert.equal((await fx.bridge.execute(ctxFor(), 'open_url', { url: 'https://shop.example.com' })).error.code, 'E_NOT_PAIRED');
    // Pairing is refused while killed, and works again after a re-pair once the switch is off.
    fx.bridge.setKilled(OWNER, true);
    const blocked = fx.client();
    await blocked.open();
    blocked.json({ type: 'pair', code: fx.store.createPairingCode(OWNER).code, extensionId: EXT_ID });
    assert.equal((await blocked.closed).code, 4403);
    assert.equal(fx.store.getInstallForOwner(OWNER), null);
    fx.bridge.setKilled(OWNER, false);
    const repaired = await fx.pairedClient();
    assert.equal(fx.bridge.status(OWNER).connected, true);
    await repaired.close();
  } finally { await fx.close(); }
});

test('reconnect after a dropped socket restores the connection; disconnect fails the running command', async () => {
  const fx = await createFixture();
  try {
    fx.store.approveDomain(OWNER, 'shop.example.com');
    const client = await fx.pairedClient();
    client.respondWith(() => null); // never answers
    const running = fx.bridge.execute(ctxFor(), 'open_url', { url: 'https://shop.example.com/' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    client.ws.terminate();
    assert.equal((await running).error.code, 'E_DISCONNECTED');
    assert.equal(fx.bridge.status(OWNER).connected, false);
    assert.equal((await fx.bridge.execute(ctxFor(), 'open_url', { url: 'https://shop.example.com/' })).error.code, 'E_DISCONNECTED');
    const back = fx.client();
    await back.open();
    back.json({ type: 'auth', installId: client.paired.installId, token: client.paired.token });
    const authed = await back.next('authed');
    assert.deepEqual(authed.allowed, ['shop.example.com']);
    assert.equal(fx.bridge.status(OWNER).connected, true);
    back.json({ type: 'ping' });
    assert.equal((await back.next('pong')).type, 'pong');
    await back.close();
  } finally { await fx.close(); }
});

test('a cookie-less extension is never answered with auth.loginRequired', async () => {
  const fx = await createFixture();
  try {
    const client = fx.client();
    await client.open();
    // Still open: the router handed the socket to the bridge instead of closing it for missing cookies.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(client.closeInfo, null);
    client.ws.terminate();
  } finally { await fx.close(); }
});

test('commands without a pairing report E_NOT_PAIRED', async () => {
  const fx = await createFixture();
  try {
    assert.equal((await fx.bridge.execute(ctxFor(), 'open_url', { url: 'https://a.example.com' })).error.code, 'E_NOT_PAIRED');
    assert.ok(EXT_ID);
  } finally { await fx.close(); }
});
