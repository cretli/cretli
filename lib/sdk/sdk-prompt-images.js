import path from 'node:path';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolveDataPath } from '../runtime-paths.js';

const DEFAULT_UPLOADS_DIR = resolveDataPath('uploads');
const SCREENSHOT_MARKER_RE = /\[Screenshot:\s*([^\]\n]+)\]/gi;
const UPLOAD_FILENAME_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.jpg$/i;
const MAX_SDK_IMAGES = 5;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Converts safe screenshot markers into native Cursor SDK images.
 *
 * @param {string} promptText
 * @param {{ uploadsDir?: string }} [options]
 * @returns {Promise<string | { text: string, images: Array<{ data: string, mimeType: string }> }>}
 */
export async function buildSdkPromptMessage(promptText, options = {}) {
  const text = String(promptText || '').trim();
  const matches = Array.from(text.matchAll(SCREENSHOT_MARKER_RE));
  if (matches.length === 0) return text;

  const uploadsDir = path.resolve(options.uploadsDir || DEFAULT_UPLOADS_DIR);
  const attachedMarkers = new Set();
  const attachedPaths = new Set();
  const images = [];

  for (const match of matches) {
    if (images.length >= MAX_SDK_IMAGES) break;

    const imagePath = String(match[1] || '').trim();
    const image = await readUploadedImage(imagePath, uploadsDir);
    if (!image || attachedPaths.has(image.path)) {
      if (image) attachedMarkers.add(match[0]);
      continue;
    }

    attachedPaths.add(image.path);
    attachedMarkers.add(match[0]);
    images.push({ data: image.data, mimeType: 'image/jpeg' });
  }

  if (images.length === 0) return text;

  const messageText =
    text
      .replace(SCREENSHOT_MARKER_RE, (marker) => (attachedMarkers.has(marker) ? '' : marker))
      .replace(/\n{3,}/g, '\n\n')
      .trim() || 'Analyze the attached image.';

  return { text: messageText, images };
}

/**
 * @param {string} imagePath
 * @param {string} uploadsDir
 * @returns {Promise<{ path: string, data: string } | null>}
 */
async function readUploadedImage(imagePath, uploadsDir) {
  if (!imagePath) return null;

  const candidatePath = path.resolve(imagePath);
  if (path.dirname(candidatePath) !== uploadsDir) return null;
  if (!UPLOAD_FILENAME_RE.test(path.basename(candidatePath))) return null;

  try {
    const [realUploadsDir, realImagePath] = await Promise.all([
      realpath(uploadsDir),
      realpath(candidatePath),
    ]);
    if (path.dirname(realImagePath) !== realUploadsDir) return null;

    const imageStat = await stat(realImagePath);
    if (!imageStat.isFile() || imageStat.size <= 0 || imageStat.size > MAX_IMAGE_BYTES) return null;

    const image = await readFile(realImagePath);
    if (image.length > MAX_IMAGE_BYTES || image[0] !== 0xff || image[1] !== 0xd8) return null;

    return { path: realImagePath, data: image.toString('base64') };
  } catch {
    return null;
  }
}
