import fs from 'node:fs';
import path from 'node:path';

/**
 * Resolve explicit source files inside the workspace, rejecting flags and symlink escapes.
 */
export function resolveReviewLintFiles(files: string[], projectRoot: string | undefined): string[] | null {
  if (!files.length || !projectRoot) return null;
  let root: string;
  try {
    root = fs.realpathSync(projectRoot);
  } catch {
    return null;
  }
  const resolved: string[] = [];
  for (const file of files) {
    if (!/^(?:\.\/)?(?:lib|app_front|tests|scripts|harnesses)\/[\w./-]+\.(?:js|mjs|cjs|ts|mts|cts)$/.test(file)) return null;
    if (file.split('/').includes('..')) return null;
    try {
      const absolute = fs.realpathSync(path.resolve(root, file));
      const relative = path.relative(root, absolute);
      if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !fs.statSync(absolute).isFile()) return null;
      resolved.push(absolute);
    } catch {
      return null;
    }
  }
  return resolved;
}
