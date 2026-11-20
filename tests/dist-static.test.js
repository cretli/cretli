import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';
import express from 'express';
import { cacheControlFor, createDistStaticMiddleware, pickEncoding } from '../lib/dist-static.js';
import { frontBundleDir, resolveFrontBundleMode, resolveServedFrontBundle } from '../lib/front-bundle.js';

test('pickEncoding prefers brotli, then gzip, and honors q=0', () => {
  assert.equal(pickEncoding('gzip, deflate, br'), 'br');
  assert.equal(pickEncoding('gzip, deflate'), 'gzip');
  assert.equal(pickEncoding('br;q=0, gzip'), 'gzip');
  assert.equal(pickEncoding('identity'), null);
  assert.equal(pickEncoding(undefined), null);
  assert.equal(pickEncoding('*'), 'br');
});

test('cacheControlFor: hashed files immutable in prod, stable names revalidate, dev never cached', () => {
  assert.match(cacheControlFor('151.9372803b.chunk.js', 'prod'), /immutable/);
  assert.match(cacheControlFor('3cc7c7f2349bf453bbad.woff2', 'prod'), /immutable/);
  assert.equal(cacheControlFor('index.bundle.js', 'prod'), 'no-cache');
  assert.equal(cacheControlFor('i18n-pl.bundle.js', 'prod'), 'no-cache');
  assert.equal(cacheControlFor('151.9372803b.chunk.js', 'dev'), 'no-store');
});

test('bundle mode: prod by default, dev only through CRETLI_FRONT_BUNDLE=dev', () => {
  assert.equal(resolveFrontBundleMode({}), 'prod');
  assert.equal(resolveFrontBundleMode({ CRETLI_FRONT_BUNDLE: 'prod' }), 'prod');
  assert.equal(resolveFrontBundleMode({ CRETLI_FRONT_BUNDLE: ' DEV ' }), 'dev');
  const built = (...modes) => (p) => modes.some((m) => p === path.join(frontBundleDir('/pub', m), 'index.bundle.js'));
  assert.equal(resolveServedFrontBundle({ publicDir: '/pub', env: {}, exists: built('prod', 'dev') }).mode, 'prod');
  assert.equal(resolveServedFrontBundle({ publicDir: '/pub', env: { CRETLI_FRONT_BUNDLE: 'dev' }, exists: built('prod', 'dev') }).mode, 'dev');
  const fallback = resolveServedFrontBundle({ publicDir: '/pub', env: {}, exists: built('dev') });
  assert.deepEqual([fallback.mode, fallback.fellBack], ['dev', true]);
});

async function withServer(mode, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dist-static-'));
  fs.writeFileSync(path.join(dir, 'index.bundle.js'), 'console.log("hello");\n'.repeat(500));
  fs.writeFileSync(path.join(dir, 'abcdef12.chunk.js'.replace('abcdef12', 'panel.abcdef12')), 'x'.repeat(4000));
  fs.writeFileSync(path.join(dir, 'tiny.js'), 'a=1');
  const app = express();
  app.use('/dist/app', createDistStaticMiddleware({ dir, mode }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const get = (urlPath, headers = {}) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
  try {
    await run(get);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('serves brotli, gzip and identity bodies that decode to the original', () => withServer('prod', async (get) => {
  const original = 'console.log("hello");\n'.repeat(500);
  const br = await get('/dist/app/index.bundle.js', { 'accept-encoding': 'gzip, br' });
  assert.equal(br.headers['content-encoding'], 'br');
  assert.equal(br.headers.vary, 'Accept-Encoding');
  assert.equal(zlib.brotliDecompressSync(br.body).toString(), original);
  const gz = await get('/dist/app/index.bundle.js', { 'accept-encoding': 'gzip' });
  assert.equal(gz.headers['content-encoding'], 'gzip');
  assert.equal(zlib.gunzipSync(gz.body).toString(), original);
  const plain = await get('/dist/app/index.bundle.js');
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.equal(plain.body.toString(), original);
  assert.equal(plain.headers['cache-control'], 'no-cache');
  assert.match(plain.headers['content-type'], /javascript/);
}));

test('hashed chunk is immutable; tiny files are not compressed; ETag gives 304', () => withServer('prod', async (get) => {
  const chunk = await get('/dist/app/panel.abcdef12.chunk.js', { 'accept-encoding': 'br' });
  assert.match(chunk.headers['cache-control'], /immutable/);
  const again = await get('/dist/app/panel.abcdef12.chunk.js', { 'accept-encoding': 'br', 'if-none-match': chunk.headers.etag });
  assert.equal(again.status, 304);
  const tiny = await get('/dist/app/tiny.js', { 'accept-encoding': 'br' });
  assert.equal(tiny.headers['content-encoding'], undefined);
}));

test('dev mode is never cached; missing files and traversal are 404', () => withServer('dev', async (get) => {
  assert.equal((await get('/dist/app/index.bundle.js')).headers['cache-control'], 'no-store');
  assert.equal((await get('/dist/app/nope.js')).status, 404);
  assert.equal((await get('/dist/app/..%2f..%2fetc%2fpasswd')).status, 404);
}));
