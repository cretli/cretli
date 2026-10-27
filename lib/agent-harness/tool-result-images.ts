/**
 * Replaces base64 image blocks inside tool results with durable chat-media
 * markers so history/WS payloads never carry inline image bytes.
 */

import { saveChatMediaSync } from '../chat-media.js';

export const MAX_TOOL_IMAGE_BYTES = 5 * 1024 * 1024;

export type ToolImageSaver = (buffer: Buffer, ext: 'png' | 'jpg' | 'webp' | 'gif') => { url: string } | null;

type ImageKind = { ext: 'png' | 'jpg' | 'webp' | 'gif', mime: string };

/** Detects PNG/JPEG/WebP/GIF by magic bytes. SVG never matches. */
function sniffImage(buf: Buffer): ImageKind | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: 'png', mime: 'image/png' };
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.toString('latin1', 0, 6))) return { ext: 'gif', mime: 'image/gif' };
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Reads base64 data from an Anthropic (`source.data`) or MCP (`data`) image block. */
function readImageData(block: Record<string, unknown>): string | null {
  const source = asRecord(block.source);
  if (source && typeof source.data === 'string') return source.data;
  return typeof block.data === 'string' ? block.data : null;
}

function externalizeBlock(block: Record<string, unknown>, save: ToolImageSaver): Record<string, unknown> {
  const omitted = { type: 'text', text: '[image omitted]' };
  try {
    const data = readImageData(block);
    if (!data) return omitted;
    if (Math.floor(data.length * 3 / 4) > MAX_TOOL_IMAGE_BYTES + 3) return omitted;
    const buf = Buffer.from(data, 'base64');
    if (buf.length === 0 || buf.length > MAX_TOOL_IMAGE_BYTES) return omitted;
    const kind = sniffImage(buf);
    if (!kind) return omitted;
    const saved = save(buf, kind.ext);
    if (!saved || typeof saved.url !== 'string' || !saved.url) return omitted;
    return { type: 'text', text: `[image: ${saved.url} ${kind.mime} ${buf.length}B]` };
  } catch {
    return omitted;
  }
}

function mapContent(content: unknown, save: ToolImageSaver): unknown {
  if (!Array.isArray(content)) return content;
  return content.map((block) => {
    const rec = asRecord(block);
    return rec && rec.type === 'image' ? externalizeBlock(rec, save) : block;
  });
}

/**
 * Pure: returns a clone of `message` where image blocks of Claude
 * `tool_result` content and Codex `mcp_tool_call` results are replaced by
 * `[image: <mediaUrl> <mime> <bytes>B]` (or `[image omitted]`). The input is
 * never mutated; non-image data is shared structurally.
 */
export function externalizeToolResultImages<T>(message: T, save: ToolImageSaver): T {
  const visit = (value: unknown, depth: number): unknown => {
    if (depth > 8 || !value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((v) => visit(v, depth + 1));
    const rec = value as Record<string, unknown>;
    if (rec.type === 'tool_result' && Array.isArray(rec.content)) {
      return { ...rec, content: mapContent(rec.content, save) };
    }
    if (rec.type === 'mcp_tool_call') {
      const result = asRecord(rec.result);
      if (result && Array.isArray(result.content)) {
        return { ...rec, result: { ...result, content: mapContent(result.content, save) } };
      }
      return rec;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rec)) out[k] = visit(v, depth + 1);
    return out;
  };
  return visit(message, 0) as T;
}

/** Saver bound to a chat; returns null when the store is off or the chat is ineligible. */
export function chatMediaSaver(chatId: unknown): ToolImageSaver {
  return (buffer, ext) => (typeof chatId === 'string' && chatId ? saveChatMediaSync(chatId, buffer, { ext }) : null);
}
