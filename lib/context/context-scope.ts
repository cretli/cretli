/**
 * Authorized workspace scope for GET /api/cursor-context.
 * Client query paths never override chat or widget scope; out-of-scope paths are rejected.
 */

import path from 'node:path';
import { loadChats } from '../persist/chats-persist.js';
import { normalizeFolder } from '../git-context.js';
import { resolveTrustedRoot, assertPathWithinProjectRoot } from './source-trust.ts';
import { widgetChatAccessScope } from '../widget/widget-chat-scope.ts';

export const CURSOR_CONTEXT_SCOPE_SOURCES = Object.freeze(['widget', 'chat', 'workspace', 'global']);

export const CURSOR_CONTEXT_SCOPE_ERROR_CODES = Object.freeze({
  CHAT_NOT_FOUND: 'chat_not_found',
  CHAT_ACCESS_DENIED: 'chat_access_denied',
  SCOPE_OUT_OF_BOUNDS: 'scope_out_of_bounds',
  WORKSPACE_REQUIRED: 'workspace_required',
});

/** The request fields this module reads (an Express request satisfies it). */
export type CursorContextScopeRequest = {
  query?: Record<string, any>,
  widgetAccess?: Record<string, any>,
};

export type CursorContextScopeResult = {
  ok: true,
  source: string,
  audience: 'host' | 'widget',
  workspaceDir: string,
  projectRoot: string,
  chatId: string,
  compareLegacy: boolean,
  legacyWorkspaceDir: string,
} | { ok: false, status: number, code: string, error: string };

export function readCursorContextScopeInput(req: CursorContextScopeRequest | null | undefined): { chatId: string, workspaceFolder: string, compareLegacy: boolean } {
  const query = req?.query || {};
  const compareLegacy = query.compare === 'legacy' || query.legacy === '1' || query.legacy === 'true';
  return {
    chatId: String(query.chatId || '').trim(),
    workspaceFolder: normalizeFolder(query.workspaceFolder || query.cwd),
    compareLegacy,
  };
}

/**
 * Legacy workspace selection (pre–stage-1 behaviour) for compare mode only.
 */
export function resolveLegacyClientWorkspaceDir(req: CursorContextScopeRequest | null | undefined, getCurrentCwd: () => string): string {
  const widgetFolder = req?.widgetAccess?.workspaceFolder;
  const input = readCursorContextScopeInput(req);
  if (widgetFolder) {
    return normalizeFolder(widgetFolder);
  }
  if (input.workspaceFolder) {
    return input.workspaceFolder;
  }
  return normalizeFolder(getCurrentCwd());
}

function resolveChatProjectRoot(chat: Record<string, any> | null | undefined, clientPath: string): string {
  const execution = normalizeFolder(chat?.executionFolder);
  const workspace = normalizeFolder(chat?.workspaceFolder);
  if (execution) return execution;
  if (workspace) return workspace;
  return clientPath;
}

function reconcileClientPathWithAuthorizedRoot(authorizedRoot: string, clientPath: string): { ok: true, workspaceDir: string } | { ok: false, code: string, error: string } {
  const authReal = resolveTrustedRoot(authorizedRoot);
  if (!authReal) {
    return {
      ok: false,
      code: CURSOR_CONTEXT_SCOPE_ERROR_CODES.WORKSPACE_REQUIRED,
      error: 'Could not resolve authorized project root',
    };
  }
  if (!clientPath) {
    return { ok: true, workspaceDir: authReal };
  }
  const clientReal = resolveTrustedRoot(clientPath);
  if (!clientReal) {
    return {
      ok: false,
      code: CURSOR_CONTEXT_SCOPE_ERROR_CODES.SCOPE_OUT_OF_BOUNDS,
      error: 'Client workspace path is not accessible',
    };
  }
  const within = assertPathWithinProjectRoot(authReal, clientReal);
  if (within.ok === false) {
    return {
      ok: false,
      code: CURSOR_CONTEXT_SCOPE_ERROR_CODES.SCOPE_OUT_OF_BOUNDS,
      error: 'Client workspace is outside the authorized scope',
    };
  }
  return { ok: true, workspaceDir: clientReal };
}

