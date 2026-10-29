import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const ps1 = fs.readFileSync(new URL('../scripts/wsl-port-forward.ps1', import.meta.url), 'utf8');
const bat = fs.readFileSync(new URL('../scripts/wsl-port-forward.bat', import.meta.url), 'utf8');
// Polish diacritics or common unaccented Polish words used in the old comments.
const POLISH = /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]|\b(Uruchom|Przekierowanie|Ustawia|Nie udalo|portow|Adres IP|jako Administrator)\b/;

test('ps1 firewall add rule is limited to private/domain profiles and the local subnet', () => {
  const rule = ps1.split('\n').find((l) => /advfirewall firewall add rule/.test(l));
  assert.ok(rule, 'add rule line present');
  assert.match(rule, /profile=private,domain/);
  assert.match(rule, /remoteip=localsubnet/);
  assert.doesNotMatch(rule, /public/i);
});

test('ps1 refuses denylisted ports such as 9222', () => {
  assert.match(ps1, /\$denyPorts\s*=\s*@\([^)]*\b9222\b/);
  assert.match(ps1, /-contains \$p[\s\S]*exit 1/);
});

test('ps1 and bat contain no Polish text and ps1 points to the Network panel', () => {
  assert.doesNotMatch(ps1, POLISH);
  assert.doesNotMatch(bat, POLISH);
  assert.match(ps1.split('\n').slice(0, 4).join('\n'), /Network panel/);
});

test('bat forwards its arguments to the ps1 script', () => {
  assert.match(bat, /wsl-port-forward\.ps1"\s+%\*/);
});
