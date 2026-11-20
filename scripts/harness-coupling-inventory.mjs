#!/usr/bin/env node
/**
 * Non-core harness coupling inventory (docs/ts-migration-and-core-harnesses-plan.md, B1).
 *
 * Core harnesses are `claude`, `sdk` (Cursor) and `codex`. For every other
 * transport this lists where the code names it, split into:
 *   - owned files: live in `lib/<id>/` or carry the id in their file name, so
 *     they move with the harness when it becomes a plugin;
 *   - shared files: everything else; each reference there is coupling that B2
 *     has to replace with a registry lookup.
 * Owned files that name another non-core harness become cross-harness edges.
 *
 *   node scripts/harness-coupling-inventory.mjs           # write the JSON
 *   node scripts/harness-coupling-inventory.mjs --print   # also print a summary
 *
 * Classification is a line-level heuristic (see `heuristics` in the output),
 * good enough to size and order the work, not a proof of every dependency.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = path.join(projectRoot, 'docs', 'harness-coupling-inventory.json');
const print = process.argv.includes('--print');

const ROOTS = ['server.js', 'lib', 'app_front', 'scripts', 'tests', 'harnesses'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'generated', '.tmp', '.vendor']);
const EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts']);
const SELF = 'scripts/harness-coupling-inventory.mjs';
// Modules that wire built-ins into the host (B2): the provider descriptors, the
// lightweight backend descriptors, the leaf-only MCP adapter registry and the
// front-end model Settings panel list. Their references are the intended
// composition, not coupling, so they are reported apart.
const COMPOSITION_ROOTS = [
  'lib/agent-harness/builtin-harness-providers.ts',
  'lib/agent-harness/builtin-harness-backends.ts',
  'lib/mcp/adapters/index.js',
  'app_front/features/settings/models/harnessModelSettingsPanels.js',
  'app_front/features/settings/models/optionalHarnessPanels.js',
  'app_front/core/harness/harnessUiRegistry.js',
  'app_front/features/settings/models/harnessSettingsSchemas.js',
  'app_front/i18n/harness/packs.en.js',
  'app_front/i18n/harness/packs.pl.js',
];

// Spellings seen in the code; `ai` suffix covers the `@mistralai/*` packages.
const HARNESSES = {
  openrouter: ['openrouter', 'OpenRouter', 'openRouter', 'Openrouter', 'OPENROUTER', 'OPEN_ROUTER'],
  mistral: ['mistral', 'Mistral', 'MISTRAL', 'mistralai'],
  zai: ['zai', 'Zai', 'ZAI', 'zAI'],
  mimo: ['mimo', 'Mimo', 'MiMo', 'MIMO'],
  opencode: ['opencode', 'OpenCode', 'openCode', 'Opencode', 'OPENCODE', 'OPEN_CODE'],
  codebuddy: ['codebuddy', 'CodeBuddy', 'codeBuddy', 'Codebuddy', 'CODEBUDDY', 'CODE_BUDDY'],
  deepseek: ['deepseek', 'DeepSeek', 'deepSeek', 'Deepseek', 'DEEPSEEK', 'DEEP_SEEK'],
  qwen: ['qwen', 'Qwen', 'QWEN'],
};
const IDS = Object.keys(HARNESSES);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A spelling counts when it is not glued to more letters of the same case run:
// `qwenConfigured` and `resolveQwenCli` match, `zaire` does not.
function spellingPattern(spelling) {
  const before = /^[a-z]/.test(spelling) ? '(?<![a-zA-Z])' : /^[A-Z]{2}/.test(spelling) ? '(?<![A-Z])' : '';
  const after = /[A-Z]$/.test(spelling) && /^[A-Z_]+$/.test(spelling) ? '(?![A-Z])' : '(?![a-z])';
  return `${before}${escapeRegExp(spelling)}${after}`;
}

const MATCHERS = Object.fromEntries(
  IDS.map((id) => [id, new RegExp(HARNESSES[id].map(spellingPattern).join('|'), 'g')])
);

const REF_KINDS = ['import', 'branch', 'literal', 'key', 'identifier', 'comment'];
const CONCERNS = ['settings_ui', 'auth', 'models', 'usage_pricing', 'i18n', 'tests', 'capability'];

/** @type {Array<[string, RegExp]>} */
const CONCERN_RULES = [
  ['auth', /api[-_]?key|apikey|auth|credential|login|secret|token(?!s?[- ]?usage)/i],
  ['usage_pricing', /usage|pric|cost|credit|ledger|billing|quota|cache[-_]?state/i],
  ['models', /model|catalog/i],
];

