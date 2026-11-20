/**
 * Target the OpenCode project instance on HTTP calls.
 * v2 session routes omit `directory` in OpenAPI, but the server still
 * selects the instance from query/header — without it replies 404 NotFound.
 */

/**
 * @param {string} [directory]
 * @returns {string}
 */
export function buildOpenCodeDirectoryQuery(directory = '') {
  const dir = String(directory || '').trim();
  if (!dir) return '';
  const params = new URLSearchParams();
  params.set('directory', dir);
  params.set('location[directory]', dir);
  return `?${params.toString()}`;
}

/**
 * @param {string} [directory]
 * @returns {Record<string, string>}
 */
export function buildOpenCodeInstanceHeaders(directory = '') {
  const dir = String(directory || '').trim();
  /** @type {Record<string, string>} */
  const headers = { 'Content-Type': 'application/json' };
  if (dir) {
    headers['x-opencode-directory'] = encodeURIComponent(dir);
  }
  return headers;
}

/**
 * @param {{
 *   baseUrl: string,
 *   path: string,
 *   directory?: string,
 *   body?: string,
 * }} input
 * @returns {Promise<Response>}
 */
export async function fetchOpenCodeInstancePost(input) {
  const baseUrl = String(input.baseUrl || '').replace(/\/$/, '');
  const path = String(input.path || '');
  const directory = String(input.directory || '').trim();
  return fetch(`${baseUrl}${path}${buildOpenCodeDirectoryQuery(directory)}`, {
    method: 'POST',
    headers: buildOpenCodeInstanceHeaders(directory),
    body: input.body,
  });
}

/**
 * @param {number} status
 * @param {string} detail
 * @returns {boolean}
 */
export function isOpenCodeNotFoundDetail(status, detail) {
  if (status !== 404) return false;
  return /NotFoundError|not found/i.test(String(detail || ''));
}

/**
 * Permission/question already resolved, expired, or auto-denied.
 * @param {number} status
 * @param {string} detail
 * @returns {boolean}
 */
export function isOpenCodeStaleSkillError(status, detail) {
  if (status !== 404) return false;
  return /PermissionNotFoundError|QuestionNotFoundError/i.test(String(detail || ''));
}

/**
 * POST session-scoped path first, then global v1 path on instance 404.
 *
 * @param {{
 *   baseUrl: string,
 *   directory?: string,
 *   sessionPath?: string,
 *   globalPath: string,
 *   body?: string,
 *   errorLabel: string,
 * }} input
 */
export async function postOpenCodeInstanceWithFallback(input) {
  const sessionPath = String(input.sessionPath || '').trim();
  const globalPath = String(input.globalPath || '').trim();
  const firstPath = sessionPath || globalPath;
  if (!firstPath) {
    throw new Error(`Missing OpenCode ${input.errorLabel} target`);
  }
  const first = await fetchOpenCodeInstancePost({
    baseUrl: input.baseUrl,
    path: firstPath,
    directory: input.directory,
    body: input.body,
  });
  if (first.ok) return;
  const detail = await first.text().catch(() => '');
  const canFallback = Boolean(sessionPath && globalPath && sessionPath !== globalPath)
    && isOpenCodeNotFoundDetail(first.status, detail);
  if (!canFallback) {
    if (isOpenCodeStaleSkillError(first.status, detail)) return;
    throw new Error(detail.trim() || `OpenCode ${input.errorLabel} failed (${first.status})`);
  }
  const retry = await fetchOpenCodeInstancePost({
    baseUrl: input.baseUrl,
    path: globalPath,
    directory: input.directory,
    body: input.body,
  });
  if (retry.ok) return;
  const retryDetail = await retry.text().catch(() => '');
  if (isOpenCodeStaleSkillError(retry.status, retryDetail) || isOpenCodeStaleSkillError(first.status, detail)) {
    return;
  }
  throw new Error(retryDetail.trim() || `OpenCode ${input.errorLabel} failed (${retry.status})`);
}
