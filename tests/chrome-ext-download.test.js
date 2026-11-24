import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createFixture, ctxFor, openShopTab, OWNER } from './helpers/chrome-ext-fixture.js';
import { sanitizeFileName } from '../lib/browser/cretli-extension-bridge.js';

const MiB = 1024 * 1024;
const pdf = (n = 1000) => Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(n, 0x61)]);
const items = (n) => Array.from({ length: n }, (_, i) => ({ href: `https://shop.example.com/inv-${i}.pdf` }));
const partFiles = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith('.part')) : []);

async function setup() {
  const fx = await createFixture();
  const client = await fx.pairedClient();
  const tabId = await openShopTab(fx, client);
  return { fx, client, tabId };
}

/** Fake extension that sends the given files (in order) for a download command. */
function sendsFiles(client, files) {
  client.respondWith((cmd) => {
    if (cmd.name !== 'download') return null;
    for (const file of files) client.sendFile(cmd.id, file);
    return { ok: true, data: {} };
  });
}

test('binary framing: file lands in the chat dir with size, sha256, mime; audit written', async () => {
  const { fx, client, tabId } = await setup();
  try {
    const bytes = pdf(600 * 1024); // three frames
    sendsFiles(client, [{ name: 'Invoice 01.pdf', mime: 'application/pdf', bytes }]);
    const out = await fx.bridge.execute(ctxFor({ chatId: 'chat/1' }), 'download', { tabId, items: items(1) });
    assert.equal(out.ok, true, JSON.stringify(out));
    const [file] = out.data.files;
    assert.equal(file.size, bytes.length);
    assert.equal(file.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
    assert.equal(file.mime, 'application/pdf');
    assert.equal(file.name, 'Invoice_01.pdf');
    assert.equal(path.dirname(file.path), path.join(fx.downloadsDir, 'chat_1'));
    assert.ok(file.path.startsWith(fx.root));
    assert.deepEqual(fs.readFileSync(file.path), bytes);
    assert.equal(fs.statSync(path.dirname(file.path)).mode & 0o077, 0);
    assert.deepEqual(partFiles(fx.downloadsDir), []);
    const [entry] = fx.store.readAudit(OWNER);
    assert.deepEqual([entry.chatId, entry.domain, entry.file, entry.size, entry.sha256, entry.result],
      ['chat/1', 'shop.example.com', 'Invoice_01.pdf', bytes.length, file.sha256, 'ok']);
    // Same name again: collision suffix.
    sendsFiles(client, [{ name: 'Invoice 01.pdf', mime: 'application/pdf', bytes }]);
    const again = await fx.bridge.execute(ctxFor({ chatId: 'chat/1' }), 'download', { tabId, items: items(1) });
    assert.equal(again.data.files[0].name, 'Invoice_01-1.pdf');
    // Result never carries credentials.
    assert.ok(!JSON.stringify(out).match(/cookie|authorization|headers/i));
  } finally { await fx.close(); }
});

test('csv is accepted; PDF magic mismatch, NUL bytes and wrong MIME are E_TYPE', async () => {
  const { fx, client, tabId } = await setup();
  try {
    sendsFiles(client, [{ name: 'a.csv', mime: 'text/csv', bytes: 'id,amount\n1,10\n' }]);
    const ok = await fx.bridge.execute(ctxFor(), 'download', { tabId, items: items(1) });
    assert.equal(ok.data.files[0].mime, 'text/csv');
    for (const bad of [
      { name: 'x.pdf', mime: 'application/pdf', bytes: 'not a pdf' },
      { name: 'x.csv', mime: 'text/csv', bytes: Buffer.from([0x61, 0x2c, 0x00, 0x62]) },
      { name: 'x.csv', mime: 'text/csv', bytes: Buffer.from([0xff, 0xfe, 0xfd]) },
      { name: 'x.txt', mime: 'text/plain', bytes: 'hello' },
      { name: 'x.exe', mime: 'application/octet-stream', bytes: 'MZ' },
    ]) {
      sendsFiles(client, [bad]);
      const out = await fx.bridge.execute(ctxFor(), 'download', { tabId, items: items(1) });
      assert.equal(out.error.code, 'E_TYPE', bad.name + bad.mime);
    }
    assert.deepEqual(partFiles(fx.downloadsDir), []);
    assert.equal(fx.store.readAudit(OWNER)[0].result, 'E_TYPE');
  } finally { await fx.close(); }
});

test('sha256 mismatch removes the partial file', async () => {
  const { fx, client, tabId } = await setup();
  try {
    sendsFiles(client, [{ name: 'a.pdf', mime: 'application/pdf', bytes: pdf(), sha256: 'f'.repeat(64) }]);
    const out = await fx.bridge.execute(ctxFor(), 'download', { tabId, items: items(1) });
    assert.equal(out.error.code, 'E_INTERNAL');
    assert.deepEqual(fs.readdirSync(path.join(fx.downloadsDir, 'chat-1')), []);
  } finally { await fx.close(); }
});

test('limits: 20 MiB per file, 50 MiB per command, 10 files', async () => {
  const { fx, client, tabId } = await setup();
  try {
    sendsFiles(client, [{ name: 'big.pdf', mime: 'application/pdf', bytes: pdf(20 * MiB + 1), declare: false }]);
    const big = await fx.bridge.execute(ctxFor(), 'download', { tabId, items: items(1) });
    assert.equal(big.error.code, 'E_LIMIT');
    const declared = { name: 'big.pdf', mime: 'application/pdf', bytes: pdf(10) };
    client.respondWith((cmd) => {
      if (cmd.name !== 'download') return null;
      client.json({ type: 'download.begin', requestId: cmd.id, mime: 'application/pdf', name: 'x.pdf', size: 21 * MiB, sourceHost: 'shop.example.com' });
      return null;
    });
    assert.equal((await fx.bridge.execute(ctxFor(), 'download', { tabId, items: items(1) })).error.code, 'E_LIMIT');
    // 3 x 19 MiB = 57 MiB > 50 MiB
    sendsFiles(client, [1, 2, 3].map((n) => ({ name: `f${n}.pdf`, mime: 'application/pdf', bytes: pdf(19 * MiB), declare: false })));
    const total = await fx.bridge.execute(ctxFor(), 'download', { tabId, items: items(3) });
    assert.equal(total.error.code, 'E_LIMIT');
    assert.deepEqual(fs.readdirSync(path.join(fx.downloadsDir, 'chat-1')), [], 'completed files of a failed command are removed');
    assert.equal((await fx.bridge.execute(ctxFor(), 'download', { tabId, items: items(11) })).error.code, 'E_LIMIT');
    // 10 small files are fine.
    sendsFiles(client, Array.from({ length: 10 }, (_, i) => ({ ...declared, name: `s${i}.pdf` })));
    const ten = await fx.bridge.execute(ctxFor(), 'download', { tabId, items: items(10) });
    assert.equal(ten.data.files.length, 10);
  } finally { await fx.close(); }
});

test('cancel (abort), timeout and disconnect all remove the partial file', async () => {
  const { fx, client, tabId } = await setup();
  try {
    const half = (cmd) => {
      client.json({ type: 'download.begin', requestId: cmd.id, mime: 'application/pdf', name: 'p.pdf', sourceHost: 'shop.example.com' });
      client.frame(cmd.id, pdf(100));
      return null;
    };
    client.respondWith((cmd) => (cmd.name === 'download' ? half(cmd) : { ok: true, data: {} }));
    const controller = new AbortController();
    const cancelled = fx.bridge.execute(ctxFor(), 'download', { tabId, items: items(1) }, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();
    assert.equal((await cancelled).error.code, 'E_CANCELLED');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(client.seen.at(-1).name, 'cancel');
    assert.deepEqual(partFiles(fx.downloadsDir), []);
    const timed = await fx.bridge.execute(ctxFor(), 'download', { tabId, items: items(1), timeoutMs: 150 });
    assert.equal(timed.error.code, 'E_TIMEOUT');
    assert.deepEqual(partFiles(fx.downloadsDir), []);
    const dropped = fx.bridge.execute(ctxFor(), 'download', { tabId, items: items(1) });
    await new Promise((resolve) => setTimeout(resolve, 100));
    client.ws.terminate();
    assert.equal((await dropped).error.code, 'E_DISCONNECTED');
    assert.deepEqual(partFiles(fx.downloadsDir), []);
  } finally { await fx.close(); }
});

test('file names are sanitised', () => {
  assert.equal(sanitizeFileName('../../etc/pass wd?.pdf', 'application/pdf'), 'pass_wd_.pdf');
  assert.equal(sanitizeFileName('.hidden', 'text/csv'), 'hidden.csv');
  assert.equal(sanitizeFileName('', 'application/pdf'), 'document.pdf');
  assert.ok(sanitizeFileName('x'.repeat(300), 'application/pdf').length <= 120);
  assert.match(sanitizeFileName('łąka faktura.csv', 'text/csv'), /^[A-Za-z0-9._-]+$/);
});
