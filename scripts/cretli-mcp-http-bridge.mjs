#!/usr/bin/env node
/**
 * Stdio → HTTP bridge for the Cretli external MCP endpoint.
 *
 * MCP clients start this as a plain stdio server, so a Cretli restart or a
 * token rotation never marks the server as failed for the rest of the session:
 * every request is retried until Cretli answers, and the token is re-read for
 * each request. Node built-ins only, so the file can run from anywhere.
 *
 * Environment:
 *   CRETLI_MCP_URL          Endpoint, e.g. https://your-pc:3011/mcp (required)
 *   CRETLI_MCP_TOKEN        Client token (or use CRETLI_MCP_TOKEN_FILE)
 *   CRETLI_MCP_TOKEN_FILE   File holding the token; re-read on every request
 *   CRETLI_MCP_CA_FILE      PEM certificate to trust (self-signed Cretli)
 *   CRETLI_MCP_INSECURE_TLS Set to 1 to skip TLS verification (local networks only)
 *   CRETLI_MCP_RETRY_MS     Give up on one request after this long (default 120000)
 */

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import readline from 'node:readline';

const RETRY_MS = Math.max(1000, Number(process.env.CRETLI_MCP_RETRY_MS) || 120000);

/** Token from the file when configured (so rotation needs no restart), else the environment. */
function readToken() {
  const file = String(process.env.CRETLI_MCP_TOKEN_FILE || '').trim();
  if (file) {
    try {
      return fs.readFileSync(file, 'utf8').trim();
    } catch {
      // Fall through to the environment variable.
    }
  }
  return String(process.env.CRETLI_MCP_TOKEN || '').trim();
}

/** @param {unknown} message */
function writeOut(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/**
 * @param {URL} url
 * @param {string} body
 * @returns {Promise<{ status: number, type: string, text: string }>}
 */
function post(url, body) {
  return new Promise((resolve, reject) => {
    const secure = url.protocol === 'https:';
    /** @type {import('node:https').RequestOptions} */
    const options = {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'content-length': Buffer.byteLength(body),
        ...(readToken() ? { authorization: `Bearer ${readToken()}` } : {}),
      },
    };
    if (secure) {
      const ca = String(process.env.CRETLI_MCP_CA_FILE || '').trim();
      if (ca) options.ca = fs.readFileSync(ca);
      if (process.env.CRETLI_MCP_INSECURE_TLS === '1') options.rejectUnauthorized = false;
    }
    const req = (secure ? https : http).request(url, options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode || 0,
        type: String(res.headers['content-type'] || ''),
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.setTimeout(60000, () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Forward one JSON-RPC message, retrying while Cretli is unreachable or restarting.
 *
 * @param {URL} url
 * @param {string} line
 */
async function forward(url, line) {
  let id = null;
  try { id = JSON.parse(line)?.id ?? null; } catch { /* reported below */ }
  const deadline = Date.now() + RETRY_MS;
  let delay = 500;
  for (;;) {
    try {
      const res = await post(url, line);
      const retryable = res.status === 502 || res.status === 503 || res.status === 504;
      if (!retryable || Date.now() > deadline) return { res, id };
    } catch (err) {
      if (Date.now() > deadline) return { error: err instanceof Error ? err.message : String(err), id };
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 5000);
  }
}

async function handle(url, line) {
  const out = await forward(url, line);
  const notification = out.id === null || out.id === undefined;
  if (out.error || !out.res) {
    if (!notification) writeOut({ jsonrpc: '2.0', id: out.id, error: { code: -32000, message: `Cretli unreachable: ${out.error}` } });
    return;
  }
  const { res } = out;
  if (res.status === 202 || !res.text.trim()) return;
  if (res.status >= 400 && !res.text.trim().startsWith('{')) {
    if (!notification) writeOut({ jsonrpc: '2.0', id: out.id, error: { code: -32000, message: `Cretli returned HTTP ${res.status}` } });
    return;
  }
  if (res.type.includes('text/event-stream')) {
    for (const part of res.text.split('\n')) {
      if (part.startsWith('data:')) process.stdout.write(`${part.slice(5).trim()}\n`);
    }
    return;
  }
  process.stdout.write(`${res.text.trim()}\n`);
}

function main() {
  let url;
  try {
    url = new URL(String(process.env.CRETLI_MCP_URL || ''));
  } catch {
    process.stderr.write('CRETLI_MCP_URL must be an absolute http(s) URL\n');
    process.exit(2);
  }
  const lines = readline.createInterface({ input: process.stdin });
  const pending = new Set();
  lines.on('line', (line) => {
    if (!line.trim()) return;
    const task = handle(url, line).catch(() => {}).finally(() => pending.delete(task));
    pending.add(task);
  });
  lines.on('close', () => { Promise.all(pending).then(() => process.exit(0)); });
}

main();
