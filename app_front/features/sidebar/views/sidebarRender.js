/** Render entry point and the rebuild/reconcile pass over workspace nodes. */

import { probeSync } from '../../../lib/perfProbe.js';
import { chatListRows } from '../../../state/index.js';
import { getCurrentLang, t } from '../../../i18n/index.js';
import { setRenderedSidebarChatIds, getRenderedSidebarChatIds } from '../sidebarVisibleChats.js';
import { filterWorkspacesByActiveWorkspace, readSidebarOnlyActiveWorkspaceFlag } from '../sidebarOnlyActiveFilter.js';
import { readWorkspaceOrder } from '../sidebarWorkspaceOrder.js';
import { sortSidebarWorkspaces } from '../sidebarWorkspaceSort.js';
import { readPinActiveWorkspaceFlag } from '../state/sidebarPersistence.js';
import { isUiFreezeTraceActive } from '../../../lib/uiFreezeTrace.js';
import { getUiFreezeCounters } from '../../../lib/uiFreezeCounters.js';
import { diffSignatureSegments, getUiFreezeMetrics, monoNow } from '../sidebarRenderMetrics.js';
import { captureSidebarFocusInfo, restoreSidebarFocus } from '../sidebarArchiveSidebarFocus.js';
import { createSidebarWorkspaceHostElement, hydrateSidebarWorkspaceHosts, requestSidebarWorkspaceUpdate, waitForSidebarLitHostsCommit } from '../sidebarWorkspaceMount.js';
import { ensureChatListRovingTabindex } from './sidebarBodyKeyboard.js';
import { planWorkspaceRebuild } from './sidebarRebuildPlan.js';

/**
 * @param {Record<string, any>} ctx shared sidebar closure: deps, state and sibling modules
 */
