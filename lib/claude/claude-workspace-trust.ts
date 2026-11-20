/**
 * Workspace trust for the Cretli-owned Claude Code config.
 *
 * Claude Code ignores `permissions.allow` from `<cwd>/.claude/settings.local.json`
 * until the folder has `projects[cwd].hasTrustDialogAccepted: true` in its global
 * config (`$CLAUDE_CONFIG_DIR/.claude.json`). Headless runs cannot answer the
 * dialog, so the warning ("this workspace has not been trusted") shows up in
 * stderr, typically next to a SIGTERM exit (143). Cretli pre-accepts trust only
 * for folders it launches itself, and only inside its own data directory; the
 * user's global ~/.claude is never edited.
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveDataPath } from '../runtime-paths.js';

export const CLAUDE_TRUST_STDERR_RE = /workspace has not been trusted|hasTrustDialogAccepted/i;
export const CLAUDE_TRUST_HINT =
  'Claude Code does not trust this workspace folder (hasTrustDialogAccepted is not set in the Cretli Claude config), so it ignored project permissions.';

/** True when `dir` lives under the Cretli data directory (never ~/.claude). */
function isInsideDataDir(dir: string): boolean {
  const root = path.resolve(resolveDataPath());
  const rel = path.relative(root, path.resolve(dir));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Idempotently marks `cwd` as trusted in `<configDir>/.claude.json`.
 * Returns true when the file was written, false when nothing changed or the
 * config dir is not Cretli-owned. Never throws.
 */
export function ensureClaudeWorkspaceTrust(configDir: unknown, cwd: unknown): boolean {
  const dir = String(configDir || '').trim();
  const folder = String(cwd || '').trim();
  if (!dir || !folder || !path.isAbsolute(folder)) return false;
  try {
    if (!isInsideDataDir(dir)) return false;
    const file = path.join(dir, '.claude.json');
    let config: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) config = parsed;
      else return false;
    } catch (err) {
      // A corrupt file is left alone; only a missing one is created.
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') return false;
    }
    const key = path.resolve(folder);
    const projects = (config.projects && typeof config.projects === 'object' && !Array.isArray(config.projects)
      ? config.projects : {}) as Record<string, Record<string, unknown>>;
    const entry = projects[key] && typeof projects[key] === 'object' ? projects[key] : {};
    if (entry.hasTrustDialogAccepted === true) return false;
    projects[key] = { ...entry, hasTrustDialogAccepted: true };
    config.projects = projects;
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/** Appends the trust hint to an exit-code style error when stderr shows the trust warning. */
export function withClaudeTrustHint(message: string, stderrTail: string[]): string {
  const text = String(message || '');
  if (!text || text.includes(CLAUDE_TRUST_HINT)) return text;
  if (!stderrTail.some(line => CLAUDE_TRUST_STDERR_RE.test(String(line)))) return text;
  return `${text} (${CLAUDE_TRUST_HINT})`;
}
