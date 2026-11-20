import fs from 'node:fs';
import path from 'node:path';
import { resolveRepositoryIdentity } from './worktree/git-worktree.ts';

const REPOSITORY_PATH_PATTERN = /(?:repo(?:sitory)?(?:\s+(?:path|at))?\s*[:=]\s*|file:\/\/)([A-Za-z]:\\[^\s`"']+|\/[^\s`"']+)/gi;

/**
 * Find explicit repository paths in todo material that resolve to another Git repository.
 * Paths that are missing, files, or outside Git are ordinary references and are ignored.
 * @param {{ workspaceFolder: string, todo: Record<string, any>, items?: Record<string, any>[] }} input
 * @returns {{ ok: boolean, reason?: string, path?: string }}
 */
export function validateTodoRepositoryBinding(input) {
  const workspace = resolveRepositoryIdentity(input.workspaceFolder);
  const rows = Array.isArray(input.items) ? input.items : [];
  const byId = new Map(rows.map((row) => [String(row.id || ''), row]));
  const relevant = new Map([[String(input.todo?.id || ''), input.todo]]);
  let parentId = String(input.todo?.parentId || '');
  while (parentId && !relevant.has(parentId)) {
    const parent = byId.get(parentId);
    if (!parent) break;
    relevant.set(parentId, parent);
    parentId = String(parent.parentId || '');
  }
  const material = [...relevant.values()]
    .filter(Boolean)
    .map((todo) => `${String(todo.body || '')}\n${String(todo.planStoredMarkdown || todo.plan?.markdown || '')}`)
    .join('\n');
  for (const match of material.matchAll(REPOSITORY_PATH_PATTERN)) {
    const candidate = String(match[1] || '').replace(/[),.;]+$/, '');
    if (!path.isAbsolute(candidate)) continue;
    try {
      if (!fs.statSync(candidate).isDirectory()) continue;
    } catch {
      continue;
    }
    const referenced = resolveRepositoryIdentity(candidate);
    if (referenced && (!workspace || referenced.commonDir !== workspace.commonDir)) {
      return { ok: false, reason: 'repository_mismatch', path: candidate };
    }
  }
  return { ok: true };
}
