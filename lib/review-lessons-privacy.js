/**
 * Shared privacy classifier for review lessons: the one place that decides
 * whether lesson text, a path glob or a finding file names a private machine
 * location (home directory, Windows profile, UNC share, private LAN address).
 *
 * Text is tokenised instead of matched with anchored regexes: a path run is a
 * maximal sequence from an explicit allowlist of path characters, so every
 * other character (whitespace, markdown, punctuation, curly quotes, ellipsis,
 * em/en dashes, arrows, a bare `*`) ends the run instead of gluing onto a
 * private head and hiding it. Runs are split at `label=`/`label:` separators
 * and classified piece by piece. A `home`/`users` segment deep inside a
 * relative repo path is legitimate; only home-rooted heads are private.
 * The spec matrix lives in tests/review-lessons-privacy.test.js.
 *
 * Re-scoped follow-ups (not fixed in this change; each needs a product decision
 * or a separate leaf, so they are accepted residuals rather than classifier
 * bugs):
 * - A fully lowercase multi-word surname (`/home/jan van der berg/a.js`) still
 *   leaks its trailing word. An arbitrary lowercase word after the name budget
 *   cannot be told apart from prose, and consuming it would swallow a legitimate
 *   text tail (`/home/u leaks in lib/x.js` -> `<path>/x.js`), losing the P1
 *   guard on the usable repo-relative tail. Re-scoped until a product decision
 *   says prose over-redaction is preferred.
 * - The distill FU-1 item (a re-anchored tail can expose a project directory
 *   name, see the note on `redactPiece`), the P3 follow-ups tracked under
 *   23007e68, and the browser check are re-scoped to their own leaves/runs:
 *   they are product decisions or unrelated verification work, not classifier
 *   bugs, and fixing them here would widen this leaf's blast radius.
 */

/** Repo top-level directories a private path may be re-anchored at. */
export const REPO_ROOT_DIRS = Object.freeze(new Set(['lib', 'tests', 'docs', 'app_front', 'scripts', 'public', 'src', 'server', 'config']));

// Allowlist of characters that may occur inside a path run. `*` is deliberately
// absent: it stays a run terminator so globs like `**/home/x` keep the slash
// that starts the private head. `=` is allowed so labels such as `path=/home/x`
// stay one run; splitLabels() separates the label from its value.
const PATH_CHAR_CLASS = '[A-Za-z0-9_./\\\\:~@%#$&!^+=-]';
const PATH_RUN_RE = new RegExp(`${PATH_CHAR_CLASS}+`, 'g');
// A literal `\n` (backslash + n) at a run boundary is an escaped newline, not a
// path character: mask it as a terminator and restore it after redaction. A
// Windows segment that merely starts with `n` (`C:\Users\newuser`) is left
// intact because it is not at a run boundary.
const ESCAPED_NEWLINE_RE = new RegExp(String.raw`(?<!${PATH_CHAR_CLASS})\\n`, 'g');
const MASKED_NEWLINE = '\u0000';
// A profile name may contain spaces (`C:\Users\Jan Kowalski\a.js`); the run
// tokeniser splits at the space and would leak the trailing words. The whole
// spaced head is redacted up front, but only when a path separator follows, so
// trailing prose is kept (`Path /home/u leaks in lib/x.js`).
//
// The first one or two extra words are accepted unconditionally: that is the
// historic conservative budget, and the mandatory closing separator is what
// keeps prose out. A longer name run may only continue while the extra word
// still looks like part of a human name — a capitalised word or a lowercase
// name particle (`del`, `van`, `der`, ...) — so `Jean Claude Van Damme` no
// longer leaks its tail while ordinary sentences are not swallowed.
//
// Both parts of the extension are bounded on purpose, and their alternatives
// are disjoint (particles are matched in lower case only, so a capitalised
// `De`/`Van` can only be consumed by the uppercase branch). Overlapping
// alternatives under an unbounded `*` made a failed closing separator explore
// ~2^n splits — catastrophic backtracking on prose that merely contains many
// name-like words. The `{0,20}` cap covers a full human name (1-2 unconditional
// words plus up to 20 extension words, i.e. names of ~23 words) while keeping
// every repetition step deterministic: a word matches at most one branch, so a
// failed closing separator costs O(words) backtracks, not an exponential tree.
//
// `o'` is a particle prefix rather than a whole word: an apostrophe-headed
// surname (`o'brien`) never ends at the apostrophe, so it must consume the rest
// of the word. Keeping it out of the whole-word branch also keeps the
// alternatives disjoint (the prefix starts with a lowercase ASCII letter, which
// the uppercase branch cannot match).
const NAME_PARTICLES = Object.freeze([
  'de', 'del', 'da', 'dos', 'van', 'von', 'der', 'den', 'la', 'le', 'bin', 'ibn', 'al', 'el', 'di', 'du', 'ter', 'ten',
  // Follow-up particles seen in real surnames (`Ana Maria Garcia y Lopez`,
  // `Karl Theodor Freiherr zu Guttenberg`, `Jean Claude mac Donald`).
  'y', 'e', 'af', 'zu', 'st', 'mac', "o'",
]);
const WHOLE_WORD_PARTICLES = Object.freeze(NAME_PARTICLES.filter((particle) => /^[a-z]+$/.test(particle)));
const PREFIX_PARTICLES = Object.freeze(NAME_PARTICLES.filter((particle) => !/^[a-z]+$/.test(particle)));
// The profile head is matched case-insensitively without the `i` flag, because
// `i` would also make the capitalised-name check match lowercase prose words.
const PROFILE_WORD_SOURCE = String.raw`[^\s\\/:*?"<>|]`;
// Unicode uppercase (and titlecase, e.g. `ǅ`) starts a later name word too, so a
// name such as `Jean Claude Van Élodie` no longer leaks the non-ASCII tail. This
// is a `u`-flag property escape; the pattern stays case-sensitive on purpose
// (the `i` flag would also make this branch match lowercase prose words).
const UPPERCASE_START_SOURCE = String.raw`[\p{Lu}\p{Lt}]`;

