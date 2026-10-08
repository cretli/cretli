/**
 * Standalone HTTP(S) egress proxy: validates every hop (DNS/IP/allowlist) before
 * opening upstream sockets. Inside a TLS CONNECT tunnel the proxy cannot inspect
 * plaintext redirects without MITM; route-level policy in session-manager remains
 * the boundary there.
 */

import dns from 'node:dns';
import net from 'node:net';
import { loadEgressProxyConfig } from './config.js';
import { createSessionResolver } from './allowlist.js';
import {
  validateConnectAuthority,
  validatePolicyUrl,
  validateRedirectHop,
} from './target.js';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
]);

/**
 * @param {net.Socket} socket
 * @param {number} timeoutMs
 */
function armIdleTimeout(socket, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return;
  socket.setTimeout(timeoutMs);
  socket.on('timeout', () => socket.destroy());
}

/**
 * @param {Buffer} buffer
 * @returns {{ consumed: number, headers: Record<string, string>, head: Buffer } | null}
 */
function tryParseHeaders(buffer) {
  const marker = buffer.indexOf('\r\n\r\n');
  if (marker === -1) return null;
  const headText = buffer.slice(0, marker).toString('latin1');
  const lines = headText.split('\r\n');
  /** @type {Record<string, string>} */
  const headers = {};
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    headers[key] = headers[key] ? `${headers[key]}, ${value}` : value;
  }
  return {
    consumed: marker + 4,
    headers,
    head: buffer.slice(0, marker + 4),
  };
}

/**
 * @param {string} requestLine
 * @returns {{ method: string, target: string, version: string } | null}
 */
function parseRequestLine(requestLine) {
  const parts = requestLine.trim().split(/\s+/);
  if (parts.length < 3) return null;
  return { method: parts[0], target: parts[1], version: parts[2] };
}

/**
 * @param {string} statusLine
 * @returns {number|null}
 */
function parseStatusCode(statusLine) {
  const parts = statusLine.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const code = Number.parseInt(parts[1], 10);
  return Number.isInteger(code) ? code : null;
}

/**
 * @param {string} absoluteTarget
 * @returns {string}
 */
function originFormPath(absoluteTarget) {
  try {
    const u = new URL(absoluteTarget);
    return `${u.pathname || '/'}${u.search || ''}`;
  } catch {
    return '/';
  }
}

/**
 * @param {string} connectionValue
 * @returns {Set<string>}
 */
function connectionHeaderTokens(connectionValue) {
  /** @type {Set<string>} */
  const tokens = new Set();
  for (const part of String(connectionValue).split(',')) {
    const token = part.trim().toLowerCase();
    if (token) tokens.add(token);
  }
  return tokens;
}

/**
 * @param {{ head: Buffer, headers: Record<string, string> }} parsed
 * @param {{ method: string, target: string, version: string }} req
 * @param {{ keepUpgrade?: boolean, preserveChunkedTe?: boolean }} opts
 * @returns {Buffer}
 */
function rebuildUpstreamRequestHead(parsed, req, opts = {}) {
  const keepUpgrade = opts.keepUpgrade === true;
  const preserveChunkedTe = opts.preserveChunkedTe === true;
  const teValue = String(parsed.headers['transfer-encoding'] ?? '').toLowerCase();
  const hasChunkedTe = preserveChunkedTe && teValue.includes('chunked');
  const connTokens = connectionHeaderTokens(parsed.headers.connection ?? '');
  const headText = parsed.head.toString('latin1');
  const lines = headText.split('\r\n');
  const path = originFormPath(req.target);
  /** @type {string[]} */
  const out = [`${req.method} ${path} ${req.version}`];
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    if (key === 'proxy-authorization') continue;
    if (keepUpgrade && (key === 'connection' || key === 'upgrade')) {
      out.push(line);
      continue;
    }
    if (hasChunkedTe && key === 'transfer-encoding') {
      out.push(line);
      continue;
    }
    if (HOP_BY_HOP.has(key)) continue;
    if (connTokens.has(key)) continue;
    if (!keepUpgrade && key === 'upgrade') continue;
    out.push(line);
  }
  return Buffer.from(`${out.join('\r\n')}\r\n\r\n`, 'latin1');
}

/**
 * @param {net.Socket} client
 */
