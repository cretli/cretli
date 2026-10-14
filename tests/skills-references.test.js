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

// Mechanical reviewer rotation: the rule, its filters and the recovery paths.
{
  const fs = await import('node:fs');
  const text = fs.readFileSync(
    new URL('../.agents/skills/cretli-todo-refine-loop/references/round-protocol.md', import.meta.url),
    'utf8',
  );
  for (const needle of [
    'review_subject=plan', 'phase=independent', 'session=-', 'uncertified=unknown',
    'minimum `queued`', 'no row has an active status', 'latest\n   finished round', 'next_cursor',
    'force_new', 'Worked example', 'only plan write', 'Nothing else is written to the plan or to workflow state',
  ]) {
    assert.ok(text.includes(needle), `round-protocol lost: ${needle}`);
  }
}

// Fixture: the documented rotation procedure applied to RENDERED list text lines.
{
  const ACTIVE = new Set(['queued', 'starting', 'running', 'waiting_for_input', 'cancelling']);
  const parseLine = (line) => {
    const [status, id, model, ...rest] = line.trim().split(/\s+/);
    const tokens = Object.fromEntries(rest.map((t) => t.split('=')).map(([k, ...v]) => [k, v.join('=')]));
    return { status, id, model, ...tokens };
  };
  const selectExclusions = (lines, leaf) => {
    const rows = lines.map(parseLine).filter((r) => r.leaf === leaf
      && r.review_subject === 'plan' && r.phase === 'independent' && r.session && r.session !== '-');
    const rounds = new Map();
    for (const r of rows) {
      if (!rounds.has(r.session)) rounds.set(r.session, []);
      rounds.get(r.session).push(r);
    }
    const finished = [...rounds.entries()].map(([session, list]) => ({
      session, list, time: list.map((r) => r.queued).sort()[0],
    })).filter((r) => !r.list.some((row) => ACTIVE.has(row.status)));
    finished.sort((a, b) => (a.time === b.time ? (a.session < b.session ? 1 : -1) : (a.time < b.time ? 1 : -1)));
    const latest = finished[0];
    if (!latest) return [];
    const validFail = (r) => r.verdict === 'FAIL' && r.report === '1' && r.err === '0' && r.interrupt === '-';
    const excluded = [];
    for (const r of latest.list) {
      const otherFail = latest.list.some((o) => o !== r && validFail(o));
      if (r.verdict === 'PASS' && r.status !== 'interrupted' && otherFail) excluded.push(r.model);
      if (r.uncertified === 'true') excluded.push(r.model);
    }
    return excluded;
  };
  const row = (status, model, o = {}) => `${status} id-${model} ${model} verdict=${o.verdict || 'PASS'} review_subject=${o.subject || 'plan'}`
    + ` session=${o.session || 's1'} phase=${o.phase || 'independent'} uncertified=${o.unc || 'false'} leaf=${o.leaf || 'T'}`
    + ` outcome=success interrupt=${o.interrupt || '-'} err=${o.err || 0} report=${o.report ?? 1} queued=${o.queued || '2026-01-01T10:00:00Z'}`;
  assert.deepEqual(selectExclusions([row('completed', 'a'), row('completed', 'b', { verdict: 'FAIL' })], 'T'), ['a']);
  assert.deepEqual(selectExclusions([row('completed', 'a'), row('completed', 'b', { verdict: 'FAIL', err: 1 })], 'T'), []);
  assert.deepEqual(selectExclusions([row('completed', 'a'), row('completed', 'b', { verdict: 'FAIL', interrupt: 'x' })], 'T'), []);
  assert.deepEqual(selectExclusions([
    row('interrupted', 'a', { verdict: 'FAIL', interrupt: 'x' }), row('completed', 'b'), row('completed', 'c', { verdict: 'FAIL' }),
  ], 'T'), ['b']);
  for (const active of ['starting', 'waiting_for_input', 'cancelling']) {
    assert.deepEqual(selectExclusions([row(active, 'a'), row('completed', 'b', { verdict: 'FAIL' })], 'T'), []);
  }
  assert.deepEqual(selectExclusions([
    row('completed', 'a', { phase: 'exchange' }), row('completed', 'b', { verdict: 'FAIL', session: '-' }),
    row('completed', 'c', { verdict: 'FAIL', subject: 'other' }), row('completed', 'd', { verdict: 'FAIL', leaf: 'X' }),
  ], 'T'), []);
  assert.deepEqual(selectExclusions([
    row('completed', 'a', { session: 's1', queued: '2026-01-01T10:00:00Z' }),
    row('completed', 'b', { session: 's1', verdict: 'FAIL', queued: '2026-01-01T10:00:00Z' }),
    row('completed', 'c', { session: 's2', queued: '2026-01-01T11:00:00Z' }),
    row('completed', 'd', { session: 's2', verdict: 'FAIL', queued: '2026-01-01T11:00:00Z' }),
  ], 'T'), ['c']);
  assert.deepEqual(selectExclusions([
    row('completed', 'a', { session: 's1' }), row('completed', 'b', { session: 's1', verdict: 'FAIL' }),
    row('completed', 'c', { session: 's2' }), row('completed', 'd', { session: 's2', verdict: 'FAIL' }),
  ], 'T'), ['c']);
}
