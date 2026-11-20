import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const unitText = readFileSync(path.join(root, 'systemd', 'cretli.service.example'), 'utf8');
const monitorUnitText = readFileSync(path.join(root, 'systemd', 'cretli-memory-monitor.service.example'), 'utf8');
const diagnosticsText = readFileSync(path.join(root, 'docs', 'server-diagnostics.md'), 'utf8');

/** Parses a unit file into { Section: { Key: [values] } }, ignoring comments. */
function parseUnit(text) {
  const sections = {};
  let current = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const header = /^\[(\w+)\]$/.exec(line);
    if (header) {
      current = sections[header[1]] = {};
      continue;
    }
    const eq = line.indexOf('=');
    assert.ok(current && eq > 0, `unparseable unit line: ${line}`);
    (current[line.slice(0, eq)] ||= []).push(line.slice(eq + 1));
  }
  return sections;
}

const unit = parseUnit(unitText);
const monitorUnit = parseUnit(monitorUnitText);

/** Extracts the ```sh fenced block that contains `marker`. */
function extractShellBlock(text, marker) {
  const start = text.indexOf(marker);
  assert.ok(start >= 0, `shell block starting with "${marker}" not found`);
  const fenceStart = text.lastIndexOf('```sh', start);
  assert.ok(fenceStart >= 0, 'opening ```sh fence not found');
  const fenceEnd = text.indexOf('```', fenceStart + 4);
  assert.ok(fenceEnd > fenceStart, 'closing ``` fence not found');
  return text.slice(fenceStart, fenceEnd);
}

test('unit restarts always with restart-storm protection', () => {
  assert.equal(unit.Service.Restart[0], 'always');
  assert.ok(Number(unit.Service.RestartSec[0]) >= 5);
  assert.ok(Number(unit.Unit.StartLimitBurst[0]) <= 5);
  assert.ok(Number(unit.Unit.StartLimitIntervalSec[0]) >= 300);
});

test('unit does not claim notify/watchdog support the app lacks', () => {
  assert.equal(unit.Service.Type[0], 'simple');
  assert.equal(unit.Service.WatchdogSec, undefined);
  assert.equal(unit.Service.NotifyAccess, undefined);
});

test('unit has graceful stop and persistent state dir matching the app env', () => {
  assert.equal(unit.Service.KillSignal[0], 'SIGTERM');
  assert.ok(Number(unit.Service.TimeoutStopSec[0]) >= 30);
  assert.equal(unit.Service.StateDirectory[0], 'cretli');
  assert.ok(unit.Service.Environment.includes('CRETLI_DATA_DIR=%S/cretli'));
  assert.ok(unit.Service.Environment.includes('NODE_ENV=production'));
});

test('server and monitor use the same persistent state directory', () => {
  assert.deepEqual(monitorUnit.Service.StateDirectory, unit.Service.StateDirectory);
  const serverDataDirectory = unit.Service.Environment.filter((value) => value.startsWith('CRETLI_DATA_DIR='));
  const monitorDataDirectory = monitorUnit.Service.Environment.filter((value) => value.startsWith('CRETLI_DATA_DIR='));
  assert.deepEqual(monitorDataDirectory, serverDataDirectory);
  assert.deepEqual(serverDataDirectory, ['CRETLI_DATA_DIR=%S/cretli']);
});

test('docs explain service scope alignment and safe checkout data migration', () => {
  assert.match(diagnosticsText, /same systemd service scope/i);
  assert.match(diagnosticsText, /Do not install one unit as a user service and the other as a system service/i);
  assert.match(diagnosticsText, /same explicit absolute path/i);
  assert.match(diagnosticsText, /before the first .*enable --now/i);
  // All three units are stopped during the migration via a guarded loop.
  assert.match(diagnosticsText, /for unit in cretli-memory-monitor\.timer cretli-memory-monitor\.service cretli\.service/);
  assert.match(diagnosticsText, /refusing to migrate: .*already exists and is not empty/);
  assert.match(diagnosticsText, /Copy the checkout data BEFORE enabling or starting either unit/i);
  assert.ok(
    diagnosticsText.indexOf('cp -a /path/to/cretli/data/.')
      < diagnosticsText.indexOf('systemctl --user enable --now cretli.service cretli-memory-monitor.timer'),
    'the copy must happen before the units are enabled/started',
  );
  assert.match(diagnosticsText, /Inspect the destination before removing the old checkout data/i);
});

