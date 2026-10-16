// Table-driven spec for the shared lesson privacy classifier. Every private
// form found in review rounds 1-3 lives here so a classifier change is judged
// against the whole matrix, not the latest hole.
import assert from 'node:assert/strict';
import { containsPrivateData, redactPrivatePaths, scrubFindingFile } from '../lib/review-lessons-privacy.js';

const MUST_REJECT = [
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
];

const MUST_ACCEPT = [
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
assert.equal(redactPrivatePaths('Connect to 192.168.1.20'), 'Connect to <lan-ip>');
assert.equal(redactPrivatePaths('path=C:\\Users\\alice\\proj\\src\\x.ts'), 'path=src/x.ts');

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
};
for (const [input, expected] of Object.entries(FILES)) assert.equal(scrubFindingFile(input), expected, input);

console.log('review-lessons-privacy tests passed');