export function createSidebarRender(ctx) {
  const { getWorkspaces, getChats, getActiveWorkspaceFile, getActiveWorkspaceFolder, getActiveChatId, getPreferredWorkspaceFolder, openWorkspaceSettings, state, renderedWorkspaceNodes, updateScheduler } = ctx;
  const getContainer = (...args) => ctx.getContainer(...args);
  const beginRenderPass = (...args) => ctx.beginRenderPass(...args);
  const endRenderPass = (...args) => ctx.endRenderPass(...args);
  const workspaceModel = (...args) => ctx.workspaceModel(...args);
  const registerWorkspaceGroupEntry = (...args) => ctx.registerWorkspaceGroupEntry(...args);
  const applyPinnedSection = (...args) => ctx.applyPinnedSection(...args);
  const collectRenderableChatIds = (...args) => ctx.collectRenderableChatIds(...args);
  const computeWorkspaceStructureSignature = (...args) => ctx.computeWorkspaceStructureSignature(...args);
  const renderSignature = (...args) => ctx.renderSignature(...args);
  const refreshLitWorkspaceHostsOnSignatureMatch = (...args) => ctx.refreshLitWorkspaceHostsOnSignatureMatch(...args);
  const patchTransientVisualStates = (...args) => ctx.patchTransientVisualStates(...args);
  const tryPatchChangedRows = (...args) => ctx.tryPatchChangedRows(...args);
  const wireBodyEvents = (...args) => ctx.wireBodyEvents(...args);
  const isSearchActive = (...args) => ctx.isSearchActive(...args);
  const visibleChatsForWorkspace = (...args) => ctx.visibleChatsForWorkspace(...args);

  function render() {
    const aside = getContainer();
    if (!aside) return;
    // Never rebuild the DOM mid-gesture — a live drag node would detach, and
    // a swipe follows an inline transform on this aside. Coalesce a deferred
    // render onto the next animation frame once the gesture releases; otherwise
    // a change that arrived mid-drag would be dropped and the DOM left stale.
    if (state.workspaceDrag.isDragging() || state.chatDrag.isDragging() || state.swipe.isSwiping()) {
      updateScheduler.schedule();
      return;
    }
    const body = aside.querySelector('.sidebar-body');
    if (!body) return;
    // The whole pass shares one workspace-tree computation (see workspaceModel).
    beginRenderPass();
    try {
      probeSync('sidebar.renderPass', () => renderPassBody(body));
      state.lastPatchedActiveChatId = state.renderPass ? state.renderPass.activeChatId : null;
    } finally {
      endRenderPass();
    }
    // Task 0.1: the mounted row count after the pass (viewport-limited once the
    // archive is virtualized). No-op while diagnostics are off.
    getUiFreezeCounters()?.recordMountedRows(getRenderedSidebarChatIds().size);
  }

  /**
   * The rebuild branch of a render, run inside a `renderPass`. All measurement is
   * opt-in through the uiFreeze trace flag (default off) and guarded at the
   * callsite so production does zero extra work — this never changes what is
   * rendered, only the signature/short-circuit it compares against.
   * @param {Element} body
   */

  function renderPassBody(body) {
    const trace = isUiFreezeTraceActive();
    const metrics = trace ? getUiFreezeMetrics() : null;
    const sigParts = trace ? {} : null;
    const sigStart = trace ? monoNow() : 0;
    const lastRenderSignature = state.lastRenderSignature;
    const sig = renderSignature(sigParts);
    const sigMs = trace ? monoNow() - sigStart : 0;
    if (sig === lastRenderSignature) {
      // Structural signature unchanged: skip reconcile/markup rebuild, but Lit hosts
      // still own row/workspace payloads — refresh registrations and push updates.
      refreshLitWorkspaceHostsOnSignatureMatch(body);
      // Repaint visuals outside the signature (active chat, group summaries, badges).
      patchTransientVisualStates();
      if (trace) state.lastRenderSigParts = sigParts;
      if (metrics) {
        metrics.recordSidebarRender({
          changed: false,
          changedSegments: [],
          sigMs,
          rows: getRenderedSidebarChatIds().size,
          rebuilt: false,
        });
      }
      return;
    }
    // Segments are diffed ONLY on a real rebuild, against the parts that produced
    // lastRenderSignature (null on the first measured rebuild → all-segment baseline).
    let changedSegments = null;
    if (trace) {
      changedSegments = diffSignatureSegments(state.lastRenderSigParts, sigParts);
      state.lastRenderSigParts = sigParts;
    }
    const prevSkeleton = state.lastSkeletonSignature;
    state.lastSkeletonSignature = renderSignature(null, true);
    state.lastRenderSignature = sig;

    // Row-only change: same skeleton (ids, order, grouping, layout), only some rows'
    // field signatures differ. Repaint just those Lit hosts instead of rebuilding.
    const diff = chatListRows.setChats(getChats());
    if (
      prevSkeleton !== null &&
      prevSkeleton === state.lastSkeletonSignature &&
      !diff.removed.length &&
      tryPatchChangedRows(body, diff.changed)
    ) {
      if (metrics) {
        metrics.recordSidebarRender({
          changed: true,
          changedSegments: changedSegments || [],
          sigMs,
          rows: diff.changed.length,
          rebuilt: false,
        });
      }
      return;
    }

    const wsList = getWorkspaces();
    const activeWorkspaceFile = getActiveWorkspaceFile();
    const activeWorkspaceFolder = getActiveWorkspaceFolder();
    const activeChatId = getActiveChatId();

    if (!wsList.length) {
      renderedWorkspaceNodes.clear();
      state.lastPinnedSectionHtml = '';
      const innerStart = trace ? monoNow() : 0;
      const emptyBox = document.createElement('div');
      emptyBox.className = 'sidebar-empty';
      const emptyHint = document.createElement('p');
      emptyHint.className = 'sidebar-empty-hint';
      emptyHint.textContent = t('workspace.emptyHint');
      const emptyAdd = document.createElement('cr-bar-button');
      emptyAdd.className = 'sidebar-empty-add';
      emptyAdd.setAttribute('variant', 'primary');
      emptyAdd.textContent = t('workspace.emptyAction');
      emptyBox.append(emptyHint, emptyAdd);
      body.replaceChildren(emptyBox);
      if (metrics) {
        metrics.recordSidebarRender({
          changed: true,
          changedSegments,
          sigMs,
          innerMs: monoNow() - innerStart,
          rows: 0,
          rebuilt: true,
        });
      }
      body.querySelector('.sidebar-empty-add')?.addEventListener('click', () => {
        openWorkspaceSettings();
      });
      return;
    }

    const ordered = sortSidebarWorkspaces(wsList, {
      pinActiveOnTop: readPinActiveWorkspaceFlag(),
      activeWorkspaceFile,
      activeWorkspaceFolder,
      getPreferredWorkspaceFolder,
      locale: getCurrentLang(),
      order: readWorkspaceOrder(),
    });

    const searching = isSearchActive();
    const focusInfo = captureSidebarFocusInfo(body);
    const scrollTop = typeof body.scrollTop === 'number' ? body.scrollTop : 0;

    // The rendered-id set and the settled groups must stay correct even for the
    // workspaces whose `<li>` node is reused, so they are derived from the shared
    // render pass instead of being accumulated while building HTML.
    setRenderedSidebarChatIds(collectRenderableChatIds());
    state.settledGroupsByParent = new Map();
    const structureByKey = new Map();
    const chatsByKey = new Map();
    for (const workspace of /** @type {any[]} */ (ordered)) {
      const sidebarKey = workspace.sidebarKey || workspace.workspaceFile || '';
      chatsByKey.set(sidebarKey, visibleChatsForWorkspace(workspace));
      const { grouped } = workspaceModel(workspace);
      for (const group of grouped.groups) state.settledGroupsByParent.set(group.parentId, group);
      // Per-workspace signatures are only needed on a rebuild (this branch), so
      // the signature-only skip in renderSignature() stays cheap.
      structureByKey.set(
        sidebarKey,
        computeWorkspaceStructureSignature(workspace, activeChatId, searching),
      );
    }
    const activeFilter = filterWorkspacesByActiveWorkspace(ordered, {
      activeWorkspaceFolder,
      searching,
      enabled: readSidebarOnlyActiveWorkspaceFlag(),
      getPreferredWorkspaceFolder,
    });
    const visibleWorkspaces = /** @type {any[]} */ (activeFilter.workspaces).filter((workspace) => {
      const sidebarKey = workspace.sidebarKey || workspace.workspaceFile || '';
      return !(searching && (chatsByKey.get(sidebarKey) || []).length === 0);
    });

    if (!visibleWorkspaces.length) {
      renderedWorkspaceNodes.clear();
      state.lastPinnedSectionHtml = '';
      const innerStart = trace ? monoNow() : 0;
      // When only the search empties the list this is the "no results" state;
      // the workspace filter never empties the list (it falls back to all),
      // so this branch keeps meaning "the search found nothing".
      const noResults = document.createElement('div');
      noResults.className = 'sidebar-empty';
      noResults.textContent = t('sidebar.noSearchResults');
      body.replaceChildren(noResults);
      if (metrics) {
        metrics.recordSidebarRender({
          changed: true,
          changedSegments,
          sigMs,
          innerMs: monoNow() - innerStart,
          rows: 0,
          rebuilt: true,
        });
      }
      return;
    }

    const innerStart = trace ? monoNow() : 0;
    reconcileWorkspaceNodes(body, visibleWorkspaces, {
      activeWorkspaceFile,
      activeWorkspaceFolder,
      activeChatId,
      structureByKey,
      chatsByKey,
    });
    applyPinnedSection(body, activeChatId);
    applyOnlyActiveHint(body, activeFilter);
    const innerMs = trace ? monoNow() - innerStart : 0;
    const wireStart = trace ? monoNow() : 0;
    wireBodyEvents();
    ensureChatListRovingTabindex(body);
    scheduleSidebarFocusAndScrollRestore(body, focusInfo, scrollTop);
    if (metrics) {
      metrics.recordSidebarRender({
        changed: true,
        changedSegments,
        sigMs,
        innerMs,
        wireMs: monoNow() - wireStart,
        rows: getRenderedSidebarChatIds().size,
        rebuilt: true,
      });
    }
  }

  /**
   * Reuses unchanged workspace `<li>` nodes and swaps only the ones whose
   * per-workspace structure signature changed, then reorders/removes the rest.
   * The `<ul>` itself is never recreated, so delegated listeners and scroll
   * position survive a partial rebuild.
   */
  function reconcileWorkspaceNodes(body, visibleWorkspaces, opts) {
    let ul = body.querySelector('.sidebar-workspaces');
    if (!ul) {
      ul = document.createElement('ul');
      ul.className = 'sidebar-workspaces';
      ul.setAttribute('role', 'listbox');
      body.replaceChildren(ul);
      renderedWorkspaceNodes.clear();
    }
    // A forced render drops the reuse map so every row can be regenerated (for
    // example after a language change). The existing list stays mounted to keep
    // scroll and listeners stable, so remove any rows no longer owned by that
    // map before inserting their replacements. This also repairs stale DOM after
    // a hot module reload resets the closure while preserving the sidebar shell.
    const trackedNodes = new Set(
      [...renderedWorkspaceNodes.values()].map((entry) => entry.node).filter(Boolean),
    );
    for (const child of Array.from(ul.children)) {
      if (!trackedNodes.has(child)) child.remove();
    }
    const orderedKeys = visibleWorkspaces.map(
      (workspace) => workspace.sidebarKey || workspace.workspaceFile || '',
    );
    const previousSigs = new Map();
    for (const [key, entry] of renderedWorkspaceNodes) previousSigs.set(key, entry.sig);
    const plan = planWorkspaceRebuild(previousSigs, orderedKeys, opts.structureByKey);

    visibleWorkspaces.forEach((workspace, index) => {
      const sidebarKey = workspace.sidebarKey || workspace.workspaceFile || '';
      const sig = opts.structureByKey.get(sidebarKey) || '';
      let entry = renderedWorkspaceNodes.get(sidebarKey);
      const mustRebuild = !plan.reuseKeys.has(sidebarKey) || !entry || !entry.node
        || entry.node.parentNode !== ul;
      if (mustRebuild) {
        const registered = registerWorkspaceGroupEntry(
          workspace,
          opts.activeWorkspaceFile,
          opts.activeWorkspaceFolder,
          opts.activeChatId,
          opts.chatsByKey.get(sidebarKey) || [],
          new Set(),
        );
        if (!registered) {
          if (entry?.node?.parentNode) entry.node.remove();
          renderedWorkspaceNodes.delete(sidebarKey);
          return;
        }
        const existingHost = entry?.node;
        const canUpdateInPlace = existingHost instanceof HTMLElement
          && existingHost.localName === 'cr-sidebar-workspace'
          && existingHost.getAttribute('sidebar-key') === sidebarKey;
        let node;
        if (canUpdateInPlace) {
          node = existingHost;
          requestSidebarWorkspaceUpdate(node);
        } else {
          node = createSidebarWorkspaceHostElement(sidebarKey);
          if (!node) return;
          hydrateSidebarWorkspaceHosts(node);
          if (entry?.node?.parentNode) entry.node.replaceWith(node);
        }
        entry = { sig, node };
        renderedWorkspaceNodes.set(sidebarKey, entry);
      } else {
        entry.sig = sig;
      }
      const target = ul.children[index] || null;
      if (target !== entry.node) ul.insertBefore(entry.node, target);
    });
    for (const key of plan.removeKeys) {
      renderedWorkspaceNodes.get(key)?.node?.remove();
      renderedWorkspaceNodes.delete(key);
    }
  }

  /**
   * One-line notice for the "active workspace only" fallback: the filter was on
   * but the active folder matches no sidebar group, so everything is shown.
   *
   * @param {Element} body
   * @param {{ fallback: boolean }} activeFilter
   */
  function applyOnlyActiveHint(body, activeFilter) {
    const existing = body.querySelector('.sidebar-only-active-hint');
    if (!activeFilter?.fallback) {
      if (existing) existing.remove();
      return;
    }
    const text = t('workspace.onlyActiveFallbackHint');
    if (existing) {
      if (existing.textContent !== text) existing.textContent = text;
      return;
    }
    const hint = document.createElement('div');
    hint.className = 'sidebar-only-active-hint';
    hint.textContent = text;
    const ul = body.querySelector('.sidebar-workspaces');
    const pinned = body.querySelector('.sidebar-pinned-section');
    if (ul) body.insertBefore(hint, ul);
    else if (pinned) body.insertBefore(hint, pinned.nextSibling);
    else body.appendChild(hint);
  }

  /**
   * Re-focus after Lit commits (unsafeHTML runs in a microtask).
   *
   * @param {Element} body
   * @param {ReturnType<typeof captureSidebarFocusInfo>} info
   * @param {number} scrollTop
   */
  function scheduleSidebarFocusAndScrollRestore(body, info, scrollTop) {
    if (!info && !(typeof scrollTop === 'number' && scrollTop > 0)) return;
    void (async () => {
      await waitForSidebarLitHostsCommit(body);
      if (typeof body.scrollTop === 'number' && body.scrollTop !== scrollTop) {
        body.scrollTop = scrollTop;
      }
      restoreSidebarFocus(body, info);
    })();
  }

  return { render, renderPassBody, reconcileWorkspaceNodes, applyOnlyActiveHint, scheduleSidebarFocusAndScrollRestore };
}
