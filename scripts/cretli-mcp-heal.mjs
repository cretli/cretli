#!/usr/bin/env node
/**
 * Self-repair for a Claude Code session started by a Cretli operator chat
 * (Remote Control) that lost its Cretli MCP tools, e.g. after it resumed
 * without the project server approved.
 *
 *   node cretli-mcp-heal.mjs          ask Cretli to re-approve the `cretli`
 *                                     server of this folder and restart the
 *                                     operator chat; the conversation resumes
 *                                     with the tools a few seconds later
 *   node cretli-mcp-heal.mjs --hint   one line for a SessionStart hook
 *
 * It finds the `cretli` entry of the nearest `.mcp.json` (from the current
 * directory up) and authenticates with that connection's own token, so it
 * needs no Cretli login. Node built-ins only, so it runs from anywhere.
 */

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_NAME = 'cretli';
const SELF = fileURLToPath(import.meta.url);

/** Nearest `.mcp.json` with a `cretli` entry, from `start` up. */
function findEntry(start = process.cwd()) {
  let dir = path.resolve(start);
  for (;;) {
    const file = path.join(dir, '.mcp.json');
    try {
      const entry = JSON.parse(fs.readFileSync(file, 'utf8'))?.mcpServers?.[SERVER_NAME];
      if (entry && typeof entry === 'object') return { folder: dir, entry };
    } catch {
      // missing or unreadable: keep looking upwards
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** @param {Record<string, any>} env */
function readToken(env) {
  const file = String(env.CRETLI_MCP_TOKEN_FILE || '').trim();
  if (file) {
    try {
      return fs.readFileSync(file, 'utf8').trim();
    } catch {
      // fall back to a literal token
    }
  }
  const token = String(env.CRETLI_MCP_TOKEN || '').trim();
  return token.startsWith('${') ? '' : token;
}

/**
 * @param {URL} url
 * @param {string} token
 * @param {string} caFile
 * @returns {Promise<{ status: number, body: any }>}
 */
function post(url, token, caFile) {
  return new Promise((resolve, reject) => {
    const secure = url.protocol === 'https:';
    /** @type {import('node:https').RequestOptions} */
    const options = { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-length': 0 } };
    if (secure && caFile) options.ca = fs.readFileSync(caFile);
    const req = (secure ? https : http).request(url, options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body = null;
        try { body = JSON.parse(text); } catch { body = { error: text.slice(0, 300) }; }
        resolve({ status: res.statusCode || 0, body });
      });
    });
    req.setTimeout(15000, () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function heal() {
  const found = findEntry();
  if (!found) {
    console.error('No .mcp.json with a "cretli" server here or above; connect the folder in Cretli (Settings → MCP → Connect).');
    return 2;
  }
  const env = found.entry.env || {};
  const endpoint = String(env.CRETLI_MCP_URL || found.entry.url || '').trim();
  const token = readToken(env);
  if (!endpoint || !token) {
    console.error(`The "cretli" entry in ${path.join(found.folder, '.mcp.json')} has no Cretli URL or token; connect the folder again in Cretli.`);
    return 2;
  }
  const url = new URL('/mcp/remote-control/heal', endpoint);
  try {
    const { status, body } = await post(url, token, String(env.CRETLI_MCP_CA_FILE || '').trim());
    if (status >= 200 && status < 300 && body?.ok) {
      console.log(body.message || 'Cretli is restarting this operator chat; it resumes with the Cretli tools in a few seconds.');
      return 0;
    }
    console.error(`Cretli refused (${status}): ${body?.error || 'unknown error'}`);
    return 1;
  } catch (err) {
    console.error(`Cretli is not reachable at ${url.origin}: ${err instanceof Error ? err.message : err}. It may be restarting; try again in a minute.`);
    return 1;
  }
}

function hint() {
  if (!findEntry()) return 0;
  console.log(`Cretli: if the Cretli MCP tools (mcp__${SERVER_NAME}__*) are missing in this session, run \`node "${SELF}"\` with Bash. It restores the Cretli MCP connection and restarts this operator chat; the conversation resumes with the tools a few seconds later.`);
  return 0;
}

process.exitCode = process.argv.includes('--hint') ? hint() : await heal();
