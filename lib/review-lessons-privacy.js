/**
 * Shared privacy classifier for review lessons: the one place that decides
 * whether lesson text, a path glob or a finding file names a private machine
 * location (home directory, Windows profile, UNC share, private LAN address).
 *
 * Text is tokenised instead of matched with anchored regexes: every maximal
 * run of characters that can belong to a path (markdown and punctuation such
 * as backticks, quotes, brackets, `*`, `=` and `,` end a run) is split at
 * `label:` separators and classified on its own. A `home`/`users` segment deep
 * inside a relative repo path is legitimate; only home-rooted heads are private.
 * The spec matrix lives in tests/review-lessons-privacy.test.js.
 */

/** Repo top-level directories a private path may be re-anchored at. */
export const REPO_ROOT_DIRS = Object.freeze(new Set(['lib', 'tests', 'docs', 'app_front', 'scripts', 'public', 'src', 'server', 'config']));

const PATH_RUN_RE = /[^\s`'"()[\]<>{},;|=*]+/g;
const LAN_IP_SOURCE = String.raw`(?<![\d.])(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})(?!\.?\d)`;
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
 * @param {string} piece one path-like piece, no whitespace or markdown around it
 * @returns {boolean} the piece names a home-rooted or network location
 */
function isPrivatePiece(piece) {
  let p = piece.replace(/\\/g, '/');
  const scheme = SCHEME_RE.exec(p);
  if (scheme) {
    // Web URLs carry no local path; their host is covered by the LAN address rule.
    if (scheme[1].toLowerCase() !== 'file') return false;
    p = p.slice('file:'.length);
  }
  if (/^\/\/[^/]+\/[^/]/.test(p)) return true; // UNC share `\\host\share\...`
  p = p.replace(/^\/{2,}/, '/').replace(/^\/(?=[A-Za-z]:\/)/, '');
  if (/^[A-Za-z]:\/+users(?:\/|$)/i.test(p)) return true;
  if (/^\/(?:home|users|root)(?:\/|$)/i.test(p)) return true;
  if (/^\/mnt\/[a-z]\/users(?:\/|$)/i.test(p)) return true;
  if (/^~[\w.-]*\//.test(p)) return true;
  // Slash-less `home/<x>` is private only as the first segment of a relative path.
  return /^home\/[^/]/i.test(p.replace(/^(?:\.\.?\/)+/, ''));
}

/** @param {string} text @returns {string[]} every path-like piece of the text */
function listPieces(text) {
  return (text.match(PATH_RUN_RE) || []).flatMap(splitPieces);
}

/**
 * @param {unknown} value
 * @returns {boolean} true when the string carries a private path or a private LAN address
 */
export function containsPrivateData(value) {
  const text = String(value ?? '');
  return LAN_IP_RE.test(text) || listPieces(text).some(isPrivatePiece);
}

/**
 * @param {string} piece a private piece
 * @returns {string} its repo-relative tail from the first known top-level folder, or `<path>`
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
  const text = String(value ?? '');
  const scrubbed = text.replace(PATH_RUN_RE, (run) => splitPieces(run)
    .map((piece) => (isPrivatePiece(piece) ? redactPiece(piece) : piece))
    .join(':'));
  return scrubbed.replace(LAN_IP_GLOBAL_RE, '<lan-ip>');
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
