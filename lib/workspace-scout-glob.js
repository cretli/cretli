/**
 * Minimal, dependency-free glob matcher for Scout profile scopes.
 *
 * Only the syntax the profile UI documents is supported, so a scope can never
 * pull in an unexpected path:
 *   - `*`  matches within one path segment (never `/`)
 *   - `**` matches any number of segments, including zero
 *   - `?`  matches exactly one character inside a segment
 *   - a pattern without a `/` matches the basename at any depth
 *
 * Matching is always done against a workspace-relative POSIX path, so the
 * scope is a pure string filter and never touches the filesystem by itself.
 */

/**
 * @param {string} value
 * @returns {string}
 */
export function normalizeScoutPath(value) {
  return String(value == null ? '' : value)
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '')
    .trim();
}

/**
 * @param {string} char
 * @returns {string}
 */
function escapeRegExpChar(char) {
  return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}

/**
 * Compile one workspace-relative glob into an anchored RegExp.
 * A pattern without a slash matches a basename at any depth.
 *
 * @param {string} glob
 * @returns {RegExp | null}
 */
export function scoutGlobToRegExp(glob) {
  const pattern = normalizeScoutPath(glob);
  if (!pattern) return null;
  const hasSlash = pattern.includes('/');
  let body = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*') {
      const next = pattern[index + 1];
      if (next === '*') {
        index += 1;
        // `**/` also matches zero segments, so `**/*.js` matches `a.js`.
        if (pattern[index + 1] === '/') {
          index += 1;
          body += '(?:.*/)?';
        } else {
          body += '.*';
        }
      } else {
        body += '[^/]*';
      }
      continue;
    }
    if (char === '?') {
      body += '[^/]';
      continue;
    }
    body += escapeRegExpChar(char);
  }
  const prefix = hasSlash ? '' : '(?:.*/)?';
  try {
    return new RegExp(`^${prefix}${body}$`);
  } catch {
    return null;
  }
}

/**
 * @param {string} pathValue workspace-relative path
 * @param {string} glob
 * @returns {boolean}
 */
export function scoutGlobMatches(pathValue, glob) {
  const file = normalizeScoutPath(pathValue);
  if (!file) return false;
  const re = scoutGlobToRegExp(glob);
  return re ? re.test(file) : false;
}

/**
 * @param {string} pathValue
 * @param {string[]} globs
 * @returns {boolean}
 */
export function scoutPathMatchesAny(pathValue, globs) {
  return (Array.isArray(globs) ? globs : []).some((glob) => scoutGlobMatches(pathValue, glob));
}

/**
 * True when a workspace-relative path belongs to the profile scope. An empty
 * include list means "no include restriction"; an empty exclude list means
 * "nothing excluded".
 *
 * @param {string} pathValue
 * @param {{ include?: unknown, exclude?: unknown } | null | undefined} scope
 * @returns {boolean}
 */
export function scoutPathInScope(pathValue, scope) {
  const include = Array.isArray(scope?.include) ? scope.include : [];
  const exclude = Array.isArray(scope?.exclude) ? scope.exclude : [];
  if (include.length > 0 && !scoutPathMatchesAny(pathValue, include)) return false;
  if (exclude.length > 0 && scoutPathMatchesAny(pathValue, exclude)) return false;
  return true;
}

/**
 * Filter a list of workspace-relative paths by scope, preserving order.
 *
 * @param {unknown} paths
 * @param {{ include?: unknown, exclude?: unknown } | null | undefined} scope
 * @param {number} [max]
 * @returns {string[]}
 */
export function filterScoutPathsByScope(paths, scope, max = Number.POSITIVE_INFINITY) {
  const seen = new Set();
  /** @type {string[]} */
  const out = [];
  for (const raw of Array.isArray(paths) ? paths : []) {
    const file = normalizeScoutPath(raw);
    if (!file || seen.has(file)) continue;
    if (!scoutPathInScope(file, scope)) continue;
    seen.add(file);
    out.push(file);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Git pathspec arguments for a scope, or an empty array when the whole tree is
 * meant. Includes become positive pathspecs; excludes use the `:(exclude)`
 * magic so git itself never reads an out-of-scope file.
 *
 * @param {{ include?: unknown, exclude?: unknown } | null | undefined} scope
 * @returns {string[]}
 */
export function buildScoutGitPathspecArgs(scope) {
  const include = (Array.isArray(scope?.include) ? scope.include : []).map(normalizeScoutPath).filter(Boolean);
  const exclude = (Array.isArray(scope?.exclude) ? scope.exclude : []).map(normalizeScoutPath).filter(Boolean);
  if (include.length === 0 && exclude.length === 0) return [];
  const args = ['--'];
  if (include.length === 0) args.push('.');
  else args.push(...include);
  for (const glob of exclude) args.push(`:(exclude)${glob}`);
  return args;
}
