import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { analyzeTodosDaily, readDiagnostics } from '../scripts/todos-stringify-daily.js';

for (const [fixture, verdict] of [['pass', 'PASS'], ['fail', 'FAIL'], ['incomplete', 'INCOMPLETE']]) {
  test(`JSONL fixture ${verdict}`, () => {
    const file = new URL(`./fixtures/todos-daily/${fixture}.jsonl`, import.meta.url);
    const events = readDiagnostics([file]);
    const [result] = analyzeTodosDaily(events, ['2026-10-28']);
    assert.equal(result.verdict, verdict);
    assert.equal(result.missingIntervals, verdict === 'INCOMPLETE' ? 1 : 0);
    const cli = spawnSync(process.execPath, ['scripts/todos-stringify-daily.js', '--day=2026-10-28', file.pathname], { encoding: 'utf8' });
    assert.equal(cli.status, verdict === 'PASS' ? 0 : 1, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).results[0].verdict, verdict);
  });
}
test('only recorded exit followed by restart excuses missing intervals', () => {
  const events = readDiagnostics([new URL('./fixtures/todos-daily/incomplete.jsonl', import.meta.url)]);
  events.push({ at: '2026-10-28T23:55:00Z', event: 'process-exit' }, { at: '2026-10-29T00:00:00Z', event: 'server-start' });
  assert.equal(analyzeTodosDaily(events, ['2026-10-28'])[0].verdict, 'PASS');
  events.pop();
  assert.equal(analyzeTodosDaily(events, ['2026-10-28'])[0].verdict, 'INCOMPLETE');
});
test('overlapping input files do not double count identical events', () => {
  const events = readDiagnostics([new URL('./fixtures/todos-daily/pass.jsonl', import.meta.url)]);
  assert.equal(analyzeTodosDaily([...events, ...events], ['2026-10-28'])[0].stringifyMs, 288);
});

test('exactly 99 percent reduction passes and an absent whole day is incomplete', () => {
  const events = readDiagnostics([new URL('./fixtures/todos-daily/pass.jsonl', import.meta.url)]);
  for (const event of events) event.details.todosWriteStats.stringifyMs = 870 / 288;
  assert.equal(analyzeTodosDaily(events, ['2026-10-28'])[0].verdict, 'PASS');
  const [missing] = analyzeTodosDaily(events, ['2026-10-27']);
  assert.equal(missing.verdict, 'INCOMPLETE');
  assert.equal(missing.missingIntervals, 288);
});
test('invalid intervals cannot silently certify a day', () => {
  assert.throws(() => analyzeTodosDaily([{ event: 'todos-write-stats', at: '2026-10-28', details: { intervalStart: 'invalid' } }]), /Invalid/);
});
