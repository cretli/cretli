#!/usr/bin/env node
/**
 * Read-only dependency-cycle report for the server code (stage 2 of the architecture
 * program, docs/architecture-baseline.md section 6). It parses import specifiers with
 * regular expressions, never runs application code and never touches `data/`.
 *
 * Scope: every .js/.mjs/.ts file under lib/ plus server.js. Only relative specifiers that
 * resolve to a scanned file become edges. Two graphs are reported:
 * - `static`: `import ... from`, `export ... from` and bare `import 'x'` (these form
 *   real ESM load-time cycles),
 * - `withDynamic`: static plus literal `import('x')` (cycles that exist only at run time).
 * Cycles are strongly connected components (Tarjan) with more than one file, plus
 * self-imports. Output is deterministic (sorted, no timestamps) so it can be hashed.
 * Comments are stripped before scanning; matches inside string literals are still possible.
 * A `./x.js` specifier resolves to `x.ts` when `x.js` does not exist but `x.ts` does.
 *
 * Usage: node scripts/architecture-dependency-cycles.mjs [--out docs/architecture-dependency-cycles.json]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATIC_IMPORT = /(?:^|[\n;])\s*(?:import|export)\s+(?:[^'"`;]*?\sfrom\s+)?['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

/** @param {string} dir @returns {string[]} */
export function listJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') out.push(...listJsFiles(full));
    } else if (/\.(?:js|mjs|ts)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * @param {string} from Absolute importing file.
 * @param {string} specifier
 * @param {Set<string>} known Absolute paths of scanned files.
 * @returns {string | null}
 */
export function resolveSpecifier(from, specifier, known) {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(from), specifier);
  const candidates = [base, `${base}.js`, `${base}.mjs`, `${base}.ts`, path.join(base, 'index.js'), path.join(base, 'index.ts')];
  // TypeScript-style `./x.js` specifier whose source is x.ts.
  if (base.endsWith('.js')) candidates.push(`${base.slice(0, -3)}.ts`);
  else if (base.endsWith('.mjs')) candidates.push(`${base.slice(0, -4)}.mts`);
  for (const candidate of candidates) {
    if (known.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Removes block and line comments while keeping string/template/regex-free scanning simple:
 * quoted strings are skipped so `'//'` inside a specifier is not treated as a comment.
 * @param {string} text
 * @returns {string}
 */
export function stripComments(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (c === '/' && n === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
      out += ' ';
    } else if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== c && !(c !== '`' && text[j] === '\n')) j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

/**
 * @param {Map<string, Set<string>>} graph
 * @returns {string[][]} Components with more than one node, each sorted, list sorted.
 */
export function findCycles(graph) {
  let counter = 0;
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const result = [];
  // Iterative Tarjan: the import graph is deep enough to make recursion risky.
  for (const start of [...graph.keys()].sort()) {
    if (index.has(start)) continue;
    const work = [{ node: start, next: [...graph.get(start)].sort(), i: 0 }];
    index.set(start, counter); low.set(start, counter); counter += 1;
    stack.push(start); onStack.add(start);
    while (work.length) {
      const frame = work[work.length - 1];
      if (frame.i < frame.next.length) {
        const to = frame.next[frame.i++];
        if (!index.has(to)) {
          index.set(to, counter); low.set(to, counter); counter += 1;
          stack.push(to); onStack.add(to);
          work.push({ node: to, next: [...(graph.get(to) || [])].sort(), i: 0 });
        } else if (onStack.has(to)) {
          low.set(frame.node, Math.min(low.get(frame.node), index.get(to)));
        }
        continue;
      }
      work.pop();
      if (work.length) {
        const parent = work[work.length - 1].node;
        low.set(parent, Math.min(low.get(parent), low.get(frame.node)));
      }
      if (low.get(frame.node) !== index.get(frame.node)) continue;
      const component = [];
      let member;
      do {
        member = stack.pop();
        onStack.delete(member);
        component.push(member);
      } while (member !== frame.node);
      if (component.length > 1) result.push(component.sort());
    }
  }
  return result.sort((a, b) => b.length - a.length || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/**
 * @param {Map<string, Set<string>>} graph
 * @param {string} root
 */
export function summarize(graph, root) {
  const rel = (file) => path.relative(root, file).split(path.sep).join('/');
  const cycles = findCycles(graph).map((files) => files.map(rel));
  const selfImports = [...graph].filter(([file, deps]) => deps.has(file)).map(([file]) => rel(file)).sort();
  const edgeCount = [...graph.values()].reduce((sum, deps) => sum + deps.size, 0);
  return {
    edgeCount,
    cycleCount: cycles.length,
    filesInCycles: cycles.reduce((sum, files) => sum + files.length, 0),
    largestCycle: cycles[0]?.length || 0,
    selfImports,
    cycles,
  };
}

/**
 * @param {string} root Repository root (scans lib/ and server.js).
 */
export function buildReport(root) {
  const files = [...listJsFiles(path.join(root, 'lib')), path.join(root, 'server.js')].sort();
  const known = new Set(files);
  const staticGraph = new Map(files.map((file) => [file, new Set()]));
  const dynamicGraph = new Map(files.map((file) => [file, new Set()]));
  for (const file of files) {
    const text = stripComments(fs.readFileSync(file, 'utf8'));
    for (const [pattern, graphs] of [[STATIC_IMPORT, [staticGraph, dynamicGraph]], [DYNAMIC_IMPORT, [dynamicGraph]]]) {
      for (const match of text.matchAll(pattern)) {
        const target = resolveSpecifier(file, match[1], known);
        if (target) for (const graph of graphs) graph.get(file).add(target);
      }
    }
  }
  return {
    schema: 1,
    fileCount: files.length,
    static: summarize(staticGraph, root),
    withDynamic: summarize(dynamicGraph, root),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const json = `${JSON.stringify(buildReport(ROOT), null, 2)}\n`;
  const outIndex = process.argv.indexOf('--out');
  if (outIndex > 0) fs.writeFileSync(path.resolve(ROOT, process.argv[outIndex + 1]), json);
  else process.stdout.write(json);
}
