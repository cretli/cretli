import { existsSync, readFileSync, statSync } from 'fs';
import { promises as fsp } from 'fs';
import path from 'path';
import {
  isGitRepo,
  normalizeGitArg,
  parseGitStatusBranchLine,
  runGitCommand,
  runGitCommandAsync,
} from '../git-cli.js';
import { collectWorkspaceGitActivity } from '../git-switch-guard.js';
import { getGithubRemoteFromCwd, listWorkflowRuns, listWorkflowRunJobs, fetchWorkflowJobLogs } from '../github.js';
import { getGithubTokenMetaForClient } from '../github-token.js';
import { msg } from '../messages.js';
import { resolveGitRequestContext, resolvePathWithinBase } from '../git-context.js';

/**
 * @typedef {Object} GitRoutesContext
 * @property {() => string} getCurrentCwd
 * @property {string} [dataDir]
 * @property {(req: import('express').Request) => Record<string, any>} [resolveScope]
 * @property {Record<string, any>} [gitGuardDeps] injectable registry readers for
 *   `collectWorkspaceGitActivity` (tests); production uses the durable stores
 */

/** Actions that rewrite the main working tree, so the busy-work guard applies. */
const GUARDED_GIT_ACTIONS = new Set(['switch', 'switch-new']);

/**
 * Parse `git for-each-ref --format='%(refname:short)%09%(HEAD)' refs/heads`.
 * A tab separator is used because it can never occur inside a ref name.
 *
 * @param {string} stdout
 * @returns {Array<{ name: string, current: boolean, argSafe: boolean }>}
 */
export function parseGitBranchRefs(stdout) {
  return String(stdout || '')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const tabIndex = line.indexOf('\t');
      const name = (tabIndex > -1 ? line.slice(0, tabIndex) : line).trim();
      const marker = tabIndex > -1 ? line.slice(tabIndex + 1).trim() : '';
      return {
        name,
        current: marker === '*',
        // normalizeGitArg is the same allow-list the run action enforces, so a
        // name rejected there is rendered disabled instead of failing later.
        argSafe: Boolean(name) && normalizeGitArg(name) === name,
      };
    })
    .filter((branch) => branch.name !== '');
}

/**
 * Resolve the authorized Git context for a request. The default resolver reads
 * durable chat / TODO records; tests may inject `ctx.resolveScope`.
 *
 * @param {import('express').Request} req
 * @param {GitRoutesContext} ctx
 * @returns {{ ok: true, context: Record<string, any> } | { ok: false, status: number, body: Record<string, any> }}
 */
function resolveScope(req, ctx) {
  const resolver = typeof ctx.resolveScope === 'function' ? ctx.resolveScope : null;
  /** @type {Record<string, any>} */
  const result = resolver
    ? resolver(req)
    : resolveGitRequestContext(req, { dataDir: ctx.dataDir, getCurrentCwd: ctx.getCurrentCwd });
  if (result?.ok) return { ok: true, context: result };
  const code = String(result?.code || 'scope_error');
  const status = code === 'chat_not_found' || code === 'todo_not_found'
    ? 404
    : code === 'context_conflict'
      ? 409
      : 400;
  return { ok: false, status, body: { ok: false, code, error: result?.error || 'Invalid Git context.' } };
}

/**
 * Trimmed scope fields shared by every response so the UI can tell the main
 * project apart from a task worktree.
 *
 * @param {Record<string, any>} context
 * @returns {Record<string, any>}
 */
function scopeSummary(context) {
  return {
    source: context.source,
    chatId: context.chatId || '',
    todoId: context.todoId || '',
    workspaceFolder: context.workspaceFolder || '',
    executionFolder: context.executionFolder || '',
    isWorktree: context.isWorktree === true,
    worktree: context.worktree || null,
    todo: context.todo || null,
    chat: context.chat || null,
  };
}

/**
 * @param {string} cwd
 */
function resolveGithubRepoFromCwd(cwd) {
  if (!isGitRepo(cwd)) {
    return { ok: false, cwd, isRepo: false, isGithub: false };
  }
  const remote = getGithubRemoteFromCwd(runGitCommand, cwd);
  if (!remote) {
    return { ok: true, cwd, isRepo: true, isGithub: false };
  }
  return {
    ok: true,
    cwd,
    isRepo: true,
    isGithub: true,
    owner: remote.owner,
    repo: remote.repo,
    remoteUrl: remote.remoteUrl,
    htmlUrl: remote.htmlUrl,
    ...getGithubTokenMetaForClient(),
  };
}

/** Short TTL: the signature below cannot see unstaged edits, so bound staleness in time. */
const GIT_INFO_TTL_MS = 2000;
const GIT_INFO_CACHE_MAX = 64;
/** @type {Map<string, { at: number, signature: string, info: Record<string, any> | null }>} */
const gitInfoCache = new Map();
/** @type {Map<string, Promise<Record<string, any> | null>>} */
const gitInfoInflight = new Map();

