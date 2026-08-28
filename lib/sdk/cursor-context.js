/**
 * Collects Cursor rules, commands, skills and agents (project + user + shared roots).
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  getConfiguredAdditionalCursorContextDirs,
  mergeNamedContextEntries,
} from './shared-cursor-context.js';

/**
 * @param {string} dir
 * @param {string} baseDir
 * @returns {Array<{ name: string, path: string }>}
 */
function listMdc(dir, baseDir = dir) {
  const out = [];
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return out;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const rel = path.relative(baseDir, full);
    if (e.isDirectory()) {
      out.push(...listMdc(full, baseDir));
    } else if (e.name.endsWith('.mdc') || e.name.endsWith('.md')) {
      out.push({ name: e.name, path: rel });
    }
  }
  return out;
}

/**
 * @param {string} homeDir
 * @returns {Array<{ name: string }>}
 */
function listUserSkills(homeDir) {
  const skillsDir = path.join(homeDir, '.cursor', 'skills-cursor');
  if (!fs.existsSync(skillsDir) || !fs.statSync(skillsDir).isDirectory()) return [];
  return fs.readdirSync(skillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name }));
}

/**
 * @param {string} workspaceDir
 * @returns {Array<{ name: string, path: string }>}
 */
function listCommands(workspaceDir) {
  const cmdDir = path.join(workspaceDir, '.cursor', 'commands');
  if (!fs.existsSync(cmdDir) || !fs.statSync(cmdDir).isDirectory()) return [];
  return fs.readdirSync(cmdDir, { withFileTypes: true })
    .filter((e) => e.isFile() && (e.name.endsWith('.md') || e.name.endsWith('.mdc')))
    .map((e) => ({ name: e.name, path: `.cursor/commands/${e.name}` }));
}

/**
 * @param {string} workspaceDir
 * @returns {Array<{ name: string, path: string }>}
 */
function listProjectSkills(workspaceDir) {
  const skillsDir = path.join(workspaceDir, '.cursor', 'skills');
  if (!fs.existsSync(skillsDir) || !fs.statSync(skillsDir).isDirectory()) {
    return [];
  }
  return fs.readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => {
      if (!entry.isDirectory()) {
        return false;
      }
      const skillFile = path.join(skillsDir, entry.name, 'SKILL.md');
      return fs.existsSync(skillFile) && fs.statSync(skillFile).isFile();
    })
    .map((entry) => ({
      name: entry.name,
      path: `.cursor/skills/${entry.name}/SKILL.md`,
    }));
}

/**
 * @param {string} baseDir
 * @param {string} relPrefix
 * @returns {Array<{ name: string, path: string }>}
 */
function listAgents(baseDir, relPrefix = '.cursor/agents') {
  const agentsDir = path.join(baseDir, '.cursor', 'agents');
  if (!fs.existsSync(agentsDir) || !fs.statSync(agentsDir).isDirectory()) {
    return [];
  }
  return fs.readdirSync(agentsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && (entry.name.endsWith('.md') || entry.name.endsWith('.mdc')))
    .map((entry) => ({
      name: entry.name.replace(/\.(md|mdc)$/, ''),
      path: `${relPrefix}/${entry.name}`,
    }));
}

/**
 * @param {string} rootDir
 * @param {string} label
 */
function collectSharedTree(rootDir, label) {
  const cursorDir = path.join(rootDir, '.cursor');
  const rulesDir = path.join(cursorDir, 'rules');
  const rules = (fs.existsSync(rulesDir) ? listMdc(rulesDir, cursorDir) : []).map((r) => ({
    name: r.name,
    path: path.join(rootDir, '.cursor', r.path).replace(/\\/g, '/'),
    source: label,
  }));
  const commands = listCommands(rootDir).map((item) => ({
    name: item.name,
    path: path.join(rootDir, item.path).replace(/\\/g, '/'),
    source: label,
  }));
  const skills = listProjectSkills(rootDir).map((item) => ({
    name: item.name,
    path: path.join(rootDir, item.path).replace(/\\/g, '/'),
    source: label,
  }));
  const agents = listAgents(rootDir).map((item) => ({
    name: item.name,
    path: path.join(rootDir, item.path).replace(/\\/g, '/'),
    source: label,
  }));
  return { rules, commands, skills, agents };
}

/**
 * @param {string} workspaceDir
 * @param {{ additionalDirs?: string[] }} [options]
 */
export function getCursorContext(workspaceDir, options = {}) {
  const cursorDir = path.join(workspaceDir, '.cursor');
  const rulesDir = path.join(cursorDir, 'rules');
  const projectRules = (fs.existsSync(rulesDir) ? listMdc(rulesDir, cursorDir) : []).map((r) => ({
    name: r.name,
    path: `.cursor/${r.path}`,
    source: 'project',
  }));
  const projectCommands = listCommands(workspaceDir).map((item) => ({ ...item, source: 'project' }));
  const projectSkills = listProjectSkills(workspaceDir).map((item) => ({ ...item, source: 'project' }));
  const projectAgents = listAgents(workspaceDir).map((item) => ({ ...item, source: 'project' }));

  const workspaceResolved = workspaceDir ? path.resolve(workspaceDir) : '';
  const additionalDirs = Array.isArray(options.additionalDirs)
    ? options.additionalDirs
    : getConfiguredAdditionalCursorContextDirs().filter((dir) => dir !== workspaceResolved);

  let sharedRules = [];
  let sharedCommands = [];
  let sharedSkills = [];
  let sharedAgents = [];
  for (const dir of additionalDirs) {
    const shared = collectSharedTree(dir, `shared:${path.basename(dir)}`);
    sharedRules = mergeNamedContextEntries(sharedRules, shared.rules);
    sharedCommands = mergeNamedContextEntries(sharedCommands, shared.commands);
    sharedSkills = mergeNamedContextEntries(sharedSkills, shared.skills);
    sharedAgents = mergeNamedContextEntries(sharedAgents, shared.agents);
  }

  const homeDir = os.homedir();
  return {
    projectRules,
    projectCommands,
    projectSkills,
    projectAgents,
    sharedRules,
    sharedCommands,
    sharedSkills,
    sharedAgents,
    additionalCursorContextDirs: additionalDirs,
    userSkills: listUserSkills(homeDir),
    userAgents: listAgents(homeDir, '~/.cursor/agents'),
    cursorRemoteTodosApi: {
      list: 'GET /api/todos',
      create: 'POST /api/todos',
      update: 'PATCH /api/todos/:id',
      remove: 'DELETE /api/todos/:id',
      startAgent: 'POST /api/todos/:id/start-agent',
      setFromAgent: 'POST /api/set-todo-from-agent',
    },
  };
}