/**
 * @param {string} value
 * @returns {string} the value escaped for literal use in a regex source
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @param {string} word lower-case word
 * @returns {string} an ASCII case-insensitive regex source for that word
 */
function anyCaseWordSource(word) {
  return word.split('').map((char) => `[${char.toLowerCase()}${char.toUpperCase()}]`).join('');
}

const NAME_PARTICLE_SOURCE = `(?:${WHOLE_WORD_PARTICLES.join('|')}|${PREFIX_PARTICLES.map((particle) => `${escapeRegExp(particle)}${PROFILE_WORD_SOURCE}+`).join('|')})`;
const SPACED_PROFILE_SOURCE = String.raw`(?<![A-Za-z0-9.])(?:[A-Za-z]:[\\/]|\/)`
  + `(?:${anyCaseWordSource('users')}|${anyCaseWordSource('home')})[\\\\/]${PROFILE_WORD_SOURCE}+`
  + String.raw`(?:\s+${PROFILE_WORD_SOURCE}+){1,2}`
  + `(?:\\s+(?:${UPPERCASE_START_SOURCE}${PROFILE_WORD_SOURCE}*|${NAME_PARTICLE_SOURCE})){0,20}`
  + String.raw`(?=[\\/])`;
const SPACED_PROFILE_RE = new RegExp(SPACED_PROFILE_SOURCE, 'gu');
const LAN_IPV4_SOURCE = String.raw`(?<![\d.])(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])(?:\.\d{1,3}){2})(?!\.?\d)`;
// IPv6 ULA `fc00::/7` and link-local `fe80::/10`. The lookarounds keep the
// match out of a longer hex token (`xfd00::1`) and out of a bare `::`.
const LAN_IPV6_SOURCE = String.raw`(?<![0-9A-Za-z:])(?:f[cd][0-9A-Fa-f]{2}|fe[89ab][0-9A-Fa-f])(?::[0-9A-Fa-f]{0,4})+(?![0-9A-Za-z:])`;
const LAN_IP_SOURCE = String.raw`(?:${LAN_IPV4_SOURCE}|${LAN_IPV6_SOURCE})`;
const LAN_IP_RE = new RegExp(LAN_IP_SOURCE);
const LAN_IP_GLOBAL_RE = new RegExp(LAN_IP_SOURCE, 'g');
const SCHEME_RE = /^([a-z][a-z0-9+.-]*):\/\//i;

/**
 * Split a path run at `label:` separators (`cwd:/home/x`) while keeping a
 * drive letter (`C:\x`) and a URL scheme (`file:///x`) intact.
 *
 * @param {string} run
 * @returns {string[]} pieces; `pieces.join(':') === run`
 */
function splitPieces(run) {
  const pieces = [];
  let start = 0;
  for (let i = 0; i < run.length; i += 1) {
    if (run[i] !== ':' || !/[\\/~]/.test(run[i + 1] || '')) continue;
    const head = run.slice(start, i);
    const isDrive = /^[A-Za-z]$/.test(head);
    const isScheme = /^[a-z][a-z0-9+.-]*$/i.test(head) && /^[\\/]{2}/.test(run.slice(i + 1));
    if (isDrive || isScheme) continue;
    pieces.push(head);
    start = i + 1;
  }
  pieces.push(run.slice(start));
  return pieces;
}

/**
 * Split a run at `=` label separators (`path=/home/x`) so a private value is
 * classified on its own instead of being glued to its label.
 *
 * @param {string} run
 * @returns {string[]}
 */
function splitLabels(run) {
  return run.split('=');
}

/**
 * @param {string} piece one path-like piece, no whitespace or markdown around it
 * @returns {boolean} the piece names a home-rooted or network location
 */