function classifyRef(line, id) {
  const trimmed = line.trim();
  if (/^(\*|\/\/|\/\*)/.test(trimmed)) return 'comment';
  if (/^(import|export)\b.*\bfrom\b|\bimport\s*\(|\brequire\s*\(/.test(trimmed)) return 'import';
  const quoted = `['"\`]${id}['"\`]`;
  if (new RegExp(`[=!]==?\\s*${quoted}|${quoted}\\s*[=!]==?|\\bcase\\s+${quoted}`).test(line)) return 'branch';
  if (new RegExp(`(^|[{,\\s])${id}\\s*:`).test(line)) return 'key';
  if (new RegExp(quoted).test(line)) return 'literal';
  return 'identifier';
}

function classifyConcern(file, line) {
  if (file.startsWith('tests/')) return 'tests';
  if (file.startsWith('app_front/i18n/')) return 'i18n';
  for (const [concern, pattern] of CONCERN_RULES) {
    if (pattern.test(line)) return concern;
  }
  for (const [concern, pattern] of CONCERN_RULES) {
    if (pattern.test(path.basename(file))) return concern;
  }
  if (file.startsWith('app_front/') || /settings/.test(file)) return 'settings_ui';
  return 'capability';
}

function ownerOf(file) {
  const dirMatch = /^(?:lib|harnesses)\/([^/]+)\//.exec(file);
  if (dirMatch && IDS.includes(dirMatch[1])) return dirMatch[1];
  const base = path.basename(file);
  for (const id of IDS) {
    MATCHERS[id].lastIndex = 0;
    if (MATCHERS[id].test(base)) return id;
  }
  return null;
}

function listFiles(entry) {
  const absolute = path.join(projectRoot, entry);
  let dirents;
  try {
    dirents = readdirSync(absolute, { withFileTypes: true });
  } catch {
    return EXTENSIONS.has(path.extname(entry)) ? [entry] : [];
  }
  const files = [];
  for (const dirent of dirents) {
    const relative = `${entry}/${dirent.name}`;
    if (dirent.isDirectory()) {
      if (!SKIP_DIRS.has(dirent.name)) files.push(...listFiles(relative));
    } else if (EXTENSIONS.has(path.extname(dirent.name))) {
      files.push(relative);
    }
  }
  return files;
}

function emptyCounts(keys) {
  return Object.fromEntries(keys.map((key) => [key, 0]));
}

function nonZero(counts) {
  return Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0));
}

// Pretty-print the structure but keep each per-file record on one line, so the
// committed JSON stays reviewable and diffs show one changed line per file.
function stringifyInventory(value) {
  const placeholders = [];
  const json = JSON.stringify(
    value,
    (key, item) => {
      if (item && typeof item === 'object' && !Array.isArray(item) && typeof item.file === 'string') {
        placeholders.push(JSON.stringify(item));
        return `__INLINE_${placeholders.length - 1}__`;
      }
      return item;
    },
    2
  );
  return json.replace(/"__INLINE_(\d+)__"/g, (_match, index) => placeholders[Number(index)]);
}

const harnesses = Object.fromEntries(
  IDS.map((id) => [
    id,
    {
      ownedFiles: [],
      ownedLines: 0,
      sharedFiles: [],
      sharedRefs: 0,
      refs: emptyCounts(REF_KINDS),
      concerns: emptyCounts(CONCERNS),
    },
  ])
);
const crossHarness = new Map();
const hotspots = new Map();

