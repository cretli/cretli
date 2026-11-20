/** Harness-independent access to the Claude in Chrome extension. */
import { chromeExtensionBridge } from '../../browser/chrome-extension-bridge.js';
import { chromeAccess } from '../../browser/chrome-access.js';
import { resolveBrowserChatOwner } from '../../browser/agent-tools.js';
import { browserScopeKey, resolveBrowserPolicy } from '../../browser/policy-store.js';
import { isBrowserOwnerSessionActive } from '../../auth.js';
import { getChatByIdAsync } from '../../persist/chats-persist.js';
import { loadSettings } from '../../persist/settings.js';
import { resolveDataPath } from '../../runtime-paths.js';
import { hasClaudeSubscriptionAuth } from '../../claude/claude-subscription.ts';
import { isScoutReadOnlyChatId } from '../../workspace-scout-chat.js';
import { lookupMcpExecutionContext } from '../mcp-execution-registry.js';
import { saveBrowserScreenshot } from '../../browser/screenshot-file.js';
import { resolveCretliToolContext, isChatInWorkspace } from './tool-context.js';
import { mcpToolResult } from './result.js';
import { CretliMcpToolError, MCP_BUILTIN_ERROR_CODES as CODES } from './errors.js';

/** Dependencies are injectable so policy tests never touch a real Chrome profile. */
export function createChromeToolExecutor({
  bridge = chromeExtensionBridge,
  loadChat = getChatByIdAsync,
  resolveOwner = resolveBrowserChatOwner,
  ownerActive = isBrowserOwnerSessionActive,
  allowsChrome = (key) => resolveBrowserPolicy(resolveDataPath(), key, loadSettings()).allowClaudeChrome === true,
  subscription = hasClaudeSubscriptionAuth,
  saveImage = saveBrowserScreenshot,
  access = chromeAccess,
} = {}) {
  return async (name, args, session, signal) => {
    const ctx = resolveCretliToolContext(session);
    const initialRun = lookupMcpExecutionContext(session);
    const executionKey = () => {
      const live = lookupMcpExecutionContext(session);
      return JSON.stringify([ctx, session.sessionId, live?.incarnation, live?.runId, live?.attemptId]);
    };
    const accessKey = executionKey();
    let ownerSessionId = '';
    const authorize = async (mayPrompt = false) => {
      const live = lookupMcpExecutionContext(session);
      if (executionKey() !== accessKey || (initialRun && !live)) {
        throw new CretliMcpToolError(CODES.OUT_OF_SCOPE, 'The chat run changed while Chrome access was pending. Start the browser action again in the current run.');
      }
      const mode = typeof session.getMode === 'function' ? session.getMode()
        : typeof live?.getMode === 'function' ? live.getMode() : ctx.mode;
      if (mode !== 'agent') throw new CretliMcpToolError(CODES.PLAN_MODE_DENIED, 'Chrome extension tools require Agent mode.');
      const chat = ctx.chatId ? await loadChat(ctx.chatId) : null;
      if (!chat || !isChatInWorkspace(chat, ctx.workspaceFolder, ctx.workspaceFile)) {
        throw new CretliMcpToolError(CODES.OUT_OF_SCOPE, 'Chrome extension tools require a chat in the calling workspace.');
      }
      // The contract imports the builtin catalog, so load it only at call time.
      const { isWorkspaceWatcherOrchestratorChat } = await import('../mcp-orchestrator-contract.js');
      if (chat.widgetInstallationId || session.delegationId || session.delegationAssignment || live?.delegationId || chat.delegationId || chat.delegationParentChatId
        || chat.delegationAssignment || isScoutReadOnlyChatId(ctx.chatId) || isWorkspaceWatcherOrchestratorChat(chat)) {
        throw new CretliMcpToolError(CODES.OUT_OF_SCOPE, 'Delegations, Watcher and Scout cannot use the Chrome extension.');
      }
      if (!subscription()) {
        throw new CretliMcpToolError(CODES.HARNESS_UNAVAILABLE, 'Claude in Chrome requires an existing Claude Code subscription login. Sign in to Claude Code; the chat authentication mode can remain API key.');
      }
      let grant = access.get(accessKey);
      const attachedOwner = resolveOwner(ctx.chatId);
      if (mayPrompt && !grant && (!allowsChrome(browserScopeKey(ctx)) || !attachedOwner || !ownerActive(attachedOwner))) {
        if (!initialRun?.runId) {
          throw new CretliMcpToolError(CODES.OUT_OF_SCOPE, 'A Chrome access request needs an active Cretli chat run. Start a new message in Cretli and retry.');
        }
        grant = await access.request(accessKey, ctx.chatId, () => executionKey() === accessKey);
        if (signal?.aborted) signal.throwIfAborted();
        if (grant.decision === 'allow') return authorize();
      }
      if (grant && grant.decision !== 'allow') {
        const pending = grant.decision === 'pending';
        throw new CretliMcpToolError(CODES.OUT_OF_SCOPE, pending
          ? 'browser-access-pending: A global Chrome access request is waiting in Cretli. The user can approve it from any chat or panel. Retry this tool after approval; do not ask the user to sign in again.'
          : `browser-access-${grant.decision}: Chrome access was refused or expired. Do not retry unless the user asks.`);
      }
      if (!grant && !allowsChrome(browserScopeKey(ctx))) {
        throw new CretliMcpToolError(CODES.OUT_OF_SCOPE, 'Chrome access is no longer authorized for this workspace.');
      }
      const owner = grant?.ownerSessionId || attachedOwner;
      if (!owner || !ownerActive(owner) || (ownerSessionId && owner !== ownerSessionId)) {
        if (grant) access.revoke(accessKey);
        throw new CretliMcpToolError(CODES.OUT_OF_SCOPE, 'The login authorizing Chrome access ended. Retry to request access from a signed-in Cretli window.');
      }
      ownerSessionId = owner;
    };
    if (name === 'chrome_call' && (args.confirm !== true || typeof args.tool !== 'string' || !args.tool.trim()
      || !args.arguments || typeof args.arguments !== 'object' || Array.isArray(args.arguments))) {
      throw new CretliMcpToolError(CODES.VALIDATION_ERROR, 'chrome_call requires tool, an arguments object and confirm:true.');
    }
    await authorize(true);
    let result;
    try {
      result = await bridge.execute(
        { ...ctx, sessionId: session.sessionId || ctx.chatId, ownerSessionId, authorize: () => authorize() },
        name === 'chrome_call' ? args.tool : '', args.arguments || {}, signal,
      );
    } catch (error) {
      if (error instanceof CretliMcpToolError) throw error;
      throw new CretliMcpToolError(CODES.HARNESS_UNAVAILABLE,
        `Chrome extension bridge failed: ${error.message}. Check Claude CLI, Claude subscription login and the Chrome extension connection.`);
    }
    if (name === 'chrome_tools') return mcpToolResult(JSON.stringify(result), result);
    // Keep images available both as MCP content and as files for text-only harnesses.
    const content = [];
    for (const part of result.content || []) {
      if (part.type === 'image' && ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(part.mimeType)) {
        const saved = saveImage(ctx.chatId, { data: part.data, mimeType: part.mimeType });
        content.push({ type: 'text', text: `Chrome image: ${saved.path}${saved.mediaUrl ? `\nPreview: ${saved.mediaUrl}` : ''}` });
      }
      content.push(part);
    }
    return { ...result, content };
  };
}