function createProxyResponseState(client) {
  let proxyResponseSent = false;
  let tunnelOpen = false;
  return {
    markTunnelOpen() {
      tunnelOpen = true;
    },
    trySendProxyResponse(writeFn) {
      if (tunnelOpen || proxyResponseSent || client.destroyed) {
        if (tunnelOpen && !client.destroyed) client.destroy();
        return false;
      }
      proxyResponseSent = true;
      writeFn();
      return true;
    },
    destroyClientIfTunnel() {
      if (!client.destroyed) client.destroy();
    },
  };
}

/**
 * @param {string} code
 * @param {string} reason
 * @returns {string}
 */
function denyResponse(code, reason) {
  const body = `${reason}\n`;
  return [
    'HTTP/1.1 403 Forbidden',
    'Content-Type: text/plain; charset=utf-8',
    'Connection: close',
    `Content-Length: ${Buffer.byteLength(body)}`,
    `X-Egress-Deny: ${code}`,
    '',
    body,
  ].join('\r\n');
}

/**
 * @param {net.Socket} client
 * @param {number} status
 * @param {string} reason
 * @param {string} [denyCode]
 */
function replyProxyError(client, status, reason, denyCode) {
  const body = `${reason}\n`;
  /** @type {string[]} */
  const lines = [
    `HTTP/1.1 ${status} ${status === 403 ? 'Forbidden' : status === 431 ? 'Request Header Fields Too Large' : 'Bad Gateway'}`,
    'Content-Type: text/plain; charset=utf-8',
    'Connection: close',
    `Content-Length: ${Buffer.byteLength(body)}`,
  ];
  if (denyCode) lines.push(`X-Egress-Deny: ${denyCode}`);
  lines.push('', body);
  client.end(lines.join('\r\n'));
}

/**
 * @param {net.Socket} client
 * @param {Buffer} extraBody
 * @param {net.Socket} upstream
 * @param {Buffer} head
 */
function forwardClientRequestBody(client, extraBody, upstream, head) {
  upstream.write(head);
  if (extraBody.length) upstream.write(extraBody);
  if (client.readableEnded) return;
  client.pipe(upstream, { end: true });
}

/**
 * @param {{
 *   config?: import('./config.js').EgressProxyConfig,
 *   lookup?: (hostname: string, options?: object) => Promise<Array<{ address: string }>>,
 *   sessionResolver?: ReturnType<typeof createSessionResolver>,
 *   port?: number,
 * }} [options]
 */
