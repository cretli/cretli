/**
 * Static serving for /dist/app: content negotiation (brotli, gzip) with an
 * in-memory cache of compressed bodies, plus Cache-Control by file kind.
 * Uses node:zlib only. Compressed bodies are produced once per file version
 * (path + mtime + size), so the one-time brotli cost is not paid per request.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';

const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

/** Webpack chunk files carry an 8+ hex content hash: `name.0123abcd.chunk.js`. */
const HASHED_FILE_RE = /(?:\.[0-9a-f]{8,}\.(?:chunk\.)?(?:js|css)|(?:^|\/)[0-9a-f]{16,}\.(?:woff2?|ttf|eot|svg|png))$/;
const COMPRESSIBLE_RE = /\.(?:js|css|svg|json|map|html|txt)$/i;
const MIN_COMPRESS_BYTES = 1024;
const MIME = {
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Best supported coding from an Accept-Encoding header: br, then gzip.
 * Honors q=0 as "not acceptable".
 * @param {string | undefined} header
 * @returns {'br' | 'gzip' | null}
 */
export function pickEncoding(header) {
  const accepted = new Map();
  for (const part of String(header || '').split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    if (!name) continue;
    const q = params.map((p) => /^\s*q=([\d.]+)/.exec(p)).find(Boolean);
    accepted.set(name.trim(), q ? Number(q[1]) : 1);
  }
  const ok = (name) => (accepted.get(name) ?? accepted.get('*') ?? 0) > 0;
  if (ok('br')) return 'br';
  if (ok('gzip')) return 'gzip';
  return null;
}

/**
 * @param {string} relPath path relative to the bundle directory
 * @param {'dev' | 'prod'} mode
 * @returns {string}
 */
export function cacheControlFor(relPath, mode) {
  // The dev bundle is rebuilt constantly; never let a browser keep it.
  if (mode === 'dev') return 'no-store';
  // Hashed names change with their content, so they can be kept forever.
  if (HASHED_FILE_RE.test(relPath)) return 'public, max-age=31536000, immutable';
  // Stable names (entries, vendor, shells' css) are revalidated through the ETag.
  return 'no-cache';
}

/**
 * @param {{ dir: string, mode: 'dev' | 'prod' }} options
 * @returns {import('express').RequestHandler}
 */
export function createDistStaticMiddleware({ dir, mode }) {
  const root = path.resolve(dir);
  /** @type {Map<string, { stamp: string, br?: Buffer, gzip?: Buffer }>} */
  const encoded = new Map();

  return async function distStatic(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    try {
      const rel = decodeURIComponent(String(req.path || '')).replace(/^\/+/, '');
      const abs = path.resolve(root, rel);
      if (!rel || (abs !== root && !abs.startsWith(root + path.sep))) return res.status(404).end();
      const stat = await fsp.stat(abs).catch(() => null);
      if (!stat || !stat.isFile()) return res.status(404).end();

      const ext = path.extname(abs).toLowerCase();
      const stamp = `${stat.mtimeMs}-${stat.size}`;
      const wantCoding = COMPRESSIBLE_RE.test(abs) && stat.size >= MIN_COMPRESS_BYTES
        ? pickEncoding(req.headers['accept-encoding'])
        : null;
      res.setHeader('Cache-Control', cacheControlFor(rel, mode));
      res.setHeader('Vary', 'Accept-Encoding');
      if (MIME[ext]) res.setHeader('Content-Type', MIME[ext]);

      let body = null;
      if (wantCoding) {
        let entry = encoded.get(abs);
        if (!entry || entry.stamp !== stamp) {
          entry = { stamp };
          encoded.set(abs, entry);
        }
        if (!entry[wantCoding]) {
          const raw = await fsp.readFile(abs);
          entry[wantCoding] = wantCoding === 'br'
            ? await brotli(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } })
            : await gzip(raw, { level: 9 });
        }
        body = entry[wantCoding];
        res.setHeader('Content-Encoding', wantCoding);
      }
      const etag = `W/"${stamp}${wantCoding ? `-${wantCoding}` : ''}"`;
      res.setHeader('ETag', etag);
      res.setHeader('Last-Modified', stat.mtime.toUTCString());
      if (req.headers['if-none-match'] === etag) return res.status(304).end();
      if (!body) body = await fsp.readFile(abs);
      res.setHeader('Content-Length', String(body.length));
      return res.status(200).end(req.method === 'HEAD' ? undefined : body);
    } catch (err) {
      return next(err);
    }
  };
}
