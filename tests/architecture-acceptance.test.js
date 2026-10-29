import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const docsDir = path.join(root, 'docs');
const readDoc = (file) => fs.readFileSync(path.join(docsDir, file), 'utf8');
const acceptance = JSON.parse(readDoc('architecture-acceptance.json'));
const matrix = JSON.parse(readDoc('architecture-readiness-matrix.json'));
const manifest = JSON.parse(readDoc('architecture-manifest-stage7.json'));
const markdown = readDoc('architecture-acceptance.md');
const VERDICTS = ['ACCEPTED', 'NOT ACCEPTED', 'BLOCKED', 'NOT MEASURED'];

test('every matrix vertical has a valid acceptance verdict', () => {
  assert.equal(acceptance.schemaVersion, 1);
  const byId = new Map(acceptance.verticals.map((v) => [v.id, v]));
  assert.equal(byId.size, acceptance.verticals.length);
  for (const mv of matrix.verticals) {
    const v = byId.get(mv.id);
    assert.ok(v, `missing vertical ${mv.id}`);
    assert.ok(VERDICTS.includes(v.verdict), `${mv.id} verdict ${v.verdict}`);
    assert.ok(v.reason && v.reason.length > 5, `${mv.id} needs a reason`);
    if (mv.completionAllowed === false) assert.notEqual(v.verdict, 'ACCEPTED', `${mv.id} must not be ACCEPTED`);
  }
});

test('BLOCKED verticals are backed by a dependency-only no-go entry and are deferred, not required', () => {
  for (const v of acceptance.verticals) {
    const noGo = matrix.noGoList.filter((n) => new RegExp(`^${v.id}\\b`).test(n.item));
    if (v.verdict === 'BLOCKED') {
      assert.ok(noGo.length > 0, `${v.id} BLOCKED without a no-go entry`);
      assert.ok(noGo.every((n) => n.blockedBy.length > 0), `${v.id} no-go without blockers`);
      assert.deepEqual([v.required, v.deferred], [false, true], `${v.id} blocked must be deferred`);
    } else {
      assert.deepEqual([v.required, v.deferred], [true, false], `${v.id} must be required`);
    }
  }
  for (const c of acceptance.criteria) {
    assert.equal(c.deferred, !c.required, `${c.id} required/deferred inconsistent`);
    if (c.verdict === 'BLOCKED') assert.equal(c.required, false, `${c.id} blocked criterion must be deferred`);
  }
});

test('criteria have verdicts and the overall verdict is not a full acceptance', () => {
  const ids = acceptance.criteria.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const c of acceptance.criteria) {
    assert.ok(VERDICTS.includes(c.verdict), `${c.id} verdict`);
    assert.ok(c.evidence, `${c.id} evidence`);
  }
  assert.notEqual(acceptance.overallVerdict, 'ACCEPTED');
  assert.ok(acceptance.notAccepted.length > 0);
  assert.ok(acceptance.criteria.some((c) => c.verdict !== 'ACCEPTED'));
  for (const id of ['C3a', 'C3b', 'C15', 'C16', 'C17', 'C18', 'C19']) assert.ok(ids.includes(id), `missing ${id}`);
});

test('markdown and JSON agree on vertical and criterion verdicts', () => {
  for (const v of acceptance.verticals) {
    const row = markdown.split('\n').find((l) => l.startsWith(`| ${v.id} |`));
    assert.ok(row, `md row for ${v.id}`);
    assert.ok(row.includes(v.verdict), `${v.id} md verdict differs from json ${v.verdict}`);
  }
  for (const c of acceptance.criteria.filter((x) => /^C(3a|3b|1[5-9])$/.test(x.id))) {
    const row = markdown.split('\n').find((l) => l.startsWith(`| ${c.id}:`));
    assert.ok(row, `md row for ${c.id}`);
    assert.ok(row.includes(c.verdict), `${c.id} md verdict differs from json ${c.verdict}`);
  }
  assert.ok(markdown.includes(`**Werdykt ogólny: ${acceptance.overallVerdict}.**`));
  for (const item of ['0185d51d', '41b8179c', '9c45b1f5', '70438662', 'c4ca43f3', 'af2d01d2']) {
    assert.ok(markdown.includes(item) && acceptance.openItems.followUpTodos.includes(item), `follow-up ${item}`);
  }
});

/**
 * The manifest also lists live source and living documents (lib/, app_front/, package.json, contracts and
 * profiles that are regenerated). Those change with every commit, so pinning them makes the test fail
 * without any architecture regression. Only the frozen architecture artifacts are hash-checked.
 */
const LIVING_ARCHITECTURE_PATHS = new Set([
  'docs/architecture-chat-catalog-contract.md',
  'docs/architecture-list-sync-contract.md',
  'docs/architecture-readiness-matrix.json',
  'docs/architecture-readiness-matrix.md',
  'docs/architecture-stall-profile.json',
  'docs/architecture-stall-profile.md',
  'scripts/architecture-stall-profile.mjs',
  // Fixture scripts follow the todos-store API as it moves to the async facade.
  'scripts/architecture-http-fixture.mjs',
  // This file: a self-pinned hash would break on every edit of the test itself.
  'tests/architecture-acceptance.test.js',
]);
const isFrozenArchitecturePath = (file) => /^(docs|scripts|tests)\/architecture-/.test(file) && !LIVING_ARCHITECTURE_PATHS.has(file);

test('stage-7 manifest hashes every frozen architecture file (sha256 and bytes) except itself', () => {
  assert.equal(manifest.count, manifest.entries.length);
  assert.ok(manifest.entries.some((e) => e.path === 'docs/architecture-acceptance.json'));
  assert.ok(manifest.entries.some((e) => e.path === 'tests/architecture-acceptance.test.js'));
  for (const e of manifest.entries) {
    assert.notEqual(e.path, 'docs/architecture-manifest-stage7.json', 'manifest must not list itself');
    if (!isFrozenArchitecturePath(e.path)) continue;
    const buf = fs.readFileSync(path.join(root, e.path));
    assert.equal(buf.length, e.bytes, `${e.path} bytes`);
    assert.equal(crypto.createHash('sha256').update(buf).digest('hex'), e.sha256, `${e.path} sha256`);
  }
});

test('acceptance documents contain no private paths or addresses', () => {
  const home = ['/ho', 'me/'].join('');
  const pattern = new RegExp(`${home}|\\b192\\.168\\.|\\b10\\.\\d+\\.\\d+\\.\\d+\\b|/mnt/[a-z]/`);
  const dag = readDoc('architecture-vertical-dag.md');
  const stage8 = dag.slice(dag.indexOf('## Stage 8 acceptance'));
  assert.ok(stage8.length > 100);
  const texts = {
    'architecture-acceptance.json': readDoc('architecture-acceptance.json'),
    'architecture-acceptance.md': markdown,
    'architecture-vertical-dag.md (Stage 8)': stage8,
  };
  for (const [file, text] of Object.entries(texts)) {
    assert.equal(pattern.test(text), false, `${file} leaks a private path or address`);
  }
});