export function createEgressProxyServer(options = {}) {
  const config = options.config || loadEgressProxyConfig();
  const lookup = typeof options.lookup === 'function' ? options.lookup : defaultLookup;
  const sessionResolver = options.sessionResolver || createSessionResolver({
    dataDir: config.dataDir,
    policyFile: config.policyFile,
  });
  /** @type {net.Server|null} */
  let tcpServer = null;
  let boundPort = options.port ?? config.port;
  /** @type {Set<net.Socket>} */
  const openClients = new Set();
  const maxHeaderBytes = config.maxHeaderBytes ?? 65_536;

  /**
   * @param {net.Socket} client
   */
  async function handleConnection(client) {
    armIdleTimeout(client, config.idleTimeoutMs);
    /** @type {Buffer[]} */
    const chunks = [];
    /** @type {Buffer} */
    let buffer = Buffer.alloc(0);

    /**
     * @returns {Promise<{ parsed: { consumed: number, headers: Record<string, string>, head: Buffer }, extraBody: Buffer }|null>}
     */
    const readRequestHead = () => new Promise((resolve, reject) => {
      const onReadable = () => {
        let chunk;
        while ((chunk = client.read()) !== null) {
          chunks.push(chunk);
          buffer = Buffer.concat(chunks);
          if (buffer.length > maxHeaderBytes && !tryParseHeaders(buffer)) {
            cleanup();
            replyProxyError(client, 431, 'Request header too large', 'header-too-large');
            client.destroy();
            resolve(null);
            return;
          }
          const parsed = tryParseHeaders(buffer);
          if (parsed) {
            cleanup();
            const extraBody = buffer.length > parsed.consumed
              ? buffer.slice(parsed.consumed)
              : Buffer.alloc(0);
            resolve({ parsed, extraBody });
            return;
          }
        }
      };
      const onEnd = () => {
        cleanup();
        resolve(null);
      };
      const onError = (err) => {
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        client.off('readable', onReadable);
        client.off('end', onEnd);
        client.off('error', onError);
      };
      client.on('readable', onReadable);
      client.once('end', onEnd);
      client.once('error', onError);
      onReadable();
    });

    let headBundle;
    try {
      headBundle = await readRequestHead();
    } catch {
      client.destroy();
      return;
    }
    if (!headBundle) {
      if (!client.destroyed) client.destroy();
      return;
    }
    const parsedHeaders = headBundle.parsed;
    const extraBody = headBundle.extraBody;
    const headText = parsedHeaders.head.slice(0, parsedHeaders.head.indexOf('\r\n\r\n')).toString('latin1');
    const requestLine = headText.split('\r\n')[0] || '';
    const req = parseRequestLine(requestLine);
    const responseState = createProxyResponseState(client);
    if (!req) {
      responseState.trySendProxyResponse(() => client.end(denyResponse('invalid-request', 'Malformed request line')));
      return;
    }

    if (req.method === 'GET' && req.target === config.probePath) {
      responseState.trySendProxyResponse(() => client.end('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nConnection: close\r\nContent-Length: 2\r\n\r\nok'));
      return;
    }

    const session = sessionResolver.resolveSession(parsedHeaders.headers['proxy-authorization']);
    if (!session) {
      responseState.trySendProxyResponse(() => client.end(denyResponse('unknown-session', 'Proxy authentication required')));
      return;
    }

    const ctx = {
      policy: session.policy,
      blockedOrigins: config.selfOrigins,
      blockedPorts: config.blockedPorts,
      lookup,
    };

    if (req.method === 'CONNECT') {
      await handleConnect(client, req, ctx, extraBody, responseState);
      return;
    }

    await handleAbsoluteHttp(client, req, parsedHeaders, extraBody, ctx, responseState);
  }

  /**
   * @param {net.Socket} client
   * @param {{ method: string, target: string, version: string }} req
   * @param {object} ctx
   * @param {Buffer} extra
   */
  async function handleConnect(client, req, ctx, extra, responseState) {
    const authority = req.target.trim();
    const colon = authority.lastIndexOf(':');
    if (colon === -1) {
      responseState.trySendProxyResponse(() => replyProxyError(client, 400, 'Invalid CONNECT authority'));
      return;
    }
    const hostname = authority.slice(0, colon);
    const port = Number.parseInt(authority.slice(colon + 1), 10);
    const validation = await validateConnectAuthority({
      hostname,
      port,
      ...ctx,
    });
    if (!validation.allowed) {
      responseState.trySendProxyResponse(() => replyProxyError(client, 403, validation.reason || validation.code, validation.code));
      return;
    }
    /** @type {net.Socket|null} */
    let upstream = null;
    const tearDown = () => {
      if (upstream && !upstream.destroyed) upstream.destroy();
    };
    client.once('close', tearDown);
    client.once('error', tearDown);
    upstream = net.connect({
      host: validation.address,
      port: validation.port,
    });
    const onConnectTimeout = () => onConnectFail(new Error('Upstream connect timeout'));
    const onConnectFail = (err) => {
      client.off('close', tearDown);
      client.off('error', tearDown);
      upstream?.removeListener('timeout', onConnectTimeout);
      responseState.trySendProxyResponse(() => replyProxyError(client, 502, err?.message || 'Upstream connect failed', 'upstream-connect-failed'));
      upstream?.destroy();
    };
    upstream.setTimeout(config.connectTimeoutMs, onConnectTimeout);
    upstream.once('error', onConnectFail);
    upstream.once('connect', () => {
      upstream.removeListener('error', onConnectFail);
      upstream.removeListener('timeout', onConnectTimeout);
      upstream.setTimeout(0);
      client.off('close', tearDown);
      client.off('error', tearDown);
      armIdleTimeout(client, config.idleTimeoutMs);
      armIdleTimeout(upstream, config.idleTimeoutMs);
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      responseState.markTunnelOpen();
      if (extra.length) upstream.write(extra);
      client.pipe(upstream);
      upstream.pipe(client);
      client.on('close', () => upstream.destroy());
      upstream.on('close', () => client.destroy());
      upstream.on('error', () => responseState.destroyClientIfTunnel());
    });
  }

  /**
   * @param {net.Socket} upstream
   * @param {net.Socket} client
   * @param {string} targetUrl
   * @param {object} ctx
   * @param {number} maxHeader
   */
  function attachPlaintextResponseHandler(upstream, client, targetUrl, ctx, maxHeader, responseState, pinnedAddress) {
    /** @type {Buffer[]} */
    const upChunks = [];
    let responseHeadersDone = false;
    let headerSettled = false;
    const onUpstreamData = (chunk) => {
      if (responseHeadersDone) {
        client.write(chunk);
        return;
      }
      if (headerSettled) return;
      upChunks.push(chunk);
      const buf = Buffer.concat(upChunks);
      if (buf.length > maxHeader && buf.indexOf('\r\n\r\n') === -1) {
        headerSettled = true;
        upstream.pause();
        upstream.off('data', onUpstreamData);
        upstream.destroy();
        responseState.trySendProxyResponse(() => replyProxyError(client, 502, 'Upstream response header too large', 'header-too-large'));
        return;
      }
      const marker = buf.indexOf('\r\n\r\n');
      if (marker === -1) return;
      headerSettled = true;
      upstream.pause();
      upstream.off('data', onUpstreamData);
      const headerBlock = buf.slice(0, marker + 4);
      const rest = buf.slice(marker + 4);
      void (async () => {
        const statusLine = headerBlock.toString('latin1').split('\r\n')[0] || '';
        const statusCode = parseStatusCode(statusLine);
        /** @type {Record<string, string>} */
        const respHeaders = {};
        for (const line of headerBlock.toString('latin1').split('\r\n').slice(1)) {
          const colon = line.indexOf(':');
          if (colon === -1) continue;
          const key = line.slice(0, colon).trim().toLowerCase();
          respHeaders[key] = line.slice(colon + 1).trim();
        }
        if (statusCode !== null && REDIRECT_STATUSES.has(statusCode) && respHeaders.location) {
          const hop = await validateRedirectHop({
            location: respHeaders.location,
            baseUrl: targetUrl,
            pinnedAddresses: pinnedAddress ? [pinnedAddress] : undefined,
            ...ctx,
          });
          if (!hop.allowed) {
            upstream.destroy();
            responseState.trySendProxyResponse(() => replyProxyError(client, 403, hop.reason || hop.code, hop.code));
            return;
          }
        }
        responseHeadersDone = true;
        client.write(headerBlock);
        if (rest.length) client.write(rest);
        upstream.resume();
        upstream.pipe(client, { end: true });
      })();
    };
    upstream.on('data', onUpstreamData);
    upstream.on('end', () => {
      if (!client.destroyed && !client.writableEnded) client.end();
    });
    upstream.on('close', () => {
      if (!client.destroyed && !client.writableEnded) client.end();
    });
    upstream.on('error', () => {
      if (responseHeadersDone) {
        responseState.destroyClientIfTunnel();
        return;
      }
      responseState.trySendProxyResponse(() => replyProxyError(client, 502, 'Upstream error'));
    });
    client.on('close', () => upstream.destroy());
  }

  /**
   * @param {net.Socket} client
   * @param {{ method: string, target: string, version: string }} req
   * @param {{ consumed: number, headers: Record<string, string>, head: Buffer }} parsed
   * @param {Buffer} extraBody
   * @param {object} ctx
   */
  async function handleWebSocketUpgrade(client, req, parsed, extraBody, ctx, targetUrl, responseState) {
    const validation = await validatePolicyUrl({ url: targetUrl, ...ctx });
    if (!validation.allowed) {
      responseState.trySendProxyResponse(() => replyProxyError(client, 403, validation.reason || validation.code, validation.code));
      return;
    }
    const upstream = net.connect({ host: validation.address, port: validation.port });
    let tunnelStarted = false;
    const abortUpstream = () => {
      if (!upstream.destroyed) upstream.destroy();
    };
    client.on('close', abortUpstream);
    client.on('error', abortUpstream);
    const onConnectTimeout = () => onConnectFail(new Error('Upstream connect timeout'));
    const onConnectFail = (err) => {
      client.off('close', abortUpstream);
      client.off('error', abortUpstream);
      upstream.removeListener('timeout', onConnectTimeout);
      responseState.trySendProxyResponse(() => replyProxyError(client, 502, err?.message || 'Upstream connect failed', 'upstream-connect-failed'));
      upstream.destroy();
    };
    upstream.setTimeout(config.connectTimeoutMs, onConnectTimeout);
    upstream.once('error', onConnectFail);
    await new Promise((resolve) => {
      upstream.once('connect', resolve);
      upstream.once('error', () => resolve());
    });
    if (upstream.destroyed) {
      if (!responseState.trySendProxyResponse(() => replyProxyError(client, 502, 'Upstream connect failed', 'upstream-connect-failed'))) {
        client.off('close', abortUpstream);
        client.off('error', abortUpstream);
      }
      return;
    }
    upstream.removeListener('error', onConnectFail);
    upstream.removeListener('timeout', onConnectTimeout);
    upstream.setTimeout(0);
    armIdleTimeout(upstream, config.idleTimeoutMs);
    armIdleTimeout(client, config.idleTimeoutMs);
    const head = rebuildUpstreamRequestHead(parsed, req, { keepUpgrade: true });
    /** @type {Buffer[]} */
    const upChunks = [];
    let headerSettled = false;
    const onUpstreamData = (chunk) => {
      if (tunnelStarted) {
        client.write(chunk);
        return;
      }
      if (headerSettled) return;
      upChunks.push(chunk);
      const buf = Buffer.concat(upChunks);
      const marker = buf.indexOf('\r\n\r\n');
      if (marker === -1) return;
      headerSettled = true;
      upstream.off('data', onUpstreamData);
      const headerBlock = buf.slice(0, marker + 4);
      const rest = buf.slice(marker + 4);
      const statusCode = parseStatusCode(headerBlock.toString('latin1').split('\r\n')[0] || '');
      if (statusCode !== 101) {
        client.write(headerBlock);
        if (rest.length) client.write(rest);
        upstream.pipe(client, { end: true });
        return;
      }
      tunnelStarted = true;
      responseState.markTunnelOpen();
      client.off('close', abortUpstream);
      client.off('error', abortUpstream);
      client.write(headerBlock);
      if (rest.length) client.write(rest);
      upstream.on('data', (c) => {
        if (!client.destroyed) client.write(c);
      });
      client.on('close', () => upstream.destroy());
      upstream.on('close', () => client.destroy());
      upstream.on('error', () => responseState.destroyClientIfTunnel());
    };
    upstream.on('data', onUpstreamData);
    upstream.on('error', () => {
      if (tunnelStarted) {
        responseState.destroyClientIfTunnel();
        return;
      }
      responseState.trySendProxyResponse(() => replyProxyError(client, 502, 'Upstream error'));
    });
    forwardClientRequestBody(client, extraBody, upstream, head);
  }

  /**
   * @param {net.Socket} client
   * @param {{ method: string, target: string, version: string }} req
   * @param {{ consumed: number, headers: Record<string, string>, head: Buffer }} parsed
   * @param {Buffer} extraBody
   * @param {object} ctx
   */
  async function handleAbsoluteHttp(client, req, parsed, extraBody, ctx, responseState) {
    const targetUrl = req.target.trim();
    const upgradeHeader = String(parsed.headers.upgrade ?? '').toLowerCase();
    const isWsUpgrade = upgradeHeader === 'websocket'
      || targetUrl.startsWith('ws://');
    if (targetUrl.startsWith('wss://')) {
      responseState.trySendProxyResponse(() => replyProxyError(client, 400, 'Use CONNECT for wss targets', 'wss-use-connect'));
      return;
    }
    if (targetUrl.startsWith('https://')) {
      responseState.trySendProxyResponse(() => replyProxyError(client, 400, 'Use CONNECT for https targets', 'https-use-connect'));
      return;
    }
    if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('ws://')) {
      responseState.trySendProxyResponse(() => replyProxyError(client, 400, 'Absolute-form URL required'));
      return;
    }
    const teHeader = String(parsed.headers['transfer-encoding'] ?? '').toLowerCase();
    const hasChunkedTe = teHeader.includes('chunked');
    const hasContentLength = String(parsed.headers['content-length'] ?? '').trim() !== '';
    if (hasChunkedTe && hasContentLength) {
      responseState.trySendProxyResponse(() => replyProxyError(
        client,
        400,
        'Conflicting Transfer-Encoding and Content-Length',
        'transfer-encoding-conflict',
      ));
      return;
    }
    if (isWsUpgrade) {
      await handleWebSocketUpgrade(client, req, parsed, extraBody, ctx, targetUrl, responseState);
      return;
    }
    /** @type {net.Socket|undefined} */
    let upstream;
    const abortUpstream = () => {
      if (upstream && !upstream.destroyed) upstream.destroy();
    };
    client.on('close', abortUpstream);
    client.on('error', abortUpstream);
    const validation = await validatePolicyUrl({ url: targetUrl, ...ctx });
    if (!validation.allowed) {
      client.off('close', abortUpstream);
      client.off('error', abortUpstream);
      responseState.trySendProxyResponse(() => replyProxyError(client, 403, validation.reason || validation.code, validation.code));
      return;
    }
    if (client.destroyed) {
      client.off('close', abortUpstream);
      client.off('error', abortUpstream);
      return;
    }
    upstream = net.connect({ host: validation.address, port: validation.port });
    const onConnectTimeout = () => onConnectFail(new Error('Upstream connect timeout'));
    const onConnectFail = (err) => {
      client.off('close', abortUpstream);
      client.off('error', abortUpstream);
      upstream.removeListener('timeout', onConnectTimeout);
      responseState.trySendProxyResponse(() => replyProxyError(client, 502, err?.message || 'Upstream connect failed', 'upstream-connect-failed'));
      upstream.destroy();
    };
    upstream.setTimeout(config.connectTimeoutMs, onConnectTimeout);
    upstream.once('error', onConnectFail);
    await new Promise((resolve) => {
      upstream.once('connect', resolve);
      upstream.once('error', () => resolve());
    });
    if (upstream.destroyed) {
      client.off('close', abortUpstream);
      client.off('error', abortUpstream);
      responseState.trySendProxyResponse(() => replyProxyError(client, 502, 'Upstream connect failed', 'upstream-connect-failed'));
      return;
    }
    upstream.removeListener('error', onConnectFail);
    upstream.removeListener('timeout', onConnectTimeout);
    upstream.setTimeout(0);
    client.off('close', abortUpstream);
    client.off('error', abortUpstream);
    armIdleTimeout(upstream, config.idleTimeoutMs);
    attachPlaintextResponseHandler(upstream, client, targetUrl, ctx, maxHeaderBytes, responseState, validation.address);
    const preserveChunkedTe = hasChunkedTe;
    const head = rebuildUpstreamRequestHead(parsed, req, { keepUpgrade: false, preserveChunkedTe });
    forwardClientRequestBody(client, extraBody, upstream, head);
  }

  return {
    get port() {
      return boundPort;
    },
    /**
     * @param {number} [portOverride]
     * @returns {Promise<{ host: string, port: number }>}
     */
    listen(portOverride) {
      if (tcpServer) throw new Error('Already listening');
      boundPort = portOverride ?? boundPort;
      return new Promise((resolve, reject) => {
        tcpServer = net.createServer((socket) => {
          openClients.add(socket);
          socket.on('close', () => openClients.delete(socket));
          handleConnection(socket).catch(() => socket.destroy());
        });
        tcpServer.unref();
        tcpServer.once('error', reject);
        tcpServer.listen(boundPort, config.bind, () => {
          const addr = tcpServer.address();
          if (addr && typeof addr === 'object') boundPort = addr.port;
          resolve({ host: config.bind, port: boundPort });
        });
      });
    },
    async close() {
      for (const socket of openClients) socket.destroy();
      openClients.clear();
      if (!tcpServer) return;
      await new Promise((resolve) => tcpServer.close(() => resolve()));
      tcpServer = null;
    },
  };
}

/**
 * @param {string} hostname
 * @param {object} [opts]
 * @returns {Promise<Array<{ address: string }>>}
 */
function defaultLookup(hostname, opts) {
  return new Promise((resolve, reject) => {
    dns.lookup(hostname, { ...(opts || {}), all: true, verbatim: true }, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses);
    });
  });
}
