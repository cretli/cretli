import { extractAssistantPlainText, isEmptyAssistantStreamPayload, isHarnessErrorAssistantText, projectStreamAccumulator, resetSdkStreamState, takeStreamDelta, textsOverlap } from '../../../../lib/sdk-chat-format.js';
import { presentSdkActivityTrayStatus } from '../../../../../lib/sdk/sdk-run-outcome.ts';
import { splitTrailingTitleJson } from '../../chatTitleParsing.js';
import { buildStableSdkToolCallFallback, canonicalizeSdkToolStatus, findOpenSdkToolRecord, hasRunningSdkTools, isEmptyGenericSdkToolEvent, isOpenSdkToolStatus, isTerminalSdkRunStatus, isTerminalSdkToolStatus, normalizeSdkToolStreamEvent, resolveSdkToolCallId, shouldAcceptSdkToolStatus, updateRunningSdkToolState } from '../../../../../lib/sdk/sdk-thinking-state.ts';
import { extractPlanTextFromSdkEvent } from '../../../../../lib/sdk/sdk-plan-text.ts';
import { isPlaceholderSdkPlanMarkdown, mergeSdkPlanMarkdown } from '../../../../../lib/sdk/sdk-plan-block-reuse.ts';
import { parseInheritedPrompt } from '../../../../../lib/conversation-fork.js';
import { t } from '../../../../i18n/index.js';
import { isToolSearchName, parseToolSearchQuery, presentToolSearchUpdate, readToolSearchQuery } from '../../../../../lib/agent-harness/tool-search-display.ts';
import { escapeHtml } from '../../chatHtmlUtils.js';
import { resolveViewOrderKey } from '../../chatHistoryViewOrder.js';
import { extractUserPlain, pathsFromToolArgs, stringifySnippet } from './sdkEventNormalize.js';

/**
 * SDK event dispatch (applySdkEventCore).
 *
 * @param {any} rv Shared view scope created by `createSdkRichView`.
 */
