/** Project CLAUDE.md delivery for runtimes without Claude Code's native loader. */
import fs from 'node:fs';
import path from 'node:path';
import {
  assertFileSizeWithinLimit,
  assertPathWithinProjectRoot,
  isInsideTrustedRoot,
  resolveTrustedRoot,
} from './source-trust.ts';

export function buildClaudeMdPromptBlock(input: {
  cwd?: string;
  projectRoot?: string;
  transport?: string;
}): string {
  // Claude Code already loads these instructions through its project preset.
  if (input.transport === 'claude') return '';
  const root = resolveTrustedRoot(input.projectRoot || input.cwd || process.cwd());
  const cwd = resolveTrustedRoot(input.cwd || root);
  if (!root || !cwd || !isInsideTrustedRoot(root, cwd)) return '';
  const dirs = [root];
  const rel = path.relative(root, cwd);
  if (rel) for (const segment of rel.split(path.sep)) dirs.push(path.join(dirs[dirs.length - 1], segment));
  const chunks: string[] = [];
  for (const dir of dirs) {
    const file = path.join(dir, 'CLAUDE.md');
    const trusted = assertPathWithinProjectRoot(root, file);
    if (!trusted.ok || !assertFileSizeWithinLimit(file, 'rule').ok) continue;
    try {
      const body = fs.readFileSync(trusted.resolvedReal, 'utf8').trim();
      if (body) chunks.push(`### ${path.relative(root, file).split(path.sep).join('/')}\n${body}`);
    } catch {
      // Missing or unreadable project instructions must not prevent a send.
    }
  }
  if (!chunks.length) return '';
  return [
    '[CLAUDE.MD INSTRUCTIONS]',
    'Project instructions shared by Cretli. Listed from the project root to the working directory; more local instructions take precedence.',
    ...chunks,
  ].join('\n\n');
}
