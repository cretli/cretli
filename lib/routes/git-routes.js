import path from 'path';
import { existsSync, readFileSync, realpathSync, statSync } from 'fs';
import {
  isGitRepo,
  normalizeGitArg,
  parseGitStatusBranchLine,
  runGitCommand,
} from '../git-cli.js';
import { getGithubRemoteFromCwd, listWorkflowRuns, listWorkflowRunJobs, fetchWorkflowJobLogs } from '../github.js';
import { getGithubTokenMetaForClient } from '../github-token.js';
import { msg } from '../messages.js';

/**
 * @typedef {Object} GitRoutesContext
 * @property {() => string} getCurrentCwd
 */

/**
 * @param {GitRoutesContext} ctx
 */
function resolveGithubRepoFromCwd(ctx) {
  const cwd = ctx.getCurrentCwd();
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
  app.get('/api/git/info', (_req, res) => {
    const cwd = ctx.getCurrentCwd();
    if (!isGitRepo(cwd)) {
      return res.json({ ok: true, cwd, isRepo: false });
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

  /** Single-file diff against HEAD. path = relative to cwd. */
  app.get('/api/git/file-diff', (req, res) => {
    const cwd = ctx.getCurrentCwd();
    if (!isGitRepo(cwd)) {
      return res.json({ ok: false, error: msg(req, 'git.noRepo') });
    }
    const rel = (req.query.path && String(req.query.path).trim()) || '';
    if (!rel) return res.status(400).json({ ok: false, error: msg(req, 'files.missingPath') });
    const requested = path.join(cwd, rel);
    const resolved = path.resolve(requested);
    let baseReal;
    let resolvedReal;
    try {
      baseReal = realpathSync(cwd);
      resolvedReal = realpathSync(resolved);
    } catch {
      return res.status(400).json({ ok: false, error: 'Path outside workspace' });
    }
    if (resolvedReal !== baseReal && !resolvedReal.startsWith(baseReal + path.sep)) {
      return res.status(400).json({ ok: false, error: 'Path outside workspace' });
    }
    const relPosix = rel.replace(/\\/g, '/');
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

  app.post('/api/git/run', (req, res) => {
    const cwd = ctx.getCurrentCwd();
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
    const args = factory(arg);
    const result = runGitCommand(args, cwd);
    if (!result.ok) {
      const message = (result.stderr || result.stdout || '').trim();
      return res.json({ ok: false, error: message || 'git command failed.' });
    }
    return res.json({
      ok: true,
      command: `git ${args.join(' ')}`,
      output: (result.stdout || result.stderr || '').trim(),
    });
  });

  app.get('/api/github/info', (_req, res) => {
    try {
      res.json(resolveGithubRepoFromCwd(ctx));
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/github/actions/runs', async (req, res) => {
    try {
      const repoInfo = resolveGithubRepoFromCwd(ctx);
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
      const repoInfo = resolveGithubRepoFromCwd(ctx);
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
      const repoInfo = resolveGithubRepoFromCwd(ctx);
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
