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
    /** @type {string} */
    this.code = '';
    /** @type {string} */
    this.reason = '';
    /** @type {Record<string, unknown>|null} */
    this.body = null;
  }
}

/** HTTP statuses that may carry a structured workspace-watcher denial body. */
const WATCHER_SOFT_DENIAL_STATUSES = new Set([403, 404]);

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
  async #authorizedRequest(method, pathname, options = {}, { allowSoftDenial = false } = {}) {
    if (!this.bearerToken && !this.sessionCookie) await this.login();
    let res = await this.#request(method, pathname, options);
    if (res.status === 401 && !this.bearerToken) {
      this.sessionCookie = '';
      this.csrfToken = '';
      await this.login();
      res = await this.#request(method, pathname, options);
    }
    if (res.status >= 400) {
      if (
        allowSoftDenial
        && WATCHER_SOFT_DENIAL_STATUSES.has(res.status)
        && res.json
        && res.json.ok === false
        && typeof res.json.reason === 'string'
        && res.json.reason
      ) {
        return res;
      }
      const err = new CretliApiError(
        String(res.json?.error || `Cretli API ${method} ${pathname} failed (HTTP ${res.status})`),
        res.status,
      );
      err.code = String(res.json?.code || '');
      err.reason = String(res.json?.reason || '');
      err.body = res.json;
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

  async getChat({ chatId, workspaceFolder, workspaceFile, skipWorkspace } = {}) {
    const chats = await this.listChats({ includeArchived: true });
    const chat = chats.find((row) => row.id === chatId) || null;
    if (!chat) return null;
    if (skipWorkspace === true) return chat;
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

  /** @param {string} chatId */
  async getChatTitleHistory(chatId) {
    const res = await this.#authorizedRequest('GET', `/api/chats/${encodeURIComponent(chatId)}/title-history`);
    return Array.isArray(res.json?.history) ? res.json.history : [];
  }

  async renameChat(chatId, title) {
    return this.patchChat(chatId, { title: String(title || '').trim() });
  }

  /** @param {string} chatId @param {string} title */
  async setAgentTitle(chatId, title) {
    const res = await this.#authorizedRequest('POST', `/api/chats/${encodeURIComponent(chatId)}/agent-title`, {
      body: { title: String(title || '') },
    });
    return res.json;
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

  async createTodo({ workspaceFolder, title, body, status, idempotencyKey, parentId, siblingIndex, assignee, runMode, orchestratorChatId, createdByChatId, sourceHarness } = {}) {
    const res = await this.#authorizedRequest('POST', '/api/todos', {
      body: {
        workspaceFolder,
        title,
        body,
        status,
        idempotencyKey,
        parentId,
        siblingIndex,
        assignee,
        runMode,
        orchestratorChatId,
        createdByChatId,
        sourceHarness,
        strictStatus: true,
      },
    });
    return res.json;
  }

  async updateTodo({ workspaceFolder, todoId, expectedUpdatedAt, title, body, status, parentId, siblingIndex, assignee, runMode, orchestratorChatId, linkedChatId, appendChangelog, plan } = {}) {
    const res = await this.#authorizedRequest('PATCH', `/api/todos/${encodeURIComponent(todoId)}`, {
      body: {
        workspaceFolder,
        title,
        body,
        status,
        parentId,
        siblingIndex,
        assignee,
        runMode,
        orchestratorChatId,
        linkedChatId,
        appendChangelog,
        plan,
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
      pickReason,
      pickId,
      pick_id,
      manualSource,
      manual_source,
      pickFallbackFrom,
      pick_fallback_from,
      idempotencyKey,
      sourceKind,
      historySeq,
      contentHash,
      taskText,
      executionMode,
      assignment,
      requestedRole,
      requested_role,
      leafId,
      leaf_id,
      todoId,
      todo_id,
      resumeRounds,
      resume_rounds,
      maxRounds,
      max_rounds,
      returnWhenStarting,
    } = {}) {
      const resolvedLeafId = leafId ?? leaf_id ?? todoId ?? todo_id;
      const resolvedResumeRounds = resumeRounds ?? resume_rounds;
      const resolvedMaxRounds = maxRounds ?? max_rounds;
      const res = await this.#authorizedRequest('POST', `/api/chats/${encodeURIComponent(chatId)}/delegations`, {
        body: {
          workspaceFolder,
          planRevision,
          executor: { transport: harness, model },
          extraInstructions,
          pickReason,
          pickId: pickId ?? pick_id,
          manualSource: manualSource ?? manual_source,
          pickFallbackFrom: pickFallbackFrom ?? pick_fallback_from,
          idempotencyKey,
          sourceKind,
          historySeq,
          contentHash,
          taskText,
          executionMode,
          assignment,
          requestedRole: requestedRole ?? requested_role,
          leafId: resolvedLeafId,
          resumeRounds: resolvedResumeRounds,
          maxRounds: resolvedMaxRounds,
          returnWhenStarting,
        },
      });
      return res.json;
    }

    async replyDelegation({ chatId, workspaceFolder, body, historySeq, contentHash, idempotencyKey, delegationId, replyKind } = {}) {
      const res = await this.#authorizedRequest('POST', `/api/chats/${encodeURIComponent(chatId)}/mailbox/reply`, {
        body: {
          workspaceFolder,
          body,
          historySeq,
          contentHash,
          idempotencyKey,
          delegationId,
          replyKind,
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

  /**
   * Parent-channel rating for the MCP `delegation_rate` tool. Chat-scoped like
   * `updateDelegationWorkflow`; the server fixes `rater=parent` from the route.
   *
   * @param {{ chatId: string, delegationId: string, workspaceFolder?: string,
   *   score?: unknown, tags?: unknown, note?: unknown }} input
   */
  async rateDelegation({ chatId, delegationId, workspaceFolder, score, tags, note } = {}) {
    const res = await this.#authorizedRequest(
      'POST',
      `/api/chats/${encodeURIComponent(chatId)}/delegation-rate`,
      {
        body: {
          workspaceFolder,
          delegationId,
          score,
          tags,
          note,
        },
      },
    );
    return res.json;
  }

  /**
   * Parent-channel acknowledgement for the MCP `delegation_ack` tool. Chat-scoped
   * like `delegation-rate`: the calling session must be the job parent, so the
   * route fixes the parent channel and rejects a child chat.
   *
   * @param {{ chatId: string, delegationId: string, workspaceFolder?: string,
   *   reason?: unknown }} input
   */
  async acknowledgeDelegation({ chatId, delegationId, workspaceFolder, reason } = {}) {
    const res = await this.#authorizedRequest(
      'POST',
      `/api/chats/${encodeURIComponent(chatId)}/delegation-ack`,
      {
        body: {
          workspaceFolder,
          delegationId,
          reason,
        },
      },
    );
    return res.json;
  }

  async getDelegationWorkflow({ chatId, workspaceFolder, leafId } = {}) {
    const res = await this.#authorizedRequest('GET', `/api/chats/${encodeURIComponent(chatId)}/delegation-workflow`, {
      query: { workspaceFolder, leafId },
    });
    return res.json?.workflow || null;
  }

  async updateDelegationWorkflow({
    chatId,
    workspaceFolder,
    role,
    round,
    maxRounds,
    lastImplementer,
    lastModel,
    lastReviewer,
    findingsText,
    findingsHash,
    lastVerdict,
    reportText,
    fanoutVerdicts,
      stopReason,
      clearStop,
      deadlineAt,
      budgetTokens,
      budgetCostUsd,
      materialRevision,
      idempotencyKey,
      leafId,
      resumeRounds,
    } = {}) {
    const res = await this.#authorizedRequest('POST', `/api/chats/${encodeURIComponent(chatId)}/delegation-workflow`, {
      body: {
        workspaceFolder,
        leafId,
        resumeRounds,
        role,
        round,
        maxRounds,
        lastImplementer,
        lastModel,
        lastReviewer,
        findingsText,
        findingsHash,
        lastVerdict,
        reportText,
        fanoutVerdicts,
        stopReason,
        clearStop,
        deadlineAt,
        budgetTokens,
        budgetCostUsd,
        materialRevision,
        idempotencyKey,
      },
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
      favorites_configured: res.json?.favorites_configured === true,
    };
  }

  async workspaceWatcherShow({ workspaceFolder } = {}) {
    const res = await this.#authorizedRequest('GET', '/api/workspace-watcher', {
      query: { workspaceFolder },
    });
    return res.json;
  }

  async workspaceWatcherUpdate(input = {}) {
    const workspaceFolder = String(input.workspaceFolder || '').trim();
    const action = String(input.action || 'configure').trim().toLowerCase();
    if (action === 'tick') {
      const res = await this.#authorizedRequest('POST', '/api/workspace-watcher/tick', {
        body: { workspaceFolder },
      });
      return { ...res.json, view: await this.workspaceWatcherShow({ workspaceFolder }) };
    }
    if (action === 'run_cycle') {
      const res = await this.#authorizedRequest('POST', '/api/workspace-watcher/run-cycle', {
        body: { workspaceFolder },
      });
      return { ...res.json, view: await this.workspaceWatcherShow({ workspaceFolder }) };
    }
    if (action === 'claim_next') {
      const res = await this.#authorizedRequest('POST', '/api/workspace-watcher/claim-next', {
        body: {
          workspaceFolder,
          sourceChatId: input.sourceChatId,
          claimedByChatId: input.claimedByChatId,
          ttlMs: input.ttlMs,
        },
      }, { allowSoftDenial: true });
      return res.json;
    }
    if (action === 'reset_plan_requests') {
      const res = await this.#authorizedRequest('POST', '/api/workspace-watcher/reset-plan-requests', {
        body: { workspaceFolder, todoId: input.todoId },
      });
      return res.json;
    }
    if (action === 'recover_todo') {
      const todoId = String(input.todoId || '').trim();
      const res = await this.#authorizedRequest('POST', `/api/workspace-watcher/todos/${encodeURIComponent(todoId)}/recover`, {
        body: {
          workspaceFolder,
          expectedUpdatedAt: input.expectedUpdatedAt,
          idempotencyKey: input.idempotencyKey,
        },
      }, { allowSoftDenial: true });
      return { ...res.json, view: res.json?.view || await this.workspaceWatcherShow({ workspaceFolder }) };
    }
    if (action === 'record_findings') {
      const res = await this.#authorizedRequest('POST', '/api/workspace-watcher/findings', {
        body: {
          workspaceFolder,
          hash: input.findingsHash,
          todoId: input.todoId,
          findingsText: input.findingsText,
        },
      });
      return res.json;
    }
    if (action === 'report') {
      const res = await this.#authorizedRequest('POST', '/api/workspace-watcher/report', {
        body: {
          workspaceFolder,
          sourceChatId: input.sourceChatId,
          outcome: input.outcome,
          todoIds: input.todoIds,
          cycleId: input.cycleId,
          reportId: input.reportId,
          message: input.message,
        },
      }, { allowSoftDenial: true });
      return { ...res.json, view: await this.workspaceWatcherShow({ workspaceFolder }) };
    }
    if (action === 'save_plan') {
      const res = await this.#authorizedRequest('POST', '/api/workspace-watcher/save-plan', {
        body: {
          workspaceFolder,
          todoId: input.todoId,
          expectedUpdatedAt: input.expectedUpdatedAt,
          planMarkdown: input.planMarkdown,
          sourceChatId: input.sourceChatId,
        },
      });
      return res.json;
    }
    const res = await this.#authorizedRequest('PATCH', '/api/workspace-watcher', {
      body: {
        workspaceFolder,
        mode: input.mode,
        enabled: input.enabled,
        paused: input.paused,
        stopReason: input.stopReason,
        policy: input.policy,
      },
    });
    return { ...res.json, view: await this.workspaceWatcherShow({ workspaceFolder }) };
  }

  async workspaceWatcherScout(input = {}) {
    const workspaceFolder = String(input.workspaceFolder || '').trim();
    const action = String(input.action || 'list').trim().toLowerCase() || 'list';
    if (action === 'list') {
      const res = await this.#authorizedRequest('GET', '/api/workspace-watcher/scout', {
        query: {
          workspaceFolder,
          status: input.status,
          category: input.category,
          scoutId: input.scoutId || input.scout_id,
          max: input.max,
        },
      });
      return res.json;
    }
    const res = await this.#authorizedRequest('POST', '/api/workspace-watcher/scout', {
      body: {
        workspaceFolder,
        action,
        ids: input.ids,
        id: input.id,
        findings: input.findings,
        text: input.text,
        status: input.status,
        category: input.category,
        scoutId: input.scoutId || input.scout_id,
        max: input.max,
        sourceChatId: input.sourceChatId,
        scanId: input.scanId,
        scoutSubmitToken: input.scoutSubmitToken || input.submitToken,
      },
    }, { allowSoftDenial: true });
    return res.json;
  }

  /**
   * Scout profile configuration surface (stage 4a). Mirrors the new REST
   * endpoints; a 409/404 surfaces as a CretliApiError the MCP layer maps back
   * onto CONFLICT / NOT_FOUND.
   *
   * @param {object} [input]
   * @returns {Promise<object>}
   */
  async workspaceWatcherScoutProfiles(input = {}) {
    const workspaceFolder = String(input.workspaceFolder || '').trim();
    const action = String(input.action || 'list').trim().toLowerCase() || 'list';
    const scoutId = String(input.scoutId || input.scout_id || '').trim();
    if (action === 'list') {
      const res = await this.#authorizedRequest('GET', '/api/workspace-watcher/scout/profiles', {
        query: { workspaceFolder },
      });
      return res.json;
    }
    if (action === 'get') {
      const res = await this.#authorizedRequest(
        'GET',
        `/api/workspace-watcher/scout/profiles/${encodeURIComponent(scoutId)}`,
        { query: { workspaceFolder } },
      );
      return res.json;
    }
    if (action === 'create') {
      const res = await this.#authorizedRequest('POST', '/api/workspace-watcher/scout/profiles', {
        body: { workspaceFolder, profile: input.profile },
      });
      return res.json;
    }
    if (action === 'update') {
      const res = await this.#authorizedRequest(
        'PATCH',
        `/api/workspace-watcher/scout/profiles/${encodeURIComponent(scoutId)}`,
        {
          body: {
            workspaceFolder,
            profile: input.profile,
            expectedRevision: input.expectedRevision ?? input.expected_revision,
          },
        },
      );
      return res.json;
    }
    if (action === 'duplicate') {
      const res = await this.#authorizedRequest(
        'POST',
        `/api/workspace-watcher/scout/profiles/${encodeURIComponent(scoutId)}/duplicate`,
        { body: { workspaceFolder } },
      );
      return res.json;
    }
    if (action === 'archive') {
      const res = await this.#authorizedRequest(
        'POST',
        `/api/workspace-watcher/scout/profiles/${encodeURIComponent(scoutId)}/archive`,
        { body: { workspaceFolder } },
      );
      return res.json;
    }
    if (action === 'preview') {
      const res = await this.#authorizedRequest(
        'GET',
        `/api/workspace-watcher/scout/profiles/${encodeURIComponent(scoutId)}/preview`,
        { query: { workspaceFolder } },
      );
      return res.json;
    }
    if (action === 'history') {
      const res = await this.#authorizedRequest('GET', '/api/workspace-watcher/scout/history', {
        query: { workspaceFolder, scoutId: scoutId || undefined, max: input.max },
      });
      return res.json;
    }
    if (action === 'run') {
      if (!scoutId) throw new Error('scoutId is required for run');
      const res = await this.#authorizedRequest(
        'POST',
        `/api/workspace-watcher/scout/profiles/${encodeURIComponent(scoutId)}/run`,
        { body: { workspaceFolder } },
      );
      return res.json;
    }
    throw new Error('action must be one of: list, get, create, update, duplicate, archive, preview, history, run');
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