const execute = createChromeToolExecutor();
const description = 'Claude in Chrome extension in the user\'s real Chrome, available to every harness. '
  + 'Requires an existing Claude Code subscription login and the connected extension. If access is missing, Cretli shows a global request naming this chat; the user can allow this run without opening settings. Chat authentication may remain API key. '
  + 'Uses signed-in accounts; extension site approvals apply. Separate from the Cretli Browser panel and CDP. '
  + 'Unavailable in delegations, Watcher, Scout and read-only modes. ';

export const CHROME_MCP_TOOLS = [
  {
    name: 'chrome_tools',
    description: description + 'List upstream tool names, descriptions and input schemas. Use before chrome_call; start with tabs_context_mcp to obtain tab IDs.',
    readOnly: false,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: (args, { session, signal }) => execute('chrome_tools', args, session, signal),
  },
  {
    name: 'chrome_call',
    description: description + 'Call an upstream tool from chrome_tools, passing its exact arguments. Supports reading pages, navigation, clicks, typing and screenshots. Requires confirm:true; never guess tab IDs.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: 'Exact upstream tool name from chrome_tools.' },
        arguments: { type: 'object', additionalProperties: true, description: 'Arguments matching the upstream inputSchema.' },
        confirm: { type: 'boolean', description: 'Must be true: acknowledges access to the user\'s live Chrome.' },
      },
      required: ['tool', 'arguments', 'confirm'],
      additionalProperties: false,
    },
    handler: (args, { session, signal }) => execute('chrome_call', args, session, signal),
  },
];
