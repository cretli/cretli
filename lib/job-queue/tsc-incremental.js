/**
 * `tsc --incremental` arguments with a stable tsBuildInfo location.
 *
 * `scope: 'worktree'` (default) keeps one build-info file per checkout so
 * parallel worktrees never invalidate each other; `scope: 'shared'` keys only
 * by tsconfig for one cache reused across worktrees (tsc revalidates by file
 * hash, so a shared file is correct but may churn).
 */
import { createHash } from 'node:crypto';
import path from 'node:path';

/**
 * @param {{ root: string, cacheDir: string, project?: string, scope?: 'worktree' | 'shared', noEmit?: boolean }} input
 * @returns {{ args: string[], buildInfoPath: string }}
 */
export function buildTscIncrementalArgs(input) {
  const project = input.project || 'tsconfig.json';
  const scope = input.scope === 'shared' ? 'shared' : 'worktree';
  const key = scope === 'shared'
    ? path.basename(project)
    : `${path.basename(project)}-${createHash('sha1').update(path.resolve(input.root)).digest('hex').slice(0, 12)}`;
  const buildInfoPath = path.join(input.cacheDir, 'tsbuildinfo', `${key}.tsbuildinfo`);
  const args = ['-p', project, '--incremental', '--tsBuildInfoFile', buildInfoPath];
  if (input.noEmit !== false) args.push('--noEmit');
  return { args, buildInfoPath };
}
