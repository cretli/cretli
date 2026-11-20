import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildCodexClientOptions } from '../lib/codex/codex-thread-options.ts';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('Codex threads stay headless: approvalPolicy never, no host approval channel', () => {
  const options = buildCodexClientOptions({ cwd: root, model: '' });
  assert.equal(options.threadOptions.approvalPolicy, 'never');
});

test('Codex SDK ThreadEvent has no approval request event', () => {
  const dts = read('node_modules/@openai/codex-sdk/dist/index.d.ts');
  const union = dts.match(/type ThreadEvent =([^;]+);/)?.[1] || '';
  const variants = union.split('|').map((v) => v.trim()).filter(Boolean);
  assert.ok(variants.length > 0, 'ThreadEvent union must be parseable');
  for (const expected of ['ThreadStartedEvent', 'TurnStartedEvent', 'TurnCompletedEvent', 'TurnFailedEvent', 'ItemStartedEvent', 'ItemUpdatedEvent', 'ItemCompletedEvent', 'ThreadErrorEvent']) {
    assert.ok(variants.includes(expected), `missing variant ${expected}`);
  }
  for (const variant of variants) {
    assert.doesNotMatch(variant, /Approval|Permission|Request|Reply|Response/i, variant);
  }
  assert.doesNotMatch(dts, /ApprovalRequest|approval\.request|PermissionRequest/i);
});

test('Cursor SDK options expose no permission callback or pre-tool hook', () => {
  const dts = read('node_modules/@cursor/sdk/dist/esm/options.d.ts');
  assert.doesNotMatch(dts, /canUseTool|onPermission|permissionCallback|beforeToolCall/);
  assert.match(dts, /customTools\?:/);
});

test('shared canUseTool permission flow is not wired into Codex or Cursor SDK adapters', () => {
  for (const rel of ['lib/codex/codex-agent-ws.ts', 'lib/sdk/cursor-agent-sdk-ws.ts']) {
    assert.doesNotMatch(read(rel), /can-use-tool-permission|can-use-tool-adapter/, rel);
  }
});
