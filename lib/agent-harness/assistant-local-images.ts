/**
 * Turns local image paths mentioned in an assistant turn into durable chat media.
 *
 * The browser cannot load `/home/...` paths and a generic "read this path" route
 * would expose the disk, so the server copies the mentioned images once at the
 * end of the run and emits a `local_images` SDK event the chat renders as
 * thumbnails. Best effort: a failure here never affects the run.
 */

import fs from 'node:fs';
import path from 'node:path';
import { saveChatMediaSync } from '../chat-media.js';
import { sniffImage } from './tool-result-images.ts';

/** Larger than tool images: generated sheets are big and these bytes never enter a WS payload. */
export const MAX_LOCAL_IMAGE_BYTES = 20 * 1024 * 1024;
/** Per run, so one long answer cannot evict the chat's whole media history. */
export const MAX_LOCAL_IMAGES_PER_RUN = 6;
const MAX_TRACKED_TEXT_CHARS = 200_000;

const PATH_RE = /(?:^|[\s`'"([<*:=])((?:\/(?!\/)|\.{1,2}\/|[\w.-]+\/)[^\s`'"<>()[\]*]*\.(?:png|jpe?g|webp|gif))(?=$|[\s`'"<>)\],.;:!?*])/gim;

/** Pure: unique path candidates in order of last mention, newest first. */
export function extractImagePathCandidates(text: string): string[] {
  const found: string[] = [];
  for (const match of String(text || '').matchAll(PATH_RE)) {
    const value = match[1];
    const at = found.indexOf(value);
    if (at !== -1) found.splice(at, 1);
    found.push(value);
  }
  return found.reverse();
}

function isHiddenPath(target: string): boolean {
  return target.split(path.sep).some((part) => part.startsWith('.') && part !== '.' && part !== '..');
}

/**
 * Resolves a mentioned path to a real, non-hidden file. Relative paths must stay
 * inside the chat cwd; absolute ones are allowed because agents often work in
 * sibling folders, and only verified image bytes ever leave this module.
 */
function resolveImageFile(candidate: string, cwd: string): string | null {
  const absolute = path.isAbsolute(candidate);
  if (!absolute && !cwd) return null;
  let real: string;
  try {
    real = fs.realpathSync(absolute ? candidate : path.resolve(cwd, candidate));
    if (!absolute && !real.startsWith(fs.realpathSync(cwd) + path.sep)) return null;
    if (isHiddenPath(real)) return null;
    const st = fs.statSync(real);
    if (!st.isFile() || st.size === 0 || st.size > MAX_LOCAL_IMAGE_BYTES) return null;
  } catch {
    return null;
  }
  return real;
}

function readAssistantText(event: Record<string, any>): string {
  const content = event?.message?.content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => (block?.type === 'text' && typeof block.text === 'string' ? block.text : '')).join('');
}

export interface LocalImageCollector {
  note: (event: unknown) => void;
  drain: (input: { chatId: unknown, cwd: unknown }) => Record<string, unknown> | null;
}

export function createLocalImageCollector(): LocalImageCollector {
  const items: string[] = [];
  /** path + mtime + size → url, so repeating a path does not burn media slots. */
  const copied = new Map<string, string>();
  let itemOpen = false;

  return {
    note(event) {
      const rec = event && typeof event === 'object' ? event as Record<string, any> : null;
      if (!rec) return;
      if (String(rec.type || '').toLowerCase() !== 'assistant') {
        itemOpen = false;
        return;
      }
      const text = readAssistantText(rec);
      if (!text) return;
      const last = itemOpen ? items[items.length - 1] : undefined;
      const merged = last === undefined
        ? text
        : rec.streamTextMode === 'delta' ? last + text : text;
      if (merged.length > MAX_TRACKED_TEXT_CHARS) return;
      if (last === undefined) items.push(merged);
      else items[items.length - 1] = merged;
      itemOpen = true;
    },

    drain({ chatId, cwd }) {
      const text = items.join('\n');
      items.length = 0;
      itemOpen = false;
      if (typeof chatId !== 'string' || !chatId || !text) return null;
      const dir = typeof cwd === 'string' ? cwd : '';
      const images: Array<{ href: string, source: string }> = [];
      for (const candidate of extractImagePathCandidates(text)) {
        if (images.length >= MAX_LOCAL_IMAGES_PER_RUN) break;
        const file = resolveImageFile(candidate, dir);
        if (!file) continue;
        try {
          const st = fs.statSync(file);
          const key = `${file}:${st.mtimeMs}:${st.size}`;
          let href = copied.get(key);
          if (!href) {
            const buffer = fs.readFileSync(file);
            const kind = sniffImage(buffer);
            const saved = kind ? saveChatMediaSync(chatId, buffer, { ext: kind.ext }) : null;
            if (!saved) continue;
            href = saved.url;
            copied.set(key, href);
          }
          if (!images.some((image) => image.href === href)) images.push({ href, source: candidate });
        } catch {
          // Unreadable or vanished file: the other images still get through.
        }
      }
      return images.length > 0 ? { type: 'local_images', images } : null;
    },
  };
}

/**
 * Tracks one outgoing WS payload for a room. Returns the event to broadcast
 * immediately before a `sdkRunFinished` frame. Never throws.
 */
export function noteRoomPayloadForLocalImages(
  room: { chatId?: unknown, cwd?: unknown, _localImages?: LocalImageCollector } | null | undefined,
  payload: Record<string, any> | null | undefined,
): Record<string, unknown> | null {
  try {
    if (!room || !payload) return null;
    if (payload.type === 'sdkEvent') {
      if (!room._localImages) room._localImages = createLocalImageCollector();
      room._localImages.note(payload.event);
      return null;
    }
    if (payload.type !== 'sdkRunFinished' || !room._localImages) return null;
    return room._localImages.drain({ chatId: room.chatId, cwd: room.cwd });
  } catch {
    return null;
  }
}