/**
 * Cheap change signature: mtimes of the git dir's HEAD and index (async stat).
 *
 * @param {string} gitDir
 * @returns {Promise<string>}
 */
async function gitStateSignature(gitDir) {
  const mtime = async (/** @type {string} */ name) => {
    try {
      return (await fsp.stat(path.join(gitDir, name))).mtimeMs;
    } catch {
      return 0;
    }
  };
  const [head, index] = await Promise.all([mtime('HEAD'), mtime('index')]);
  return `${head}:${index}`;
}

/**
 * @param {string} cwd
 * @returns {Promise<Record<string, any> | null>} null when cwd is not a git repo
 */
async function computeGitInfo(cwd) {
  const [inside, status, head, top, gitDir] = await Promise.all([
    runGitCommandAsync(['rev-parse', '--is-inside-work-tree'], cwd),
    runGitCommandAsync(['status', '--porcelain=v1', '-b'], cwd),
    runGitCommandAsync(['rev-parse', '--short', 'HEAD'], cwd),
    runGitCommandAsync(['rev-parse', '--show-toplevel'], cwd),
    runGitCommandAsync(['rev-parse', '--absolute-git-dir'], cwd),
  ]);
  if (!inside.ok || (inside.stdout || '').trim() !== 'true') return null;
  const lines = (status.stdout || '').split('\n').filter(Boolean);
  const branchLine = lines.find((l) => l.startsWith('## ')) || '';
  const { branch, upstream, aheadBehind } = parseGitStatusBranchLine(branchLine);
  return {
    topLevel: (top.stdout || '').trim(),
    branch,
    upstream,
    aheadBehind,
    head: (head.stdout || '').trim(),
    statusShort: lines.filter((l) => !l.startsWith('## ')),
    gitDir: (gitDir.stdout || '').trim(),
  };
}

/**
 * Cached, non-blocking repo snapshot for `/api/git/info`.
 *
 * @param {string} cwd
 * @returns {Promise<Record<string, any> | null>}
 */
async function readGitInfo(cwd) {
  const hit = gitInfoCache.get(cwd);
  if (hit && Date.now() - hit.at < GIT_INFO_TTL_MS) {
    const gitDir = hit.info?.gitDir;
    if (!gitDir || (await gitStateSignature(gitDir)) === hit.signature) return strip(hit.info);
  }
  let pending = gitInfoInflight.get(cwd);
  if (!pending) {
    // Sign before computing: a change landing mid-compute then mismatches on the next read.
    const prior = gitInfoCache.get(cwd)?.info?.gitDir;
    const early = prior ? gitStateSignature(prior) : null;
    pending = computeGitInfo(cwd)
      .then(async (info) => {
        const signature = !info?.gitDir ? ''
          : early && info.gitDir === prior ? await early : await gitStateSignature(info.gitDir);
        gitInfoCache.delete(cwd);
        gitInfoCache.set(cwd, { at: Date.now(), signature, info });
        while (gitInfoCache.size > GIT_INFO_CACHE_MAX) {
          gitInfoCache.delete(gitInfoCache.keys().next().value);
        }
        return info;
      })
      .finally(() => gitInfoInflight.delete(cwd));
    gitInfoInflight.set(cwd, pending);
  }
  return strip(await pending);
}

/**
 * Drop the internal gitDir field so the response shape is unchanged.
 *
 * @param {Record<string, any> | null} info
 */
function strip(info) {
  if (!info) return null;
  const { gitDir: _gitDir, ...rest } = info;
  return rest;
}

/**
 * @param {import('express').Express} app
 * @param {GitRoutesContext} ctx
 */
