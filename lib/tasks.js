/**
 * Reads tasks from .vscode/tasks.json in the workspace directory (VS Code / Cursor).
 * Supports type: shell and process, plus ${workspaceFolder} substitution.
 */

import fs from 'fs';
import path from 'path';

/**
 * Loads and parses .vscode/tasks.json, tolerating // comments (JSONC).
 * @param {string} workspaceDir - absolute path to the workspace directory (where .code-workspace lives, or the project directory)
 * @returns {{ tasks: Array<{ label: string, type: string, command?: string, args?: string[], cwd: string, env?: Record<string, string> }> } | null}
 */
export function loadTasks(workspaceDir) {
  const baseDir = path.resolve(workspaceDir);
  const tasksPath = path.join(baseDir, '.vscode', 'tasks.json');
  if (!fs.existsSync(tasksPath)) return null;
  let raw = fs.readFileSync(tasksPath, 'utf8');
  // Strip only line-leading comments, so that // inside strings (e.g. regexps) survives
  raw = raw.replace(/^\s*\/\/[^\n]*/gm, '');
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    console.warn('[tasks] loadTasks: parse error', tasksPath, err.message);
    return null;
  }
  const tasks = data.tasks || [];
  const workspaceFolder = baseDir;

  function resolveTaskCwd(taskOptions, taskPath) {
    const options = taskOptions && typeof taskOptions === 'object' ? taskOptions : {};
    const optionCwdRaw = typeof options.cwd === 'string' ? options.cwd.trim() : '';
    const taskPathRaw = typeof taskPath === 'string' ? taskPath.trim() : '';

    let cwd = optionCwdRaw
      ? optionCwdRaw.replace(/\$\{workspaceFolder\}/g, workspaceFolder)
      : baseDir;

    if (!optionCwdRaw && taskPathRaw) {
      cwd = taskPathRaw.replace(/\$\{workspaceFolder\}/g, workspaceFolder);
    }

    cwd = path.resolve(baseDir, cwd);
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      return baseDir;
    }
    return cwd;
  }

  function substituteWorkspace(value) {
    return String(value).replace(/\$\{workspaceFolder\}/g, workspaceFolder);
  }

  function shellQuoteArg(value) {
    const text = substituteWorkspace(value);
    if (/^[A-Za-z0-9_./:=@+-]+$/.test(text)) {
      return text;
    }
    return `'${text.replace(/'/g, `'"'"'`)}'`;
  }

  function buildShellCommand(command, commandArgs) {
    const parts = [substituteWorkspace(command)];
    if (!Array.isArray(commandArgs)) {
      return parts[0];
    }
    for (const arg of commandArgs) {
      parts.push(shellQuoteArg(arg));
    }
    return parts.join(' ');
  }

  const result = [];
  for (const t of tasks) {
    const label = t.label;
    if (!label || typeof label !== 'string') continue;
    const type = t.type || 'shell';
    const cmd = t.command;
    const args = t.args;
    const opts = t.options || {};
    const cwd = resolveTaskCwd(opts, t.path);
    const env = opts.env && typeof opts.env === 'object' ? { ...opts.env } : undefined;
    if (type === 'shell' && cmd) {
      const command = buildShellCommand(cmd, args);
      result.push({ label, type: 'shell', command, cwd, env });
      continue;
    }
    if (type === 'process' && cmd) {
      const command = String(cmd).replace(/\$\{workspaceFolder\}/g, workspaceFolder);
      const a = Array.isArray(args) ? args.map((x) => String(x).replace(/\$\{workspaceFolder\}/g, workspaceFolder)) : [];
      result.push({ label, type: 'process', command, args: a, cwd, env });
      continue;
    }
    if (type === 'npm') {
      const script = typeof t.script === 'string' ? t.script.trim() : '';
      if (!script) continue;
      result.push({
        label,
        type: 'shell',
        command: `npm run ${script}`,
        cwd,
        env,
      });
    }
  }
  return { tasks: result };
}
