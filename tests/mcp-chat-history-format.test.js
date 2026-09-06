import assert from 'node:assert/strict';
import {
  assembleHistoryPageText,
  formatContinueHints,
  formatHistoryEvent,
  formatHistoryPage,
  formatHistoryPagingLines,
  formatHistoryTail,
  parseEventSliceLength,
  readEventField,
  resolveHistoryCursors,
  sliceEventField,
  unwrapHistoryEntry,
  MCP_EVENT_TEXT_CHARS,
  MCP_HISTORY_PAGE_CHARS,
  MCP_TOOL_PAYLOAD_CHARS,
} from '../lib/mcp/builtin/chat-history-format.js';
import {
  filterChatsForWorkspace,
  listChatsForMcpScope,
  normalizeMcpChatScope,
} from '../lib/mcp/builtin/chat-scope.js';
import { formatMcpToolResult } from '../lib/mcp/mcp-runtime.js';

assert.equal(normalizeMcpChatScope(''), 'workspace');
assert.equal(normalizeMcpChatScope('ALL'), 'all');

const chats = [
  { id: 'aaaaaaaa-1111-2222-3333-444444444444', title: 'Ask', workspaceFolder: '/tmp/w1' },
  { id: 'bbbbbbbb-1111-2222-3333-444444444444', title: 'Delegations', workspaceFolder: '/tmp/w2' },
];
const scoped = filterChatsForWorkspace(chats, '/tmp/w1');
assert.equal(scoped.length, 1);
assert.equal(scoped[0].title, 'Ask');

const listed = listChatsForMcpScope(chats, { workspaceFolder: '/tmp/w1' }, {});
assert.deepEqual(listed.map((row) => row.title), ['Ask']);
const all = listChatsForMcpScope(chats, { workspaceFolder: '/tmp/w1' }, { scope: 'all' });
assert.equal(all.length, 2);

const history = {
  headSeq: 3,
  events: [
    { seq: 1, rec: { kind: 'localUser', text: 'Ask dropdown' } },
    {
      seq: 2,
      rec: {
        kind: 'sdk',
        event: {
          type: 'tool_call',
          name: 'bash',
          status: 'completed',
          call_id: 'c1',
          args: { command: 'ls' },
          result: 'ok',
        },
      },
    },
    {
      seq: 3,
      rec: {
        kind: 'sdk',
        event: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
      },
    },
  ],
};
assert.match(formatHistoryTail(history), /Ask dropdown/);
assert.match(formatHistoryTail(history), /tool calls: 1/);
assert.doesNotMatch(formatHistoryTail(history), /command/);

const compact = formatHistoryPage(history);
assert.equal(compact.oldest_seq, 1);
assert.equal(compact.newest_seq, 3);
assert.equal(compact.events[1].kind, 'tool');
assert.equal(compact.events[1].args, undefined);
assert.match(compact.text, /^1 {2}user/);

const withPayloads = formatHistoryPage(history, { includeToolPayloads: true });
assert.match(withPayloads.text, /args/);
assert.match(withPayloads.text, /ls/);
assert.equal(withPayloads.events[1].args, undefined);

const unwrapped = unwrapHistoryEntry(history.events[1]);
const toolLine = formatHistoryEvent(unwrapped, { includeToolPayloads: true });
assert.match(toolLine.line, /2 {2}tool {2}bash/);

