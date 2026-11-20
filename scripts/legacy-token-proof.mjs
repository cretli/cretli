#!/usr/bin/env node
// Proof that moving font-size literals onto --cr-font-size-legacy-* tokens
// changes nothing. Usage (from the repo root): node scripts/legacy-token-proof.mjs [git-ref]
//
// The legacy tokens are defined once, on :root (tokens.scss lines 6-7, with the
// dark block), so they resolve in both themes and at every viewport width.
// Because of that, substituting each var(--cr-font-size-legacy-<id>) with its
// defined value must reproduce the base stylesheet byte for byte.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ref = process.argv[2] || 'HEAD';
const repo = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-token-proof-'));

function compile(cwd, out) {
  execFileSync('npx', ['--no-install', 'sass', '--no-source-map', '--style=expanded', path.join(cwd, 'app_front/css/app.scss'), out], {
    cwd: repo,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  return fs.readFileSync(out, 'utf8');
}

const baseDir = path.join(tmp, 'base');
fs.mkdirSync(baseDir);
const archive = execFileSync('git', ['archive', ref, 'app_front'], { cwd: repo, maxBuffer: 1 << 30 });
execFileSync('tar', ['-x', '-C', baseDir], { input: archive });
// Resolve node_modules imports (e.g. ~ packages) from the repo for the base copy.
const nm = path.join(repo, 'node_modules');
if (fs.existsSync(nm)) fs.symlinkSync(nm, path.join(baseDir, 'node_modules'));

const baseCss = compile(baseDir, path.join(tmp, 'base.css'));
const newCss = compile(repo, path.join(tmp, 'new.css'));

const defs = new Map();
for (const m of baseCss.matchAll(/--cr-font-size-legacy-([\w-]+):\s*([^;]+);/g)) defs.set(m[1], m[2].trim());
if (!defs.size) {
  console.error('No legacy token definitions found in the base CSS');
  process.exit(1);
}

const counts = new Map();
const resolved = newCss.replace(/var\(--cr-font-size-legacy-([\w-]+)\)/g, (all, id) => {
  if (!defs.has(id)) return all;
  counts.set(id, (counts.get(id) || 0) + 1);
  return defs.get(id);
});
const unresolved = resolved.match(/var\(--cr-font-size-legacy-[^)]*\)/g);
if (unresolved) {
  console.error(`Unresolved legacy tokens remain: ${[...new Set(unresolved)].join(', ')}`);
  process.exit(1);
}

if (resolved !== baseCss) {
  const a = baseCss.split('\n');
  const b = resolved.split('\n');
  let shown = 0;
  for (let i = 0; i < Math.max(a.length, b.length) && shown < 10; i++) {
    if (a[i] !== b[i]) {
      console.error(`line ${i + 1}:\n  base: ${a[i]}\n  new:  ${b[i]}`);
      shown++;
    }
  }
  console.error('NOT identical');
  process.exit(1);
}

console.log('token=old-value table (replacements in compiled CSS):');
let total = 0;
for (const [id, value] of defs) {
  const n = counts.get(id) || 0;
  if (!n) continue;
  total += n;
  console.log(`  --cr-font-size-legacy-${id} = ${value}  x${n}`);
}
console.log(`total var() uses resolved: ${total}`);
console.log(`IDENTICAL: base (${ref}) CSS == worktree CSS with legacy tokens resolved (${baseCss.length} bytes)`);
fs.rmSync(tmp, { recursive: true, force: true });
