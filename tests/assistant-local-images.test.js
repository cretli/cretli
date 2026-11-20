import '../tests/helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import { configureChatMedia } from '../lib/chat-media.js';
import {
  MAX_LOCAL_IMAGES_PER_RUN,
  createLocalImageCollector,
  extractImagePathCandidates,
  noteRoomPayloadForLocalImages,
} from '../lib/agent-harness/assistant-local-images.ts';
import { collectLocalImageRefs } from '../app_front/features/chat/history/services/inlineImages.js';
import { buildAssistantDeltaEvent, buildAssistantSnapshotEvent } from '../lib/agent-harness/event-normalizer.ts';

configureChatMedia({ dataDir: path.join(ISOLATED_DATA_DIR, 'local-images'), enabled: true });

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-images-'));
const cwd = path.join(root, 'project');
const sibling = path.join(root, 'sibling');
fs.mkdirSync(path.join(cwd, 'out'), { recursive: true });
fs.mkdirSync(sibling);
fs.mkdirSync(path.join(root, '.hidden'));
const write = (file, data = PNG) => { fs.writeFileSync(file, data); return file; };

const run = (text, chatId = 'chat-local') => {
  const collector = createLocalImageCollector();
  collector.note(buildAssistantSnapshotEvent(text));
  return collector.drain({ chatId, cwd });
};

test('extracts paths from backticks, links and prose, newest mention first', () => {
  const found = extractImagePathCandidates('see `/a/b.png`, [x](out/c.jpg) and /a/b.png.\nnot https://x.io/d.png or e.txt');
  assert.deepEqual(found, ['/a/b.png', 'out/c.jpg']);
});

test('copies an absolute image outside the cwd and a relative one inside it', () => {
  const outside = write(path.join(sibling, 'sheet.png'));
  write(path.join(cwd, 'out', 'a.png'));
  const event = run(`Look at \`${outside}\` and out/a.png.`);
  assert.equal(event.type, 'local_images');
  assert.equal(event.images.length, 2);
  for (const image of event.images) assert.match(image.href, /^\/api\/chats\/chat-local\/media\/\d{13}-[a-f0-9-]{36}\.png$/);
});

test('rejects fake images, escapes, hidden folders and missing files', () => {
  const fake = write(path.join(sibling, 'fake.png'), Buffer.from('<svg onload="x()"/>'));
  const hidden = write(path.join(root, '.hidden', 'key.png'));
  write(path.join(sibling, 'escape.png'));
  assert.equal(run(`${fake} ${hidden} ../sibling/escape.png /nope/missing.png`), null);
});

test('caps images per run and reuses the copy of an unchanged file', () => {
  const files = Array.from({ length: MAX_LOCAL_IMAGES_PER_RUN + 2 }, (_, i) => write(path.join(sibling, `n${i}.png`)));
  assert.equal(run(files.join(' ')).images.length, MAX_LOCAL_IMAGES_PER_RUN);
  const collector = createLocalImageCollector();
  collector.note(buildAssistantSnapshotEvent(files[0]));
  const first = collector.drain({ chatId: 'chat-local', cwd });
  collector.note(buildAssistantSnapshotEvent(files[0]));
  assert.equal(collector.drain({ chatId: 'chat-local', cwd }).images[0].href, first.images[0].href);
});

test('joins a path split across deltas and keeps earlier items', () => {
  const file = write(path.join(sibling, 'split.png'));
  const other = write(path.join(sibling, 'first.png'));
  const room = { chatId: 'chat-local', cwd };
  const send = (event) => noteRoomPayloadForLocalImages(room, { type: 'sdkEvent', event });
  send(buildAssistantDeltaEvent(`${other} `));
  send({ type: 'tool_call', name: 'Read' });
  send(buildAssistantDeltaEvent(file.slice(0, 5)));
  send(buildAssistantDeltaEvent(file.slice(5)));
  const event = noteRoomPayloadForLocalImages(room, { type: 'sdkRunFinished' });
  assert.deepEqual(event.images.map((image) => image.source), [file, other]);
  assert.equal(noteRoomPayloadForLocalImages(room, { type: 'sdkRunFinished' }), null);
});

test('stays silent without a usable chat', () => {
  const file = write(path.join(sibling, 'op.png'));
  assert.equal(run(file, 'cretli-operator-1'), null);
  assert.equal(run(file, ''), null);
  assert.equal(noteRoomPayloadForLocalImages(null, { type: 'sdkRunFinished' }), null);
});

test('the chat only renders same-origin chat media', () => {
  const href = '/api/chats/chat-local/media/1730000000000-00000000-0000-4000-8000-000000000000.png';
  const refs = collectLocalImageRefs({ images: [{ href, source: 'a.png' }, { href: 'https://evil.example/a.png' }, { href: '/home/a.png' }, null] });
  assert.deepEqual(refs, [{ href, source: 'a.png' }]);
  assert.deepEqual(collectLocalImageRefs({}), []);
});
