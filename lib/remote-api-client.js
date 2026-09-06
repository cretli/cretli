/**
 * Dependency-free HTTP client for the Cretli REST API.
 *
 * Used by out-of-process tooling (scripts/chat-cli.js, scripts/cretli-mcp.js)
 * so chat management always goes through the running server API instead of
 * touching data/ files directly (the server keeps state in memory and would
 * overwrite external edits).
 */

import http from 'node:http';
import https from 'node:https';
import { isChatInWorkspace } from './mcp/builtin/tool-context.js';

const DEFAULT_BASE_URL = 'https://127.0.0.1:3011';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const MUTATION_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/** HTTP failure with the server-provided error message when available. */
export class CretliApiError extends Error {
  /**
   * @param {string} message
   * @param {number} status
   */
  constructor(message, status) {
    super(message);
    this.name = 'CretliApiError';
    this.status = status;
  }
}

/**
 * @param {string} baseUrl
 * @returns {boolean} true when the target host is local (self-signed cert is
 *   the default there, so TLS verification is relaxed unless disabled).
 */
export function isLoopbackUrl(baseUrl) {
  try {
    return LOOPBACK_HOSTS.has(new URL(baseUrl).hostname.toLowerCase());
  } catch (_) {
    return false;
  }
}

/**
 * @param {string[]} setCookieValues
 * @returns {string} cookie header value with name=value pairs
 */
function joinSessionCookies(setCookieValues) {
  const pairs = [];
  for (const value of setCookieValues || []) {
    const pair = String(value).split(';')[0].trim();
    if (pair) pairs.push(pair);
  }
  return pairs.join('; ');
}