export function registerGitRoutes(app, ctx) {
  app.get('/api/git/info', async (req, res) => {
    /** @type {Record<string, any>} */
    const scope = resolveScope(req, ctx);
    if (!scope.ok) return res.status(scope.status).json(scope.body);
    const context = scope.context;
    const cwd = context.executionFolder;
    const summary = scopeSummary(context);
    try {
      const info = await readGitInfo(cwd);
      if (!info) return res.json({ ok: true, ...summary, cwd, isRepo: false });
      return res.json({ ok: true, ...summary, cwd, isRepo: true, ...info });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err?.message || 'git info failed.' });
    }
  });

  /** Single-file diff against HEAD. path = relative to the execution folder. */
  app.get('/api/git/file-diff', (req, res) => {
    /** @type {Record<string, any>} */
    const scope = resolveScope(req, ctx);
    if (!scope.ok) return res.status(scope.status).json(scope.body);
    const context = scope.context;
    const cwd = context.executionFolder;
    if (!isGitRepo(cwd)) {
      return res.json({ ok: false, error: msg(req, 'git.noRepo') });
    }
    const rel = (req.query.path && String(req.query.path).trim()) || '';
    if (!rel) return res.status(400).json({ ok: false, error: msg(req, 'files.missingPath') });
    /** @type {Record<string, any>} */
    const located = resolvePathWithinBase(cwd, rel);
    if (!located.ok) {
      return res.status(400).json({ ok: false, error: located.error });
    }
    const { resolvedReal, relPosix } = located;
    const statusRes = runGitCommand(['status', '--porcelain=v1', '--', relPosix], cwd);
    if (!statusRes.ok) {
      return res.json({ ok: false, error: statusRes.error || 'git status failed.' });
    }
    const statusLine = (statusRes.stdout || '').split('\n').find((l) => l.trim());
    const code = statusLine ? statusLine.slice(0, 2) : '';
    const isUntracked = code === '??';
    const isDeleted = !isUntracked && (code[0] === 'D' || code[1] === 'D');
    if (isUntracked) {
      try {
        if (!existsSync(resolvedReal) || !statSync(resolvedReal).isFile()) {
          return res.json({ ok: false, error: msg(req, 'files.fileNotFound') });
        }
        const content = readFileSync(resolvedReal, 'utf8');
        const header =
          `diff --git a/${relPosix} b/${relPosix}\n` +
          `new file mode 100644\n` +
          `--- /dev/null\n` +
          `+++ b/${relPosix}\n` +
          `@@ -0,0 +1,${content.split('\n').length} @@\n`;
        return res.json({
          ok: true,
          path: relPosix,
          status: 'U',
          isUntracked: true,
          isDeleted: false,
          diff: header + content.split('\n').map((l) => `+${l}`).join('\n'),
        });
      } catch (err) {
        return res.status(500).json({ ok: false, error: err.message });
      }
    }
    const diffRes = runGitCommand(['--no-pager', 'diff', 'HEAD', '--', relPosix], cwd);
    if (!diffRes.ok) {
      return res.json({ ok: false, error: diffRes.stderr?.trim() || diffRes.error || 'git diff failed.' });
    }
    return res.json({
      ok: true,
      path: relPosix,
      status: code.trim() || '',
      isUntracked: false,
      isDeleted,
      diff: diffRes.stdout || '',
    });
  });

  /** Local branches for the workspace quick switch; `for-each-ref`, not `branch -a`. */
  app.get('/api/git/branches', (req, res) => {
    /** @type {Record<string, any>} */
    const scope = resolveScope(req, ctx);
    if (!scope.ok) return res.status(scope.status).json(scope.body);
    const context = scope.context;
    const cwd = context.executionFolder;
    if (!isGitRepo(cwd)) {
      return res.json({ ok: false, ...scopeSummary(context), error: msg(req, 'git.noRepo') });
    }
    const result = runGitCommand(
      ['for-each-ref', '--format=%(refname:short)%09%(HEAD)', 'refs/heads'],
      cwd,
    );
    if (!result.ok) {
      const message = (result.stderr || result.stdout || '').trim();
      return res.json({ ok: false, ...scopeSummary(context), error: message || msg(req, 'git.branchesError') });
    }
    return res.json({
      ok: true,
      ...scopeSummary(context),
      branches: parseGitBranchRefs(result.stdout),
    });
  });

  app.post('/api/git/run', (req, res) => {
    /** @type {Record<string, any>} */
    const scope = resolveScope(req, ctx);
    if (!scope.ok) return res.status(scope.status).json(scope.body);
    const context = scope.context;
    const cwd = context.executionFolder;
    if (!isGitRepo(cwd)) {
      return res.json({ ok: false, error: 'No git repository in the current directory.' });
    }
    // Any git action may mutate the repo: drop the cached snapshot before and after the response.
    gitInfoCache.delete(cwd);
    res.on?.('finish', () => gitInfoCache.delete(cwd));
    const action = String(req.body?.action || '').trim();
    const arg = normalizeGitArg(req.body?.arg);
    const actionMap = {
      status: () => ['status', '-sb'],
      fetch: () => ['fetch'],
      pull: () => ['pull'],
      push: () => ['push'],
      log: () => ['log', '--oneline', '--graph', '--decorate', '-n', '20'],
      diff: () => ['diff'],
      'diff-staged': () => ['diff', '--staged'],
      branch: () => ['branch', '-a'],
      stash: () => ['stash'],
      'stash-pop': () => ['stash', 'pop'],
      switch: (value) => ['switch', value],
      'switch-new': (value) => ['switch', '-c', value],
      merge: (value) => ['merge', value],
      rebase: (value) => ['rebase', value],
    };
    const factory = actionMap[action];
    if (!factory) return res.json({ ok: false, error: msg(req, 'git.unknownAction') });
    if (['switch', 'switch-new', 'merge', 'rebase'].includes(action) && !arg) {
      return res.json({ ok: false, error: 'Missing required value (e.g. branch name).' });
    }
    if (GUARDED_GIT_ACTIONS.has(action)) {
      const topLevel = runGitCommand(['rev-parse', '--show-toplevel'], cwd);
      const activity = collectWorkspaceGitActivity(topLevel.stdout?.trim() || cwd, {
        dataDir: ctx.dataDir,
        deps: ctx.gitGuardDeps,
      });
      if (activity.busy) {
        return res.json({
          ok: false,
          code: 'workspace_busy',
          error: msg(req, 'git.workspaceBusy', {
            chats: activity.runningChats,
            delegations: activity.runningDelegations,
            watcher: activity.watcherCycles,
          }),
        });
      }
    }
    const args = factory(arg);
    const result = runGitCommand(args, cwd);
    if (!result.ok) {
      const message = (result.stderr || result.stdout || '').trim();
      return res.json({ ok: false, error: message || 'git command failed.' });
    }
    return res.json({
      ok: true,
      ...scopeSummary(context),
      command: `git ${args.join(' ')}`,
      output: (result.stdout || result.stderr || '').trim(),
    });
  });

  app.get('/api/github/info', (req, res) => {
    try {
      /** @type {Record<string, any>} */
      const scope = resolveScope(req, ctx);
      if (!scope.ok) return res.status(scope.status).json(scope.body);
      res.json({ ...resolveGithubRepoFromCwd(scope.context.executionFolder), scope: scopeSummary(scope.context) });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/github/actions/runs', async (req, res) => {
    try {
      /** @type {Record<string, any>} */
      const scope = resolveScope(req, ctx);
      if (!scope.ok) return res.status(scope.status).json(scope.body);
      /** @type {Record<string, any>} */
      const repoInfo = resolveGithubRepoFromCwd(scope.context.executionFolder);
      if (!repoInfo.isGithub) {
        return res.json({ ok: false, error: 'No GitHub remote configured for origin.' });
      }
      const perPage = Number(req.query.per_page) || 20;
      const page = Number(req.query.page) || 1;
      const data = await listWorkflowRuns(
        { owner: repoInfo.owner, repo: repoInfo.repo },
        { perPage, page },
      );
      res.json({
        ok: true,
        owner: repoInfo.owner,
        repo: repoInfo.repo,
        htmlUrl: repoInfo.htmlUrl,
        totalCount: data.totalCount,
        runs: data.runs,
      });
    } catch (err) {
      res.status(err.status === 401 || err.status === 403 ? err.status : 500).json({
        ok: false,
        error: err.message || 'Failed to load GitHub Actions runs.',
      });
    }
  });

  app.get('/api/github/actions/runs/:runId/jobs', async (req, res) => {
    try {
      /** @type {Record<string, any>} */
      const scope = resolveScope(req, ctx);
      if (!scope.ok) return res.status(scope.status).json(scope.body);
      /** @type {Record<string, any>} */
      const repoInfo = resolveGithubRepoFromCwd(scope.context.executionFolder);
      if (!repoInfo.isGithub) {
        return res.json({ ok: false, error: 'No GitHub remote configured for origin.' });
      }
      const runId = String(req.params.runId || '').trim();
      if (!/^\d+$/.test(runId)) {
        return res.status(400).json({ ok: false, error: 'Invalid workflow run id.' });
      }
      const jobs = await listWorkflowRunJobs({ owner: repoInfo.owner, repo: repoInfo.repo }, runId);
      res.json({ ok: true, runId, jobs });
    } catch (err) {
      res.status(err.status === 401 || err.status === 403 ? err.status : 500).json({
        ok: false,
        error: err.message || 'Failed to load workflow jobs.',
      });
    }
  });

  app.get('/api/github/actions/jobs/:jobId/logs', async (req, res) => {
    try {
      /** @type {Record<string, any>} */
      const scope = resolveScope(req, ctx);
      if (!scope.ok) return res.status(scope.status).json(scope.body);
      /** @type {Record<string, any>} */
      const repoInfo = resolveGithubRepoFromCwd(scope.context.executionFolder);
      if (!repoInfo.isGithub) {
        return res.json({ ok: false, error: 'No GitHub remote configured for origin.' });
      }
      const jobId = String(req.params.jobId || '').trim();
      if (!/^\d+$/.test(jobId)) {
        return res.status(400).json({ ok: false, error: 'Invalid job id.' });
      }
      const logs = await fetchWorkflowJobLogs({ owner: repoInfo.owner, repo: repoInfo.repo }, jobId);
      res.json({ ok: true, jobId, logs });
    } catch (err) {
      res.status(err.status === 401 || err.status === 403 ? err.status : 500).json({
        ok: false,
        error: err.message || 'Failed to load job logs.',
      });
    }
  });
}
