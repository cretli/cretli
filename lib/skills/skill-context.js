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
    'These reusable skills are available in this Cretli chat. When a skill matches the request, read its full SKILL.md before acting. The listed paths are shared by Cretli and do not need to be copied into the workspace.',
    ...entries.map((skill) => `- ${skill.name}: ${skill.description || 'Reusable task instructions.'} (read ${skill.path})`),
    'If the user explicitly names a skill as $name or by name, load and follow that skill first.',
  ];
  const prompt = String(userPrompt || '').toLowerCase();
  const explicitlySelected = entries.filter((skill) =>
    prompt.includes(`$${skill.name.toLowerCase()}`)
      || prompt.includes(skill.name.toLowerCase()));
  for (const skill of explicitlySelected) {
    try {
      const instructions = fs.readFileSync(skill.path, 'utf8');
      parts.push(`[SKILL: ${skill.name}]`, instructions);
    } catch {
      parts.push(`[SKILL: ${skill.name}] Read the full instructions at ${skill.path} before acting.`);
    }
  }
  return parts.join('\n');
}