const huge = `x`.repeat(1_000_009);
const hugeHistory = {
  headSeq: 1,
  events: [{ seq: 1, rec: { kind: 'localUser', text: huge } }],
};
const hugePage = formatHistoryPage(hugeHistory, { forward: true });
assert.ok(hugePage.text.length <= MCP_EVENT_TEXT_CHARS + 20);
assert.equal(hugePage.events[0].text, undefined);
assert.equal(hugePage.events[0].text_truncated, true);
assert.match(formatContinueHints('chat-a', hugePage.events), /chat_event\(chat="chat-a"/);
assert.ok(JSON.stringify(hugePage).length < 20_000);

const many = {
  headSeq: 3,
  events: [
    { seq: 1, rec: { kind: 'localUser', text: 'a'.repeat(MCP_EVENT_TEXT_CHARS) } },
    { seq: 2, rec: { kind: 'localUser', text: 'b'.repeat(MCP_EVENT_TEXT_CHARS) } },
    { seq: 3, rec: { kind: 'localUser', text: 'c'.repeat(MCP_EVENT_TEXT_CHARS) } },
  ],
};
const packed = formatHistoryPage(many, { forward: true, maxPageChars: MCP_EVENT_TEXT_CHARS + 40 });
assert.ok(packed.text.length <= MCP_HISTORY_PAGE_CHARS);
assert.equal(packed.truncated, true);
assert.equal(packed.omitted_from_seq, 2);
assert.match(formatHistoryPagingLines({ next_from_seq: packed.omitted_from_seq, truncated: true }), /next_from_seq: 2/);

const longMarker = `START${'x'.repeat(2000)}UNIQUE_TAIL_MARKER`;
const longSlice = sliceEventField(longMarker, 0, 1500);
assert.equal(longSlice.truncated, true);
assert.equal(longSlice.next_offset, 1500);
const rest = sliceEventField(longMarker, longSlice.next_offset, 4000);
assert.equal(`${longSlice.fragment}${rest.fragment}`, longMarker);
assert.match(rest.fragment, /UNIQUE_TAIL_MARKER/);
assert.equal(rest.next_offset, null);

const unicode = 'żółć 😀\nlinia';
assert.equal(
  sliceEventField(unicode, 0, 3).fragment + sliceEventField(unicode, 3, 4000).fragment,
  unicode,
);
assert.equal(sliceEventField(`  ${unicode}  `, 0, 4000).fragment, `  ${unicode}  `);

const systemOnly = formatHistoryPage({
  hasMore: true,
  events: [
    { seq: 10, rec: { kind: 'sdk', event: { type: 'system' } } },
    { seq: 11, rec: { kind: 'sdk', event: { type: 'system' } } },
  ],
}, { forward: true });
assert.equal(systemOnly.events.length, 0);
assert.equal(systemOnly.scanned_newest_seq, 11);
const systemCursors = resolveHistoryCursors(systemOnly, { from_seq: 10 });
assert.equal(systemCursors.next_from_seq, 12);
assert.doesNotMatch(formatHistoryPagingLines(systemCursors), /next: none/);

const skipped = [];
let fromSeq = 1;
for (let i = 0; i < 4; i += 1) {
  const sliceEvents = [
    { seq: fromSeq, rec: { kind: 'sdk', event: { type: 'system' } } },
    { seq: fromSeq + 1, rec: { kind: 'sdk', event: { type: 'system' } } },
  ];
  if (i === 3) sliceEvents[1] = { seq: fromSeq + 1, rec: { kind: 'localUser', text: 'visible-after-skip' } };
  const page = formatHistoryPage({ hasMore: i < 3, events: sliceEvents }, { forward: true });
  const cursors = resolveHistoryCursors(page, { from_seq: fromSeq });
  skipped.push(fromSeq);
  assert.ok(cursors.next_from_seq == null || cursors.next_from_seq > fromSeq);
  if (page.text.includes('visible-after-skip')) break;
  fromSeq = cursors.next_from_seq;
}
assert.match(skipped.join(','), /1/);
assert.ok(fromSeq > 1);

const gapped = formatHistoryPage({
  hasMore: true,
  events: [
    { seq: 1, rec: { kind: 'localUser', text: 'one' } },
    { seq: 5, rec: { kind: 'localUser', text: 'five' } },
  ],
}, { forward: true });
assert.deepEqual(gapped.events.map((row) => row.seq), [1, 5]);
assert.equal(resolveHistoryCursors(gapped, { from_seq: 1 }).next_from_seq, 6);

const ten = {
  hasOlder: false,
  events: Array.from({ length: 10 }, (_, index) => ({
    seq: index + 1,
    rec: { kind: 'localUser', text: `MESSAGE_${index + 1} ${'z'.repeat(900)}` },
  })),
};
const showPage = formatHistoryPage(ten, { compactTools: true, forward: false, maxPageChars: 4000 });
assert.match(showPage.compact_text, /MESSAGE_10/);
assert.equal(showPage.newest_seq, 10);
assert.ok(showPage.oldest_seq >= 1);
assert.match(showPage.text, new RegExp(`${showPage.oldest_seq}  user`));

const mixedSeqs = [1, 2, 4, 7, 8];
const mixedEvents = mixedSeqs.map((seq) => ({ seq, rec: { kind: 'localUser', text: `m${seq}` } }));
const forwardSeen = [];
let walkFrom = 1;
for (let i = 0; i < 6; i += 1) {
  const start = mixedEvents.findIndex((row) => row.seq >= walkFrom);
  const slice = mixedEvents.slice(start, start + 2);
  const page = formatHistoryPage({
    hasMore: start + 2 < mixedEvents.length,
    events: slice,
  }, { forward: true });
  forwardSeen.push(...page.events.map((row) => row.seq));
  const next = resolveHistoryCursors(page, { from_seq: walkFrom }).next_from_seq;
  if (!next) break;
  walkFrom = next;
}
assert.deepEqual(forwardSeen, mixedSeqs);

const backwardSeen = [];
let before = 0;
for (let i = 0; i < 6; i += 1) {
  const pool = before > 0 ? mixedEvents.filter((row) => row.seq < before) : mixedEvents;
  const slice = pool.slice(-2);
  const page = formatHistoryPage({
    hasOlder: pool.length > slice.length,
    events: slice,
  }, { forward: false });
  backwardSeen.unshift(...page.events.map((row) => row.seq));
  const next = resolveHistoryCursors(page, {}).next_before_seq;
  if (!next) break;
  before = next;
}
assert.deepEqual(backwardSeen, mixedSeqs);

const continueText = formatMcpToolResult({
  content: [{ type: 'text', text: 'text_truncated: true\ncontinue: chat_event(chat="c", seq=1, field="text", offset=1500)' }],
  structuredContent: { next_offset: 1500, truncated: true },
});
assert.match(continueText, /continue: chat_event/);
assert.match(continueText, /next_offset: 1500/);

const rec = unwrapHistoryEntry({ seq: 42, rec: { kind: 'localUser', text: 'abc' } }).rec;
assert.equal(readEventField(rec, 'text'), 'abc');
assert.equal(readEventField(rec, 'args'), '');

assert.equal(parseEventSliceLength(undefined).ok, true);
assert.equal(parseEventSliceLength(0.5).ok, false);
assert.equal(parseEventSliceLength(0).ok, false);
assert.equal(parseEventSliceLength(1.5).ok, false);
assert.equal(parseEventSliceLength(20).value, 20);
const stalled = sliceEventField('hello-world', 0, 0.5);
assert.equal(stalled.truncated, false);
assert.equal(stalled.next_offset, null);
assert.equal(stalled.fragment, '');

const titleHeader = [
  '# HTTP history (aaaaaaaa-1111-2222-3333-444444444444)',
  'workspace: /tmp/mcp-history-http-ws',
  'harness: sdk  model: model-a  archived: no',
  'created: 2026-09-06  updated: 2026-09-06',
  'fork_parent: (none)',
].join('\n');
const toolCalls = {
  headSeq: 20,
  hasMore: true,
  events: Array.from({ length: 20 }, (_, index) => ({
    seq: index + 1,
    rec: {
      kind: 'sdk',
      event: {
        type: 'tool_call',
        name: 'bash',
        status: 'completed',
        call_id: `c${index + 1}`,
        args: { blob: 'a'.repeat(2000) },
        result: 'b'.repeat(2000),
      },
    },
  })),
};
const packedTools = formatHistoryPage(toolCalls, {
  includeToolPayloads: true,
  forward: true,
  chatId: 'aaaaaaaa-1111-2222-3333-444444444444',
  titleHeader,
  section: 'history',
  headSeq: 20,
});
assert.ok(packedTools.events.length >= 1);
assert.equal(packedTools.truncated, true);
assert.ok(packedTools.omitted_from_seq > packedTools.events[packedTools.events.length - 1].seq);
const packedToolText = assembleHistoryPageText({
  titleHeader,
  section: 'history',
  headSeq: 20,
  body: packedTools.text,
  events: packedTools.events,
  cursors: resolveHistoryCursors(packedTools, { from_seq: 1 }),
  chatId: 'aaaaaaaa-1111-2222-3333-444444444444',
});
assert.ok(packedToolText.length <= MCP_HISTORY_PAGE_CHARS, packedToolText.length);
assert.match(packedToolText, /continue: chat_event/);
assert.ok(packedTools.events.some((row) => row.args_truncated === true));
assert.ok(MCP_TOOL_PAYLOAD_CHARS > 0);

console.log('mcp-chat-history-format.test.js OK');
