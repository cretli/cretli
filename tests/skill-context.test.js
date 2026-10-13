/**
 * Tests for the skills catalog: YAML frontmatter descriptions (including block
 * scalars) and the split between the stable catalog and the instructions of the
 * skills this turn invokes.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildAvailableSkillsPrompt,
  buildSkillPromptBlocks,
  collectAvailableSkills,
} from '../lib/skills/skill-context.js';

/**
 * @param {Record<string, string>} skills Map of folder name -> SKILL.md content.
 * @returns {{ root: string, options: { additionalDirs: string[], appRoot: string, homeDir: string }, cleanup: () => void }}
 */
function makeSkillWorkspace(skills) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cr-skill-context-'));
  for (const [name, content] of Object.entries(skills)) {
    const dir = path.join(root, '.agents', 'skills', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf8');
  }
  return {
    root,
    options: { additionalDirs: [], appRoot: root, homeDir: root },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const FOLDED_SKILL = [
  '---',
  'name: demo-skill',
  'description: >-',
  '  Folded description that used to',
  '  show up as an empty catalog line.',
  '---',
  '',
  '# Demo skill',
  '',
  'BODY-OF-DEMO-SKILL',
  '',
].join('\n');

test('a folded (>-) description reaches the catalog', () => {
  const workspace = makeSkillWorkspace({ 'demo-skill': FOLDED_SKILL });
  try {
    const { catalog } = buildSkillPromptBlocks(workspace.root, workspace.options, '');
    assert.match(catalog, /\[AVAILABLE AGENT SKILLS\]/);
    assert.match(
      catalog,
      /- demo-skill: Folded description that used to show up as an empty catalog line\./,
    );
    assert.doesNotMatch(catalog, /demo-skill: >-/);
    assert.doesNotMatch(catalog, /BODY-OF-DEMO-SKILL/);
  } finally {
    workspace.cleanup();
  }
});

test('the catalog is identical with and without a skill invocation', () => {
  const workspace = makeSkillWorkspace({ 'demo-skill': FOLDED_SKILL });
  try {
    const plain = buildSkillPromptBlocks(workspace.root, workspace.options, 'Fix the parser.');
    const invoked = buildSkillPromptBlocks(workspace.root, workspace.options, 'Use @demo-skill now.');
    assert.equal(plain.catalog, invoked.catalog);
    assert.equal(plain.selected, '');
    assert.match(invoked.selected, /\[SKILL: demo-skill\]/);
    assert.match(invoked.selected, /BODY-OF-DEMO-SKILL/);
  } finally {
    workspace.cleanup();
  }
});

test('buildAvailableSkillsPrompt keeps the combined legacy layout', () => {
  const workspace = makeSkillWorkspace({ 'demo-skill': FOLDED_SKILL });
  try {
    const combined = buildAvailableSkillsPrompt(workspace.root, workspace.options, 'run demo-skill');
    const { catalog, selected } = buildSkillPromptBlocks(workspace.root, workspace.options, 'run demo-skill');
    assert.equal(combined, `${catalog}\n${selected}`);
    assert.ok(combined.startsWith('[AVAILABLE AGENT SKILLS]'));
  } finally {
    workspace.cleanup();
  }
});

test('an unreadable or oversized skill file never breaks the catalog', () => {
  const workspace = makeSkillWorkspace({
    'block-skill': '---\nname: block-skill\ndescription: |\n  literal body\n---\n\nBODY\n',
    'broken-skill': '---\nname: broken-skill\ndescription: >-\n  broken: [\n---\n\nBODY\n',
    'huge-skill': `---\nname: huge-skill\ndescription: too big\n---\n\n${'x'.repeat(70 * 1024)}\n`,
  });
  try {
    const entries = collectAvailableSkills(workspace.root, workspace.options);
    const names = entries.map((entry) => entry.name);
    assert.ok(names.includes('block-skill'));
    assert.ok(names.includes('broken-skill'));
    assert.ok(!names.includes('huge-skill'));
    const broken = entries.find((entry) => entry.name === 'broken-skill');
    assert.equal(broken.description, 'broken: [');
  } finally {
    workspace.cleanup();
  }
});

test('a skill without frontmatter keeps its folder name', () => {
  const workspace = makeSkillWorkspace({ 'plain-skill': '# No frontmatter\n\nBODY\n' });
  try {
    const entries = collectAvailableSkills(workspace.root, workspace.options);
    assert.deepEqual(entries.map((entry) => entry.name), ['plain-skill']);
    assert.equal(entries[0].description, '');
  } finally {
    workspace.cleanup();
  }
});

test('an empty workspace produces no catalog and no selected block', () => {
  const workspace = makeSkillWorkspace({});
  try {
    const blocks = buildSkillPromptBlocks(workspace.root, workspace.options, 'run demo-skill');
    assert.equal(blocks.catalog, '');
    assert.equal(blocks.selected, '');
    assert.equal(buildAvailableSkillsPrompt(workspace.root, workspace.options, 'x'), '');
  } finally {
    workspace.cleanup();
  }
});
