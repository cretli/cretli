import { existsSync, readFileSync, statSync } from 'fs';
import {
  isGitRepo,
  normalizeGitArg,
  parseGitStatusBranchLine,
  runGitCommand,
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
 * @property {(req: import('express').Request) => object} [resolveScope]
 * @property {object} [gitGuardDeps] injectable registry readers for
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
 * @returns {{ ok: true, context: object } | { ok: false, status: number, body: object }}
 */
function resolveScope(req, ctx) {
  const resolver = typeof ctx.resolveScope === 'function' ? ctx.resolveScope : null;
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
 * @param {object} context
 * @returns {object}
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
 * @param {GitRoutesContext} ctx
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

/**
 * @param {import('express').Express} app
 * @param {GitRoutesContext} ctx
 */
export function registerGitRoutes(app, ctx) {
  app.get('/api/git/info', (req, res) => {
    const scope = resolveScope(req, ctx);
    if (!scope.ok) return res.status(scope.status).json(scope.body);
    const context = scope.context;
    const cwd = context.executionFolder;
    const summary = scopeSummary(context);
    if (!isGitRepo(cwd)) {
      return res.json({ ok: true, ...summary, cwd, isRepo: false });
    }
    const status = runGitCommand(['status', '--porcelain=v1', '-b'], cwd);
    const lines = (status.stdout || '').split('\n').filter(Boolean);
    const branchLine = lines.find((l) => l.startsWith('## ')) || '';
    const { branch, upstream, aheadBehind } = parseGitStatusBranchLine(branchLine);
    const head = runGitCommand(['rev-parse', '--short', 'HEAD'], cwd).stdout.trim();
    const topLevel = runGitCommand(['rev-parse', '--show-toplevel'], cwd).stdout.trim();
    const statusShort = lines.filter((l) => !l.startsWith('## '));
    return res.json({
      ok: true,
      ...summary,
      cwd,
      isRepo: true,
      topLevel,
      branch,
      upstream,
      aheadBehind,
      head,
      statusShort,
    });
  });

  /** Single-file diff against HEAD. path = relative to the execution folder. */
  app.get('/api/git/file-diff', (req, res) => {
    const scope = resolveScope(req, ctx);
    if (!scope.ok) return res.status(scope.status).json(scope.body);
    const context = scope.context;
    const cwd = context.executionFolder;
    if (!isGitRepo(cwd)) {
      return res.json({ ok: false, error: msg(req, 'git.noRepo') });
    }
    const rel = (req.query.path && String(req.query.path).trim()) || '';
    if (!rel) return res.status(400).json({ ok: false, error: msg(req, 'files.missingPath') });
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
    const scope = resolveScope(req, ctx);
    if (!scope.ok) return res.status(scope.status).json(scope.body);
    const context = scope.context;
    const cwd = context.executionFolder;
    if (!isGitRepo(cwd)) {
      return res.json({ ok: false, error: 'No git repository in the current directory.' });
    }
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
      const scope = resolveScope(req, ctx);
      if (!scope.ok) return res.status(scope.status).json(scope.body);
      res.json({ ...resolveGithubRepoFromCwd(scope.context.executionFolder), scope: scopeSummary(scope.context) });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/github/actions/runs', async (req, res) => {
    try {
      const scope = resolveScope(req, ctx);
      if (!scope.ok) return res.status(scope.status).json(scope.body);
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
      const scope = resolveScope(req, ctx);
      if (!scope.ok) return res.status(scope.status).json(scope.body);
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
      const scope = resolveScope(req, ctx);
      if (!scope.ok) return res.status(scope.status).json(scope.body);
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
