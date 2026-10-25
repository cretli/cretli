import { presentSdkActivityTrayStatus, shouldKeepSdkActivityTrayStatus } from '../../../../../lib/sdk/sdk-run-outcome.ts';
import { canonicalizeSdkToolStatus, isOpenSdkToolStatus, resolveAbandonedToolStatus, setRunningSdkToolCallCount, shouldAcceptSdkToolStatus, updateRunningSdkToolState } from '../../../../../lib/sdk/sdk-thinking-state.ts';
import { extractTodoSummaryFromToolEvent } from '../../../../../lib/sdk/sdk-todo-summary.ts';
import { findPrecedingActivityTrayIndex } from '../../../../../lib/sdk/sdk-activity-group.ts';
import { registerRunItem } from '../../../../../lib/sdk/sdk-run-block-registry.ts';
import { t } from '../../../../i18n/index.js';
import { parseToolSearchQuery, readToolSearchQuery } from '../../../../../lib/agent-harness/tool-search-display.ts';
import { escapeHtml } from '../../chatHtmlUtils.js';
import { buildHistoryCardReportHostHtml } from '../../../../lib/delegationHistoryCardReport.js';
import { buildBoundedToolJsonPreview, buildToolOutputResultSectionHtml, extractPrimaryToolOutputText, extractToolResultMeta, formatToolResultMetaLine } from '../../../../lib/sdkToolCallOutputPreview.js';
import { resolveViewOrderKey } from '../../chatHistoryViewOrder.js';
import { TIMEOUT_PROGRESS_SERIES_CLASS } from '../../timeoutProgressSeries.js';
import { pathsFromToolArgs } from '../services/sdkEventNormalize.js';

/**
 * Tool blocks, activity trays and compact tool tiles.
 *
 * @param {any} rv Shared view scope created by `createSdkRichView`.
 */
