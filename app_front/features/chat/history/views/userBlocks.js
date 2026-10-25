import { resetSdkStreamState } from '../../../../lib/sdk-chat-format.js';
import { formatChatTimestamp } from '../../../../lib/chat-timestamp.js';
import { isSdkRunFailureStatus, presentSdkActivityTrayStatus } from '../../../../../lib/sdk/sdk-run-outcome.ts';
import { extractTodoRefsFromMessage, todoStatusLabelKey } from '../../todoMention.js';
import { stripTodoExecutionWorkflow } from '../../../../../lib/todo-execution-prompt.js';
import { parseContextSeedPayload } from '../../../../lib/context-seed-payload.js';
import { parseInheritedPrompt } from '../../../../../lib/conversation-fork.js';
import { t } from '../../../../i18n/index.js';
import { resolveChatMessageRefAction } from '../../../../../lib/chat-message-ref.js';
import { escapeHtml } from '../../chatHtmlUtils.js';
import { appendInlineImageThumbs, collectInlineImageRefs, stripScreenshotMarkers } from '../services/inlineImages.js';

/**
 * User, assistant and context-seed message blocks and queued prompts.
 *
 * @param {any} rv Shared view scope created by `createSdkRichView`.
 */
export function installUserBlocks(rv) {
  const { chat, hooks } = rv;
  rv.resolveRunFinishedLineClass = resolveRunFinishedLineClass;
  rv.lineMeta = lineMeta;
  rv.relabelQueuedBlocks = relabelQueuedBlocks;
  rv.normalizeUserPromptText = normalizeUserPromptText;
  rv.findUserBlockByText = findUserBlockByText;
  rv.hasQueuedOrSentUserText = hasQueuedOrSentUserText;
  rv.attachQueuedBlockActions = attachQueuedBlockActions;
  rv.readBlockMessagePoint = readBlockMessagePoint;
  rv.applyMessageSourceActions = applyMessageSourceActions;
  rv.createSdkBlock = createSdkBlock;
  rv.createAssistantBlock = createAssistantBlock;
  rv.createUserBlock = createUserBlock;
  rv.createContextSeedBlock = createContextSeedBlock;
  rv.resolveVisibleUserPromptText = resolveVisibleUserPromptText;
  rv.renderUserTurn = renderUserTurn;
  rv.emitHistoryTurn = emitHistoryTurn;

  /**
   * @param {unknown} status
   * @returns {string}
   */
  function resolveRunFinishedLineClass(status, lastErrorCode = '') {
    const presented = presentSdkActivityTrayStatus({ status, lastErrorCode });
    const normalized = presented.datasetStatus || String(status || '').trim().toLowerCase();
    if (
      !normalized
      || normalized === 'finished'
      || normalized === 'completed'
      || normalized === 'reported'
    ) {
      return 'sdk-rich-line--ok';
    }
    if (isSdkRunFailureStatus(normalized)) return 'sdk-rich-line--err';
    return 'sdk-rich-line--warn';
  }

  /**
   * @param {string} htmlClass
   * @param {string} htmlInner
   * @param {string} [createdAt]
   * @param {boolean} [compactHidden]
   * @returns {string}
   */
  function lineMeta(
    htmlClass,
    htmlInner,
    createdAt = '',
    compactHidden = false,
    skipTimeoutFinalize = false
  ) {
    const rawCreatedAt =
      typeof createdAt === 'string' && createdAt.trim()
        ? createdAt
        : rv.renderedRecordCreatedAt || new Date().toISOString();
    const date = new Date(rawCreatedAt);
    const validDate = Number.isFinite(date.getTime()) ? date : new Date();
    const normalizedCreatedAt = validDate.toISOString();

    const div = document.createElement('div');
    div.className = `sdk-rich-line ${htmlClass}`;

    const content = document.createElement('div');
    content.className = 'sdk-rich-line__content';
    content.innerHTML = htmlInner;
    div.appendChild(content);

    const time = document.createElement('time');
    time.className = 'sdk-rich-line__timestamp';
    time.dateTime = normalizedCreatedAt;
    time.title = normalizedCreatedAt;
    time.textContent = formatChatTimestamp(validDate, t('sdkBlock.yesterday'));
    div.appendChild(time);

    if (compactHidden) {
      rv.compactStatusLines.add(div);
      div.hidden = rv.uiMode === 'compact';
    }
    rv.appendStreamChild(div, { skipTimeoutFinalize });
    rv.scrollToBottom();
    return normalizedCreatedAt;
  }

  const queuedUserBlocks = [];
  rv.queuedUserBlocks = queuedUserBlocks;

  /**
   * Renumbers the labels of all pending queue blocks.
   */
  function relabelQueuedBlocks() {
    queuedUserBlocks.forEach((item, idx) => {
      if (!item.block) return;
      item.block.label = t('sdkView.youQueuedNumbered', { n: idx + 1 });
    });
  }

  function normalizeUserPromptText(text) {
    return text == null ? '' : String(text).trim();
  }

  function findUserBlockByText(text) {
    const raw = normalizeUserPromptText(text);
    if (!raw) return null;
    return Array.from(rv.stream.children).find(
      (item) => item?.localName === 'cr-sdk-block' && normalizeUserPromptText(item.copyText) === raw,
    ) || null;
  }

  function hasQueuedOrSentUserText(text) {
    const raw = normalizeUserPromptText(text);
    if (!raw) return false;
    if (queuedUserBlocks.some((item) => normalizeUserPromptText(item.text) === raw)) return true;
    return !!findUserBlockByText(raw);
  }

  function attachQueuedBlockActions(block, text) {
    block.classList.add('sdk-rich-block--queued');
    block.queued = true;
    // Not sent yet — the history cut point would be ambiguous, so no fork action
    // until the queued record is promoted to a sent localUser record.
    block.forkable = false;
    block.addEventListener('cr-sdk-block-force-send', () => {
      if (typeof hooks.onForceSendQueueItem === 'function') hooks.onForceSendQueueItem(text);
    });
    block.addEventListener('cr-sdk-block-remove', () => {
      if (typeof hooks.onRemoveQueueItem === 'function') hooks.onRemoveQueueItem(text);
    });
    applyMessageSourceActions(block);
  }

  /**
   * Creates a consistent collapsible SDK block (<cr-sdk-block>) and appends it to the stream.
   *
   * @param {{ variant?: string, label?: string, name?: string, paths?: string[], open?: boolean, createdAt?: string }} opts
   * @returns {HTMLElement} the <cr-sdk-block> element (light DOM host for the content)
   */
  function readBlockMessagePoint(block) {
    if (!(block instanceof HTMLElement)) {
      return { historySeq: 0, createdAt: '', text: '' };
    }
    const seq = Number(/** @type {any} */ (block).historySeq);
    const createdAt =
      typeof /** @type {any} */ (block).createdAt === 'string'
        ? /** @type {any} */ (block).createdAt.trim()
        : '';
    const text =
      typeof /** @type {any} */ (block).getBlockCopyText === 'function'
        ? String(/** @type {any} */ (block).getBlockCopyText() || '').trim()
        : String(/** @type {any} */ (block).copyText || '').trim();
    return {
      historySeq: Number.isSafeInteger(seq) && seq > 0 ? seq : 0,
      createdAt,
      text,
    };
  }

  function applyDelegationArrows(block) {
    if (!(block instanceof HTMLElement)) return;
    const hasParent = typeof chat?.delegationParentChatId === 'string'
      && chat.delegationParentChatId.trim() !== '';
    const variant = String(block.variant || '');
    const eligibleVariant = variant === 'user' || variant === 'assistant';
    const blocked = block.running === true || block.queued === true || !eligibleVariant;
    const seq = Number(block.historySeq);
    const saved = Number.isSafeInteger(seq) && seq > 0;
    if (blocked) {
      block.passable = false;
      block.replyable = false;
      block.passDisabled = false;
      block.passHint = '';
      return;
    }
    if (!saved) {
      block.passable = false;
      block.replyable = false;
      block.passDisabled = true;
      block.passHint = t('sdkBlock.passNeedsSavedHistory');
      return;
    }
    block.passDisabled = false;
    block.passHint = '';
    block.passable = true;
    block.replyable = hasParent;
  }

  /**
   * Copy-ref is independent of Fork/Pass. Hide thinking/tool/queued/running;
   * disable with a hint when the block is user/assistant but not yet saved.
   *
   * @param {HTMLElement} block
   */
  function applyCopyRefAction(block) {
    if (!(block instanceof HTMLElement)) return;
    const chatId = String(block.chatId || chat?.id || '').trim();
    if (chatId && 'chatId' in block) block.chatId = chatId;
    const action = resolveChatMessageRefAction({
      variant: block.variant,
      historySeq: block.historySeq,
      chatId,
      queued: block.queued === true,
      running: block.running === true,
    });
    block.refCopyable = action.visible && action.enabled;
    block.refCopyDisabled = action.visible && !action.enabled;
    block.refCopyHint = action.reason === 'needs_saved_history'
      ? t('sdkBlock.copyRefNeedsSavedHistory')
      : '';
  }

  function applyMessageSourceActions(block) {
    if (!(block instanceof HTMLElement)) return;
    const chatId = String(chat?.id || '').trim();
    if (chatId && 'chatId' in block) block.chatId = chatId;
    if (rv.renderedRecordHistorySeq > 0) {
      const current = Number(block.historySeq) || 0;
      if (current <= 0 || current === rv.renderedRecordHistorySeq) {
        block.historySeq = rv.renderedRecordHistorySeq;
      }
    }
    applyDelegationArrows(block);
    applyCopyRefAction(block);
  }

  function createSdkBlock(opts = {}) {
    const block = document.createElement('cr-sdk-block');
    block.variant = opts.variant || 'muted';
    block.label = opts.label || '';
    block.name = opts.name || '';
    block.paths = Array.isArray(opts.paths) ? opts.paths : [];
    block.open = opts.open === true;
    block.createdAt =
      typeof opts.createdAt === 'string' && opts.createdAt
        ? opts.createdAt
        : rv.renderedRecordCreatedAt || new Date().toISOString();
    const seq = Number(opts.historySeq);
    block.historySeq = Number.isSafeInteger(seq) && seq > 0
      ? seq
      : (rv.renderedRecordHistorySeq || 0);
    const chatId = String(chat?.id || '').trim();
    if (chatId) block.chatId = chatId;
    rv.appendStreamChild(block, { skipTimeoutFinalize: opts.skipTimeoutFinalize === true });
    return block;
  }

  /**
   * Assistant answer block rendered as a regular cr-sdk-block.
   *
   * @returns {HTMLElement} host for the Markdown content
   */
  function createAssistantBlock() {
    const block = createSdkBlock({ variant: 'assistant', label: t('sdkView.answer'), open: true });
    block.speakable = true;
    block.forkable = true;
    applyMessageSourceActions(block);
    const mdEl = document.createElement('div');
    mdEl.className = 'sdk-md sdk-rich-md sdk-rich-assistant-md';
    block.appendChild(mdEl);
    return mdEl;
  }

  /**
   * Compact todo marker inside a user turn. The raw pointer stays in copyText.
   *
   * @param {HTMLElement} body
   * @param {string} todoId
   */
  function appendTodoHistoryRow(body, todoId) {
    const known = chat._todoRowMeta && chat._todoRowMeta[todoId];
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'sdk-rich-todo-row';
    const title = document.createElement('span');
    title.className = 'sdk-rich-todo-row-title';
    title.textContent = known?.title || todoId.slice(0, 8);
    const statusKey = todoStatusLabelKey(known?.status);
    if (statusKey) {
      const status = document.createElement('span');
      status.className = 'sdk-rich-todo-row-status';
      status.textContent = t(statusKey);
      row.append(title, status);
    } else {
      row.append(title);
    }
    row.addEventListener('click', () => {
      document.dispatchEvent(new CustomEvent('cretli-open-todo', { detail: { todoId } }));
    });
    body.appendChild(row);
    if (known?.title || typeof hooks.resolveTodoRow !== 'function') return;
    void Promise.resolve(hooks.resolveTodoRow(todoId)).then((summary) => {
      const nextTitle = String(summary?.title || '').trim();
      if (!nextTitle) return;
      if (!chat._todoRowMeta) chat._todoRowMeta = {};
      chat._todoRowMeta[todoId] = {
        title: nextTitle,
        status: String(summary?.status || ''),
      };
      title.textContent = nextTitle;
      const statusKeyNext = todoStatusLabelKey(summary?.status);
      let statusEl = row.querySelector('.sdk-rich-todo-row-status');
      if (!statusKeyNext) {
        statusEl?.remove();
        return;
      }
      if (!(statusEl instanceof HTMLElement)) {
        statusEl = document.createElement('span');
        statusEl.className = 'sdk-rich-todo-row-status';
        row.appendChild(statusEl);
      }
      statusEl.textContent = t(statusKeyNext);
    }).catch(() => {});
  }

  /**
   * User message rendered as a regular cr-sdk-block.
   *
   * @param {string} textRaw
   * @param {string} [createdAt]
   * @returns {HTMLElement} the <cr-sdk-block> element
   */
  function createUserBlock(textRaw, createdAt = '') {
    const text = String(textRaw || '').trim();
    if (!text) return null;
    const block = createSdkBlock({ variant: 'user', label: t('sdkView.you'), open: true, createdAt });
    block.forkable = true;
    applyMessageSourceActions(block);
    let shown = text;
    if (text === 'Child reply') shown = t('chat.mailboxReplyFromChild');
    else if (text === 'Task from parent') shown = t('chat.mailboxTaskFromParent');
    const extracted = extractTodoRefsFromMessage(shown);
    const continuePrompt = t('sendBar.todoContinuePrompt');
    const displayText = extracted.todoIds.length ? stripTodoExecutionWorkflow(extracted.text) : extracted.text;
    const visibleText = extracted.todoIds.length && displayText === continuePrompt
      ? ''
      : displayText;
    const textForDisplay = stripScreenshotMarkers(visibleText);
    block.copyText = text;
    const body = document.createElement('div');
    body.className = 'sdk-rich-user-body';
    if (textForDisplay) {
      body.innerHTML = escapeHtml(textForDisplay).replace(/\r?\n/g, '<br/>');
    }
    extracted.todoIds.forEach((todoId) => appendTodoHistoryRow(body, todoId));
    appendInlineImageThumbs(body, collectInlineImageRefs(text));
    if (!textForDisplay && extracted.todoIds.length === 0 && !body.childElementCount) return null;
    block.appendChild(body);
    return block;
  }

  /**
   * Collapsed block for compressed conversation context seeded after reset.
   *
   * @param {string} summaryRaw
   * @param {string} [createdAt]
   * @returns {HTMLElement}
   */
  function createContextSeedBlock(summaryRaw, createdAt = '') {
    const summary = String(summaryRaw || '').trim();
    const block = createSdkBlock({
      variant: 'muted',
      label: t('sdkView.contextCompressed'),
      open: false,
      createdAt,
    });
    block.classList.add('sdk-rich-block--context-seed');
    block.copyText = summary;
    const body = document.createElement('div');
    body.className = 'sdk-rich-context-seed-body';
    body.innerHTML = escapeHtml(summary).replace(/\r?\n/g, '<br/>');
    block.appendChild(body);
    return block;
  }

  function inheritedPromptDisplayLabel(kind) {
    if (kind === 'analyze') return t('chat.monitorAgentDisplayPrompt');
    if (kind === 'handoff') return t('chat.harnessHandoffDisplayText');
    return t('chat.forkContinueDisplayText');
  }

  /**
   * Text shown in the user bubble (unwraps compressed context and fork/handoff wrappers).
   *
   * @param {unknown} textRaw
   * @returns {string}
   */
  function resolveVisibleUserPromptText(textRaw) {
    const parsed = parseContextSeedPayload(textRaw);
    if (parsed.hasSeed) return parsed.userText.trim();
    const inherited = parseInheritedPrompt(textRaw);
    if (!inherited.wrapped) return String(textRaw || '').trim();
    if (inherited.kind === 'analyze') return inheritedPromptDisplayLabel('analyze');
    if (inherited.followUp) return inherited.followUp;
    return inheritedPromptDisplayLabel(inherited.kind);
  }

  /**
   * Render a user turn, splitting compressed context from the visible user message.
   *
   * @param {string} textRaw
   * @param {string} [createdAt]
   * @returns {string} user text used for dedupe / queue matching
   */
  function renderUserTurn(textRaw, createdAt = '') {
    const parsed = parseContextSeedPayload(textRaw);
    if (parsed.hasSeed) {
      if (parsed.summary.trim()) createContextSeedBlock(parsed.summary.trim(), createdAt);
      const userText = parsed.userText.trim();
      if (userText) createUserBlock(userText, createdAt);
      return userText;
    }
    const inherited = parseInheritedPrompt(textRaw);
    if (inherited.wrapped) {
      const label = inheritedPromptDisplayLabel(inherited.kind);
      if (!findUserBlockByText(label)) createUserBlock(label, createdAt);
      if (
        inherited.kind !== 'analyze' &&
        inherited.followUp &&
        !findUserBlockByText(inherited.followUp)
      ) {
        createUserBlock(inherited.followUp, createdAt);
      }
      const echo = inherited.kind === 'analyze' ? label : inherited.followUp || label;
      chat._sdkLastLocalUserEcho = echo;
      return echo;
    }
    const text = String(textRaw || '').trim();
    if (!text) return '';
    if (findUserBlockByText(text)) {
      chat._sdkLastLocalUserEcho = text;
      return text;
    }
    createUserBlock(text, createdAt);
    return text;
  }

  /**
   * Renders one conversation turn (history/API or a restored plaintext buffer).
   *
   * @param {boolean} isUser
   * @param {string} textRaw
   */
  function emitHistoryTurn(isUser, textRaw) {
    const text = String(textRaw || '').trim();
    if (!text) return;

    resetSdkStreamState(chat);
    rv.clearSegmentPointers();

    if (isUser) {
      renderUserTurn(text);
      rv.scrollToBottom();
      return;
    }

    const mdEl = createAssistantBlock();
    rv.flushMarkdown(mdEl, text);
  }
}