export function resolveCursorContextScope(
  req: CursorContextScopeRequest | null | undefined,
  options: {
    getCurrentCwd?: () => string,
    deps?: { loadChats?: () => object[] },
  } = {},
): CursorContextScopeResult {
  const getCurrentCwd = typeof options.getCurrentCwd === 'function'
    ? options.getCurrentCwd
    : () => process.cwd();
  const loadChatsFn = options.deps?.loadChats || loadChats;
  const input = readCursorContextScopeInput(req);
  const widgetAccess = req?.widgetAccess;
  const audience = widgetAccess ? 'widget' : 'host';
  const legacyWorkspaceDir = resolveLegacyClientWorkspaceDir(req, getCurrentCwd);

  if (widgetAccess) {
    const widgetRoot = normalizeFolder(widgetAccess.workspaceFolder);
    if (!widgetRoot) {
      return {
        ok: false,
        status: 400,
        code: CURSOR_CONTEXT_SCOPE_ERROR_CODES.WORKSPACE_REQUIRED,
        error: 'Widget session requires an authorized workspace folder',
      };
    }
    if (input.chatId) {
      const chat = ((loadChatsFn() || []) as Record<string, any>[]).find((row) => String(row?.id || '') === input.chatId) || null;
      if (!chat) {
        return {
          ok: false,
          status: 404,
          code: CURSOR_CONTEXT_SCOPE_ERROR_CODES.CHAT_NOT_FOUND,
          error: `Unknown chat: ${input.chatId}`,
        };
      }
      if (!widgetChatAccessScope(chat, widgetAccess)) {
        return {
          ok: false,
          status: 403,
          code: CURSOR_CONTEXT_SCOPE_ERROR_CODES.CHAT_ACCESS_DENIED,
          error: 'Chat is outside this widget scope',
        };
      }
    }
    if (input.workspaceFolder && path.resolve(input.workspaceFolder) !== path.resolve(widgetRoot)) {
      return {
        ok: false,
        status: 403,
        code: CURSOR_CONTEXT_SCOPE_ERROR_CODES.SCOPE_OUT_OF_BOUNDS,
        error: 'Client workspace cannot override widget scope',
      };
    }
    const widgetReal = resolveTrustedRoot(widgetRoot);
    if (!widgetReal) {
      return {
        ok: false,
        status: 400,
        code: CURSOR_CONTEXT_SCOPE_ERROR_CODES.WORKSPACE_REQUIRED,
        error: 'Widget workspace is not accessible',
      };
    }
    return {
      ok: true,
      source: 'widget',
      audience,
      workspaceDir: widgetReal,
      projectRoot: widgetReal,
      chatId: input.chatId,
      compareLegacy: input.compareLegacy,
      legacyWorkspaceDir,
    };
  }

  if (input.chatId) {
    const chat = ((loadChatsFn() || []) as Record<string, any>[]).find((row) => String(row?.id || '') === input.chatId) || null;
    if (!chat) {
      return {
        ok: false,
        status: 404,
        code: CURSOR_CONTEXT_SCOPE_ERROR_CODES.CHAT_NOT_FOUND,
        error: `Unknown chat: ${input.chatId}`,
      };
    }
    const authorizedRoot = resolveChatProjectRoot(chat, input.workspaceFolder);
    const reconciled = reconcileClientPathWithAuthorizedRoot(authorizedRoot, input.workspaceFolder);
    if (reconciled.ok === false) {
      return {
        ok: false,
        status: reconciled.code === CURSOR_CONTEXT_SCOPE_ERROR_CODES.SCOPE_OUT_OF_BOUNDS ? 403 : 400,
        code: reconciled.code,
        error: reconciled.error,
      };
    }
    const projectRoot = resolveTrustedRoot(normalizeFolder(chat.workspaceFolder) || authorizedRoot) || reconciled.workspaceDir;
    return {
      ok: true,
      source: 'chat',
      audience,
      workspaceDir: reconciled.workspaceDir,
      projectRoot,
      chatId: input.chatId,
      compareLegacy: input.compareLegacy,
      legacyWorkspaceDir,
    };
  }

  if (input.workspaceFolder) {
    const workspaceReal = resolveTrustedRoot(input.workspaceFolder);
    if (!workspaceReal) {
      return {
        ok: false,
        status: 403,
        code: CURSOR_CONTEXT_SCOPE_ERROR_CODES.SCOPE_OUT_OF_BOUNDS,
        error: 'Requested workspace is not accessible',
      };
    }
    return {
      ok: true,
      source: 'workspace',
      audience,
      workspaceDir: workspaceReal,
      projectRoot: workspaceReal,
      chatId: '',
      compareLegacy: input.compareLegacy,
      legacyWorkspaceDir,
    };
  }

  const globalCwd = normalizeFolder(getCurrentCwd());
  const globalReal = resolveTrustedRoot(globalCwd) || globalCwd;
  return {
    ok: true,
    source: 'global',
    audience,
    workspaceDir: globalReal,
    projectRoot: globalReal,
    chatId: '',
    compareLegacy: input.compareLegacy,
    legacyWorkspaceDir,
  };
}