export function installToolBlocks(rv) {
  rv.createToolBody = createToolBody;
  rv.resolveToolBlockVariant = resolveToolBlockVariant;
  rv.finalizeOpenToolCalls = finalizeOpenToolCalls;
  rv.applyStatusToLatestOpenTool = applyStatusToLatestOpenTool;
  rv.resolveActivityTrayLabel = resolveActivityTrayLabel;
  rv.setTrayStatus = setTrayStatus;
  rv.updateCompactToolTile = updateCompactToolTile;
  rv.createCompactToolRecord = createCompactToolRecord;
  rv.applyUiModeVisibility = applyUiModeVisibility;
  rv.resetRenderedActivity = resetRenderedActivity;

  /**
   * @param {string} name
   * @returns {string}
   */
  function getToolIconClass(name) {
    const normalized = String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (/read|file|glob|list/.test(normalized)) return 'mdi-file-eye-outline';
    if (/search|grep|find/.test(normalized)) return 'mdi-magnify';
    if (/edit|write|patch|delete/.test(normalized)) return 'mdi-file-edit-outline';
    if (/shell|terminal|command|bash/.test(normalized)) return 'mdi-console';
    if (/usage|token/.test(normalized)) return 'mdi-chart-donut';
    if (/todo/.test(normalized)) return 'mdi-format-list-checks';
    if (/task|subagent|agent/.test(normalized)) return 'mdi-robot-outline';
    if (/mcp/.test(normalized)) return 'mdi-power-plug-outline';
    return 'mdi-wrench-outline';
  }

  const SHELL_TOOL_NAMES = new Set(['bash', 'shell', 'sh', 'run_terminal_cmd']);
  const SHELL_SUBCOMMAND_PROGRAMS = new Set(['git', 'npm', 'pnpm', 'yarn', 'docker', 'gh']);
  const SHELL_LABEL_MAX_CHARS = 16;

  /**
   * Reads the raw command string from shell tool arguments.
   * @param {unknown} args
   * @returns {string}
   */
  function readShellCommand(args) {
    if (!args || typeof args !== 'object') return '';
    const value = args.command ?? args.cmd;
    return typeof value === 'string' ? value.trim() : '';
  }

  /**
   * Short chip label for a shell call: program (plus subcommand for git/npm/...)
   * and "+N" when the command is a `&&` / `;` / `|` chain.
   * @param {string} name
   * @param {unknown} args
   * @returns {string}
   */
  function getShellCommandLabel(name, args) {
    if (!SHELL_TOOL_NAMES.has(String(name || '').toLowerCase())) return '';
    const command = readShellCommand(args);
    if (!command) return '';
    const segments = command.split(/&&|\|\||;|\|/).map((part) => part.trim()).filter(Boolean);
    const words = (segments[0] || command).split(/\s+/);
    while (words.length > 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
    if (words[0] === 'cd' && segments.length > 1) {
      return getShellCommandLabel(name, { command: command.slice(command.indexOf(segments[1])) });
    }
    const program = (words[0] || '').split('/').pop() || '';
    if (!program) return '';
    let label = program;
    const sub = words[1] || '';
    if (SHELL_SUBCOMMAND_PROGRAMS.has(program) && sub && !sub.startsWith('-')) label += ` ${sub}`;
    if (segments.length > 1) label += ` +${segments.length - 1}`;
    return label.length > SHELL_LABEL_MAX_CHARS ? `${label.slice(0, SHELL_LABEL_MAX_CHARS - 1)}…` : label;
  }

  /**
   * @param {string} name
   * @param {string[]} paths
   * @param {unknown} [args]
   * @returns {string}
   */
  function getToolTileLabel(name, paths, args) {
    const searchQuery = parseToolSearchQuery(readToolSearchQuery(args));
    if (searchQuery) return searchQuery;
    const shellLabel = getShellCommandLabel(name, args);
    if (shellLabel) return shellLabel;
    const firstPath = Array.isArray(paths) ? String(paths[0] || '') : '';
    if (!firstPath) {
      if (String(name || '').toLowerCase() === 'usage') return t('sdkView.activityUsage');
      if (String(name || '').toLowerCase() === 'subagent') return t('sdkBlock.toolSubagent');
      return name || 'tool';
    }
    const normalized = firstPath.replace(/\\/g, '/').replace(/\/$/, '');
    return normalized.split('/').pop() || name || 'tool';
  }

  /**
   * @param {Record<string, unknown>} ev
   * @returns {HTMLElement}
   */
  function createToolBody(ev) {
    const name = typeof ev.name === 'string' ? ev.name : '';
    const nameLower = name.toLowerCase();
    const argsPreview = buildBoundedToolJsonPreview(ev.args);
    const primaryOutput = extractPrimaryToolOutputText(ev.result);
    const resultPreview = primaryOutput != null
      ? null
      : buildBoundedToolJsonPreview(ev.result);
    const todoSummary = nameLower === 'updatetodos' ? extractTodoSummaryFromToolEvent(ev) : '';
    const searchQuery = parseToolSearchQuery(readToolSearchQuery(ev.args));
    const body = document.createElement('div');
    if (todoSummary) {
      const todoPre = document.createElement('pre');
      todoPre.className = 'sdk-rich-todos';
      todoPre.textContent = todoSummary;
      body.appendChild(todoPre);
    }
    if (searchQuery) {
      const summary = document.createElement('p');
      summary.className = 'sdk-rich-tool-summary';
      summary.textContent = t('sdkView.toolSearchLookingFor', { query: searchQuery });
      body.appendChild(summary);
    }
    if (argsPreview.text) {
      const argsDetails = document.createElement('details');
      argsDetails.className = 'sdk-rich-nested';
      const argsSummary = document.createElement('summary');
      argsSummary.textContent = t('sdkView.arguments');
      const argsPre = document.createElement('pre');
      argsPre.className = 'sdk-rich-json';
      argsPre.textContent = argsPreview.text;
      argsDetails.append(argsSummary, argsPre);
      body.appendChild(argsDetails);
    }
    if (primaryOutput != null && primaryOutput.length > 0) {
      const resultMeta = extractToolResultMeta(ev.result);
      const metaLine = resultMeta ? formatToolResultMetaLine(resultMeta) : '';
      if (metaLine) {
        const metaP = document.createElement('p');
        metaP.className = 'sdk-rich-tool-meta';
        metaP.textContent = metaLine;
        body.appendChild(metaP);
      }
      const resultHtml = buildToolOutputResultSectionHtml(primaryOutput, {
        escapeHtml,
        t,
        buildReportHostHtml: (text) => buildHistoryCardReportHostHtml(text, rv.historyCardReportDeps, {
          preserveWhitespace: true,
        }),
      });
      const resultWrap = document.createElement('div');
      resultWrap.innerHTML = resultHtml;
      while (resultWrap.firstChild) body.appendChild(resultWrap.firstChild);
      rv.decorateHistoryCardReports(body);
    } else if (resultPreview?.text) {
      const resultDetails = document.createElement('details');
      resultDetails.className = 'sdk-rich-nested';
      if (searchQuery) resultDetails.open = true;
      const resultSummary = document.createElement('summary');
      resultSummary.textContent = t('sdkView.result');
      const resultPre = document.createElement('pre');
      resultPre.className = 'sdk-rich-json';
      resultPre.textContent = resultPreview.text;
      resultDetails.append(resultSummary, resultPre);
      body.appendChild(resultDetails);
    }
    return body;
  }

  /**
   * @param {string} status
   * @returns {'ok' | 'err' | 'warn' | 'run'}
   */
  function resolveToolBlockVariant(status) {
    const normalized = String(status || '').toLowerCase();
    if (normalized === 'completed') return 'ok';
    if (normalized === 'error') return 'err';
    if (normalized === 'cancelled') return 'warn';
    return 'run';
  }

  /**
   * Close tool tiles that never received a terminal SDK status after the run ended.
   *
   * @param {string} [runKey]
   * @param {string} [runStatus]
   */
  function finalizeOpenToolCalls(runKey = '', runStatus = '') {
    const abandonedStatus = resolveAbandonedToolStatus(runStatus);
    const filterKey = String(runKey || '').trim();
    for (const record of rv.toolByCallId.values()) {
      if (!record) continue;
      if (filterKey && record.runKey !== filterKey) continue;
      const prevStatus = typeof record.event?.status === 'string' ? record.event.status : '';
      if (!isOpenSdkToolStatus(prevStatus)) continue;
      if (!shouldAcceptSdkToolStatus(prevStatus, abandonedStatus)) continue;
      const ev = { ...(record.event || {}), status: abandonedStatus };
      const paths = pathsFromToolArgs(ev.args);
      record.event = ev;
      record.fullBlock.variant = resolveToolBlockVariant(abandonedStatus);
      record.fullBlock.label = abandonedStatus;
      record.fullBlock.open = false;
      if (record.fullBlock && typeof record.fullBlock === 'object' && 'running' in record.fullBlock) {
        record.fullBlock.running = false;
      }
      updateCompactToolTile(record, ev, paths);
      updateRunningSdkToolState(
        rv.runningToolCallsByRun,
        record.runKey || filterKey,
        prevStatus,
        abandonedStatus
      );
    }
    if (filterKey) {
      setRunningSdkToolCallCount(rv.runningToolCallsByRun, filterKey, 0);
      rv.syncThinkingBlockRunning(filterKey);
      return;
    }
    rv.runningToolCallsByRun.clear();
    for (const key of rv.latestThinkingByRun.keys()) {
      rv.syncThinkingBlockRunning(key);
    }
  }

  /**
   * @param {string} runKey
   * @param {string} status
   */
  function applyStatusToLatestOpenTool(runKey, status) {
    const key = String(runKey || '').trim();
    const nextStatus = canonicalizeSdkToolStatus({ status });
    let match = null;
    for (const record of rv.toolByCallId.values()) {
      if (!record) continue;
      if (key && record.runKey !== key) continue;
      const prevStatus = typeof record.event?.status === 'string' ? record.event.status : '';
      if (!isOpenSdkToolStatus(prevStatus)) continue;
      match = record;
    }
    if (!match) return;
    const prevStatus = typeof match.event?.status === 'string' ? match.event.status : '';
    if (!shouldAcceptSdkToolStatus(prevStatus, nextStatus)) return;
    const ev = { ...(match.event || {}), status: nextStatus };
    const paths = pathsFromToolArgs(ev.args);
    match.event = ev;
    match.fullBlock.variant = resolveToolBlockVariant(nextStatus);
    match.fullBlock.label = nextStatus;
    match.fullBlock.name = typeof ev.name === 'string' ? ev.name : match.fullBlock.name;
    match.fullBlock.open = false;
    match.fullBlock.replaceChildren(createToolBody(ev));
    updateCompactToolTile(match, ev, paths);
    updateRunningSdkToolState(rv.runningToolCallsByRun, match.runKey || key, prevStatus, nextStatus);
    rv.syncThinkingBlockRunning(match.runKey || key);
  }

  /**
   * @param {object} tray
   * @param {string} status
   */
  /**
   * @param {string} datasetStatus
   * @returns {string}
   */
  function resolveActivityTrayLabel(datasetStatus) {
    if (datasetStatus === 'reported') return t('sdkView.activityReported');
    if (datasetStatus === 'completed') return t('sdkView.activityCompleted');
    if (datasetStatus === 'finished') return t('sdkView.activityFinished');
    if (datasetStatus === 'cancelled') return t('sdkView.activityCancelled');
    if (datasetStatus === 'error') return t('sdkView.activityError');
    return String(datasetStatus || '').toUpperCase();
  }

  /**
   * @param {object} tray
   * @param {string} status
   * @param {string} [lastErrorCode]
   */
  function setTrayStatus(tray, status, lastErrorCode = '') {
    if (!tray?.statusEl) return;
    const presented = presentSdkActivityTrayStatus({ status, lastErrorCode });
    const datasetStatus = presented.datasetStatus;
    const current = String(tray.statusEl.dataset.status || '');
    if (shouldKeepSdkActivityTrayStatus(current, datasetStatus)) return;
    tray.statusEl.textContent = resolveActivityTrayLabel(datasetStatus);
    tray.statusEl.hidden = !datasetStatus;
    tray.statusEl.dataset.status = datasetStatus;
  }

  /**
   * Hidden tool twins, waiting rows, and status lines sit between activity
   * cards without starting a new turn.
   *
   * @param {HTMLElement} child
   * @returns {boolean}
   */
  function isActivityGroupSpacer(child) {
    if (child.classList.contains('sdk-full-tool-block')) return true;
    if (child.classList.contains(TIMEOUT_PROGRESS_SERIES_CLASS)) return true;
    if (child.classList.contains('sdk-rich-line')) return true;
    return false;
  }

  /**
   * Activity cards are one per tool when a later sibling forces an isolated
   * render (the run map is restored and no longer sees the previous tray).
   * The card already in the DOM, immediately before this insert point and
   * not across a user/assistant/plan boundary, is the group to extend.
   *
   * @returns {object | null}
   */
  function findPrecedingActivityTray() {
    const nodes = [];
    for (const child of rv.stream.children) {
      if (!(child instanceof HTMLElement)) continue;
      nodes.push({
        el: child,
        spacer: isActivityGroupSpacer(child),
        hasTray: child._sdkCompactTray?.tilesEl?.isConnected === true,
      });
    }
    const orderKey = resolveViewOrderKey({
      historySeq: rv.renderedRecordHistorySeq,
      roomEventSeq: rv.renderedRecordRoomEventSeq,
      eventStreamId: rv.renderedRecordEventStreamId,
    });
    const anchor = rv.stream === rv.realStream && !rv.suppressAutoScroll
      ? rv.findInsertBeforeChild(orderKey)
      : null;
    const anchorIndex = anchor instanceof HTMLElement
      ? nodes.findIndex((node) => node.el === anchor)
      : -1;
    const index = findPrecedingActivityTrayIndex(nodes, anchorIndex);
    if (index < 0) return null;
    return nodes[index].el._sdkCompactTray || null;
  }

  /**
   * @param {object} tray
   */
  function noteActivityGroupTimestamp(tray) {
    const block = tray?.container;
    if (!(block instanceof HTMLElement)) return;
    if (!block.classList.contains('sdk-compact-activity-block')) return;
    const next = typeof rv.renderedRecordCreatedAt === 'string' ? rv.renderedRecordCreatedAt : '';
    if (!next) return;
    const prev = typeof block.createdAt === 'string' ? block.createdAt : '';
    if (prev && prev >= next) return;
    block.createdAt = next;
  }

  /**
   * @param {string} runKey
   * @param {HTMLElement | null} thinkingBlock
   * @returns {object}
   */
  function ensureCompactTray(runKey, thinkingBlock = null) {
    const existing = thinkingBlock?._sdkCompactTray;
    if (existing) return existing;

    if (!thinkingBlock) {
      const preceding = findPrecedingActivityTray();
      if (preceding) {
        rv.latestTrayByRun.set(runKey, preceding);
        registerRunItem(rv.traysByRun, runKey, preceding);
        noteActivityGroupTimestamp(preceding);
        return preceding;
      }
      const latestTray = rv.latestTrayByRun.get(runKey);
      if (latestTray?.tilesEl?.isConnected) return latestTray;
    }

    let container = thinkingBlock;
    let compactRoot = null;
    if (!container) {
      container = rv.createSdkBlock({ variant: 'thinking', label: t('sdkView.activity'), open: true });
      container.classList.add('sdk-compact-activity-block');
      compactRoot = container;
    }

    const trayEl = document.createElement('div');
    trayEl.className = 'sdk-tool-tray';
    const header = document.createElement('div');
    header.className = 'sdk-tool-tray__header';
    const title = document.createElement('span');
    title.className = 'sdk-tool-tray__title';
    title.textContent = t('sdkView.activity');
    const statusEl = document.createElement('span');
    statusEl.className = 'sdk-tool-tray__status';
    statusEl.hidden = true;
    header.append(title, statusEl);

    const tilesEl = document.createElement('div');
    tilesEl.className = 'sdk-tool-tray__tiles';
    const detailEl = document.createElement('div');
    detailEl.className = 'sdk-tool-tray__detail';
    detailEl.hidden = true;
    trayEl.append(header, tilesEl, detailEl);
    container.appendChild(trayEl);

    const tray = {
      runKey,
      container,
      compactRoot: compactRoot || trayEl,
      trayEl,
      tilesEl,
      detailEl,
      statusEl,
      activeCallId: '',
    };
    container._sdkCompactTray = tray;
    rv.compactTrayHosts.add(tray);
    rv.latestTrayByRun.set(runKey, tray);
    registerRunItem(rv.traysByRun, runKey, tray);
    if (compactRoot) registerRunItem(rv.thinkingBlocksByRun, runKey, compactRoot);
    setTrayStatus(tray, rv.runStatusByRun.get(runKey) || '');
    tray.compactRoot.hidden = rv.uiMode !== 'compact';
    return tray;
  }

  /**
   * @param {object} record
   */
  function openCompactToolDetail(record) {
    const tray = record.tray;
    if (tray.activeCallId === record.callId && !tray.detailEl.hidden) {
      tray.activeCallId = '';
      tray.detailEl.hidden = true;
      record.tile.setAttribute('aria-expanded', 'false');
      return;
    }
    tray.tilesEl.querySelectorAll('.sdk-tool-tile[aria-expanded="true"]').forEach((tile) => {
      tile.setAttribute('aria-expanded', 'false');
    });
    tray.activeCallId = record.callId;
    record.tile.setAttribute('aria-expanded', 'true');
    tray.detailEl.replaceChildren();
    const heading = document.createElement('div');
    heading.className = 'sdk-tool-tray__detail-heading';
    heading.textContent = record.title;
    tray.detailEl.append(heading, createToolBody(record.event));
    tray.detailEl.hidden = false;
    rv.scrollToBottom();
  }

  /**
   * @param {object} record
   * @param {Record<string, unknown>} ev
   * @param {string[]} paths
   */
  function updateCompactToolTile(record, ev, paths) {
    const name = typeof ev.name === 'string' ? ev.name : '?';
    const status = typeof ev.status === 'string' ? ev.status.toLowerCase() : '';
    const label = getToolTileLabel(name, paths, ev.args);
    record.event = ev;
    const searchQuery = parseToolSearchQuery(readToolSearchQuery(ev.args));
    const shellCommand = SHELL_TOOL_NAMES.has(name.toLowerCase()) ? readShellCommand(ev.args) : '';
    record.title = searchQuery
      ? `${name}: ${searchQuery}`
      : shellCommand
        ? `${name}: ${shellCommand.length > 300 ? `${shellCommand.slice(0, 300)}…` : shellCommand}`
        : (paths.length > 0 ? `${name}: ${paths.join(', ')}` : name);
    record.tile.dataset.status = status || 'unknown';
    record.tile.title = record.title;
    record.tile.setAttribute('aria-label', `${name}: ${status || 'unknown'}`);
    record.iconEl.className = `mdi ${getToolIconClass(name)} sdk-tool-tile__icon`;
    record.labelEl.textContent = label;
    record.statusEl.className =
      isOpenSdkToolStatus(status)
        ? 'mdi mdi-loading mdi-spin sdk-tool-tile__status-icon'
        : status === 'error'
          ? 'mdi mdi-alert-circle-outline sdk-tool-tile__status-icon'
          : status === 'cancelled'
            ? 'mdi mdi-close-circle-outline sdk-tool-tile__status-icon'
            : 'mdi mdi-check sdk-tool-tile__status-icon';
    if (record.tray.activeCallId === record.callId && !record.tray.detailEl.hidden) {
      const heading = document.createElement('div');
      heading.className = 'sdk-tool-tray__detail-heading';
      heading.textContent = record.title;
      record.tray.detailEl.replaceChildren(heading, createToolBody(record.event));
    }
  }

  /**
   * @param {string} callId
   * @param {HTMLElement} fullBlock
   * @param {Record<string, unknown>} ev
   * @param {string[]} paths
   * @param {string} runKey
   * @returns {object}
   */
  function createCompactToolRecord(callId, fullBlock, ev, paths, runKey) {
    const name = typeof ev.name === 'string' ? ev.name : '?';
    const thinkingBlock = rv.resolveThinkingBlockForRun(runKey);
    if (thinkingBlock) rv.rememberThinkingBlock(runKey, thinkingBlock);
    const tray = ensureCompactTray(runKey, thinkingBlock);
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'sdk-tool-tile';
    tile.dataset.callId = callId;
    tile.setAttribute('aria-expanded', 'false');
    const iconEl = document.createElement('span');
    iconEl.setAttribute('aria-hidden', 'true');
    const labelEl = document.createElement('span');
    labelEl.className = 'sdk-tool-tile__label';
    const statusEl = document.createElement('span');
    statusEl.setAttribute('aria-hidden', 'true');
    tile.append(iconEl, labelEl, statusEl);
    tray.tilesEl.appendChild(tile);

    const record = {
      callId,
      runKey,
      fullBlock,
      tile,
      tray,
      iconEl,
      labelEl,
      statusEl,
      event: ev,
      title: name,
    };
    tile.addEventListener('click', () => openCompactToolDetail(record));
    updateCompactToolTile(record, ev, paths);
    return record;
  }

  function applyUiModeVisibility() {
    const compact = rv.uiMode === 'compact';
    rv.fullToolBlocks.forEach((block) => {
      block.hidden = compact;
    });
    rv.compactTrayHosts.forEach((tray) => {
      tray.compactRoot.hidden = !compact;
    });
    rv.compactStatusLines.forEach((line) => {
      line.hidden = compact;
    });
  }

  function resetRenderedActivity() {
    rv.toolByCallId.clear();
    rv.planByCallId.clear();
    rv.compactTrayHosts.clear();
    rv.fullToolBlocks.clear();
    rv.compactStatusLines.clear();
    rv.latestThinkingByRun.clear();
    rv.latestTrayByRun.clear();
    rv.thinkingBlocksByRun.clear();
    rv.traysByRun.clear();
    rv.runStatusByRun.clear();
    rv.runningToolCallsByRun.clear();
    rv.runScope += 1;
    rv.isLiveTurn = false;
    rv.resumeThinkingAfterStreamReset = false;
    rv.resumeAssistantAfterStreamReset = false;
    rv.lastRenderedMode = '';
  }
}