const files = ROOTS.flatMap(listFiles).filter((file) => file !== SELF).sort();
const compositionRoots = {};
for (const file of files) {
  const lines = readFileSync(path.join(projectRoot, file), 'utf8').split('\n');
  if (COMPOSITION_ROOTS.includes(file)) {
    compositionRoots[file] = Object.fromEntries(IDS.map((id) => [
      id,
      lines.filter((line) => { MATCHERS[id].lastIndex = 0; return MATCHERS[id].test(line); }).length,
    ]));
    continue;
  }
  const owner = ownerOf(file);
  if (owner) {
    harnesses[owner].ownedFiles.push(file);
    harnesses[owner].ownedLines += lines.length;
  }
  const perHarness = {};
  lines.forEach((line, index) => {
    for (const id of IDS) {
      if (id === owner) continue;
      MATCHERS[id].lastIndex = 0;
      if (!MATCHERS[id].test(line)) continue;
      if (owner) {
        const key = `${owner}->${id}|${file}`;
        crossHarness.set(key, (crossHarness.get(key) || 0) + 1);
        continue;
      }
      const kind = classifyRef(line, id);
      const concern = classifyConcern(file, line);
      const entry = (perHarness[id] ||= { file, refs: emptyCounts(REF_KINDS), concerns: emptyCounts(CONCERNS), branchLines: [] });
      entry.refs[kind] += 1;
      entry.concerns[concern] += 1;
      if (kind === 'branch') entry.branchLines.push(index + 1);
      harnesses[id].refs[kind] += 1;
      harnesses[id].concerns[concern] += 1;
      harnesses[id].sharedRefs += 1;
    }
  });
  for (const [id, entry] of Object.entries(perHarness)) {
    const total = Object.values(entry.refs).reduce((sum, n) => sum + n, 0);
    const compact = { file, total, refs: nonZero(entry.refs), concerns: nonZero(entry.concerns) };
    if (entry.branchLines.length > 0) compact.branchLines = entry.branchLines;
    harnesses[id].sharedFiles.push(compact);
    const hotspot = hotspots.get(file) || { file, total: 0, harnesses: {} };
    hotspot.total += total;
    hotspot.harnesses[id] = total;
    hotspots.set(file, hotspot);
  }
}

for (const id of IDS) {
  harnesses[id].sharedFiles.sort((a, b) => b.total - a.total || a.file.localeCompare(b.file));
}

const crossEdges = [...crossHarness.entries()]
  .map(([key, count]) => {
    const [edge, file] = key.split('|');
    const [from, to] = edge.split('->');
    return { from, to, file, count };
  })
  .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.file.localeCompare(b.file));

const totals = {
  scannedFiles: files.length,
  sharedFiles: hotspots.size,
  sharedRefs: IDS.reduce((sum, id) => sum + harnesses[id].sharedRefs, 0),
  branchRefs: IDS.reduce((sum, id) => sum + harnesses[id].refs.branch, 0),
  ownedFiles: IDS.reduce((sum, id) => sum + harnesses[id].ownedFiles.length, 0),
};

const inventory = {
  generatedBy: 'scripts/harness-coupling-inventory.mjs',
  core: ['claude', 'sdk', 'codex'],
  nonCore: IDS,
  heuristics: {
    roots: ROOTS,
    owned: 'file under lib/<id>/ or whose basename names the id; owned files are not counted as coupling',
    refKinds: {
      import: 'import/export ... from, dynamic import or require',
      branch: "equality or case against the quoted id ('qwen' === x, case 'qwen')",
      key: 'object key named the id (qwen: ...)',
      literal: 'other quoted id (arrays, maps, ids passed as data)',
      identifier: 'identifier or prose containing the id (qwenConfigured, resolveQwenCli)',
      comment: 'line starting with //, /* or *',
    },
    compositionRoots: 'references in COMPOSITION_ROOTS are listed under compositionRoots and excluded from coupling',
    concerns: 'first match wins: tests/ and i18n/ by path; auth, usage_pricing, models by line then file name; settings_ui for app_front and *settings*; else capability',
  },
  totals,
  compositionRoots,
  harnesses,
  crossHarness: crossEdges,
  hotspots: [...hotspots.values()].sort((a, b) => b.total - a.total || a.file.localeCompare(b.file)),
};

writeFileSync(outputPath, `${stringifyInventory(inventory)}\n`);
console.log(`[inventory] ${path.relative(projectRoot, outputPath)}: ${totals.sharedRefs} refs in ${totals.sharedFiles} shared files`);

if (print) {
  const rows = IDS.map((id) => {
    const h = harnesses[id];
    return {
      id,
      owned: h.ownedFiles.length,
      ownedLines: h.ownedLines,
      sharedFiles: h.sharedFiles.length,
      refs: h.sharedRefs,
      branch: h.refs.branch,
      import: h.refs.import,
      ...Object.fromEntries(CONCERNS.map((c) => [c, h.concerns[c]])),
    };
  });
  console.table(rows);
  const edges = {};
  for (const edge of crossEdges) {
    const key = `${edge.from} -> ${edge.to}`;
    edges[key] = (edges[key] || 0) + edge.count;
  }
  console.log('cross-harness (owned file of A names B):', edges);
  console.log('top shared files:');
  for (const hotspot of inventory.hotspots.slice(0, 20)) {
    console.log(`  ${String(hotspot.total).padStart(4)}  ${hotspot.file}`);
  }
}