test('docs describe rollback for both units and their data-directory settings', () => {
  const rollback = diagnosticsText.slice(diagnosticsText.indexOf('**Rollback.**'));
  assert.ok(rollback.length > 0);
  assert.match(rollback, /StateDirectory=cretli/);
  assert.match(rollback, /CRETLI_DATA_DIR=%S\/cretli/);
  assert.match(rollback, /from \*\*both\*\* copied unit files/);
  assert.match(rollback, /monitor settings together with the server settings/);
});

test('hang probe guidance recommends only atomic try-restart, never plain restart', () => {
  assert.match(diagnosticsText, /systemctl --user try-restart cretli\.service/);
  assert.ok(!diagnosticsText.includes('systemctl --user restart cretli.service'));
  assert.match(diagnosticsText, /intentionally stopped unit stays stopped/i);
  assert.match(diagnosticsText, /start-limit-hit/);
  assert.match(diagnosticsText, /reset-failed cretli\.service/);
  assert.match(diagnosticsText, /never fall back to `start`/);
  // F1 fixed: the `is-active --quiet` guard-before-restart alternative is
  // removed. It had a TOCTOU race: between the check and the restart an
  // operator could stop the unit, and a plain restart would undo that stop.
  assert.ok(
    !diagnosticsText.includes('is-active --quiet cretli.service'),
    'the is-active guard-before-restart alternative must be removed (TOCTOU race)',
  );
});

test('migration shell halts on stop/copy failure and never starts after one', () => {
  const migrationBlock = extractShellBlock(diagnosticsText, 'set -euo pipefail');
  // Fail-fast: the script must abort on the first failing command.
  assert.match(migrationBlock, /set -e[uo ]/);
  // A failed stop must abort before any enable/start.
  assert.match(
    migrationBlock,
    /systemctl --user stop "\$unit" \|\| \{[^}]*exit 1/,
    'a failed stop must abort the migration',
  );
  // A failed copy must abort before any enable/start.
  assert.match(
    migrationBlock,
    /cp -a \/path\/to\/cretli\/data\/\. "\$state_dir"\/ \|\| \{[^}]*exit 1/,
    'a failed copy must abort the migration',
  );
  // enable --now must follow the stop loop and the guarded copy, never precede.
  const enableIdx = migrationBlock.indexOf('systemctl --user enable --now cretli.service cretli-memory-monitor.timer');
  assert.ok(enableIdx > migrationBlock.indexOf('for unit in cretli-memory-monitor.timer'), 'enable/start must follow the stop loop');
  assert.ok(enableIdx > migrationBlock.indexOf('cp -a /path/to/cretli/data/. "$state_dir"/'), 'enable/start must follow the guarded copy');
});

test('cron alternative uses the same data directory as the server', () => {
  const cron = /```cron\n([\s\S]*?)```/.exec(diagnosticsText);
  assert.ok(cron, 'cron example is missing');
  assert.match(cron[1], /memory-orphan-monitor\.js/);
  assert.match(cron[1], /CRETLI_DATA_DIR=/);
  assert.match(diagnosticsText, /same data directory as the server/i);
  assert.match(diagnosticsText, /checkout-local mode/i);
});

test('unit comment allows Type=exec without sd_notify', () => {
  assert.match(unitText, /"exec"/);
  assert.ok(!/only accurate type/i.test(unitText));
});

test('unit has no secrets and no private paths', () => {
  const publicExamples = `${unitText}\n${monitorUnitText}\n${diagnosticsText}`;
  assert.ok(!/(API_KEY|TOKEN|PASSWORD|SECRET)\s*=/i.test(publicExamples));
  assert.ok(!/\/home\/|192\.168\.|\b10\.\d+\.\d+\.\d+/.test(publicExamples));
});

test('documented health endpoint exists and no sd_notify in the server', () => {
  const health = readFileSync(path.join(root, 'lib', 'routes', 'health-routes.js'), 'utf8');
  assert.match(health, /app\.get\('\/api\/health'/);
  const server = readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.ok(!/NOTIFY_SOCKET|sd_notify/.test(server));
});
