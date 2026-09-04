/**
 * Long-lived CodeBuddy session. CLI `--resume` replays the previous assistant
 * message and ignores the new prompt; keep one process and send() each turn.
 */

/**
 * @param {unknown} session
 * @returns {boolean}
 */
export function isCodeBuddyLiveSessionOpen(session) {
  if (!session || typeof session !== 'object') return false;
  const record = /** @type {{ closed?: boolean }} */ (session);
  return record.closed !== true;
}

/**
 * ProcessTransport reads these flags at spawn time — set them before send().
 * @param {unknown} session
 * @param {{
 *   cwd?: string,
 *   permissionMode?: string,
 *   settingSources?: string[],
 *   includePartialMessages?: boolean,
 *   executablePath?: string,
 * }} extras
 * @returns {void}
 */
export function applyCodeBuddyTransportOptions(session, extras) {
  if (!session || typeof session !== 'object') return;
  const transport = /** @type {{ transport?: { options?: Record<string, unknown> } }} */ (session).transport;
  if (!transport || typeof transport !== 'object') return;
  if (!transport.options || typeof transport.options !== 'object') return;
  const options = transport.options;
  if (typeof extras.cwd === 'string' && extras.cwd) options.cwd = extras.cwd;
  if (typeof extras.permissionMode === 'string' && extras.permissionMode) {
    options.permissionMode = extras.permissionMode;
  }
  if (Array.isArray(extras.settingSources)) options.settingSources = extras.settingSources;
  if (typeof extras.includePartialMessages === 'boolean') {
    options.includePartialMessages = extras.includePartialMessages;
  }
  if (typeof extras.executablePath === 'string' && extras.executablePath) {
    options.executablePath = extras.executablePath;
  }
}

/**
 * @param {{
 *   sdk: { unstable_v2_createSession?: Function },
 *   model: string,
 *   pathToCodebuddyCode: string,
 *   env: Record<string, string>,
 *   cwd: string,
 *   permissionMode: string,
 * }} params
 * @returns {object}
 */
export function createCodeBuddyLiveSession(params) {
  if (typeof params.sdk.unstable_v2_createSession !== 'function') {
    throw new Error('CodeBuddy SDK is missing unstable_v2_createSession.');
  }
  const session = params.sdk.unstable_v2_createSession({
    model: params.model,
    pathToCodebuddyCode: params.pathToCodebuddyCode,
    env: params.env,
    canUseTool: async (_toolName, input) => ({
      behavior: 'allow',
      updatedInput: input && typeof input === 'object' ? input : {},
    }),
  });
  applyCodeBuddyTransportOptions(session, {
    cwd: params.cwd,
    permissionMode: params.permissionMode,
    settingSources: ['project'],
    includePartialMessages: true,
    executablePath: params.pathToCodebuddyCode,
  });
  return session;
}

/**
 * @param {unknown} session
 * @returns {void}
 */
export function closeCodeBuddyLiveSession(session) {
  if (!session || typeof session !== 'object') return;
  const record = /** @type {{ close?: () => void, closed?: boolean }} */ (session);
  if (record.closed === true) return;
  if (typeof record.close === 'function') {
    try {
      record.close();
    } catch {
      // ignore close errors
    }
  }
}