export function installSdkEventApply(rv) {
  const { chat, hooks } = rv;
  rv.applySdkEvent = applySdkEvent;

  /**
   * @param {unknown} event
   */
  function applySdkEventCore(event) {
    if (!event || typeof event !== 'object') return;
    const ev = normalizeSdkToolStreamEvent(event) || /** @type {Record<string, unknown>} */ (event);
    const eventType = typeof ev.type === 'string' ? ev.type.toLowerCase() : '';

    // Context usage is high-frequency metadata and does not belong in the chat timeline.
    if (eventType === 'context_usage') return;

    if (eventType === 'user') {
      rv.stopTimeoutProgressSeries();
      rv.runScope += 1;
      if (!rv.suppressHistoryPersist) rv.openLiveTurn();
      rv.resumeThinkingAfterStreamReset = false;
      rv.resumeAssistantAfterStreamReset = false;
      resetSdkStreamState(chat);
      rv.clearSegmentPointers();
      const plain = extractUserPlain(ev);
      const inherited = parseInheritedPrompt(plain);
      const userEchoKey = rv.resolveVisibleUserPromptText(plain);
      if (userEchoKey === chat._sdkLastLocalUserEcho && !inherited.wrapped) {
        rv.scrollToBottom();
        return;
      }
      if (rv.findUserBlockByText(userEchoKey) && !inherited.followUp) {
        chat._sdkLastLocalUserEcho = userEchoKey;
        rv.scrollToBottom();
        return;
      }
      if (!rv.suppressHooksPlain) hooks.appendPlain(`\n[user] ${userEchoKey}\n`);
      rv.renderUserTurn(plain);
      rv.scrollToBottom();
      rv.persistThisSdkEvent(ev);
      return;
    }

    if (eventType === 'assistant') {
      const full = extractAssistantPlainText(ev);
      // Some Codex turn/item lifecycle events carry an empty assistant
      // payload. They must not create a visible answer card with only its
      // header, especially after the final tool/usage event. A whitespace-only
      // payload is a real stream delta (newlines/spaces), not an empty event.
      // The later `!display.trim()` check removes the card if the whole answer
      // is still blank.
      if (isEmptyAssistantStreamPayload(full) || isHarnessErrorAssistantText(full)) return;
      rv.stopTimeoutProgressSeries();
      if (rv.activeKind === 'thinking') {
        delete chat._sdkThinkingAcc;
        const thinkingRunKey = rv.activeThinkingRunKey || rv.getEventRunKey(ev);
        const shouldKeepThinkingOpen = hasRunningSdkTools(rv.runningToolCallsByRun, thinkingRunKey);
        if (shouldKeepThinkingOpen) {
          rv.syncThinkingBlockRunning(thinkingRunKey);
          if (rv.thinkingDetails) rv.thinkingDetails.open = true;
        } else {
          rv.setThinkingRunning(false);
          if (rv.thinkingDetails) rv.thinkingDetails.open = false;
        }
        rv.thinkingDetails = null;
        rv.thinkingPre = null;
        rv.activeThinkingRunKey = '';
      }
      // A new answer block must start from a clean accumulator.
      if (!rv.assistantMdEl && rv.snapshotAdoptCandidate instanceof HTMLElement) {
        const candidateRaw = rv.snapshotAdoptCandidate.dataset.rawMd || '';
        if (candidateRaw && (full.startsWith(candidateRaw) || candidateRaw.startsWith(full))) {
          delete chat._sdkAssistantAcc;
          rv.adoptAssistantBlock(rv.snapshotAdoptCandidate);
        }
        rv.snapshotAdoptCandidate = null;
      }
      if (!rv.assistantMdEl) {
        const sameKeyBlock = rv.findStreamChildByOrderKey(resolveViewOrderKey({
          historySeq: rv.renderedRecordHistorySeq,
          roomEventSeq: rv.renderedRecordRoomEventSeq,
          eventStreamId: rv.renderedRecordEventStreamId,
        }));
        const sameKeyMd = sameKeyBlock instanceof HTMLElement
          ? sameKeyBlock.querySelector('.sdk-rich-assistant-md')
          : null;
        if (sameKeyMd instanceof HTMLElement) {
          rv.adoptAssistantBlock(sameKeyMd);
        } else {
          const reused = rv.resolveAssistantBlockAfterReset();
          if (reused) {
            rv.adoptAssistantBlock(reused);
          } else {
            delete chat._sdkAssistantAcc;
          }
        }
      }
      rv.activeKind = 'assistant';
      const assistantPrev = typeof chat._sdkAssistantAcc === 'string' ? chat._sdkAssistantAcc : '';
      const thinkingAcc = typeof chat._sdkThinkingAcc === 'string' ? chat._sdkThinkingAcc : '';
      const projectedAssistant = projectStreamAccumulator(assistantPrev, full);
      if (thinkingAcc && textsOverlap(thinkingAcc, projectedAssistant)) {
        return;
      }
      const delta = takeStreamDelta(chat, '_sdkAssistantAcc', full);
      if (delta && !rv.suppressHooksPlain) hooks.appendPlain(delta);

      if (!rv.assistantMdEl) {
        rv.assistantMdEl = rv.createAssistantBlock();
      } else {
        rv.applyMessageSourceActions(rv.assistantMdEl.closest('cr-sdk-block'));
      }
      const acc = typeof chat._sdkAssistantAcc === 'string' ? chat._sdkAssistantAcc : '';
      const split = splitTrailingTitleJson(acc);
      const display = split.title ? split.text : acc;
      if (!display.trim()) {
        rv.assistantMdEl.closest('cr-sdk-block')?.remove();
        rv.assistantMdEl = null;
      } else if (rv.mdRenderImmediate) {
        rv.flushMarkdown(rv.assistantMdEl, display);
      } else {
        rv.scheduleMd(rv.assistantMdEl, display);
      }
      if (split.title && typeof hooks.onFinishTitle === 'function') {
        hooks.onFinishTitle(split.title);
      }
      if (split.title && !rv.suppressHistoryPersist) {
        rv.closeLiveTurn();
      }
      rv.persistSdkStreamSnapshot(ev, 'assistant', acc);
      // Replayed history must stay silent — only live answers are read aloud.
      if (!rv.suppressHistoryPersist && typeof hooks.onAssistantText === 'function') {
        hooks.onAssistantText(display);
      }
      return;
    }

    if (eventType === 'thinking') {
      rv.stopTimeoutProgressSeries();
      if (rv.activeKind === 'assistant') {
        delete chat._sdkAssistantAcc;
        rv.assistantMdEl = null;
      }
      rv.activeKind = 'thinking';
      const runKey = rv.getEventRunKey(ev);
      if (!rv.thinkingDetails) {
        const reused = rv.resolveThinkingBlockForRun(runKey);
        if (reused) {
          rv.adoptThinkingBlock(reused, runKey);
        } else {
          delete chat._sdkThinkingAcc;
          rv.thinkingDetails = rv.createSdkBlock({ variant: 'thinking', label: t('sdkView.thinking'), open: true });
          rv.thinkingPre = document.createElement('pre');
          rv.thinkingPre.className = 'sdk-rich-thinking-pre';
          rv.thinkingDetails.appendChild(rv.thinkingPre);
        }
      }
      rv.activeThinkingRunKey = runKey;
      const full = typeof ev.text === 'string' ? ev.text : '';
      const unavailable = ev.unavailable === true && !full.trim();
      rv.thinkingDetails.dataset.reasoningUnavailable = unavailable ? 'true' : 'false';
      const truncated = full.length > 12000 ? `${full.slice(0, 12000)}…` : full;
      const assistantAcc = typeof chat._sdkAssistantAcc === 'string' ? chat._sdkAssistantAcc : '';
      const thinkingPrev = typeof chat._sdkThinkingAcc === 'string' ? chat._sdkThinkingAcc : '';
      const projectedThinking = projectStreamAccumulator(thinkingPrev, truncated);
      rv.rememberThinkingBlock(runKey, rv.thinkingDetails);
      rv.syncThinkingBlockRunning(runKey);
      if (assistantAcc && textsOverlap(assistantAcc, projectedThinking)) {
        return;
      }
      const delta = takeStreamDelta(chat, '_sdkThinkingAcc', truncated);
      if (delta && !rv.suppressHooksPlain) hooks.appendPlain(delta);

      if (rv.thinkingPre) {
        const stickThinking = rv.isScrollableNearBottom(rv.thinkingPre);
        rv.thinkingPre.textContent = unavailable
          ? t('sdkView.reasoningUnavailable')
          : (typeof chat._sdkThinkingAcc === 'string' ? chat._sdkThinkingAcc : '');
        rv.thinkingPre.classList.toggle('sdk-rich-thinking-pre--unavailable', unavailable);
        if (stickThinking) rv.stickScrollToBottom(rv.thinkingPre);
      }
      rv.scrollToBottom();
      rv.persistSdkStreamSnapshot(ev, 'thinking', typeof chat._sdkThinkingAcc === 'string' ? chat._sdkThinkingAcc : '');
      return;
    }

    if (eventType === 'tool_call') {
      rv.stopTimeoutProgressSeries();
      if (isEmptyGenericSdkToolEvent(ev)) {
        const ghostRunKey = rv.getEventRunKey(ev);
        const ghostStatus = canonicalizeSdkToolStatus({
          status: ev.status,
          result: ev.result,
        });
        if (isTerminalSdkToolStatus(ghostStatus)) {
          rv.applyStatusToLatestOpenTool(ghostRunKey, ghostStatus);
        }
        return;
      }
      delete chat._sdkAssistantAcc;
      rv.assistantMdEl = null;
      rv.activeKind = 'idle';
      // A tool turn ends the answer that was live before a stream reset; a later
      // assistant snapshot is a new message and must not be merged into it.
      rv.resumeAssistantAfterStreamReset = false;

      const incomingName = typeof ev.name === 'string' ? ev.name.trim() : '';
      const incomingStatus = canonicalizeSdkToolStatus({
        status: ev.status,
        result: ev.result,
      });
      const runKey = rv.getEventRunKey(ev);
      const explicitId = resolveSdkToolCallId(ev);
      const fallbackId = buildStableSdkToolCallFallback(ev, runKey);
      let record = findOpenSdkToolRecord(rv.toolByCallId.values(), {
        callId: explicitId,
        name: incomingName,
        args: ev.args,
        runKey,
        status: incomingStatus,
        result: ev.result,
      });
      if (!record && fallbackId) record = rv.toolByCallId.get(fallbackId) || null;
      const callId = explicitId || record?.callId || fallbackId;
      if (record && record.callId !== callId) {
        rv.toolByCallId.delete(record.callId);
        record.callId = callId;
        if (record.tile) record.tile.dataset.callId = callId;
        if (record.fullBlock) record.fullBlock.dataset.callId = callId;
        rv.toolByCallId.set(callId, record);
      }
      const prevName = record?.event && typeof record.event.name === 'string'
        ? record.event.name.trim()
        : '';
      const genericIncoming = !incomingName || incomingName === '?' || incomingName.toLowerCase() === 'tool';
      const name = genericIncoming && prevName ? prevName : (incomingName || prevName || '?');
      const nameLower = name.toLowerCase();
      const compactName = nameLower.replace(/[^a-z0-9]/g, '');
      if (compactName === 'createplan') {
        const planText = extractPlanTextFromSdkEvent(ev);
        const snippet = stringifySnippet(ev.result, 8000) || stringifySnippet(ev.args, 4000);
        const incomingMarkdown = planText
          || (isPlaceholderSdkPlanMarkdown(snippet) ? '' : snippet);
        let block = rv.findReusablePlanBlock(callId);
        if (!(block instanceof HTMLElement) || !block.isConnected) {
          block = rv.createSdkBlock();
        }
        if (callId) {
          block.dataset.callId = callId;
          rv.planByCallId.set(callId, block);
        }
        block.variant = 'plan';
        const previousStatus = String(block.label || '');
        block.label = shouldAcceptSdkToolStatus(previousStatus, incomingStatus)
          ? (incomingStatus || previousStatus || 'plan')
          : (previousStatus || incomingStatus || 'plan');
        block.name = t('sdkView.implementationPlan');
        block.open = true;
        let mdEl = block.querySelector('.sdk-rich-plan-md');
        if (!mdEl) {
          mdEl = document.createElement('div');
          mdEl.className = 'sdk-md sdk-rich-md sdk-rich-plan-md';
          block.replaceChildren(mdEl);
        }
        rv.flushMarkdown(mdEl, mergeSdkPlanMarkdown(mdEl.dataset.rawMd || '', incomingMarkdown));
        rv.foldDuplicatePlanCards();
        rv.scrollToBottom();
        rv.persistThisSdkEvent(ev);
        return;
      }

      const prevStatus =
        record && record.event && typeof record.event.status === 'string' ? record.event.status : '';
      let status = shouldAcceptSdkToolStatus(prevStatus, incomingStatus)
        ? incomingStatus
        : prevStatus;
      const prevArgs = record?.event?.args && typeof record.event.args === 'object'
        ? /** @type {Record<string, unknown>} */ (record.event.args)
        : null;
      const incomingArgs = ev.args && typeof ev.args === 'object' && !Array.isArray(ev.args)
        ? /** @type {Record<string, unknown>} */ (ev.args)
        : null;
      const args = incomingArgs && Object.keys(incomingArgs).length > 0 ? incomingArgs : prevArgs;
      let result = ev.result !== undefined ? ev.result : record?.event?.result;
      if (isToolSearchName(name) && args) {
        const presented = presentToolSearchUpdate({
          status,
          args,
          result,
          open: isOpenSdkToolStatus(status),
        });
        result = presented.result;
        if (presented.status === 'error' && shouldAcceptSdkToolStatus(status, 'error')) {
          status = 'error';
        }
      }
      const evForUi = {
        ...(status === incomingStatus ? ev : { ...ev, status }),
        name,
        args,
        result,
        status,
      };
      const filePaths = pathsFromToolArgs(args);
      const searchQuery = parseToolSearchQuery(readToolSearchQuery(args));
      const paths = filePaths.length > 0 ? filePaths : (searchQuery ? [searchQuery] : []);
      if (!record) {
        const fullBlock = rv.createSdkBlock({ variant: 'run', label: status || '?', name });
        fullBlock.dataset.callId = callId;
        fullBlock.classList.add('sdk-full-tool-block');
        rv.fullToolBlocks.add(fullBlock);
        record = rv.createCompactToolRecord(callId, fullBlock, evForUi, paths, runKey);
        rv.toolByCallId.set(callId, record);
      }

      record.fullBlock.variant = rv.resolveToolBlockVariant(status);
      record.fullBlock.label = status || '?';
      record.fullBlock.name = name;
      record.fullBlock.paths = paths;
      record.fullBlock.open = isOpenSdkToolStatus(status) || (isToolSearchName(name) && status === 'error');
      record.fullBlock.replaceChildren(rv.createToolBody(evForUi));
      record.fullBlock.hidden = rv.uiMode === 'compact';
      rv.updateCompactToolTile(record, evForUi, paths);
      updateRunningSdkToolState(rv.runningToolCallsByRun, runKey, prevStatus, status);
      rv.syncThinkingBlockRunning(runKey);

      rv.scrollToBottom();
      rv.persistThisSdkEvent(evForUi);
      return;
    }

    if (eventType === 'status') {
      const st = typeof ev.status === 'string' ? ev.status : '';
      const errorCode = typeof ev.lastErrorCode === 'string' ? ev.lastErrorCode.trim() : '';
      // A run announcing itself as running is not the agent's first output. Ending the waiting
      // block here stops its spinner seconds before anything actually arrives — and the status
      // line is hidden in compact mode, so the indicator would die with no visible cause.
      const presented = presentSdkActivityTrayStatus({ status: st, lastErrorCode: errorCode });
      const keepWaiting = !isTerminalSdkRunStatus(st) && !isTerminalSdkRunStatus(presented.terminalStatus);
      if (!keepWaiting) rv.stopTimeoutProgressSeries();
      const msg = typeof ev.message === 'string' ? ev.message : '';
      const runKey = rv.getEventRunKey(ev);
      rv.runStatusByRun.set(runKey, presented.terminalStatus || st);
      if (isTerminalSdkRunStatus(st) || isTerminalSdkRunStatus(presented.terminalStatus)) {
        rv.finalizeRunPresentation(runKey, st, errorCode);
        rv.closeLiveTurn();
      } else {
        rv.openLiveTurn();
        const tray = rv.latestTrayByRun.get(runKey);
        if (tray) rv.setTrayStatus(tray, st, errorCode);
      }
      const statusLabel = rv.resolveActivityTrayLabel(presented.datasetStatus) || st;
      rv.lineMeta(
        'sdk-rich-line--status',
        `<span class="sdk-rich-badge sdk-rich-badge--status">${escapeHtml(statusLabel)}</span> ${escapeHtml(msg)}`,
        '',
        true,
        keepWaiting
      );
      rv.persistThisSdkEvent(ev);
      return;
    }

    if (eventType === 'system') {
      rv.lineMeta(
        'sdk-rich-line--muted',
        '<span class="sdk-rich-badge">system</span>',
        '',
        true,
        true
      );
      rv.persistThisSdkEvent(ev);
      return;
    }

    if (eventType === 'task') {
      const tx = typeof ev.text === 'string' ? ev.text : '';
      rv.lineMeta(
        'sdk-rich-line--task',
        `<span class="sdk-rich-badge">task</span> ${escapeHtml(tx)}`,
        '',
        true,
        true
      );
      rv.persistThisSdkEvent(ev);
      return;
    }

    if (eventType === 'request') {
      rv.stopTimeoutProgressSeries();
      rv.lineMeta(
        'sdk-rich-line--warn',
        `<span class="sdk-rich-badge sdk-rich-badge--warn">Request</span> ${escapeHtml(t('sdkView.userActionRequired'))}`
      );
      rv.persistThisSdkEvent(ev);
      return;
    }

    if (eventType === 'opencode_question') {
      rv.renderOpenCodeQuestion(ev);
      return;
    }

    if (eventType === 'opencode_permission') {
      rv.renderOpenCodePermission(ev);
      return;
    }

    delete chat._sdkAssistantAcc;
    rv.stopTimeoutProgressSeries();
    rv.assistantMdEl = null;
    rv.activeKind = 'idle';
    const rawLabel = eventType ? String(eventType) : 'sdk';
    const rawJson = stringifySnippet(ev, 6000);
    const block = rv.createSdkBlock({ variant: 'muted', label: rawLabel, name: t('sdkView.sdkEvent') });
    if (rawJson) {
      const body = document.createElement('div');
      body.innerHTML = `<details class="sdk-rich-nested"><summary>${escapeHtml(t('sdkView.arguments'))}</summary><pre class="sdk-rich-json">${escapeHtml(rawJson)}</pre></details>`;
      block.appendChild(body);
    }
    if (eventType === 'usage') {
      const runKey = rv.getEventRunKey(ev);
      const callId = `usage-${runKey}`;
      const compactEvent = {
        ...ev,
        type: 'tool_call',
        name: 'usage',
        status: 'completed',
        args: ev.usage ?? ev,
      };
      block.classList.add('sdk-full-tool-block');
      rv.fullToolBlocks.add(block);
      block.hidden = rv.uiMode === 'compact';
      const existing = rv.toolByCallId.get(callId);
      if (existing) {
        block.remove();
        existing.event = compactEvent;
        existing.fullBlock.replaceChildren(rv.createToolBody(compactEvent));
        rv.updateCompactToolTile(existing, compactEvent, []);
      } else {
        const record = rv.createCompactToolRecord(callId, block, compactEvent, [], runKey);
        rv.toolByCallId.set(callId, record);
      }
    }
    rv.scrollToBottom();
    rv.persistThisSdkEvent(ev);
  }

  function applySdkEvent(event, createdAt = '', historySeq = 0) {
    const previousCreatedAt = rv.renderedRecordCreatedAt;
    const previousSeq = rv.renderedRecordHistorySeq;
    rv.renderedRecordCreatedAt =
      typeof createdAt === 'string' && createdAt.trim() ? createdAt : new Date().toISOString();
    rv.renderedRecordHistorySeq = Number(historySeq) > 0 ? Number(historySeq) : 0;
    try {
      applySdkEventCore(event);
    } finally {
      rv.renderedRecordCreatedAt = previousCreatedAt;
      rv.renderedRecordHistorySeq = previousSeq;
    }
  }
}
