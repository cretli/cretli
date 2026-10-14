/**
 * Guards for the repo-owned skills: every relative reference resolves, and the
 * invariants that must survive modularisation are still present in SKILL.md.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { frontmatterString, oneLineFrontmatterValue, parseFrontmatter } from '../lib/skills/frontmatter.js';

const skillsDir = path.resolve(import.meta.dirname, '..', '.agents', 'skills');

/** Relative markdown links, excluding in-page anchors and external URLs. */
const LINK_PATTERN = /\[[^\]]*\]\(([^)]+)\)/g;

/**
 * @param {string} file
 * @returns {string[]}
 */
function relativeLinks(file) {
  const text = fs.readFileSync(file, 'utf8');
  const out = [];
  for (const match of text.matchAll(LINK_PATTERN)) {
    const target = match[1].trim();
    if (!target || target.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    out.push(target.split('#')[0].trim());
  }
  return out.filter(Boolean);
}

test('every relative link inside a repo-owned skill resolves', () => {
  const missing = [];
  for (const entry of fs.readdirSync(skillsDir)) {
    const base = path.join(skillsDir, entry);
    if (!fs.statSync(base).isDirectory()) continue;
    const walk = (dir) => {
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, item.name);
        if (item.isDirectory()) {
          walk(full);
          continue;
        }
        if (!item.name.endsWith('.md')) continue;
        for (const target of relativeLinks(full)) {
          const resolved = path.resolve(path.dirname(full), target);
          if (!fs.existsSync(resolved)) missing.push(`${path.relative(skillsDir, full)} -> ${target}`);
        }
      }
    };
    walk(base);
  }
  assert.deepEqual(missing, []);
});

// Skills this leaf modularised: their catalog line is held to the short form.
const SHORT_DESCRIPTION_SKILLS = new Set(['cretli-multi-harness', 'cretli-todo-refine-loop']);

test('each repo-owned skill declares a name matching its folder and a real description', () => {
  for (const entry of fs.readdirSync(skillsDir)) {
    const skillFile = path.join(skillsDir, entry, 'SKILL.md');
    if (!fs.existsSync(skillFile)) continue;
    const frontmatter = parseFrontmatter(fs.readFileSync(skillFile, 'utf8'));
    assert.ok(frontmatter, `${entry} has no frontmatter`);
    assert.equal(frontmatterString(frontmatter, 'name'), entry, `${entry} name mismatch`);
    const description = oneLineFrontmatterValue(frontmatterString(frontmatter, 'description'));
    assert.ok(description.length > 40, `${entry} description is too short to route on`);
    if (SHORT_DESCRIPTION_SKILLS.has(entry)) {
      assert.ok(description.length <= 240, `${entry} description is too long for a catalog line`);
    }
  }
});

test('modularised skills keep the invariants in SKILL.md', () => {
  const multiHarness = fs.readFileSync(path.join(skillsDir, 'cretli-multi-harness', 'SKILL.md'), 'utf8');
  for (const needle of ['review_subject', 'Never commit, push or merge', 'Never call Cursor `Task`', 'references/loop-protocol.md', 'references/model-picking.md']) {
    assert.ok(multiHarness.includes(needle), `cretli-multi-harness lost: ${needle}`);
  }

  const refineLoop = fs.readFileSync(path.join(skillsDir, 'cretli-todo-refine-loop', 'SKILL.md'), 'utf8');
  for (const needle of ['review_subject: "plan"', 'plan.approvedAt', 'reviewer_session', 'references/round-protocol.md', 'references/decomposition.md']) {
    assert.ok(refineLoop.includes(needle), `cretli-todo-refine-loop lost: ${needle}`);
  }
  // Reading the whole second skill is no longer mandatory.
  assert.equal(/read that skill for the details/.test(refineLoop), false);
});

// The exchange/collaborative procedure left the refine prompt and must live in the references.
{
  const fs = await import('node:fs');
  const text = fs.readFileSync(
    new URL('../.agents/skills/cretli-todo-refine-loop/references/round-protocol.md', import.meta.url),
    'utf8',
  );
  assert.match(text, /plan_reviewer_phase: "exchange"/);
  assert.match(text, /\/api\/plan-reviewer-sessions\/:sessionId\/messages/);
}
