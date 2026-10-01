/**
 * Discover skills available to every Cretli harness.
 *
 * `.agents/skills` is the cross-agent convention. `.cursor/skills` and
 * `~/.cursor/skills-cursor` remain supported for Cursor compatibility.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveProjectPath } from '../runtime-paths.js';
import { getConfiguredAdditionalCursorContextDirs } from '../sdk/shared-cursor-context.js';

const MAX_SKILL_FILE_BYTES = 64 * 1024;

function existingDirectory(value) {
  try {
    return fs.statSync(value).isDirectory();
  } catch {
    return false;
  }
}

function readSkillMetadata(skillFile, folderName) {
  let content = '';
  try {
    const stat = fs.statSync(skillFile);
    if (!stat.isFile() || stat.size > MAX_SKILL_FILE_BYTES) return null;
    content = fs.readFileSync(skillFile, 'utf8');
  } catch {
    return null;
  }
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] || '';
  const name = frontmatter.match(/^name:\s*["']?([^\r\n"']+)["']?\s*$/im)?.[1]?.trim() || folderName;
  const description = frontmatter.match(/^description:\s*["']?([^\r\n"']+)["']?\s*$/im)?.[1]?.trim() || '';
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) return null;
  return { name, description: description.slice(0, 1000), path: skillFile };
}

function skillsInDirectory(directory) {
  if (!existingDirectory(directory)) return [];
  let entries = [];
  try {
    entries = fs.readdirSync(directory);
  } catch {
    return [];
  }
  const result = [];
  for (const entry of entries) {
    const folder = path.join(directory, entry);
    if (!existingDirectory(folder)) continue;
    const skill = readSkillMetadata(path.join(folder, 'SKILL.md'), entry);
    if (skill) result.push(skill);
  }
  return result;
}

function workspaceSkillRoots(cwd) {
  const roots = [];
  let current = path.resolve(cwd || process.cwd());
  while (true) {
    roots.push(path.join(current, '.agents', 'skills'));
    roots.push(path.join(current, '.cursor', 'skills'));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return roots;
}

function isSkillSelected(prompt, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const mention = new RegExp(`(?:^|[^a-z0-9._-])(@${escapedName}|${escapedName})(?![a-z0-9._-])`, 'ig');
  for (const match of prompt.matchAll(mention)) {
    if (match[1].startsWith('@')) return true;
    const before = prompt.slice(Math.max(0, match.index - 48), match.index);
    const after = prompt.slice(match.index + match[0].length, match.index + match[0].length + 48);
    if (/\b(skill|agent|run|invoke|load|use)\b/i.test(`${before} ${after}`)) return true;
  }
  return false;
}

/**
 * Return a prompt section listing available skills and where their full
 * instructions live. Skill files are read on demand by the selected harness.
 *
 * @param {string} cwd
 * @param {{ additionalDirs?: string[], appRoot?: string, homeDir?: string }} [options]
 */
export function buildAvailableSkillsPrompt(cwd, options = {}, userPrompt = '') {
  const appRoot = path.resolve(options.appRoot || resolveProjectPath());
  const homeDir = path.resolve(options.homeDir || os.homedir());
  const extraRoots = Array.isArray(options.additionalDirs)
    ? options.additionalDirs
    : getConfiguredAdditionalCursorContextDirs();
  const roots = [
    ...workspaceSkillRoots(cwd),
    ...extraRoots.flatMap((root) => [path.join(root, '.agents', 'skills'), path.join(root, '.cursor', 'skills')]),
    path.join(appRoot, '.agents', 'skills'),
    path.join(appRoot, '.cursor', 'skills'),
    path.join(homeDir, '.agents', 'skills'),
    path.join(homeDir, '.cursor', 'skills-cursor'),
  ];
  const byName = new Map();
  for (const root of roots) {
    for (const skill of skillsInDirectory(root)) {
      if (!byName.has(skill.name)) byName.set(skill.name, skill);
    }
  }
  if (byName.size === 0) return '';
  const entries = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  const parts = [
    '[AVAILABLE AGENT SKILLS]',
    'These reusable skills are available in this Cretli chat. Mention a skill by its exact name or write @skill-name to load its full SKILL.md into this turn. For skills listed here, follow the instructions already included below or read the listed path with the Read tool. Do not call Claude Code’s native Skill tool for these entries; its catalog may not include Cretli skills stored outside native skill folders. The listed paths are shared by Cretli and do not need to be copied into the workspace.',
    ...entries.map((skill) => `- ${skill.name}: ${skill.description || 'Reusable task instructions.'} (read ${skill.path})`),
    'When the user names a skill as part of a request, follow its included instructions first.',
  ];
  const prompt = String(userPrompt || '');
  const selected = entries.filter((skill) => isSkillSelected(prompt, skill.name));
  for (const skill of selected) {
    try {
      const instructions = fs.readFileSync(skill.path, 'utf8');
      parts.push(`[SKILL: ${skill.name}]`, instructions);
    } catch {
      parts.push(`[SKILL: ${skill.name}] Read the full instructions at ${skill.path} before acting.`);
    }
  }
  return parts.join('\n');
}
