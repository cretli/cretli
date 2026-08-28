import path from 'path';
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import sharp from 'sharp';
import { msg } from '../messages.js';

const SCREENSHOT_MAX_BYTES = 5 * 1024 * 1024;
const SCREENSHOT_MAX_DIMENSION_PX = 1568;
const SCREENSHOT_JPEG_QUALITY = 84;

/**
 * @param {Buffer} buf
 * @returns {string}
 */
function screenshotExtFromBuffer(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return '.png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return '.jpg';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return '.webp';
  return '.png';
}

/**
 * @typedef {Object} UploadsRoutesContext
 * @property {string} uploadsDir
 */

/**
 * @param {import('express').Express} app
 * @param {UploadsRoutesContext} ctx
 */
export function registerUploadsRoutes(app, ctx) {
  /** Upload screenshot for chat: JSON body { base64 }, saved under data/uploads/, returns absolute path. */
  app.post('/api/upload-screenshot', async (req, res) => {
    try {
      const rawBase64 = req.body && typeof req.body.base64 === 'string' ? req.body.base64.trim() : null;
      const base64 = rawBase64 && rawBase64.includes(',') ? rawBase64.slice(rawBase64.indexOf(',') + 1) : rawBase64;
      if (!base64) {
        return res.status(400).json({ ok: false, error: msg(req, 'upload.missingBase64') });
      }
      let buf;
      try {
        buf = Buffer.from(base64, 'base64');
      } catch {
        return res.status(400).json({ ok: false, error: 'Invalid base64' });
      }
      if (buf.length > SCREENSHOT_MAX_BYTES) {
        return res.status(413).json({ ok: false, error: 'Image too large (max 5 MB)' });
      }
      if (buf.length < 4) {
        return res.status(400).json({ ok: false, error: 'File too small' });
      }
      const ext = screenshotExtFromBuffer(buf);
      if (!['.png', '.jpg', '.webp'].includes(ext)) {
        return res.status(400).json({ ok: false, error: 'Unsupported image format' });
      }
      let processed;
      let info;
      try {
        const result = await sharp(buf, { failOnError: true, limitInputPixels: 40_000_000 })
          .rotate()
          .resize({
            width: SCREENSHOT_MAX_DIMENSION_PX,
            height: SCREENSHOT_MAX_DIMENSION_PX,
            fit: 'inside',
            withoutEnlargement: true,
          })
          .jpeg({ quality: SCREENSHOT_JPEG_QUALITY, mozjpeg: true })
          .toBuffer({ resolveWithObject: true });
        processed = result.data;
        info = result.info;
      } catch {
        return res.status(400).json({ ok: false, error: 'Failed to process image' });
      }
      if (!existsSync(ctx.uploadsDir)) mkdirSync(ctx.uploadsDir, { recursive: true });
      const filename = randomUUID() + '.jpg';
      const filePath = path.join(ctx.uploadsDir, filename);
      writeFileSync(filePath, processed);
      const absolutePath = path.resolve(filePath);
      res.json({
        ok: true,
        path: absolutePath,
        filename,
        width: info?.width || null,
        height: info?.height || null,
        bytes: processed.length,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * Preview saved screenshot by filename.
   * Serves only files created by /api/upload-screenshot (UUID + .jpg).
   */
  app.get('/api/uploads/:filename', (req, res) => {
    const rawFilename = typeof req.params?.filename === 'string' ? req.params.filename.trim() : '';
    if (!rawFilename) {
      return res.status(400).json({ ok: false, error: msg(req, 'upload.missingFileName') });
    }
    if (!/^[a-f0-9-]{36}\.jpg$/i.test(rawFilename)) {
      return res.status(400).json({ ok: false, error: msg(req, 'upload.invalidFileName') });
    }
    const targetPath = path.join(ctx.uploadsDir, rawFilename);
    const resolvedUploadsDir = path.resolve(ctx.uploadsDir);
    const resolvedTargetPath = path.resolve(targetPath);
    if (!resolvedTargetPath.startsWith(resolvedUploadsDir + path.sep)) {
      return res.status(400).json({ ok: false, error: msg(req, 'upload.invalidFilePath') });
    }
    if (!existsSync(resolvedTargetPath)) {
      return res.status(404).json({ ok: false, error: msg(req, 'files.fileNotFound') });
    }
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return res.sendFile(resolvedTargetPath);
  });
}
