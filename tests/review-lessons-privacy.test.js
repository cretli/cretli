// Table-driven spec for the shared lesson privacy classifier. Every private
// form found in review rounds 1-3 lives here so a classifier change is judged
// against the whole matrix, not the latest hole.
import assert from 'node:assert/strict';
import { containsPrivateData, redactPrivatePaths, scrubFindingFile } from '../lib/review-lessons-privacy.js';

const MUST_REJECT = [
  'see /home/jan for details',
  'Path /home/u leaks in lib/x.js',
  // Round 1: absolute home paths.
  '/home/alice/proj/lib/a.js',
  'See /home/alice/project/file.js',
  '/Users/alice/proj/a.js',
  '/root/a.js',
  '/root',
  'C:\\Users\\alice\\proj\\lib\\a.js',
  'C:/Users/alice/proj/a.js',
  'see c:\\users\\alice\\a.js',
  '~/proj/a.js',
  'See ~/x/a.js',
  '~alice/proj/a.js',
  // Round 2: slash-less home as the first segment, WSL, file://.
  'home/alice/a.js',
  'See home/x/a.js',
  'home/x/**',
  '/mnt/c/Users/alice/a.js',
  '/mnt/d/users/alice/a.js',
  'file:///home/alice/a.js',
  'file:///C:/Users/alice/a.js',
  // Round 3 (NEW-2): markdown and punctuation contexts.
  'Token leaked in `/home/alice/proj/a.js`',
  'See `/home/x/a.js`',
  'See `~/x`',
  'See [/home/alice/a.js](link)',
  'See </home/alice/a.js>',
  'See **/home/alice/a.js**',
  'See *~/notes.md*',
  'quoted "/Users/alice/a.js" here',
  "quoted '/home/alice/a.js' here",
  '(/home/alice/a.js)',
  'path=/home/alice/a.js',
  'cwd:/home/alice',
  'a.js,/home/alice/b.js',
  '>/home/alice/out.log',
  // UNC and network shares.
  '\\\\fileserver\\share\\a.js',
  'See //fileserver/share/a.js',
  'file://fileserver/share/a.js',
  // Private LAN addresses.
  'Connect to 192.168.1.20',
  'https://10.0.0.5:3011/api',
  'host 172.16.4.2 is down',
  'host 172.31.255.1 is down',
  '`10.1.2.3`',
  // Round 4 (FU-A): characters outside the path allowlist terminate a run.
  '\u201C/home/alice/a.js\u201D',
  '\u2018/home/alice/a.js\u2019',
  '\u2026/home/alice/a.js',
  '\u2014/home/alice/a.js',
  '\u2192/home/alice/a.js',
  '\\n/home/alice/a.js',
  // Round 4 (FU-B): further home roots, encoded separators and slash-less Users.
  '/var/home/alice/proj/a.js',
  '/usr/home/alice/proj/a.js',
  '/export/home/alice/proj/a.js',
  '/media/alice/proj/a.js',
  '/run/media/alice/proj/a.js',
  '%2Fhome%2Falice%2Fa.js',
  '%2fhome%2falice%2fa.js',
  'x:/home/alice/proj/a.js',
  'Users/alice/a.js',
  // Round 4 (FU-C): profile names with spaces must not leak a token.
  'C:\\Users\\Jan Kowalski\\a.js',
  '/home/Jan Kowalski/a.js',
  '/Users/Jan Kowalski/a.js',
  // Round 4 (FU-E): IPv6 ULA/link-local and IPv4 CGNAT.
  'Connect to fd00::1',
  'host fc00:1234::abcd is private',
  'host fe80::1 is link-local',
  'host 100.64.0.5 is CGNAT',
  'host 100.127.255.254 is CGNAT',
];

const MUST_ACCEPT = [
  'a #fcfc color',
  'token fd12',
  'host fe9a',
  'lib/routes/users/a.js',
  'app_front/features/home/x.js',
  'src/users/x.ts',
  'lib/routes/users/**',
  'app_front/users/**',
  'lib/routes/**',
  'Cover users/ handlers with a test',
  'Fix the home page header',
  'home',
  'home/',
  'Users',
  'Connect to 127.0.0.1:3011',
  'https://example.com/users/home',
  'http://localhost:3011/home/x',
  'Bind on 0.0.0.0',
  'host 172.32.0.1 is public',
  'Use `lib/review-lessons-privacy.js` for paths',
  'Avoid recurring missing test findings in lib/routes/ (e.g. No test for the users route).',
  '~3 findings recur',
  '// TODO comment style',
  'misc/a.js',
  'version 1.10.0.2',
  'a/home/b.js',
  './lib/home/a.js',
  // Round 4 (FU-E): public IPv4/IPv6 must stay untouched, and the IPv6 rule
  // must not fire inside a longer token or on a bare `::`.
  'host 2001:db8::1 is documentation',
  'host 2606:4700::1111 is public',
  'host 100.63.255.255 is public',
  'host 100.128.0.1 is public',
  'connect to xfd00::1 as a longer token',
  'a::b',
];

assert.ok(MUST_REJECT.length >= 25, 'reject matrix size');
assert.ok(MUST_ACCEPT.length >= 15, 'accept matrix size');

const failures = [];
for (const input of MUST_REJECT) {
  if (!containsPrivateData(input)) failures.push(`should reject: ${input}`);
  const redacted = redactPrivatePaths(input);
  if (containsPrivateData(redacted)) failures.push(`redaction left private data: ${input} -> ${redacted}`);
  if (/alice|fileserver/i.test(redacted)) failures.push(`redaction kept a name: ${input} -> ${redacted}`);
}
for (const input of MUST_ACCEPT) {
  if (containsPrivateData(input)) failures.push(`should accept: ${input}`);
  if (redactPrivatePaths(input) !== input) failures.push(`redaction changed safe text: ${input}`);
}
assert.deepEqual(failures, []);

