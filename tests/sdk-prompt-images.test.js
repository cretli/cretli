import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildSdkPromptMessage } from '../lib/sdk/sdk-prompt-images.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'cretli-sdk-images-'));
const uploadsDir = path.join(root, 'uploads');
await mkdir(uploadsDir);

try {
  const imagePath = await createImage(uploadsDir);
  const marker = `[Screenshot: ${imagePath}]`;
  const message = await buildSdkPromptMessage(`Opisz ekran\n${marker}`, { uploadsDir });

  assert.equal(typeof message, 'object');
  assert.equal(message.text, 'Opisz ekran');
  assert.equal(message.images.length, 1);
  assert.equal(message.images[0].mimeType, 'image/jpeg');
  assert.equal(Buffer.from(message.images[0].data, 'base64')[0], 0xff);

  const imageOnly = await buildSdkPromptMessage(marker, { uploadsDir });
  assert.equal(imageOnly.text, 'Analyze the attached image.');

  const duplicate = await buildSdkPromptMessage(`${marker}\n${marker}`, { uploadsDir });
  assert.equal(duplicate.images.length, 1);
  assert.equal(duplicate.text, 'Analyze the attached image.');

  const outsidePath = await createImage(root);
  const outsideMarker = `[Screenshot: ${outsidePath}]`;
  assert.equal(await buildSdkPromptMessage(outsideMarker, { uploadsDir }), outsideMarker);

  const symlinkPath = path.join(uploadsDir, `${randomUUID()}.jpg`);
  await symlink(outsidePath, symlinkPath);
  const symlinkMarker = `[Screenshot: ${symlinkPath}]`;
  assert.equal(await buildSdkPromptMessage(symlinkMarker, { uploadsDir }), symlinkMarker);

  const imagePaths = await Promise.all(
    Array.from({ length: 6 }, () => createImage(uploadsDir))
  );
  const sixMarkers = imagePaths.map((item) => `[Screenshot: ${item}]`).join('\n');
  const limited = await buildSdkPromptMessage(sixMarkers, { uploadsDir });
  assert.equal(limited.images.length, 5);
  assert.equal(limited.text, `[Screenshot: ${imagePaths[5]}]`);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('All sdk-prompt-images tests passed.');

async function createImage(directory) {
  const imagePath = path.join(directory, `${randomUUID()}.jpg`);
  await writeFile(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x01]));
  return imagePath;
}