function isPrivatePiece(piece) {
  let p = piece.replace(/\\/g, '/');
  // URL-encoded separators hide a home head (`%2Fhome%2F<user>%2F`).
  const decoded = p.replace(/%2f/gi, '/');
  if (decoded !== p && /^\/(?:home|users|root)(?:\/|$)/i.test(decoded)) return true;
  const scheme = SCHEME_RE.exec(p);
  if (scheme) {
    // Web URLs carry no local path; their host is covered by the LAN address rule.
    if (scheme[1].toLowerCase() !== 'file') return false;
    p = p.slice('file:'.length);
  }
  if (/^\/\/[^/]+\/[^/]/.test(p)) return true; // UNC share `\\host\share\...`
  p = p.replace(/^\/{2,}/, '/').replace(/^\/(?=[A-Za-z]:\/)/, '');
  if (/^[A-Za-z]:\/+(?:users|home)(?:\/|$)/i.test(p)) return true;
  if (/^\/(?:home|users|root)(?:\/|$)/i.test(p)) return true;
  if (/^\/(?:var|usr|export)\/home(?:\/|$)/i.test(p)) return true;
  if (/^\/run\/media\/[^/]/i.test(p)) return true;
  if (/^\/media\/[^/]/i.test(p)) return true;
  if (/^\/mnt\/[a-z]\/users(?:\/|$)/i.test(p)) return true;
  if (/^~[\w.-]*\//.test(p)) return true;
  // Slash-less `home/<x>` / `Users/<x>` is private only as the first segment of
  // a relative path; it must yield at least the `Users/<name>` prefix.
  return /^(?:home|users)\/[^/]/i.test(p.replace(/^(?:\.\.?\/)+/, ''));
}

/** @param {string} text @returns {string[]} every path-like piece of the text */
function listPieces(text) {
  return (text.match(PATH_RUN_RE) || []).flatMap((run) => splitLabels(run).flatMap(splitPieces));
}

/**
 * @param {unknown} value
 * @returns {boolean} true when the string carries a private path or a private LAN address
 */
export function containsPrivateData(value) {
  const text = String(value ?? '').replace(ESCAPED_NEWLINE_RE, MASKED_NEWLINE);
  return LAN_IP_RE.test(text) || listPieces(text).some(isPrivatePiece);
}

/**
 * @param {string} piece a private piece
 * @returns {string} its repo-relative tail from the first known top-level folder, or `<path>`
 *
 * Note (FU-1, documented-only): cutting at the first known top-level folder can
 * still expose a project directory name — `src/acme-client/...` keeps
 * `acme-client` — because that segment is a legitimate repo path, not a
 * private head. It is deliberately not fixed in this leaf; the leak is limited
 * to the project folder name and every location below it stays usable.
 */
function redactPiece(piece) {
  const parts = piece.replace(/\\/g, '/').split('/').filter(Boolean);
  const at = parts.findIndex((part, i) => i > 0 && REPO_ROOT_DIRS.has(part));
  const tail = at > 0 ? parts.slice(at).join('/') : '';
  return tail && !isPrivatePiece(tail) ? tail : '<path>';
}

/**
 * Replace private paths with their repo-relative tail (or `<path>`) and
 * private LAN addresses with `<lan-ip>`; safe text is returned unchanged.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function redactPrivatePaths(value) {
  const text = String(value ?? '').replace(ESCAPED_NEWLINE_RE, MASKED_NEWLINE);
  const scrubbed = text
    .replace(SPACED_PROFILE_RE, '<path>')
    .replace(PATH_RUN_RE, (run) => splitLabels(run)
      .map((part) => splitPieces(part)
        .map((piece) => (isPrivatePiece(piece) ? redactPiece(piece) : piece))
        .join(':'))
      .join('='));
  return scrubbed
    .replace(LAN_IP_GLOBAL_RE, '<lan-ip>')
    .replaceAll(MASKED_NEWLINE, '\\n');
}

/**
 * Reduce a finding file to a repo-relative path, or '' when that cannot be
 * done safely. Absolute and private paths are re-anchored at the first known
 * top-level directory; relative paths that start outside the repo
 * (`.cretli-worktrees/...`, `www/<user>/lib/...`) are re-anchored too.
 *
 * @param {unknown} file
 * @returns {string}
 */
export function scrubFindingFile(file) {
  const raw = String(file || '').trim().replace(/\\/g, '/').replace(/^file:\/\//i, '');
  if (!raw) return '';
  const isAbsolute = /^(?:\/|~|[A-Za-z]:)/.test(raw) || containsPrivateData(raw);
  let parts = raw.replace(/^(?:\.\/)+/, '').split('/').filter((p) => p && p !== '.');
  if (isAbsolute || !REPO_ROOT_DIRS.has(parts[0])) {
    const at = parts.findIndex((part) => REPO_ROOT_DIRS.has(part));
    if (at >= 0) parts = parts.slice(at);
    else if (isAbsolute) return '';
  }
  if (parts.includes('..')) return '';
  const tail = parts.join('/');
  return containsPrivateData(tail) ? '' : tail;
}
