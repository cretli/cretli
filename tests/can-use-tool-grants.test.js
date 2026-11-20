import { buildCanUseToolGrantKeys, hasCanUseToolGrant, saveCanUseToolGrant, listCanUseToolGrants, revokeCanUseToolGrants } from '../lib/approval/can-use-tool-grants.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { requestCanUseToolPermission, replyCanUseToolPermission } from '../lib/approval/can-use-tool-permission.ts';

for (const reply of ['always', 'harness']) {
  test(`${reply}: persistent grants survive room recreation and stay scoped`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'human-grants-'));
    const file = path.join(dir, 'audit.jsonl');
    const room = { cwd: '/workspace', sdkMode: 'agent' };
    const params = {
      harness: 'claude', room, toolName: 'Bash', input: { command: 'echo hello > output.txt' },
      settings: { approvalBroker: { mode: 'local_reads' } }, auditOptions: { file },
    };
    try {
      const pending = requestCanUseToolPermission(params);
      const [card] = room._pendingQuestions.values();
      assert.equal(card.allowAlways, true);
      assert.equal(card.allowHarnessGrant, true);
      assert.equal(replyCanUseToolPermission(room, {}, { requestId: card.requestId, reply }), true);
      assert.equal((await pending).outcome, 'proceed');
      assert.equal(replyCanUseToolPermission(room, {}, { requestId: card.requestId, reply: 'harness' }), false);
      const next = await requestCanUseToolPermission({ ...params, room: { cwd: '/workspace' } });
      assert.equal(next.outcome, 'proceed');
      for (const changed of [
        { harness: 'qwen', room: { cwd: '/workspace' } },
        { room: { cwd: '/other-workspace' } },
        ...(reply === 'always' ? [{ room: { cwd: '/workspace' }, input: { command: 'echo changed > output.txt' } }] : []),
      ]) {
        const otherRoom = changed.room;
        const waiting = requestCanUseToolPermission({ ...params, ...changed });
        assert.equal(otherRoom._pendingQuestions.size, 1);
        const [otherCard] = otherRoom._pendingQuestions.values();
        replyCanUseToolPermission(otherRoom, {}, { requestId: otherCard.requestId, reply: 'reject' });
        assert.equal((await waiting).outcome, 'deny');
      }
      if (reply === 'harness') {
        assert.equal((await requestCanUseToolPermission({ ...params, room: { cwd: '/workspace' }, toolName: 'Write', input: { file_path: '/workspace/new.txt' } })).outcome, 'proceed');
      }
      assert.equal((await requestCanUseToolPermission({ ...params, room: { cwd: '/workspace', sdkMode: 'plan' } })).outcome, 'deny');
      const saved = fs.readFileSync(`${file}.grants.json`, 'utf8');
      assert.ok(!saved.includes('echo hello'));
      const audit = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
      assert.ok(audit.some((row) => row.grantScope === (reply === 'harness' ? 'harness' : 'tool')));
      fs.unlinkSync(`${file}.grants.json`);
      const waiting = requestCanUseToolPermission(params);
      const [revokedCard] = room._pendingQuestions.values();
      replyCanUseToolPermission(room, {}, { requestId: revokedCard.requestId, reply: 'reject' });
      assert.equal((await waiting).outcome, 'deny');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('legacy hashes remain active and can be listed, migrated and revoked', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-grants-'));
  const file = path.join(dir, 'grants.json');
  const keys = buildCanUseToolGrantKeys({ harness: 'claude', workspace: '/workspace', toolName: 'Write' });
  try {
    fs.writeFileSync(file, JSON.stringify([keys.tool]));
    assert.equal(hasCanUseToolGrant(keys, file), true);
    assert.equal(listCanUseToolGrants(file)[0].scope, 'legacy');
    saveCanUseToolGrant(keys, 'harness', file);
    assert.equal(listCanUseToolGrants(file).length, 2);
    assert.equal(revokeCanUseToolGrants([keys.tool], file), 1);
    assert.equal(hasCanUseToolGrant(keys, file), true);
    revokeCanUseToolGrants([keys.harness], file);
    assert.equal(hasCanUseToolGrant(keys, file), false);
    assert.throws(() => revokeCanUseToolGrants([], file), TypeError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