// Redaction keeps a usable repo-relative tail where one exists.
assert.equal(redactPrivatePaths('Token leaked in `/home/alice/proj/lib/a.js`'), 'Token leaked in `lib/a.js`');
assert.equal(redactPrivatePaths('See /home/alice/notes.md'), 'See <path>');
assert.equal(redactPrivatePaths('see /home/jan for details'), 'see <path> for details');
assert.equal(redactPrivatePaths('Path /home/u leaks in lib/x.js'), 'Path <path> leaks in lib/x.js');
for (const spaced of ['C:\\Users\\Jan Kowalski\\a.js', '/home/Jan Kowalski/a.js', '/Users/Jan Kowalski/a.js']) {
  assert.doesNotMatch(redactPrivatePaths(spaced), /Jan|Kowalski/, spaced);
}
for (const ip of ['fd00::1', 'fc00:1234::abcd', 'fe80::1', 'fd12:3456:789a::1', 'fe80:0000:0000:0000:0202:b3ff:fe1e:8329']) {
  assert.equal(redactPrivatePaths(`x ${ip} y`), 'x <lan-ip> y', ip);
}
assert.equal(redactPrivatePaths('Connect to 192.168.1.20'), 'Connect to <lan-ip>');
assert.equal(redactPrivatePaths('path=C:\\Users\\alice\\proj\\src\\x.ts'), 'path=src/x.ts');

// Round 4 (FU-A): a leading non-path character no longer hides the home head.
assert.equal(redactPrivatePaths('\u201C/home/alice/a.js\u201D'), '\u201C<path>\u201D');
assert.equal(redactPrivatePaths('\u2018/home/alice/a.js\u2019'), '\u2018<path>\u2019');
assert.equal(redactPrivatePaths('\u2026/home/alice/a.js'), '\u2026<path>');
assert.equal(redactPrivatePaths('\u2014/home/alice/a.js'), '\u2014<path>');
assert.equal(redactPrivatePaths('\u2192/home/alice/a.js'), '\u2192<path>');
assert.equal(redactPrivatePaths('\\n/home/alice/a.js'), '\\n<path>');

// Round 4 (FU-B): new home roots and encoded separators redact cleanly.
assert.equal(redactPrivatePaths('/var/home/alice/proj/lib/a.js'), 'lib/a.js');
assert.equal(redactPrivatePaths('/usr/home/alice/proj/lib/a.js'), 'lib/a.js');
assert.equal(redactPrivatePaths('/export/home/alice/proj/lib/a.js'), 'lib/a.js');
assert.equal(redactPrivatePaths('/media/alice/proj/lib/a.js'), 'lib/a.js');
assert.equal(redactPrivatePaths('/run/media/alice/proj/lib/a.js'), 'lib/a.js');
assert.equal(redactPrivatePaths('%2Fhome%2Falice%2Fa.js'), '<path>');
assert.equal(redactPrivatePaths('x:/home/alice/proj/lib/a.js'), 'lib/a.js');
assert.equal(redactPrivatePaths('Users/alice/a.js'), '<path>');

// Round 4 (FU-C): neither token of a spaced profile name may survive.
for (const input of ['C:\\Users\\Jan Kowalski\\a.js', '/home/Jan Kowalski/a.js', '/Users/Jan Kowalski/a.js']) {
  const redacted = redactPrivatePaths(input);
  assert.ok(!redacted.includes('Jan') && !redacted.includes('Kowalski'), `${input} -> ${redacted} kept a name token`);
}

// Round 4 (FU-E): private address ranges redact to `<lan-ip>`.
assert.equal(redactPrivatePaths('Connect to fd00::1'), 'Connect to <lan-ip>');
assert.equal(redactPrivatePaths('host fc00:1234::abcd is private'), 'host <lan-ip> is private');
assert.equal(redactPrivatePaths('host fe80::1 is link-local'), 'host <lan-ip> is link-local');
assert.equal(redactPrivatePaths('host 100.64.0.5 is CGNAT'), 'host <lan-ip> is CGNAT');
assert.equal(redactPrivatePaths('host 100.127.255.254 is CGNAT'), 'host <lan-ip> is CGNAT');

// Finding files: repo-relative tails survive, private heads are re-anchored or dropped.
const FILES = {
  'lib/routes/users/a.js': 'lib/routes/users/a.js',
  'app_front/features/home/x.js': 'app_front/features/home/x.js',
  '/home/alice/proj/lib/a.js': 'lib/a.js',
  'C:\\Users\\alice\\proj\\lib\\a.js': 'lib/a.js',
  'file:///home/alice/lib/a.js': 'lib/a.js',
  '\\\\fileserver\\share\\lib\\a.js': 'lib/a.js',
  'home/alice/a.js': '',
  '~/a.js': '',
  '/Users/alice/a.js': '',
  '/mnt/c/Users/alice/a.js': '',
  '/etc/x/y.js': '',
  '../a.js': '',
  '/var/home/alice/proj/lib/a.js': 'lib/a.js',
  '/run/media/alice/proj/lib/a.js': 'lib/a.js',
  '%2Fhome%2Falice%2Fa.js': '',
  'Users/alice/a.js': '',
  'C:\\Users\\Jan Kowalski\\proj\\lib\\a.js': 'lib/a.js',
};
for (const [input, expected] of Object.entries(FILES)) assert.equal(scrubFindingFile(input), expected, input);

console.log('review-lessons-privacy tests passed');
