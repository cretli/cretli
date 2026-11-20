/**
 * Source scanner behind tests/delegation-controller-guard.test.js.
 *
 * It lexes JS just enough to (1) blank comments and string/template/regex
 * literals, (2) track brace nesting with real function/class boundaries and
 * (3) attribute every `parentChatId`-style hit and every accessor call to the
 * innermost *named* enclosing function. Anonymous callbacks inherit the
 * enclosing named function; nested named functions get a dotted qualified name
 * (`outer.inner`) and repeated qualified names in one file get `#2`, `#3`, …
 * in source order, so allowlist keys are unambiguous.
 */

export const HIT_PATTERNS = [
  /\bparentChatId\b/,
  /\bdelegationParentChatId\b/,
  /parent_chat_id/,
];

export const OLD_HELPER_NAMES = [
  'listDelegationsForParent',
  'listActiveDelegationsForParent',
  'findActiveDelegationForParent',
  'drainQueueForParent',
  'listQueuedForParentSorted',
  'queuedDepthForParent',
  'isQueuedHeadForParent',
];

const BLOCK_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'else', 'try', 'finally', 'do']);
const REGEX_PRECEDERS = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new']);

/**
 * @param {string} src
 * @returns {{ code: string, bare: string }} `code` blanks comments only,
 *   `bare` blanks comments, strings, template text and regex literals. Both
 *   keep the original length and every newline.
 */
export function stripSource(src) {
  const n = src.length;
  const code = new Array(n);
  const bare = new Array(n);
  const blank = (ch) => (ch === '\n' ? '\n' : ' ');
  const templateStack = [];
  let state = 'normal';
  let depth = 0;
  let quote = '';
  let lastSig = '';
  let lastWord = '';
  const put = (i, c, b) => {
    code[i] = c;
    bare[i] = b;
  };
  for (let i = 0; i < n; i += 1) {
    const ch = src[i];
    const next = src[i + 1];
    if (state === 'line') {
      if (ch === '\n') {
        state = 'normal';
        put(i, ch, ch);
      } else put(i, ' ', ' ');
      continue;
    }
    if (state === 'block') {
      if (ch === '*' && next === '/') {
        put(i, ' ', ' ');
        put(i + 1, ' ', ' ');
        i += 1;
        state = 'normal';
      } else put(i, blank(ch), blank(ch));
      continue;
    }
    if (state === 'string') {
      if (ch === '\\') {
        put(i, ch, ' ');
        if (i + 1 < n) put(i + 1, src[i + 1], blank(src[i + 1]));
        i += 1;
      } else if (ch === quote || ch === '\n') {
        put(i, ch, ch === '\n' ? '\n' : ch);
        state = 'normal';
      } else put(i, ch, ' ');
      continue;
    }
    if (state === 'regex') {
      if (ch === '\\') {
        put(i, ch, ' ');
        if (i + 1 < n) put(i + 1, src[i + 1], ' ');
        i += 1;
      } else if (ch === '[') {
        quote = 'class';
        put(i, ch, ' ');
      } else if (ch === ']' && quote === 'class') {
        quote = '';
        put(i, ch, ' ');
      } else if (ch === '/' && quote !== 'class') {
        put(i, ch, ch);
        state = 'normal';
        lastSig = ')';
        lastWord = '';
      } else put(i, ch, ch === '\n' ? '\n' : ' ');
      continue;
    }
    if (state === 'template') {
      if (ch === '\\') {
        put(i, ch, ' ');
        if (i + 1 < n) put(i + 1, src[i + 1], blank(src[i + 1]));
        i += 1;
      } else if (ch === '`') {
        put(i, ch, ch);
        state = 'normal';
        lastSig = ')';
        lastWord = '';
      } else if (ch === '$' && next === '{') {
        put(i, ch, ch);
        put(i + 1, '{', '{');
        i += 1;
        templateStack.push(depth);
        depth = 0;
        state = 'normal';
        lastSig = '{';
        lastWord = '';
      } else put(i, ch, blank(ch));
      continue;
    }
    // normal
    if (ch === '/' && next === '/') {
      state = 'line';
      put(i, ' ', ' ');
      continue;
    }
    if (ch === '/' && next === '*') {
      state = 'block';
      put(i, ' ', ' ');
      put(i + 1, ' ', ' ');
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      state = 'string';
      quote = ch;
      put(i, ch, ch);
      continue;
    }
    if (ch === '`') {
      state = 'template';
      put(i, ch, ch);
      continue;
    }
    if (ch === '/') {
      if (REGEX_PRECEDERS.has(lastSig) || REGEX_KEYWORDS.has(lastWord)) {
        state = 'regex';
        quote = '';
        put(i, ch, ch);
        continue;
      }
      put(i, ch, ch);
      lastSig = ch;
      lastWord = '';
      continue;
    }
    put(i, ch, ch);
    if (ch === '{') depth += 1;
    if (ch === '}') {
      if (depth === 0 && templateStack.length) {
        depth = templateStack.pop();
        state = 'template';
        continue;
      }
      depth -= 1;
    }
    if (/\s/.test(ch)) continue;
    if (/[A-Za-z0-9_$]/.test(ch)) {
      let j = i;
      while (j + 1 < n && /[A-Za-z0-9_$]/.test(src[j + 1])) j += 1;
      lastWord = src.slice(i, j + 1);
      for (let k = i + 1; k <= j; k += 1) put(k, src[k], src[k]);
      i = j;
      lastSig = 'w';
      continue;
    }
    lastSig = ch;
    lastWord = '';
  }
  return { code: code.join(''), bare: bare.join('') };
}

