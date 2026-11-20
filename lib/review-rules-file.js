import fs from 'node:fs';
import path from 'node:path';
import { runGitAsync } from './worktree/git-worktree.ts';
import { logDelegationEvent } from './delegation-log.js';

export const REVIEW_RULES_MAX_BYTES = 16 * 1024;
export const REVIEW_RULES_WARNING = 'Changing REVIEW.md is outside the scope of this review and requires human acceptance.';

const GIT_TIMEOUT_MS = 5000;
// Full object ids only: abbreviations and refs never reach git.
const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
export const REVIEW_RULES_LATER_NOTE = 'REVIEW.md exists in later commits but is not pinned for this leaf.';

const git = (args, cwd, options = {}) => runGitAsync(args, cwd, { allowFailure: true, timeoutMs: GIT_TIMEOUT_MS, ...options });

async function isRepository(dir) {
  if (!fs.existsSync(dir)) return false;
  const result = await git(['rev-parse', '--is-inside-work-tree'], dir);
  return result.status === 0 && result.stdout.trim() === 'true';
}

async function repositoryTop(dir) {
  const top = (await git(['rev-parse', '--show-toplevel'], dir)).stdout.trim();
  return top || dir;
}

async function storeBlob(workspace, content) {
  const stored = await git(['hash-object', '-w', '--stdin'], workspace, { input: content });
  return stored.stdout.trim();
}

/** Whether REVIEW.md is tracked in a commit: true/false, or null when git itself failed (timeout, bad object). */
async function hasReviewFile(cwd, commit) {
  const result = await git(['ls-tree', '--full-tree', '--name-only', commit, '--', 'REVIEW.md'], cwd);
  if (result.status !== 0) return null;
  return result.stdout.trim() === 'REVIEW.md';
}

/**
 * Fallback block when the pinned rules cannot be read. `kind` selects the wording and the
 * log field; with `pin: false` no blob is stored, so a later retry can resolve properly.
 */
export async function buildUnavailableReviewRules({ workspace, head, record, log = true, kind = 'commit', pin = true }) {
  const content = kind === 'blob' ? `pinned review rules blob unavailable (${head})` : `pinned review rules unavailable (${head})`;
  if (log) logDelegationEvent('review-rules-unavailable', record || {}, kind === 'blob' ? { reviewRulesBlob: head } : { reviewRulesCommit: head });
  const blob = pin ? await storeBlob(workspace, content) : '';
  return { blob, content, block: `[REPOSITORY REVIEW RULES]\n${content}` };
}

/** Read pinned repository review rules and detect whether the leaf changed them. */
export async function resolveRepositoryReviewRules({ workspaceFolder, executionFolder, leafMaterial, mode, manifestDelta, record, log = true } = {}) {
  const workspace = String(workspaceFolder || '').trim();
  if (!workspace || !(await isRepository(workspace))) return { blob: '', block: '' };
  const pinned = String(leafMaterial?.reviewRulesCommit || '').trim();
  const head = pinned || (await git(['rev-parse', 'HEAD'], workspace)).stdout.trim();
  if (!head) return { blob: '', block: '' };
  if (!SHA_PATTERN.test(head)) return buildUnavailableReviewRules({ workspace, head, record, log });
  const kindResult = await git(['cat-file', '-t', head], workspace);
  if (kindResult.status !== 0) {
    // Only git's clean "not a valid object" answer is definitive; a timeout or any other error must not pin.
    const stderr = String(kindResult.stderr || '');
    // A corrupt object prints extra `error:` lines before the same fatal message.
    const missing = kindResult.status === 128 && /Not a valid object name|could not get object info/i.test(stderr) && !/^error:/m.test(stderr);
    return buildUnavailableReviewRules({ workspace, head, record, log, pin: missing });
  }
  if (kindResult.stdout.trim() !== 'commit') return buildUnavailableReviewRules({ workspace, head, record, log });
  let content = '';
  if (!pinned) content = 'rules read from current HEAD (no pinned base)\n';
  const pinnedHas = await hasReviewFile(workspace, head);
  if (pinnedHas === null) return buildUnavailableReviewRules({ workspace, head, record, log, pin: false });
  const pinnedMissing = !pinnedHas;
  if (pinnedHas) {
    const show = await git(['show', `${head}:REVIEW.md`], workspace);
    if (show.status !== 0) return buildUnavailableReviewRules({ workspace, head, record, log, pin: false });
    const bytes = Buffer.from(show.stdout, 'utf8');
    if (bytes.length > REVIEW_RULES_MAX_BYTES) {
      const truncated = bytes.length - REVIEW_RULES_MAX_BYTES;
      content += `${bytes.subarray(0, REVIEW_RULES_MAX_BYTES).toString('utf8')}\n[truncated ${truncated} bytes]`;
    } else content += bytes.toString('utf8');
  }
  const execFolder = String(executionFolder || workspace);
  const base = String(leafMaterial?.baseCommit || '').trim();
  const baseValid = SHA_PATTERN.test(base);
  let diff = false;
  let addedByLeaf = false;
  let laterNote = false;
  if (mode === 'project') {
    diff = Array.isArray(manifestDelta) && manifestDelta.some((row) => String(row?.path || row?.file || row || '') === 'REVIEW.md');
    addedByLeaf = diff && pinnedMissing;
  } else if (baseValid) {
    // `:(top)` keeps the pathspec repository-root relative even when the folder is a subdirectory.
    diff = Boolean((await git(['diff', base, '--', ':(top)REVIEW.md'], execFolder)).stdout);
    if (pinnedMissing) {
      const baseHas = await hasReviewFile(workspace, base);
      // A new file the base commit does not track never shows up in the diff. It counts as
      // added by this leaf only when the leaf base lacks it too (an earlier sibling may have added it).
      if (baseHas === false && (diff || fs.existsSync(path.join(await repositoryTop(execFolder), 'REVIEW.md')))) diff = addedByLeaf = true;
      else if (baseHas && !diff) laterNote = true;
    }
  }
  if (diff) {
    content += `${content ? '\n' : ''}${REVIEW_RULES_WARNING}`;
    // The leaf adds REVIEW.md: the reviewer gets the pinned version (none), only the warning.
    if (addedByLeaf && log) logDelegationEvent('review-rules-added', record || {}, { reviewRulesCommit: head });
  } else if (laterNote) content += `${content ? '\n' : ''}${REVIEW_RULES_LATER_NOTE}`;
  if (!content.trim()) return { blob: await storeBlob(workspace, ''), content: '', block: '' };
  return { blob: await storeBlob(workspace, content), content, block: `[REPOSITORY REVIEW RULES]\n${content}` };
}

/** Read a stored rules blob; `null` when it is malformed or unreadable (an empty blob reads as ''). */
export async function readPinnedReviewRulesBlob(workspaceFolder, sha) {
  const id = String(sha || '').trim();
  if (!SHA_PATTERN.test(id) || !workspaceFolder || !(await isRepository(workspaceFolder))) return null;
  const result = await git(['cat-file', '-p', id], workspaceFolder);
  return result.status === 0 ? result.stdout : null;
}
