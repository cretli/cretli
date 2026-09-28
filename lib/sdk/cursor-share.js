/** Skills-only Cursor root; canonical content remains in the application repo. */
import fs from 'node:fs';
import path from 'node:path';
import { resolveDataPath, resolveProjectPath } from '../runtime-paths.js';

function entries(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true });
}

function isDirectory(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function mirrorDirectory(source, target, accept = () => true) {
  fs.mkdirSync(target, { recursive: true });
  const selected = entries(source).filter(accept);
  const names = new Set(selected.map((entry) => entry.name));
  for (const entry of entries(target)) {
    if (names.has(entry.name)) continue;
    fs.rmSync(path.join(target, entry.name), { recursive: true, force: true });
  }
  for (const entry of selected) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    const previous = fs.existsSync(to) ? fs.lstatSync(to) : null;
    if (previous && (previous.isSymbolicLink() || previous.isDirectory() !== entry.isDirectory())) {
      fs.rmSync(to, { recursive: true, force: true });
    }
    if (entry.isDirectory()) {
      mirrorDirectory(from, to, (child) => child.isDirectory() || child.isFile());
      continue;
    }
    const content = fs.readFileSync(from);
    if (fs.existsSync(to) && fs.readFileSync(to).equals(content)) continue;
    fs.writeFileSync(to, content);
  }
}

export function ensureCursorShare(
  appRoot = resolveProjectPath(),
  shareRoot = resolveDataPath('cursor-share'),
) {
  const source = path.join(appRoot, '.cursor');
  const target = path.join(shareRoot, '.cursor');
  fs.mkdirSync(target, { recursive: true });
  // This runtime-owned root must never expose project rules or commands.
  for (const entry of entries(target)) {
    if (entry.name === 'skills' || entry.name === 'agents') continue;
    fs.rmSync(path.join(target, entry.name), { recursive: true, force: true });
  }
  const sharedSkills = path.join(target, 'skills');
  fs.mkdirSync(sharedSkills, { recursive: true });
  // Prefer the cross-harness `.agents/skills` convention. Keep existing
  // `.cursor/skills` skills available to Cursor and as a migration path.
  const skillSources = [path.join(appRoot, '.agents', 'skills'), path.join(source, 'skills')];
  const selectedSkills = new Map();
  for (const root of skillSources) {
    for (const entry of entries(root)) {
      const skillDir = path.join(root, entry.name);
      if (!isDirectory(skillDir) || !fs.existsSync(path.join(skillDir, 'SKILL.md'))) continue;
      if (!selectedSkills.has(entry.name)) selectedSkills.set(entry.name, skillDir);
    }
  }
  for (const entry of entries(sharedSkills)) {
    if (!selectedSkills.has(entry.name)) fs.rmSync(path.join(sharedSkills, entry.name), { recursive: true, force: true });
  }
  for (const [name, from] of selectedSkills) {
    mirrorDirectory(from, path.join(sharedSkills, name));
  }
  mirrorDirectory(path.join(source, 'agents'), path.join(target, 'agents'), (entry) =>
    entry.isFile() && /\.mdc?$/.test(entry.name));
  return shareRoot;
}
