/** Ordered: the first matching rule wins. */
/** @type {[ 'tests'|'mcp'|'opencode'|'claude', RegExp ][]} */
const RULES = [
  ['tests', /\b(node\s+--test|vitest|jest|playwright|run-unit-tests)\b/],
  ['mcp', /\bmcp\b.*\b(stdio|server)\b|\bmcp-server|@modelcontextprotocol/i],
  ['opencode', /\bopencode\b/],
  ['claude', /\bclaude\b/],
];

/**
 * @param {string} args Full command line of a process.
 * @returns {'tests'|'mcp'|'opencode'|'claude'|'other'}
 */
export function classifyChildProcess(args) {
  const text = String(args || '');
  for (const [type, re] of RULES) if (re.test(text)) return type;
  return 'other';
}

/**
 * Count descendants of `rootPid` by type from `ps -eo pid=,ppid=,args=` rows.
 *
 * @param {string} psOutput
 * @param {number} rootPid
 * @returns {{ claude: number, opencode: number, mcp: number, tests: number, other: number, total: number }}
 */
export function countChildProcesses(psOutput, rootPid) {
  /** @type {Map<number, { pid: number, args: string }[]>} */
  const byParent = new Map();
  for (const line of String(psOutput || '').split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const ppid = Number(m[2]);
    if (!byParent.has(ppid)) byParent.set(ppid, []);
    byParent.get(ppid).push({ pid: Number(m[1]), args: m[3] });
  }
  const counts = { claude: 0, opencode: 0, mcp: 0, tests: 0, other: 0, total: 0 };
  const seen = new Set([rootPid]);
  const queue = [rootPid];
  while (queue.length) {
    for (const child of byParent.get(queue.shift()) || []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      counts[classifyChildProcess(child.args)] += 1;
      counts.total += 1;
      queue.push(child.pid);
    }
  }
  return counts;
}