export class CretliApiClient {
  /**
   * @param {{ baseUrl?: string, password?: string, insecureTls?: boolean, bearerToken?: string }} options
   */
  constructor({ baseUrl, password, insecureTls, bearerToken } = {}) {
    this.baseUrl = String(baseUrl || process.env.CRETLI_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.password = String(password ?? '');
    this.bearerToken = String(bearerToken || process.env.CRETLI_MCP_TOKEN || '').trim();
    this.insecureTls = insecureTls === true || isLoopbackUrl(this.baseUrl);
    /** @type {string} */
    this.sessionCookie = '';
    /** @type {string} */
    this.csrfToken = '';
  }

  /**
   * @param {string} method
   * @param {string} pathname
   * @param {{ query?: Record<string, string|undefined>, body?: unknown }} [options]
   * @returns {Promise<{ status: number, json: any, headers: http.IncomingHttpHeaders }>}
   */
  #request(method, pathname, options = {}) {
    const url = new URL(pathname, this.baseUrl);
    for (const [key, value] of Object.entries(options.query || {})) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }
    const transport = url.protocol === 'http:' ? http : https;
    const headers = { Accept: 'application/json' };
    if (this.bearerToken) headers.Authorization = `Bearer ${this.bearerToken}`;
    if (this.sessionCookie) headers.Cookie = this.sessionCookie;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (MUTATION_METHODS.has(method) && this.csrfToken) {
      headers['x-cretli-csrf'] = this.csrfToken;
    }
    return new Promise((resolve, reject) => {
      const req = transport.request(
        url,
        {
          method,
          headers,
          rejectUnauthorized: !this.insecureTls,
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            let json = null;
            try {
              json = raw ? JSON.parse(raw) : null;
            } catch (_) {
              json = null;
            }
            resolve({ status: res.statusCode || 0, json, headers: res.headers });
          });
        },
      );
      req.on('error', reject);
      req.setTimeout(30000, () => req.destroy(new Error('Cretli API request timed out')));
      if (options.body !== undefined) req.write(JSON.stringify(options.body));
      req.end();
    });
  }

  /**
   * @param {string} method
   * @param {string} pathname
   * @param {{ query?: Record<string, string|undefined>, body?: unknown }} [options]
   */
  async #authorizedRequest(method, pathname, options = {}) {
    if (!this.bearerToken && !this.sessionCookie) await this.login();
    let res = await this.#request(method, pathname, options);
    if (res.status === 401 && !this.bearerToken) {
      this.sessionCookie = '';
      this.csrfToken = '';
      await this.login();
      res = await this.#request(method, pathname, options);
    }
    if (res.status >= 400) {
      const err = new CretliApiError(
        String(res.json?.error || `Cretli API ${method} ${pathname} failed (HTTP ${res.status})`),
        res.status,
      );
      err.code = String(res.json?.code || '');
      throw err;
    }
    return res;
  }

  async login() {
    const res = await this.#request('POST', '/api/login', { body: { password: this.password } });
    if (res.status !== 200 || !res.json?.ok) {
      throw new CretliApiError(
        String(res.json?.error || `Login failed (HTTP ${res.status})`),
        res.status,
      );
    }
    this.sessionCookie = joinSessionCookies(res.headers['set-cookie']);
    this.csrfToken = String(res.json.csrfToken || '');
    return true;
  }

  async authStatus() {
    const res = await this.#request('GET', '/api/auth-status');
    return res.json;
  }

  /** @returns {Promise<Array<object>>} */
  async listChats({ includeArchived } = {}) {
    const res = await this.#authorizedRequest('GET', '/api/chats', {
      query: { includeArchived: includeArchived ? '1' : undefined },
    });
    return Array.isArray(res.json?.chats) ? res.json.chats : [];
  }

  async getChat({ chatId, workspaceFolder, workspaceFile } = {}) {
    const chats = await this.listChats({ includeArchived: true });
    const chat = chats.find((row) => row.id === chatId) || null;
    if (!chat) return null;
    const folder = String(workspaceFolder || '').trim();
    if (!folder) return chat;
    if (!isChatInWorkspace(chat, folder, workspaceFile)) {
      const err = new CretliApiError('This chat is outside the current workspace.', 403);
      err.code = 'OUT_OF_SCOPE';
      throw err;
    }
    return chat;
  }

  /**
   * @param {string} chatId
   * @param {{ tail?: number, before?: number, since?: number, limit?: number }} [options]
   */
  async getChatHistory(chatId, options = {}) {
    const res = await this.#authorizedRequest('GET', `/api/chats/${encodeURIComponent(chatId)}/history`, {
      query: {
        tail: options.tail,
        before: options.before,
        since: options.since,
        limit: options.limit,
        seq: options.seq,
      },
    });
    return res.json;
  }

  /**
   * @param {string} chatId
   * @param {Record<string, unknown>} patch
   */
  async patchChat(chatId, patch) {
    const res = await this.#authorizedRequest('PATCH', `/api/chats/${encodeURIComponent(chatId)}`, {
      body: patch,
    });
    return res.json?.chat || null;
  }

  async archiveChat(chatId, archived = true) {
    return this.patchChat(chatId, { archived: archived === true });
  }

  async renameChat(chatId, title) {
    return this.patchChat(chatId, { title: String(title || '').trim() });
  }

  async deleteChat(chatId) {
    const res = await this.#authorizedRequest('DELETE', `/api/chats/${encodeURIComponent(chatId)}`);
    return res.json;
  }

  async listMcpIntegrations() {
    const res = await this.#authorizedRequest('GET', '/api/mcp/servers');
    return Array.isArray(res.json?.servers) ? res.json.servers : [];
  }

  async getMcpStatus(query = {}) {
    const res = await this.#authorizedRequest('GET', '/api/mcp/status', { query });
    return Array.isArray(res.json?.statuses) ? res.json.statuses : [];
  }

  async getMcpBridgeTools() {
    const res = await this.#authorizedRequest('GET', '/api/mcp/bridge/tools');
    return res.json;
  }

  async callMcpBridgeTool(name, args) {
    const res = await this.#authorizedRequest('POST', '/api/mcp/bridge/call', {
      body: { name, arguments: args || {} },
    });
    return res.json;
  }

  async listTodos({ workspaceFolder } = {}) {
    const res = await this.#authorizedRequest('GET', '/api/todos', {
      query: { workspaceFolder },
    });
    return Array.isArray(res.json?.items) ? res.json.items : [];
  }

  async getTodo({ workspaceFolder, todoId } = {}) {
    const items = await this.listTodos({ workspaceFolder });
    return items.find((row) => row.id === todoId) || null;
  }

  async createTodo({ workspaceFolder, title, body, status, idempotencyKey } = {}) {
    const res = await this.#authorizedRequest('POST', '/api/todos', {
      body: {
        workspaceFolder,
        title,
        body,
        status,
        idempotencyKey,
        strictStatus: true,
      },
    });
    return res.json;
  }

  async updateTodo({ workspaceFolder, todoId, expectedUpdatedAt, title, body, status } = {}) {
    const res = await this.#authorizedRequest('PATCH', `/api/todos/${encodeURIComponent(todoId)}`, {
      body: {
        workspaceFolder,
        title,
        body,
        status,
        expectedUpdatedAt,
        strictStatus: true,
      },
    });
    const items = Array.isArray(res.json?.items) ? res.json.items : [];
    return items.find((row) => row.id === todoId) || res.json?.item || null;
  }

  async getChatPlan({ chatId, workspaceFolder } = {}) {
    const res = await this.#authorizedRequest('GET', `/api/chats/${encodeURIComponent(chatId)}/plan`, {
      query: { workspaceFolder },
    });
    return res.json?.plan || res.json;
  }

  async listDelegations({ chatId, workspaceFolder } = {}) {
    const res = await this.#authorizedRequest('GET', `/api/chats/${encodeURIComponent(chatId)}/delegations`, {
      query: { workspaceFolder },
    });
    return Array.isArray(res.json?.delegations) ? res.json.delegations : [];
  }

  async getDelegation({ delegationId, workspaceFolder } = {}) {
    const res = await this.#authorizedRequest('GET', `/api/delegations/${encodeURIComponent(delegationId)}`, {
      query: { workspaceFolder },
    });
    return res.json?.delegation || null;
  }

    async startDelegation({
      chatId,
      workspaceFolder,
      planRevision,
      harness,
      model,
      extraInstructions,
      idempotencyKey,
      sourceKind,
      historySeq,
      contentHash,
      taskText,
      executionMode,
    } = {}) {
      const res = await this.#authorizedRequest('POST', `/api/chats/${encodeURIComponent(chatId)}/delegations`, {
        body: {
          workspaceFolder,
          planRevision,
          executor: { transport: harness, model },
          extraInstructions,
          idempotencyKey,
          sourceKind,
          historySeq,
          contentHash,
          taskText,
          executionMode,
        },
      });
      return res.json;
    }

    async replyDelegation({ chatId, workspaceFolder, body, historySeq, contentHash, idempotencyKey, delegationId } = {}) {
      const res = await this.#authorizedRequest('POST', `/api/chats/${encodeURIComponent(chatId)}/mailbox/reply`, {
        body: {
          workspaceFolder,
          body,
          historySeq,
          contentHash,
          idempotencyKey,
          delegationId,
        },
      });
      return res.json;
    }

    async listMailbox({ chatId, workspaceFolder } = {}) {
      const res = await this.#authorizedRequest('GET', `/api/chats/${encodeURIComponent(chatId)}/mailbox`, {
        query: { workspaceFolder },
      });
      return Array.isArray(res.json?.messages) ? res.json.messages : [];
    }

  async cancelDelegation({ delegationId, workspaceFolder } = {}) {
    const res = await this.#authorizedRequest('POST', `/api/delegations/${encodeURIComponent(delegationId)}/cancel`, {
      body: { workspaceFolder },
    });
    return res.json;
  }

  async listWorkspaceTasks({ workspaceFolder, workspaceFile } = {}) {
    const res = await this.#authorizedRequest('GET', '/api/tasks', {
      query: { workspaceFolder, workspaceFile },
    });
    return { tasks: Array.isArray(res.json?.tasks) ? res.json.tasks : [] };
  }

  async listTaskRuns({ workspaceFolder } = {}) {
    const res = await this.#authorizedRequest('GET', '/api/task-runs', {
      query: { workspaceFolder },
    });
    return Array.isArray(res.json?.runs) ? res.json.runs : [];
  }

  async listWorkspaceAgents({ workspaceFolder } = {}) {
    const res = await this.#authorizedRequest('GET', '/api/agents', {
      query: { workspaceFolder },
    });
    return { agents: Array.isArray(res.json?.agents) ? res.json.agents : [] };
  }

  async listAgentRuns({ workspaceFolder } = {}) {
    const res = await this.#authorizedRequest('GET', '/api/agent-runs', {
      query: { workspaceFolder },
    });
    return Array.isArray(res.json?.runs) ? res.json.runs : [];
  }

  async listHarnessCatalog() {
    const res = await this.#authorizedRequest('GET', '/api/harness-catalog/harnesses');
    return Array.isArray(res.json?.items) ? res.json.items : [];
  }

  async listHarnessModels({ harness, query, enabledOnly } = {}) {
    const res = await this.#authorizedRequest('GET', '/api/harness-catalog/models', {
      query: {
        harness,
        query,
        enabled_only: enabledOnly === true ? '1' : undefined,
      },
    });
    return {
      items: Array.isArray(res.json?.items) ? res.json.items : [],
      source: res.json?.source || 'remote',
      warning: res.json?.warning || '',
    };
  }
}

/**
 * Resolve a chat reference: exact/short id prefix or unique title substring.
 *
 * @param {Array<object>} chats
 * @param {string} ref
 * @returns {{ chat: object } | { matches: object[] }}
 */
export function findChatByRef(chats, ref) {
  const value = String(ref || '').trim();
  if (!value) return { matches: [] };
  const candidates = new Map();
  const add = (chat) => candidates.set(chat.id, chat);
  const idPrefix = value.toLowerCase().replace(/[^0-9a-f-]/g, '');
  if (idPrefix.length >= 4) {
    for (const chat of chats) {
      if (String(chat.id || '').toLowerCase().startsWith(idPrefix)) add(chat);
    }
  }
  if (candidates.size === 0) {
    const needle = value.toLowerCase();
    for (const chat of chats) {
      if (String(chat.title || '').toLowerCase().includes(needle)) add(chat);
    }
  }
  if (candidates.size === 1) return { chat: [...candidates.values()][0] };
  return { matches: [...candidates.values()] };
}
