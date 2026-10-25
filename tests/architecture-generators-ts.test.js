import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildReport } from '../scripts/architecture-dependency-cycles.mjs';

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-gen-ts-'));
  const files = {
    'server.js': "import './lib/a.js';\n",
    'lib/a.js': "import { b } from './b.js';\nexport const a = b;\n",
    'lib/b.ts': "import { a } from './a.js';\nexport const b: number = 1;\nexport type T = typeof a;\n",
    // JSDoc import() type in a comment must not create an edge or a self-import.
    'lib/c.js': "/** @type {import('./c.js').X} */\n// import('./a.js')\nexport const c = 1;\n",
  };
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

test('./x.js resolves to x.ts, comments create no edges, no self-import, output is stable', () => {
  const root = makeFixture();
  try {
    const report = buildReport(root);
    assert.equal(report.fileCount, 4);
    assert.equal(report.static.edgeCount, 3);
    assert.deepEqual(report.static.cycles, [['lib/a.js', 'lib/b.ts']]);
    assert.deepEqual(report.withDynamic.selfImports, []);
    assert.equal(report.withDynamic.edgeCount, 3);
    assert.equal(JSON.stringify(buildReport(root)), JSON.stringify(report));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
