import path from 'path';
import { randomUUID } from 'crypto';
import { createWriteStream, existsSync, mkdirSync, openSync, readSync, closeSync, unlinkSync, writeFileSync } from 'fs';
import { loadSharp } from '../load-sharp.js';
import { msg } from '../messages.js';
import { getUploadsSettings } from '../persist/settings.js';
import { getUploadsStats, sweepUploads } from '../uploads-retention.js';

const SCREENSHOT_MAX_BYTES = 5 * 1024 * 1024;
const SCREENSHOT_MAX_DIMENSION_PX = 1568;
const SCREENSHOT_JPEG_QUALITY = 84;

/** Container formats an agent can open with ffmpeg and friends; keyed by request MIME type. */
const VIDEO_EXT_BY_MIME = Object.freeze({
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'video/x-matroska': '.mkv',
  'video/x-m4v': '.m4v',
  'video/3gpp': '.3gp',
});
const UPLOAD_NAME_RE = /^[a-f0-9-]{36}\.(?:jpg|mp4|mov|webm|mkv|m4v|3gp)$/i;

/**
 * Cheap container sniff so a renamed non-video file is refused.
 * @param {string} filePath
 * @param {string} ext
 * @returns {boolean}
 */
function looksLikeVideo(filePath, ext) {
  const head = Buffer.alloc(12);
  let fd;
  try {
    fd = openSync(filePath, 'r');
    readSync(fd, head, 0, 12, 0);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  if (ext === '.webm' || ext === '.mkv') return head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
  return head.toString('ascii', 4, 8) === 'ftyp';
}

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
      const sharp = await loadSharp();
      if (!sharp) {
        return res.status(503).json({ ok: false, error: 'Image processing is unavailable on this platform' });
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
   * Video upload for chat: the raw file is the request body (Content-Type video/*),
   * streamed to data/uploads/ so it never sits in memory. The agent gets the
   * absolute path and inspects the file with its own tools (ffmpeg, frame grabs).
   * Old uploads are removed by the uploads retention sweep.
   */
  app.post('/api/upload-video', (req, res) => {
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const ext = VIDEO_EXT_BY_MIME[mime];
    if (!ext) {
      return res.status(415).json({ ok: false, error: 'Unsupported video format (mp4, mov, webm, mkv, m4v, 3gp)' });
    }
    const uploadsCfg = getUploadsSettings();
    if (!uploadsCfg.videoEnabled) {
      return res.status(403).json({ ok: false, error: 'Video uploads are turned off in Settings' });
    }
    const maxBytes = uploadsCfg.videoMaxMb * 1024 * 1024;
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      return res.status(413).json({ ok: false, error: `Video too large (max ${Math.round(maxBytes / 1024 / 1024)} MB)` });
    }
    if (!existsSync(ctx.uploadsDir)) mkdirSync(ctx.uploadsDir, { recursive: true });
    const filename = randomUUID() + ext;
    const filePath = path.join(ctx.uploadsDir, filename);
    const out = createWriteStream(filePath, { mode: 0o600 });
    let bytes = 0;
    let failed = false;
    const fail = (status, error) => {
      if (failed) return;
      failed = true;
      req.unpipe(out);
      out.destroy();
      try { unlinkSync(filePath); } catch { /* never created */ }
      if (!res.headersSent) res.status(status).json({ ok: false, error });
    };
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) fail(413, `Video too large (max ${Math.round(maxBytes / 1024 / 1024)} MB)`);
    });
    req.on('aborted', () => fail(400, 'Upload aborted'));
    req.on('error', (err) => fail(500, err.message));
    out.on('error', (err) => fail(500, err.message));
    out.on('finish', () => {
      if (failed) return;
      if (bytes < 32 || !looksLikeVideo(filePath, ext)) {
        return fail(400, 'File is not a valid video');
      }
      res.json({ ok: true, path: path.resolve(filePath), filename, bytes, mimeType: mime });
    });
    req.pipe(out);
  });

  /** Settings → Files: how much the uploads folder holds right now. */
  app.get('/api/uploads-stats', (req, res) => {
    res.json({ ok: true, ...getUploadsStats(ctx.uploadsDir) });
  });

  /** Settings → Files: apply the retention window immediately (or wipe everything with `all: true`). */
  app.post('/api/uploads-cleanup', (req, res) => {
    const cfg = getUploadsSettings();
    const all = req.body && req.body.all === true;
    // days: 1e-9 makes every file older than the cutoff, i.e. delete all upload files.
    const days = all ? 1e-9 : (cfg.retentionEnabled ? cfg.retentionDays : 0);
    const result = sweepUploads({ uploadsDir: ctx.uploadsDir, days });
    res.json({ ok: true, ...result, stats: getUploadsStats(ctx.uploadsDir) });
  });

  /**
   * Preview saved upload by filename.
   * Serves only files created by the upload routes (UUID + known extension);
   * sendFile handles Range requests so videos can be seeked.
   */
  app.get('/api/uploads/:filename', (req, res) => {
    const rawFilename = typeof req.params?.filename === 'string' ? req.params.filename.trim() : '';
    if (!rawFilename) {
      return res.status(400).json({ ok: false, error: msg(req, 'upload.missingFileName') });
    }
    if (!UPLOAD_NAME_RE.test(rawFilename)) {
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
    // Uploads are pruned by the retention sweep, so the browser must not pin them for a year.
    res.setHeader('Cache-Control', 'private, max-age=86400');
    return res.sendFile(resolvedTargetPath);
  });
}
