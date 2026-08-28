import assert from 'node:assert/strict';
import { listWorkflowRuns } from '../lib/github.js';

const originalFetch = global.fetch;
const previousGithubToken = process.env.GITHUB_TOKEN;
const previousGhToken = process.env.GH_TOKEN;

delete process.env.GITHUB_TOKEN;
delete process.env.GH_TOKEN;

global.fetch = async () => ({
  ok: false,
  status: 404,
  headers: { get: () => 'application/json' },
  json: async () => ({ message: 'Not Found' }),
  text: async () => '',
});

try {
  await listWorkflowRuns({ owner: 'octocat', repo: 'Hello-World' }, { perPage: 1, page: 1 });
  assert.fail('Expected listWorkflowRuns to throw on 404.');
} catch (err) {
  assert.equal(
    err?.message,
    'Repository not found or private. Configure GITHUB_TOKEN or save a token in settings.'
  );
} finally {
  global.fetch = originalFetch;
  if (typeof previousGithubToken === 'string') process.env.GITHUB_TOKEN = previousGithubToken;
  else delete process.env.GITHUB_TOKEN;
  if (typeof previousGhToken === 'string') process.env.GH_TOKEN = previousGhToken;
  else delete process.env.GH_TOKEN;
}

console.log('All github-api-errors tests passed.');
