import { extractAssistantPlainText, isEmptyAssistantStreamPayload, isHarnessErrorAssistantText, mergeThinkingSnapshot, projectStreamAccumulator, resetSdkStreamState, takeStreamDelta, takeThinkingStreamDelta, textsOverlap } from '../../../../lib/sdk-chat-format.js';
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
import { appendInlineImageThumbs, collectLocalImageRefs } from './inlineImages.js';
import { settleDeliveredSdkSteer } from '../../services/sdkPendingSteer.js';

/**
 * SDK event dispatch (applySdkEventCore).
 *
 * @param {any} rv Shared view scope created by `createSdkRichView`.
 */
export function installSdkEventApply(rv) {

  /**
   * A reconnect may resume the answer that was live, never start a new one inside an
   * older block. Snapshot events carry the whole text so far, so a resumed snapshot
   * extends (or repeats) the block text; anything else is a different answer, and
   * adopting the block would append each snapshot to the old text.
   *
   * @param {HTMLElement} mdEl
   * @param {string} full
   * @param {Record<string, unknown>} ev
   * @returns {boolean}
   */
  /**
   * The same answer can reach the view twice (live snapshots, then its saved record
   * through a catch-up, the local cache or a replay). A full answer identical to one
   * already shown in this turn updates that card instead of adding a second copy.
   * Only whole texts are compared: delta fragments and very short answers are skipped.
   *
   * @param {string} full
   * @param {Record<string, unknown>} ev
   * @returns {HTMLElement | null}
   */
  function findIdenticalAnswerInTurn(full, ev) {
    if (ev?.streamTextMode === 'delta') return null;
    const text = String(full || '').trim();
    if (text.length < 24) return null;
    for (let el = rv.stream.lastElementChild; el; el = el.previousElementSibling) {
      if (!(el instanceof HTMLElement)) continue;
      if (/** @type {any} */ (el).variant === 'user') return null;
      const md = el.querySelector('.sdk-rich-assistant-md');
      if (md instanceof HTMLElement && String(md.dataset.rawMd || '').trim() === text) return md;
    }
    return null;
  }

  function continuesAssistantBlock(mdEl, full, ev) {
    if (ev?.streamTextMode !== 'snapshot') return true;
    const existing = mdEl?.dataset?.rawMd || '';
    if (!existing || !full) return true;
    return full.startsWith(existing) || existing.startsWith(full);
  }
  const { chat, hooks } = rv;
  rv.applySdkEvent = applySdkEvent;

  /** Tells the read-aloud speaker the live answer block ended; replayed history stays silent. */
  function endAssistantBlockForSpeech() {
    if (rv.suppressHistoryPersist || typeof hooks.onAssistantBlockEnd !== 'function') return;
    if (typeof chat._sdkAssistantAcc === 'string' && chat._sdkAssistantAcc) hooks.onAssistantBlockEnd();
  }

  /**
   * @param {unknown} event
   */
  function applySdkEventCore(event) {
    if (!event || typeof event !== 'object') return;
    const ev = normalizeSdkToolStreamEvent(event) || /** @type {Record<string, unknown>} */ (event);
    const eventType = typeof ev.type === 'string' ? ev.type.toLowerCase() : '';

    // Context usage is high-frequency metadata and does not belong in the chat timeline.
    if (eventType === 'context_usage') return;

    // Run-start/activity signals for the voice speaker: a queued prompt that starts with
    // thinking or a tool call is running before any answer text exists.
    if (
      (eventType === 'user' || eventType === 'assistant' || eventType === 'thinking' || eventType === 'tool_call')
      && !rv.suppressHistoryPersist
      && typeof hooks.onRunActivity === 'function'
    ) {
      hooks.onRunActivity();
    }

    if (eventType === 'local_images') {
      const refs = collectLocalImageRefs(ev);
      if (refs.length > 0) {
        // Beside the markdown host, whose content is replaced on every repaint.
        const host = rv.assistantMdEl?.closest('cr-sdk-block') || rv.createAssistantBlock().closest('cr-sdk-block');
        // A WS replay can deliver the same event again.
        const shown = new Set(Array.from(host.querySelectorAll('.sdk-rich-inline-thumb img')).map((img) => img.getAttribute('src')));
        appendInlineImageThumbs(host, refs.filter((ref) => !shown.has(ref.href)), { large: true });
      }
      rv.scrollToBottom();
      rv.persistThisSdkEvent(ev);
      return;
    }

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
      // The echo correlates only with the very next SDK user event: consume it either way.
      const pendingEcho = chat._sdkLastLocalUserEcho;
      chat._sdkLastLocalUserEcho = '';
      // An injected steer arrives as a user event: promote its queued echo instead of rendering a copy.
      if (!inherited.wrapped && settleDeliveredSdkSteer(chat, userEchoKey)) {
        chat._sdkLastLocalUserEcho = '';
        rv.scrollToBottom();
        return;
      }
      if (pendingEcho && userEchoKey === pendingEcho && !inherited.wrapped) {
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
          const sameAnswer = reused ? null : findIdenticalAnswerInTurn(full, ev);
          if (reused && continuesAssistantBlock(reused, full, ev)) {
            rv.adoptAssistantBlock(reused);
          } else if (sameAnswer) {
            delete chat._sdkAssistantAcc;
            rv.adoptAssistantBlock(sameAnswer);
          } else {
            delete chat._sdkAssistantAcc;
          }
        }
      }
      rv.activeKind = 'assistant';
      const assistantPrev = typeof chat._sdkAssistantAcc === 'string' ? chat._sdkAssistantAcc : '';
      const thinkingAcc = typeof chat._sdkThinkingAcc === 'string' ? chat._sdkThinkingAcc : '';
      const projectedAssistant = projectStreamAccumulator(assistantPrev, full);
      // Dedupe an answer that only echoes the thinking it follows. Once a tool ran in
      // between, the answer is a new message even when the plan already spelled it out.
      if (thinkingAcc && !rv.toolRanSinceThinking && textsOverlap(thinkingAcc, projectedAssistant)) {
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
        endAssistantBlockForSpeech();
        delete chat._sdkAssistantAcc;
        rv.assistantMdEl = null;
      }
      rv.activeKind = 'thinking';
      rv.toolRanSinceThinking = false;
      const runKey = rv.getEventRunKey(ev);
      const incomingThinking = typeof ev.text === 'string' ? ev.text : '';
      if (!rv.thinkingDetails && rv.thinkingAdoptCandidate instanceof HTMLElement) {
        const candidateText = rv.thinkingAdoptCandidate.querySelector('.sdk-rich-thinking-pre')?.textContent || '';
        // Same segment when merging adds less than the whole snapshot: a replayed prefix
        // leaves the text as is, a continuation extends its last segment.
        const merged = mergeThinkingSnapshot(candidateText, incomingThinking);
        if (candidateText && incomingThinking && merged.length - candidateText.length < incomingThinking.length) {
          delete chat._sdkThinkingAcc;
          rv.adoptThinkingBlock(rv.thinkingAdoptCandidate, runKey);
        }
        rv.thinkingAdoptCandidate = null;
      }
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
      const projectedThinking = ev.streamTextMode === 'snapshot'
        ? mergeThinkingSnapshot(thinkingPrev, truncated)
        : projectStreamAccumulator(thinkingPrev, truncated);
      rv.rememberThinkingBlock(runKey, rv.thinkingDetails);
      rv.syncThinkingBlockRunning(runKey);
      if (assistantAcc && textsOverlap(assistantAcc, projectedThinking)) {
        return;
      }
      const delta = takeThinkingStreamDelta(chat, '_sdkThinkingAcc', truncated, ev.streamTextMode);
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
      endAssistantBlockForSpeech();
      delete chat._sdkAssistantAcc;
      rv.assistantMdEl = null;
      rv.activeKind = 'idle';
      rv.toolRanSinceThinking = true;
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
        // rv.stream.contains: an older page renders into a detached offscreen stream.
        if (!(block instanceof HTMLElement) || !(block.isConnected || rv.stream.contains(block))) {
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
      if (compactName === 'askuserquestion' && isTerminalSdkToolStatus(status)) {
        rv.resolveQuestionCardsForTool?.(args, status, result);
      }
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

    endAssistantBlockForSpeech();
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
