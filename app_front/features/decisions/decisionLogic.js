/** Gestures are off after the daily cap and on control cards, which must be decided from the opened details. */
export function gesturesAllowed(autonomy) {
  return !autonomy || (autonomy.gesturesLeft > 0 && autonomy.nextIsControl !== true);
}
export function canSwipe(card, autonomy) {
  return gesturesAllowed(autonomy) && card?.status === 'pending' && card.risk === 'low'
    && card.reversible === true && card.humanOnly !== true;
}

export function swipeOption(card, direction, autonomy) {
  if (!canSwipe(card, autonomy)) return null;
  const safe = (option) => option?.risk === 'low' && option.reversible === true;
  if (direction === 'right') return card.options?.find((option) => option.id === card.recommended && safe(option)) || null;
  if (direction === 'left') return card.options?.find((option) => /reject|deny|decline|no|dismiss/i.test(option.id) && safe(option)) || null;
  if (direction === 'up') return card.options?.find((option) => /defer|later|postpone|snooze/i.test(option.id) && safe(option)) || null;
  return null;
}

export function directionForPointer(start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (Math.abs(dx) < 35 && Math.abs(dy) < 35) return 'tap';
  if (dy < -60 && Math.abs(dy) > Math.abs(dx) && start.onHandle) return 'up';
  if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'right' : 'left';
  return null;
}

function priority(card, now) {
  if (card.blocksWork === true || card.blocking === true || ['needs_human', 'permission', 'question', 'plan_approval', 'integration'].includes(card.kind)) return 0;
  const expiry = Date.parse(card.expiresAt || '');
  return Number.isFinite(expiry) && expiry <= now + 60 * 60 * 1000 ? 1 : 2;
}

export function sortDecisions(cards, now = Date.now()) {
  return [...cards].sort((a, b) => priority(a, now) - priority(b, now)
    || Date.parse(a.createdAt || '') - Date.parse(b.createdAt || '')
    || String(a.id).localeCompare(String(b.id)));
}

export function groupDecisions(cards, now = Date.now()) {
  const sorted = sortDecisions(cards, now);
  const groups = [];
  const byTree = new Map();
  for (const card of sorted) {
    const tree = card.kind === 'integration' && (card.subject?.rootTodoId || card.subject?.treeId || card.subject?.todoRootId);
    const key = tree ? `integration:${tree}` : '';
    if (key && byTree.has(key)) byTree.get(key).cards.push(card);
    else {
      const group = { key: key || card.id, cards: [card], treeId: tree || '' };
      groups.push(group);
      if (key) byTree.set(key, group);
    }
  }
  return groups;
}

export function attachIntegrationRoots(cards, todos) {
  const byId = new Map((todos || []).map((item) => [item.id, item]));
  const rootId = (id) => {
    let current = byId.get(id);
    const seen = new Set();
    while (current?.parentId && byId.has(current.parentId) && !seen.has(current.parentId)) {
      seen.add(current.parentId);
      current = byId.get(current.parentId);
    }
    return current?.id || '';
  };
  return cards.map((card) => card.kind === 'integration' ? {
    ...card, subject: { ...card.subject, rootTodoId: rootId(card.subject?.todoId) },
  } : card);
}

export function createDecisionQueue(send, { delay = 5000, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const pending = new Map();
  function enqueue(card, optionId, reason = '', meta = {}) {
    const entry = { card, optionId, reason, ...meta };
    entry.timer = setTimer(() => { pending.delete(card.id); void send(entry, false); }, delay);
    pending.set(card.id, entry);
    return entry;
  }
  function undo(id) {
    const entry = pending.get(id);
    if (!entry) return false;
    clearTimer(entry.timer);
    pending.delete(id);
    return true;
  }
  function flush() {
    for (const [id, entry] of pending) {
      clearTimer(entry.timer);
      pending.delete(id);
      void send(entry, true);
    }
  }
  return { enqueue, undo, flush, pending };
}

export function decisionRequestInit(entry, keepalive) {
  return {
    method: 'POST', keepalive, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      optionId: entry.optionId, expectedRevision: entry.card.revision,
      reason: entry.reason, workspaceFolder: entry.card.workspaceFolder,
      gesture: entry.gesture === true, detailsOpened: entry.detailsOpened === true, openedMs: entry.openedMs,
    }),
  };
}

export function bindDecisionFlush(queue, page, visibility) {
  const onPageHide = () => queue.flush();
  const onVisibility = () => { if (visibility.visibilityState === 'hidden') queue.flush(); };
  page.addEventListener('pagehide', onPageHide);
  visibility.addEventListener('visibilitychange', onVisibility);
  return () => {
    page.removeEventListener('pagehide', onPageHide);
    visibility.removeEventListener('visibilitychange', onVisibility);
  };
}

export function formatDuration(msValue) {
  if (!Number.isFinite(msValue)) return '–';
  const sec = Math.round(msValue / 1000);
  return sec < 60 ? `${sec}s` : sec < 3600 ? `${Math.round(sec / 60)}m` : `${(sec / 3600).toFixed(1)}h`;
}
export function formatPercent(ratio) {
  return Number.isFinite(ratio) ? `${Math.round(ratio * 100)}%` : '–';
}
