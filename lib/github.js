/**
 * GitHub REST helpers: detect origin remote and fetch Actions workflow runs.
 */

import { getEffectiveGithubToken } from './github-token.js';

const GITHUB_API = 'https://api.github.com';

/**
 * @param {string} remoteUrl
 * @returns {{ owner: string, repo: string, htmlUrl: string } | null}
 */
export function parseGithubRemoteUrl(remoteUrl) {
  const raw = (remoteUrl || '').trim();
  if (!raw) return null;
  const sshMatch = raw.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i);
  if (sshMatch) {
    const owner = sshMatch[1];
    const repo = sshMatch[2].replace(/\.git$/i, '');
    return { owner, repo, htmlUrl: `https://github.com/${owner}/${repo}` };
  }
  const sshUrlMatch = raw.match(/^ssh:\/\/git@github\.com\/([^/]+)\/(.+?)(?:\.git)?$/i);
  if (sshUrlMatch) {
    const owner = sshUrlMatch[1];
    const repo = sshUrlMatch[2].replace(/\.git$/i, '');
    return { owner, repo, htmlUrl: `https://github.com/${owner}/${repo}` };
  }
  try {
    const parsed = new URL(raw);
    if (!/^(www\.)?github\.com$/i.test(parsed.hostname)) return null;
    const parts = parsed.pathname.replace(/^\/+|\/+$/g, '').split('/');
    if (parts.length < 2 || !parts[0] || !parts[1]) return null;
    const owner = parts[0];
    const repo = parts[1].replace(/\.git$/i, '');
    return { owner, repo, htmlUrl: `https://github.com/${owner}/${repo}` };
  } catch {
    return null;
  }
}

/**
 * @param {(args: string[], cwd: string) => { ok: boolean, stdout?: string }} runGitCommand
 * @param {string} cwd
 * @returns {{ remoteUrl: string, owner: string, repo: string, htmlUrl: string } | null}
 */
export function getGithubRemoteFromCwd(runGitCommand, cwd) {
  const result = runGitCommand(['remote', 'get-url', 'origin'], cwd);
  if (!result.ok) return null;
  const remoteUrl = (result.stdout || '').trim();
  const parsed = parseGithubRemoteUrl(remoteUrl);
  if (!parsed) return null;
  return { remoteUrl, ...parsed };
}

/**
 * @param {string} apiPath
 * @param {{ token?: string, method?: string, accept?: string }} [options]
 */
async function githubApiRequest(apiPath, options = {}) {
  const token = (options.token || getEffectiveGithubToken() || '').trim();
  const hasToken = token.length > 0;
  const headers = {
    Accept: options.accept || 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'Cretli',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${GITHUB_API}${apiPath}`, {
    method: options.method || 'GET',
    headers,
    redirect: 'follow',
  });
  const contentType = response.headers.get('content-type') || '';
  if (!response.ok) {
    let message = `GitHub API ${response.status}`;
    if (contentType.includes('application/json')) {
      try {
        const body = await response.json();
        if (body?.message) message = body.message;
      } catch {
        // ignore parse errors
      }
    } else {
      const text = await response.text().catch(() => '');
      if (text) message = text.slice(0, 300);
    }
    if (response.status === 404 && !hasToken && /^Not Found$/i.test(message.trim())) {
      message = 'Repository not found or private. Configure GITHUB_TOKEN or save a token in settings.';
    }
    const err = new Error(message);
    err.status = response.status;
    throw err;
  }
  if (contentType.includes('application/json')) {
    return response.json();
  }
  return response.text();
}

/**
 * @param {{ owner: string, repo: string }} repo
 * @param {{ perPage?: number, page?: number }} [options]
 */
export async function listWorkflowRuns(repo, options = {}) {
  const perPage = Math.min(Math.max(Number(options.perPage) || 20, 1), 50);
  const page = Math.max(Number(options.page) || 1, 1);
  const data = await githubApiRequest(
    `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/actions/runs?per_page=${perPage}&page=${page}`
  );
  const runs = Array.isArray(data?.workflow_runs) ? data.workflow_runs : [];
  return {
    totalCount: Number(data?.total_count) || runs.length,
    runs: runs.map(normalizeWorkflowRun),
  };
}

/**
 * @param {{ owner: string, repo: string }} repo
 * @param {number|string} runId
 */
export async function listWorkflowRunJobs(repo, runId) {
  const data = await githubApiRequest(
    `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/actions/runs/${encodeURIComponent(String(runId))}/jobs?per_page=100`
  );
  const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
  return jobs.map(normalizeWorkflowJob);
}

/**
 * @param {{ owner: string, repo: string }} repo
 * @param {number|string} jobId
 * @returns {Promise<string>}
 */
export async function fetchWorkflowJobLogs(repo, jobId) {
  const text = await githubApiRequest(
    `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/actions/jobs/${encodeURIComponent(String(jobId))}/logs`,
    { accept: 'application/vnd.github+json' }
  );
  if (typeof text !== 'string') return '';
  const maxLen = 64 * 1024;
  if (text.length <= maxLen) return text;
  return `…\n${text.slice(-maxLen)}`;
}

function normalizeWorkflowRun(run) {
  return {
    id: run?.id,
    name: run?.name || run?.display_title || 'Workflow',
    event: run?.event || '',
    status: run?.status || '',
    conclusion: run?.conclusion || '',
    headBranch: run?.head_branch || '',
    headSha: (run?.head_sha || '').slice(0, 7),
    htmlUrl: run?.html_url || '',
    createdAt: run?.created_at || '',
    updatedAt: run?.updated_at || '',
    runAttempt: run?.run_attempt || 1,
  };
}

function normalizeWorkflowJob(job) {
  const steps = Array.isArray(job?.steps)
    ? job.steps.map((step) => ({
        name: step?.name || '',
        status: step?.status || '',
        conclusion: step?.conclusion || '',
        number: step?.number || 0,
      }))
    : [];
  return {
    id: job?.id,
    name: job?.name || 'Job',
    status: job?.status || '',
    conclusion: job?.conclusion || '',
    htmlUrl: job?.html_url || '',
    startedAt: job?.started_at || '',
    completedAt: job?.completed_at || '',
    steps,
  };
}
