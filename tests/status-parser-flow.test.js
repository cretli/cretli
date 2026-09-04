import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import { parseTerminalInteraction, resolveTerminalState } from '../lib/status-parser.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FLOW_FILE = path.join(ROOT, 'public', 'fixtures', 'status-flow-scenarios.json');
const SCHEMA_FILE = path.join(ROOT, 'tests', 'fixtures', 'status-flow-schema.json');

function getByPath(obj, dottedPath) {
  return dottedPath.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function validateSpecOrThrow(spec, schema) {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  if (validate(spec)) return;
  const errors = (validate.errors || []).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ');
  throw new Error(`Niepoprawny format spec flow: ${errors}`);
}

function parseCliArgs(argv) {
  let scenarioId = '';
  let listOnly = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] || '';
    if (arg === '--list') {
      listOnly = true;
      continue;
    }
    if (arg === '--scenario') {
      scenarioId = argv[i + 1] || '';
      i += 1;
      continue;
    }
    if (arg.startsWith('--scenario=')) {
      scenarioId = arg.slice('--scenario='.length);
    }
  }
  return { scenarioId, listOnly };
}

let failed = 0;

function runCase(name, fn) {
  try {
    fn();
    console.log('OK:', name);
  } catch (err) {
    failed += 1;
    console.error('FAIL:', name);
    console.error(err && err.stack ? err.stack : String(err));
  }
}

const spec = loadJson(FLOW_FILE);
const schema = loadJson(SCHEMA_FILE);
validateSpecOrThrow(spec, schema);
const { scenarioId, listOnly } = parseCliArgs(process.argv.slice(2));

if (listOnly) {
  for (const scenario of spec.scenarios) {
    console.log(`${scenario.id}\t${scenario.group}\t${scenario.name}`);
  }
  process.exit(0);
}

const scenarios = scenarioId
  ? spec.scenarios.filter((s) => s.id === scenarioId)
  : spec.scenarios;

if (scenarioId && scenarios.length === 0) {
  console.error(`Brak scenariusza flow o id: ${scenarioId}`);
  process.exit(2);
}

for (const scenario of scenarios) {
  runCase(`flow ${scenario.group} / ${scenario.id}`, () => {
    let buffer = '';
    for (const step of scenario.steps) {
      const mode = step.mode || scenario.assumptions?.mode || spec.defaults.mode;
      if (mode === 'replace') buffer = step.input || '';
      else buffer += step.input || '';

      const parsed = parseTerminalInteraction(buffer);
      const state = resolveTerminalState(
        parsed,
        step.connection || scenario.assumptions?.connection || spec.defaults.connection,
        step.agent || scenario.assumptions?.agent || spec.defaults.agent,
        step.recentOutput === true
          ? true
          : scenario.assumptions?.recentOutput === true
            ? true
            : spec.defaults.recentOutput === true
      );

      const scope = { parsed, state };
      for (const ensure of step.ensures) {
        const actual = getByPath(scope, ensure.path);
        assert.deepEqual(
          actual,
          ensure.equals,
          `step "${step.name}" ensure ${ensure.path} expected ${JSON.stringify(ensure.equals)}, got ${JSON.stringify(actual)}`
        );
      }
    }
  });
}

if (failed > 0) {
  console.error(`\nStatus parser flow tests failed: ${failed}`);
  process.exit(1);
}

console.log('\nAll status parser flow tests passed.');
