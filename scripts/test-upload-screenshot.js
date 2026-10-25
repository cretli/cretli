#!/usr/bin/env node
/**
 * Screenshot upload test: posts a minimal 1x1 PNG to POST /api/upload-screenshot.
 * Requires a running server:
 *   node scripts/test-upload-screenshot.js
 * For HTTPS with a self-signed cert:
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 BASE_URL=https://localhost:3011 node scripts/test-upload-screenshot.js
 */

const baseUrl = process.env.BASE_URL || 'http://localhost:3011';
const url = new URL('/api/upload-screenshot', baseUrl);
const minimalPngBase64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDQADhgGAWjR9awAAAABJRU5ErkJggg==';

const body = JSON.stringify({ base64: minimalPngBase64 });
const opts = {
  hostname: url.hostname,
  port: url.port || (url.protocol === 'https:' ? 443 : 80),
  path: url.pathname,
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
};

const httpMod = url.protocol === 'https:' ? await import('https') : await import('http');
const req = httpMod.request(opts, (res) => {
  let data = '';
  res.on('data', (ch) => (data += ch));
  res.on('end', () => {
    const json = (() => { try { return JSON.parse(data); } catch { return {}; } })();
    if (res.statusCode === 200 && json.ok && json.path) {
      console.log('OK — screenshot saved:', json.path);
      console.log('filename:', json.filename);
      process.exit(0);
      return;
    }
    console.error('Error:', res.statusCode, json.error || data || res.statusMessage);
    process.exit(1);
  });
});
req.on('error', (err) => {
  console.error('Connection error:', err.message);
  process.exit(1);
});
req.write(body);
req.end();
