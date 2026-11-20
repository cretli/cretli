/**
 * socketMessages hello — the stored sdkMode survives a reload: the server value wins on connect
 * unless the user changed the mode within the last 15 s (the pane default 'agent' must not clobber it).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(projectRoot, 'app_front/features/chat/transport/socketMessages.js'), 'utf8');

const start = source.indexOf('const helloMode = parseExplicitSdkMode(msg.sdkMode)');
assert.ok(start >= 0, 'hello sdkMode handling missing');
const slice = source.slice(start, start + 1400);

assert.match(slice, /_sdkModeUserSetAt/);
assert.match(slice, /modeSetRecently \? chat\.sdkMode : \(helloMode \|\| chat\.sdkMode \|\| 'agent'\)/);
assert.doesNotMatch(slice, /chat\.sdkMode \|\| helloMode/, 'the local default must not outrank the server mode');

console.log('chat-hello-sdk-mode.test.js OK');
