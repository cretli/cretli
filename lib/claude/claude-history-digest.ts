import { buildTruncationMarker, estimateContextTokens } from '../context/context-budget.ts';

const MAX_TOKENS = 8000;
const MAX_TURNS = 10;

type Parsed = { text: string, role: 'user' | 'assistant' | 'tool', tool?: string, toolId?: string, running?: boolean };

function recordText(rec: any): Parsed | null {
  if (rec?.kind === 'localUser') return { text: `User: ${String(rec.text || '').trim()}`, role: 'user' };
  if (rec?.kind !== 'sdk') return null;
  const event = rec.event || {};
  const type = String(event.type || '');
  if (type === 'assistant' || type === 'user') {
    const content = typeof event.message?.content === 'string'
      ? [{ type: 'text', text: event.message.content }]
      : Array.isArray(event.message?.content) ? event.message.content : [];
    const parts = content.map((item: any) => {
      if (item?.type === 'text') return String(item.text || '').trim();
      if (item?.type === 'tool_use') return `Tool call: ${String(item.name || 'tool')}`;
      if (item?.type === 'tool_result') return 'Tool result: (payload omitted)';
      return null;
    }).filter(Boolean);
    return parts.length ? { text: `${type === 'assistant' ? 'Assistant' : 'User'}: ${parts.join(' ')}`, role: type as 'user' | 'assistant' } : null;
  }
  if (type === 'tool_use' || type === 'tool_call') {
    const tool = String(event.name || event.toolName || 'tool');
    const toolId = String(event.id || event.toolCallId || event.callId || event.tool_use_id || '');
    const status = String(event.status || event.state || '').toLowerCase();
    return { text: `Tool call: ${tool}`, role: 'tool', tool, toolId, running: ['running', 'started', 'in_progress', 'pending'].includes(status) };
  }
  // Tool results carry no durable context; they are dropped so they never crowd out user/assistant text.
  if (type === 'tool_result') return null;
  return null;
}

export function buildClaudeHistoryDigest(events: any[], planSummary = '', currentMessageId = ''): { text: string, turns: number, rows: number } | null {
  const rows: string[] = [];
  let previousUserText = '';
  // Pending run of consecutive tool calls, flushed into one collapsed line.
  let toolRun: string[] = [];
  const seenToolIds = new Set<string>();
  const flushTools = () => {
    if (!toolRun.length) return;
    const counts = new Map<string, number>();
    for (const name of toolRun) counts.set(name, (counts.get(name) || 0) + 1);
    const names = [...counts.entries()].map(([name, n]) => (n > 1 ? `${name} x${n}` : name));
    rows.push(`Tool calls: ${names.slice(0, 8).join(', ')}${names.length > 8 ? `, +${names.length - 8} more` : ''}`);
    toolRun = [];
  };
  for (const row of Array.isArray(events) ? events : []) {
    const rec = row?.rec || row;
    const id = rec?.contextMessageId || rec?.event?.contextMessageId;
    if (currentMessageId && id === currentMessageId) break;
    const parsed = recordText(rec);
    if (!parsed?.text) continue;
    if (parsed.role === 'tool') {
      // running + completed records describe one call: count by id, or skip the running twin when no id exists.
      if (parsed.toolId) {
        if (seenToolIds.has(parsed.toolId)) continue;
        seenToolIds.add(parsed.toolId);
      } else if (parsed.running) continue;
      toolRun.push(parsed.tool || 'tool');
      continue;
    }
    flushTools();
    if (parsed.role === 'user') {
      const key = parsed.text.slice(5).trim();
      if (previousUserText === key) continue;
      previousUserText = key;
    } else {
      previousUserText = '';
    }
    rows.push(parsed.text);
  }
  flushTools();
  // Select by the last N user turns (never by raw row count) so tool-heavy turns cannot evict user text.
  let recent = rows;
  const userIndexes = rows.map((line, index) => line.startsWith('User:') ? index : -1).filter((index) => index >= 0);
  if (userIndexes.length > MAX_TURNS) recent = rows.slice(userIndexes[userIndexes.length - MAX_TURNS]);
  const plan = String(planSummary || '').trim();
  const planHeading = plan ? (plan.match(/^#{1,6} .+$/m)?.[0] || plan.split('\n')[0]) : '';
  const planBody = plan ? plan.slice(plan.indexOf(planHeading) + planHeading.length).trim() : '';
  let heading = plan ? `Plan summary:\n${planHeading}${planBody ? `\n${planBody}` : ''}` : '';
  let kept = recent;
  const maxChars = MAX_TOKENS * 4;
  const headingBudget = Math.max(1, maxChars - 'Plan summary:\n'.length - 96);
  const boundedHeading = planHeading.length > headingBudget
    ? `${planHeading.slice(0, headingBudget - 1)}…`
    : planHeading;
  const summaryPrefix = plan ? `Plan summary:\n${boundedHeading}` : '';
  if (heading.length > maxChars) {
    heading = `${summaryPrefix}\n${planBody.slice(0, Math.max(0, maxChars - summaryPrefix.length - 64))}`;
  }
  const fixedLength = heading ? heading.length + 2 : 0;
  let keptStart = recent.length;
  let candidateLength = 0;
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const nextLength = candidateLength + recent[i].length + (candidateLength ? 1 : 0);
    if (Math.ceil((fixedLength + nextLength) / 4) > MAX_TOKENS) break;
    candidateLength = nextLength;
    keptStart = i;
  }
  kept = recent.slice(keptStart);
  if (!kept.length && !heading && rows.length === 0) return null;
  const omitted = rows.length - kept.length;
  const marker = omitted > 0 ? buildTruncationMarker({ kept: kept.length, total: rows.length, unit: 'history entries', side: 'tail' }) : '';
  let text = [heading, marker, kept.join('\n')].filter(Boolean).join('\n\n');
  if (estimateContextTokens(text) > MAX_TOKENS) {
    const prefix = [summaryPrefix, marker].filter(Boolean).join('\n\n');
    const charMarker = buildTruncationMarker({ kept: 0, total: kept.join('\n').length, unit: 'characters', side: 'tail' });
    const allowance = Math.max(6, maxChars - prefix.length - charMarker.length - 64);
    const source = kept.join('\n');
    const tail = source.startsWith('User:') && allowance > 6
      ? `User: ${source.slice(-(allowance - 6))}`
      : source.slice(-allowance);
    text = [prefix, buildTruncationMarker({ kept: tail.length, total: source.length, unit: 'characters', side: 'tail' }), tail].filter(Boolean).join('\n\n');
  }
  return estimateContextTokens(text) <= MAX_TOKENS ? { text, turns: kept.filter((line) => line.startsWith('User:')).length, rows: kept.filter((line) => /^(User|Assistant):/.test(line)).length } : null;
}