function matchOpenParen(text, closeIdx) {
  let depth = 0;
  for (let i = closeIdx; i >= 0; i -= 1) {
    if (text[i] === ')') depth += 1;
    else if (text[i] === '(') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function nameBeforeAssignment(before) {
  const trimmed = before.replace(/\basync\s*$/, '').trimEnd();
  if (/(?:[^=!<>]=|:)$/.test(trimmed) && !/=>$/.test(trimmed)) {
    const m = /([A-Za-z0-9_$]+)\s*(?:=|:)$/.exec(trimmed);
    if (m && !BLOCK_KEYWORDS.has(m[1])) return m[1];
  }
  return '';
}

/**
 * Drop a trailing TypeScript return-type annotation (`): Type`, `): { a: b }`,
 * `): Promise<X>`) so the head still ends with the parameter list's `)`.
 * Only a balanced annotation without `;` or a bare `=` is removed.
 *
 * @param {string} prev
 * @returns {string}
 */
function stripReturnTypeAnnotation(prev) {
  for (let i = prev.length - 1, seen = 0; i >= 0 && seen < 400; i -= 1, seen += 1) {
    if (prev[i] !== ')') continue;
    const rest = prev.slice(i + 1);
    if (!/^\s*:\s*\S/.test(rest) || /;|[^=!<>]=(?!>)/.test(rest)) continue;
    let depth = 0;
    let balanced = true;
    for (const ch of rest) {
      if ('({[<'.includes(ch)) depth += 1;
      else if (')}]>'.includes(ch)) depth -= 1;
      if (depth < 0) { balanced = false; break; }
    }
    if (balanced && depth === 0) return prev.slice(0, i + 1);
  }
  return prev;
}

/**
 * Classify the `{` at `idx` of `bare`.
 *
 * @returns {{ kind: 'fn' | 'class' | 'block', name: string }} `name` is ''
 *   for an anonymous function or a plain block.
 */
function classifyBrace(bare, idx) {
  const raw = bare.slice(0, idx).trimEnd();
  const prev = raw.endsWith('=>')
    ? `${stripReturnTypeAnnotation(raw.slice(0, -2).trimEnd())} =>`
    : stripReturnTypeAnnotation(raw);
  if (prev.endsWith('=>')) {
    let headStart = -1;
    let before = prev.slice(0, -2).trimEnd();
    if (before.endsWith(')')) {
      const open = matchOpenParen(before, before.length - 1);
      headStart = open;
      before = open >= 0 ? before.slice(0, open) : before;
    } else {
      before = before.replace(/[A-Za-z0-9_$]+$/, '');
    }
    return { kind: 'fn', name: nameBeforeAssignment(before.trimEnd()), headStart };
  }
  const cls = /\bclass\s+([A-Za-z0-9_$]+)(?:\s+extends\s+[A-Za-z0-9_$.()]+)?$/.exec(prev);
  if (cls) return { kind: 'class', name: cls[1] };
  if (prev.endsWith(')')) {
    const open = matchOpenParen(prev, prev.length - 1);
    if (open < 0) return { kind: 'block', name: '' };
    const head = prev.slice(0, open).trimEnd();
    const headStart = open;
    const named = /\bfunction\s*\*?\s*([A-Za-z0-9_$]+)$/.exec(head);
    if (named) return { kind: 'fn', name: named[1], headStart };
    if (/\bfunction\s*\*?$/.test(head)) return { kind: 'fn', name: '', headStart };
    const id = /([A-Za-z0-9_$]+)$/.exec(head);
    if (id && !BLOCK_KEYWORDS.has(id[1])) return { kind: 'fn', name: id[1], headStart };
    return { kind: 'block', name: '' };
  }
  return { kind: 'block', name: '' };
}

/**
 * Scan one source text.
 *
 * @param {string} rel Repo-relative file path (used in keys).
 * @param {string} src
 * @returns {{ functions: Map<string, { file: string, fn: string, hits: string[], accessorCalls: string[] }>, oldNames: string[] }}
 */
export function scanSource(rel, src) {
  const { code, bare } = stripSource(src);
  const lineStarts = [0];
  for (let i = 0; i < src.length; i += 1) if (src[i] === '\n') lineStarts.push(i + 1);
  const lineOf = (pos) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  // Frame ranges: [start, end) over the source, with the named-ancestor chain.
  const frames = [];
  const open = [];
  const seen = new Map();
  for (let i = 0; i < bare.length; i += 1) {
    const ch = bare[i];
    if (ch === '{') {
      const info = classifyBrace(bare, i);
      if (!info.name && info.kind === 'fn') {
        // Express callbacks: key them by `METHOD /path`.
        const upto = code.slice(Math.max(0, (info.headStart >= 0 ? info.headStart : i) - 300), info.headStart >= 0 ? info.headStart : i);
        const route = /\.(get|post|put|patch|delete|use)\(\s*(['"`])([^'"`]+)\2\s*,(?:[^;]*?,)?\s*(?:async\s+)?(?:function\s*)?$/.exec(upto);
        if (route) info.name = `route[${route[1].toUpperCase()} ${route[3].replace(/:/g, '$')}]`;
      }
      if (info.name === 'handler') {
        // MCP tool objects: key the shared `handler` method by the tool name.
        const tools = [...code.slice(Math.max(0, i - 6000), i).matchAll(/\bname:\s*['"]([\w-]+)['"]/g)];
        if (tools.length) info.name = `handler[${tools[tools.length - 1][1]}]`;
      }
      const parentNamed = [...open].reverse().find((f) => f.qualified);
      let qualified = '';
      if (info.name) {
        const base = parentNamed ? `${parentNamed.qualified}.${info.name}` : info.name;
        const count = (seen.get(base) || 0) + 1;
        seen.set(base, count);
        qualified = count === 1 ? base : `${base}#${count}`;
      }
      const frame = { start: info.headStart >= 0 && info.headStart != null ? info.headStart : i, end: bare.length, qualified, kind: info.kind };
      open.push(frame);
      frames.push(frame);
    } else if (ch === '}') {
      const frame = open.pop();
      if (frame) frame.end = i;
    }
  }
  const named = frames.filter((f) => f.qualified);
  const owner = (pos) => {
    let best = null;
    for (const f of named) {
      if (f.start <= pos && pos < f.end && (!best || f.start > best.start)) best = f;
    }
    return best ? best.qualified : '<module>';
  };
  const functions = new Map();
  const entryFor = (fn) => {
    const key = `${rel}:${fn}`;
    if (!functions.has(key)) functions.set(key, { file: rel, fn, hits: [], accessorCalls: [] });
    return functions.get(key);
  };
  const srcLines = src.split('\n');
  const hitLines = new Map();
  for (const pattern of HIT_PATTERNS) {
    const re = new RegExp(pattern.source, 'g');
    let hit;
    while ((hit = re.exec(code))) {
      const line = lineOf(hit.index);
      const fn = owner(hit.index);
      const mark = `${fn}@${line}`;
      if (hitLines.has(mark)) continue;
      hitLines.set(mark, true);
      entryFor(fn).hits.push(`${line + 1}: ${srcLines[line].trim()}`);
    }
  }
  const callRe = /\b(delegationController|canChatControlDelegation|resolveDelegationScopeChat)\s*\(/g;
  let m;
  while ((m = callRe.exec(bare))) {
    const fn = owner(m.index);
    const entry = functions.get(`${rel}:${fn}`);
    // Only functions that touch the legacy field are part of the inventory.
    if (entry) entry.accessorCalls.push(`${lineOf(m.index) + 1}: ${m[1]}`);
  }
  const oldNames = [];
  const bareLines = bare.split('\n');
  bareLines.forEach((line, index) => {
    for (const old of OLD_HELPER_NAMES) {
      if (line.includes(old)) oldNames.push(`${rel}:${index + 1} ${old}`);
    }
  });
  return { functions, oldNames };
}
