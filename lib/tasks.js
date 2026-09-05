/**
 * Reads tasks from .vscode/tasks.json (VS Code / Cursor).
 * Supports type: shell, process and npm, plus ${workspaceFolder} substitution.
 */

import fs from 'fs';
import path from 'path';
import { parse as parseJsonc } from 'jsonc-parser';

/**
 * @typedef {{
 *   label: string,
 *   type: string,
 *   command?: string,
 *   args?: string[],
 *   cwd: string,
 *   env?: Record<string, string>,
 *   folderName?: string,
 *   folderPath?: string
 * }} WorkspaceTask
 */

/**
 * Loads and parses .vscode/tasks.json from a single folder.
 * `${workspaceFolder}` is that folder (same as Cursor multi-root).
 *
 * @param {string} workspaceDir
 * @returns {{ tasks: WorkspaceTask[] } | null}
 */
export function loadTasks(workspaceDir) {
  const baseDir = path.resolve(workspaceDir);
  const tasksPath = path.join(baseDir, '.vscode', 'tasks.json');
  if (!fs.existsSync(tasksPath)) return null;
  const raw = fs.readFileSync(tasksPath, 'utf8');
  const data = parseJsonc(raw, [], { allowTrailingComma: true });
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    console.warn('[tasks] loadTasks: parse error', tasksPath);
    return null;
  }
  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  const workspaceFolder = baseDir;
  const folderName = path.basename(baseDir);

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
  for (const task of tasks) {
    const item = task && typeof task === 'object' ? task : {};
    const label = item.label;
    if (!label || typeof label !== 'string') continue;
    const type = item.type || 'shell';
    const cmd = item.command;
    const args = item.args;
    const opts = item.options || {};
    const cwd = resolveTaskCwd(opts, item.path);
    const env = opts.env && typeof opts.env === 'object' ? { ...opts.env } : undefined;
    const meta = { folderName, folderPath: baseDir };
    if (type === 'shell' && cmd) {
      result.push({ label, type: 'shell', command: buildShellCommand(cmd, args), cwd, env, ...meta });
      continue;
    }
    if (type === 'process' && cmd) {
      const command = String(cmd).replace(/\$\{workspaceFolder\}/g, workspaceFolder);
      const processArgs = Array.isArray(args)
        ? args.map((arg) => String(arg).replace(/\$\{workspaceFolder\}/g, workspaceFolder))
        : [];
      result.push({ label, type: 'process', command, args: processArgs, cwd, env, ...meta });
      continue;
    }
    if (type === 'npm') {
      const script = typeof item.script === 'string' ? item.script.trim() : '';
      if (!script) continue;
      result.push({
        label,
        type: 'shell',
        command: `npm run ${script}`,
        cwd,
        env,
        ...meta,
      });
    }
  }
  return { tasks: result };
}

/**
 * Loads tasks from every directory (Cursor multi-root: each folder's `.vscode/tasks.json`).
 * Duplicate labels get a folder-name prefix.
 *
 * @param {unknown} directories
 * @returns {{ tasks: WorkspaceTask[] } | null}
 */
export function loadTasksFromDirectories(directories) {
  const seenDirs = new Set();
  const usedLabels = new Set();
  const tasks = [];
  for (const directory of Array.isArray(directories) ? directories : []) {
    if (!directory) continue;
    const resolved = path.resolve(String(directory));
    if (seenDirs.has(resolved)) continue;
    seenDirs.add(resolved);
    const loaded = loadTasks(resolved);
    if (!loaded) continue;
    for (const task of loaded.tasks) {
      let label = task.label;
      if (usedLabels.has(label)) {
        label = `${task.folderName}: ${label}`;
      }
      usedLabels.add(label);
      tasks.push({ ...task, label });
    }
  }
  if (tasks.length === 0) return null;
  return { tasks };
}
