// Table-driven spec for the shared lesson privacy classifier. Every private
// form found in review rounds 1-3 lives here so a classifier change is judged
// against the whole matrix, not the latest hole.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
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

// Round 5 (F5): a profile name longer than two extra words must not leak its
// tail. The conservative <=2-word budget only extends while the extra words
// still look like a name (a capitalised word or a lowercase particle such as
// `del`/`van`/`der`), so a path-shaped prose tail keeps the P1 guard below.
const SPACED_PROFILE_VECTORS = [
  // 4-word names.
  ['C:\\Users\\Jean Claude Van Damme\\a.js', '<path>\\a.js', ['Jean', 'Claude', 'Van', 'Damme']],
  ['/home/Maria del Carmen Garcia/a.js', '<path>/a.js', ['Maria', 'del', 'Carmen', 'Garcia']],
  // 5-word names.
  ['/home/Jean Claude Van Damme Picard/a.js', '<path>/a.js', ['Jean', 'Claude', 'Van', 'Damme', 'Picard']],
  ['/Users/Maria del Carmen Garcia Lopez/a.js', '<path>/a.js', ['Maria', 'del', 'Carmen', 'Garcia', 'Lopez']],
  // Lowercase name particles inside an otherwise capitalised name.
  ['/home/Ana de la Cruz/a.js', '<path>/a.js', ['Ana', 'de', 'la', 'Cruz']],
  ['/home/Jan van der Berg/a.js', '<path>/a.js', ['Jan', 'van', 'der', 'Berg']],
  // Longer names: the bounded extension still covers them, i.e. the ReDoS fix
  // must not re-open the F5 tail leak.
  ['/home/Jean Claude Van Damme De La Cruz/a.js', '<path>/a.js', ['Jean', 'Claude', 'Van', 'Damme', 'De', 'La', 'Cruz']],
  ['/home/Ana Maria de la Cruz van der Berg/a.js', '<path>/a.js', ['Ana', 'Maria', 'de', 'la', 'Cruz', 'van', 'der', 'Berg']],
];
for (const [input, expected, names] of SPACED_PROFILE_VECTORS) {
  const redacted = redactPrivatePaths(input);
  assert.equal(containsPrivateData(input), true, input);
  assert.equal(redacted, expected, input);
  for (const name of names) assert.ok(!redacted.includes(name), `${input} -> ${redacted} kept '${name}'`);
}
// Round 7 (F5 follow-up): later name words starting with a non-ASCII capital are
// redacted too. The old `[A-Z]` branch stopped at `É`/`Ł`/`Ñ`, so the tail of a
// spaced profile name leaked. The branch is now a `u`-flag `[\p{Lu}\p{Lt}]`
// property escape and the pattern stays case-sensitive on purpose (no `i`
// flag), so lowercase prose is still not swallowed. Every vector puts the
// non-ASCII capital in the third-or-later extra word, i.e. past the
// unconditional two-word budget, so it exercises the extension branch itself.
const UNICODE_CAPITAL_VECTORS = [
  ['/home/Jean Claude Van \u00c9lodie/a.js', '<path>/a.js', ['Jean', 'Claude', 'Van', '\u00c9lodie']],
  ['/home/Jean Claude Pierre \u0141ukasz/a.js', '<path>/a.js', ['Jean', 'Claude', 'Pierre', '\u0141ukasz']],
  ['/home/Jean Claude Van \u00d1\u00fa\u00f1ez/a.js', '<path>/a.js', ['Jean', 'Claude', 'Van', '\u00d1\u00fa\u00f1ez']],
  ['/home/Jan van der Berg \u00c9lodie/a.js', '<path>/a.js', ['Jan', 'Berg', '\u00c9lodie']],
  ['C:\\Users\\Jean Claude Van \u00c9lodie\\a.js', '<path>\\a.js', ['Jean', 'Claude', 'Van', '\u00c9lodie']],
  // A non-Latin script is covered by the same property escape.
  ['/home/Jean Claude Van \u0418\u0432\u0430\u043d/a.js', '<path>/a.js', ['Jean', 'Claude', 'Van', '\u0418\u0432\u0430\u043d']],
];
for (const [input, expected, names] of UNICODE_CAPITAL_VECTORS) {
  const redacted = redactPrivatePaths(input);
  assert.equal(containsPrivateData(input), true, input);
  assert.equal(redacted, expected, input);
  for (const name of names) assert.ok(!redacted.includes(name), `${input} -> ${redacted} kept '${name}'`);
}
// Round 7: the particle list now also covers `y`, `e`, `af`, `zu`, `st`, `mac`
// and the `o'` prefix. `o'` is a prefix, not a whole word: an apostrophe-headed
// surname (`o'brien`) continues past the apostrophe, so it consumes the rest of
// the word.
const EXTENDED_PARTICLE_VECTORS = [
  ['/home/Ana Maria Garcia y Lopez/a.js', '<path>/a.js', ['Garcia', 'Lopez']],
  ['/home/Ana Maria Silva e Costa/a.js', '<path>/a.js', ['Silva', 'Costa']],
  ['/home/Jan van der Berg af Klint/a.js', '<path>/a.js', ['Berg', 'Klint']],
  ['/home/Karl Theodor Freiherr zu Guttenberg/a.js', '<path>/a.js', ['Freiherr', 'Guttenberg']],
  ['/home/Jean Claude Pierre st Claire/a.js', '<path>/a.js', ['Pierre', 'Claire']],
  ['/home/Jean Claude Pierre mac Donald/a.js', '<path>/a.js', ['Pierre', 'Donald']],
  ["/home/Jean Claude Pierre o'brien/a.js", '<path>/a.js', ['Pierre', 'brien']],
];
for (const [input, expected, names] of EXTENDED_PARTICLE_VECTORS) {
  const redacted = redactPrivatePaths(input);
  assert.equal(containsPrivateData(input), true, input);
  assert.equal(redacted, expected, input);
  for (const name of names) assert.ok(!redacted.includes(name), `${input} -> ${redacted} kept '${name}'`);
}
// Round 7: the extension bound is raised from `{0,6}` to `{0,20}`, so a natural
// name of ~12 words no longer stops leaking at the old 9-word budget
// (1 profile word + 2 unconditional words + 6 extension words).
const LONG_NAME_VECTORS = [
  ['/home/Ana Maria de la Cruz van der Berg de la Cruz van/a.js', '<path>/a.js', ['Ana', 'Berg', 'Cruz', 'van']],
  ['/home/Ana Maria de la Cruz van der Berg de la Cruz van der Berg/a.js', '<path>/a.js', ['Ana', 'Berg', 'Cruz']],
  ['/home/Jean Claude Van Damme De La Cruz Del Toro De La Vega/a.js', '<path>/a.js', ['Jean', 'Damme', 'Vega']],
];
for (const [input, expected, names] of LONG_NAME_VECTORS) {
  const redacted = redactPrivatePaths(input);
  assert.equal(containsPrivateData(input), true, input);
  assert.equal(redacted, expected, input);
  for (const name of names) assert.ok(!redacted.includes(name), `${input} -> ${redacted} kept '${name}'`);
}
// The P1 guard is unchanged: prose that merely follows a home path survives even
// though a path separator follows it, because the extension needs name-like
// words only.
assert.equal(redactPrivatePaths('Path /home/u leaks in lib/x.js'), 'Path <path> leaks in lib/x.js');
assert.equal(redactPrivatePaths('see /home/jan for details'), 'see <path> for details');
assert.equal(redactPrivatePaths('Token leaked in `/home/alice/proj/lib/a.js`'), 'Token leaked in `lib/a.js`');
assert.equal(redactPrivatePaths('Open /home/u then see src/a.js'), 'Open <path> then see src/a.js');
// Round 7: the Unicode-uppercase branch did not switch on the `i` flag, so
// lowercase prose after a home path keeps its tail, and the new particles stay
// whole words rather than prefixes (`error`, `macro`, `stuff`, `yellow` merely
// start with `e`, `mac`, `st`, `y`).
assert.equal(redactPrivatePaths('see /home/u error in lib/x.js'), 'see <path> error in lib/x.js');
assert.equal(redactPrivatePaths('/home/u a b error/x.js'), '<path> a b error/x.js');
assert.equal(redactPrivatePaths('/home/u a b macro/x.js'), '<path> a b macro/x.js');
assert.equal(redactPrivatePaths('/home/u a b stuff/x.js'), '<path> a b stuff/x.js');
assert.equal(redactPrivatePaths('/home/u a b yellow/x.js'), '<path> a b yellow/x.js');
// Safe-direction FU-D false positives: these redact a little too much, which is
// deliberately preferred over leaking a private location.
assert.equal(redactPrivatePaths('/users/me'), '<path>');
assert.equal(redactPrivatePaths('/home'), '<path>');
assert.equal(redactPrivatePaths('//cdn.x/y.js'), '<path>');

