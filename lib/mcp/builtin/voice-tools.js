/**
 * Builtin Cretli MCP tool `voice_reply`: the short, spoken version of an answer.
 *
 * In the browser's `agent` read mode the prompt carries a marker asking the agent
 * to call this tool once per turn. The tool only appends a `voiceReply` meta
 * record to the calling chat's history and broadcasts it; the browser that has
 * the chat open reads it aloud. The full answer stays in the chat untouched.
 */

import { appendChatHistoryEvents } from '../../persist/chat-history-service.js';
import { broadcastChatHistoryUpdate } from '../../sdk/sdk-history-updates.ts';
import { toSpeakableText } from '../../voice/speakable-text.js';
import { MCP_VOICE_TOOL_NAMES as N } from '../mcp-tool-names.js';
import { mcpToolResult } from './result.js';
import { CretliMcpToolError, MCP_BUILTIN_ERROR_CODES } from './errors.js';

/** Longest spoken version; longer text is cut at a sentence boundary. */
export const VOICE_REPLY_MAX_CHARS = 500;

/** Same shape the browser generates for a turn id. */
export const VOICE_REPLY_TURN_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Overridable collaborators (tests).
 * @type {{ append: typeof appendChatHistoryEvents, broadcast: typeof broadcastChatHistoryUpdate }}
 */
const defaultDeps = { append: appendChatHistoryEvents, broadcast: broadcastChatHistoryUpdate };
let deps = { ...defaultDeps };

/** @param {Partial<typeof defaultDeps> | null} [overrides] */
export function setVoiceToolsDeps(overrides) {
  deps = { ...defaultDeps, ...(overrides || {}) };
}

/**
 * Cuts text to the limit on the last sentence end that fits, else on a word.
 *
 * @param {string} text
 * @param {number} [max]
 * @returns {string}
 */
export function clipAtSentence(text, max = VOICE_REPLY_MAX_CHARS) {
  if (text.length <= max) return text;
  const window = text.slice(0, max);
  const boundary = /[.!?…]["')\]]*(?=\s|$)/g;
  let end = -1;
  let match = boundary.exec(window);
  while (match) {
    end = match.index + match[0].length;
    match = boundary.exec(window);
  }
  if (end > 0) return window.slice(0, end).trim();
  const space = window.lastIndexOf(' ');
  return (space > 0 ? window.slice(0, space) : window).trim();
}

/**
 * Plain, single-paragraph speech text: markdown, code and URLs removed.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function cleanVoiceReplyText(value) {
  const speakable = toSpeakableText(String(value ?? '')).replace(/\s+/g, ' ').trim();
  return clipAtSentence(speakable);
}

/** @param {Record<string, any>} session */
function requireChatId(session) {
  const chatId = String(session?.chatId || '').trim();
  if (!chatId) {
    throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'voice_reply needs a calling chat (the reply is spoken for that chat).');
  }
  return chatId;
}

export const VOICE_MCP_TOOLS = [
  {
    name: N.voiceReply,
    description:
      'Send the short spoken version of your answer to the user\'s speaker. Call it only when the prompt contains a "[voice-reply mode, turn=<id>: ...]" marker, once per turn, '
      + 'after your normal answer, and pass the turn id from the marker. text: 1-3 plain sentences (max 500 chars): the conclusion and any question or decision; no markdown, code or links. '
      + 'The full answer stays in the chat.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Plain spoken text, 1-3 sentences.' },
        turn: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9_-]{1,64}$', description: 'Turn id from the voice-reply marker in the prompt ([A-Za-z0-9_-], up to 64 chars).' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const chatId = requireChatId(ctx?.session);
      const turnRaw = args?.turn;
      // Absent is fine; a provided value (even an empty string) must be a valid id.
      const turn = turnRaw == null ? '' : String(turnRaw);
      if (turnRaw != null && !VOICE_REPLY_TURN_PATTERN.test(turn)) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'turn must match [A-Za-z0-9_-]{1,64}.');
      }
      const text = cleanVoiceReplyText(args?.text);
      if (!text) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'text is required and must contain speakable prose.');
      }
      const result = await deps.append(chatId, '', [
        { rec: { kind: 'meta', variant: 'voiceReply', payload: JSON.stringify({ text, turn }) } },
      ]);
      if (!result?.ok) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.HARNESS_UNAVAILABLE, 'The voice reply could not be saved to the chat history.');
      }
      deps.broadcast(chatId, result.appended, result.identity);
      return mcpToolResult('Voice reply queued for the speaker.', { ok: true, text, turn });
    },
  },
];
