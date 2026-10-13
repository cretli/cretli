/**
 * Discover skills available to every Cretli harness.
 *
 * `.agents/skills` is the cross-agent convention. `.cursor/skills` and
 * `~/.cursor/skills-cursor` remain supported for Cursor compatibility.
 *
 * Two prompt blocks are produced from one directory scan:
 *
 * - the **catalog** — name, purpose and path of every skill. It only changes
 *   when the skills on disk change, so the prompt decoration can dedupe it
 *   across turns;
 * - the **selected instructions** — the full body of the skills this turn
 *   actually invokes. It changes with the request, not with the catalog, so it
 *   is decorated separately and re-sent whenever a skill is invoked.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveProjectPath } from '../runtime-paths.js';
import { getConfiguredAdditionalCursorContextDirs } from '../sdk/shared-cursor-context.js';
import { frontmatterString, oneLineFrontmatterValue, parseFrontmatter } from './frontmatter.js';

const MAX_SKILL_FILE_BYTES = 64 * 1024;

function existingDirectory(value) {
  try {
    return fs.statSync(value).isDirectory();
  } catch {
    return false;
  }
}

/**
 * @param {string} skillFile
 * @param {string} folderName
 * @returns {{ name: string, description: string, path: string } | null}
 */
function readSkillMetadata(skillFile, folderName) {
  let content = '';
  try {
    const stat = fs.statSync(skillFile);
    if (!stat.isFile() || stat.size > MAX_SKILL_FILE_BYTES) return null;
    content = fs.readFileSync(skillFile, 'utf8');
  } catch {
    return null;
  }
  const frontmatter = parseFrontmatter(content);
  const name = oneLineFrontmatterValue(frontmatterString(frontmatter, 'name')) || folderName;
  const description = oneLineFrontmatterValue(frontmatterString(frontmatter, 'description'));
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) return null;
  return { name, description: description.slice(0, 1000), path: skillFile };
}

/**
 * @param {string} directory
 * @returns {{ name: string, description: string, path: string }[]}
 */
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

/**
 * @param {string} cwd
 * @returns {string[]}
 */
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
 * @param {string} prompt
 * @param {string} name
 * @returns {boolean}
 */
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
 * One directory scan over every skill root, first source wins on name clash.
 *
 * @param {string} cwd
 * @param {{ additionalDirs?: string[], appRoot?: string, homeDir?: string }} [options]
 * @returns {{ name: string, description: string, path: string }[]}
 */
export function collectAvailableSkills(cwd, options = {}) {
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
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const CATALOG_HEADER = '[AVAILABLE AGENT SKILLS]';

const CATALOG_INTRO =
  'These reusable skills are available in this Cretli chat. Mention a skill by its exact name or write @skill-name to load its full SKILL.md into this turn. For skills listed here, follow the instructions already included below or read the listed path with the Read tool. Do not call Claude Code’s native Skill tool for these entries; its catalog may not include Cretli skills stored outside native skill folders. The listed paths are shared by Cretli and do not need to be copied into the workspace.';

const CATALOG_FOOTER = 'When the user names a skill as part of a request, follow its included instructions first.';

/**
 * Stable catalog block: names, purposes and paths. Independent of the request.
 *
 * @param {{ name: string, description: string, path: string }[]} entries
 * @returns {string}
 */
export function buildSkillsCatalogText(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return '';
  return [
    CATALOG_HEADER,
    CATALOG_INTRO,
    ...entries.map((skill) => `- ${skill.name}: ${skill.description || 'Reusable task instructions.'} (read ${skill.path})`),
    CATALOG_FOOTER,
  ].join('\n');
}

/**
 * Instructions of the skills this turn invokes. Empty when no skill is named.
 *
 * @param {{ name: string, description: string, path: string }[]} entries
 * @param {string} userPrompt
 * @returns {string}
 */
export function buildSelectedSkillsText(entries, userPrompt = '') {
  if (!Array.isArray(entries) || entries.length === 0) return '';
  const prompt = String(userPrompt || '');
  if (!prompt) return '';
  const parts = [];
  for (const skill of entries.filter((entry) => isSkillSelected(prompt, entry.name))) {
    try {
      const instructions = fs.readFileSync(skill.path, 'utf8');
      parts.push(`[SKILL: ${skill.name}]`, instructions);
    } catch {
      parts.push(`[SKILL: ${skill.name}] Read the full instructions at ${skill.path} before acting.`);
    }
  }
  return parts.join('\n');
}

/**
 * Catalog and selected instructions in one scan.
 *
 * @param {string} cwd
 * @param {{ additionalDirs?: string[], appRoot?: string, homeDir?: string }} [options]
 * @param {string} [userPrompt]
 * @returns {{ catalog: string, selected: string }}
 */
export function buildSkillPromptBlocks(cwd, options = {}, userPrompt = '') {
  const entries = collectAvailableSkills(cwd, options);
  return {
    catalog: buildSkillsCatalogText(entries),
    selected: buildSelectedSkillsText(entries, userPrompt),
  };
}

/**
 * Return a prompt section listing available skills and where their full
 * instructions live, followed by the body of the skills this turn invokes.
 *
 * Kept for callers that decorate a prompt in one piece; the decoration path
 * uses `buildSkillPromptBlocks` so the stable catalog can be deduped on its
 * own.
 *
 * @param {string} cwd
 * @param {{ additionalDirs?: string[], appRoot?: string, homeDir?: string }} [options]
 * @param {string} [userPrompt]
 */
export function buildAvailableSkillsPrompt(cwd, options = {}, userPrompt = '') {
  const { catalog, selected } = buildSkillPromptBlocks(cwd, options, userPrompt);
  return [catalog, selected].filter(Boolean).join('\n');
}