// Round 4 (FU-E): private address ranges redact to `<lan-ip>`.
assert.equal(redactPrivatePaths('Connect to fd00::1'), 'Connect to <lan-ip>');
assert.equal(redactPrivatePaths('host fc00:1234::abcd is private'), 'host <lan-ip> is private');
assert.equal(redactPrivatePaths('host fe80::1 is link-local'), 'host <lan-ip> is link-local');
assert.equal(redactPrivatePaths('host 100.64.0.5 is CGNAT'), 'host <lan-ip> is CGNAT');
assert.equal(redactPrivatePaths('host 100.127.255.254 is CGNAT'), 'host <lan-ip> is CGNAT');

// Round 6 (F1): the spaced-profile extension must not backtrack catastrophically.
// A probe run with no closing separator is the worst case: overlapping
// alternatives under an unbounded repetition explored ~2^n splits, so 40
// name-like words took tens of seconds while grading server text
// synchronously. The alternatives are disjoint (lower-case particle whole words,
// the lowercase `o'` prefix, and `\p{Lu}`-started words) and the repetition is
// bounded to `{0,20}`, so a failed separator costs O(words) backtracks.
const TIMING_CEILING_MS = 50;
const TIMING_VECTORS = [
  // `De`/`Le` were the double-matching words: a case-insensitive particle branch
  // and the capitalised branch both accepted them.
  ['capitalised particle repeated (De)', '/home/u a b ' + 'De '.repeat(40)],
  ['capitalised particle repeated (Le)', '/home/u a b ' + 'Le '.repeat(40)],
  ['mixed capitalised particles', '/home/u a b ' + 'De Le Van Der '.repeat(10)],
  // Round 7 follow-up: the raised bound and the Unicode-capital / apostrophe
  // branches must not re-open the backtracking hole.
  ['long capitalised run (200 words)', '/home/u a b ' + 'De '.repeat(200)],
  ['unicode capitalised run (200 words)', '/home/u a b ' + '\u00c9lodie '.repeat(200)],
  ['apostrophe prefix run (200 words)', "/home/u a b " + "o'brien ".repeat(200)],
  ['particle run (268 words)', '/home/u a b ' + 'de la van der '.repeat(67)],
];
for (const [label, input] of TIMING_VECTORS) {
  const startedAt = performance.now();
  const redacted = redactPrivatePaths(input);
  const elapsedMs = performance.now() - startedAt;
  assert.ok(elapsedMs < TIMING_CEILING_MS, `${label}: redaction took ${elapsedMs.toFixed(1)}ms (ceiling ${TIMING_CEILING_MS}ms)`);
  // Timing must not come from skipping the work: the head is still redacted.
  assert.equal(redacted.slice(0, '<path>'.length), '<path>', label);
}

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
