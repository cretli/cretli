import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, utimes, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { registerUploadsRoutes } from '../lib/routes/uploads-routes.js';
import { sweepUploads } from '../lib/uploads-retention.js';
import { getUploadsSettings } from '../lib/persist/settings.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'cretli-uploads-video-'));
const uploadsDir = path.join(root, 'uploads');
await mkdir(uploadsDir);

const app = express();
app.use(express.json());
registerUploadsRoutes(app, { uploadsDir });
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

try {
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(64)]);
  const ok = await fetch(`${base}/api/upload-video`, { method: 'POST', headers: { 'Content-Type': 'video/mp4' }, body: mp4 });
  const okJson = await ok.json();
  assert.equal(ok.status, 200);
  assert.match(okJson.filename, /^[a-f0-9-]{36}\.mp4$/);
  assert.equal(okJson.bytes, mp4.length);

  const served = await fetch(`${base}/api/uploads/${okJson.filename}`);
  assert.equal(served.status, 200);

  const wrongMime = await fetch(`${base}/api/upload-video`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: mp4 });
  assert.equal(wrongMime.status, 415);

  const notVideo = await fetch(`${base}/api/upload-video`, { method: 'POST', headers: { 'Content-Type': 'video/mp4' }, body: Buffer.alloc(64, 7) });
  assert.equal(notVideo.status, 400);
  assert.equal((await readdir(uploadsDir)).length, 1, 'rejected upload leaves no file behind');

  // Retention: old UUID files go, fresh and foreign files stay.
  const oldName = `${randomUUID()}.mp4`;
  const freshName = `${randomUUID()}.jpg`;
  await writeFile(path.join(uploadsDir, oldName), 'x');
  await writeFile(path.join(uploadsDir, freshName), 'x');
  await writeFile(path.join(uploadsDir, 'notes.txt'), 'keep');
  const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  await utimes(path.join(uploadsDir, oldName), old, old);
  await utimes(path.join(uploadsDir, 'notes.txt'), old, old);
  const result = sweepUploads({ uploadsDir, days: 30 });
  assert.equal(result.deleted, 1);
  const left = await readdir(uploadsDir);
  assert.ok(!left.includes(oldName) && left.includes(freshName) && left.includes('notes.txt'));
  assert.equal(sweepUploads({ uploadsDir, days: 0 }).deleted, 0);
  // Settings: stored values win, env is the fallback, retention env 0 switches the sweep off.
  assert.deepEqual(getUploadsSettings({}, {}), { videoEnabled: true, videoMaxMb: 500, retentionEnabled: true, retentionDays: 30 });
  assert.equal(getUploadsSettings({}, { CRETLI_UPLOADS_RETENTION_DAYS: '0' }).retentionEnabled, false);
  assert.equal(getUploadsSettings({}, { CRETLI_UPLOAD_VIDEO_MAX_MB: '80' }).videoMaxMb, 80);
  assert.equal(getUploadsSettings({ uploads: { retentionDays: 7, videoEnabled: false } }, {}).retentionDays, 7);
  assert.equal(getUploadsSettings({ uploads: { videoMaxMb: 99999 } }, {}).videoMaxMb, 500);

  // Stats + manual cleanup endpoints.
  const stats = await (await fetch(`${base}/api/uploads-stats`)).json();
  assert.equal(stats.files, 2);
  assert.equal(stats.videos, 1);
  const wipe = await (await fetch(`${base}/api/uploads-cleanup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"all":true}' })).json();
  assert.equal(wipe.ok, true);
  assert.equal(wipe.stats.files, 0);
  console.log('uploads-video: ok');
} finally {
  server.close();
  await rm(root, { recursive: true, force: true });
}
