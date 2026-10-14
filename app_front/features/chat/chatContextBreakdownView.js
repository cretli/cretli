import { escapeHtml } from './chatHtmlUtils.js';
import { formatContextTokenCount } from '../../../lib/sdk/sdk-context-advisory.js';

const CATEGORY_KEYS = Object.freeze({
  messages: 'chat.contextPartMessages', instructions: 'chat.contextPartInstructions',
  skills: 'chat.contextPartSkills', memory: 'chat.contextPartMemory',
  systemPrompt: 'chat.contextPartSystemPrompt', toolCalls: 'chat.contextPartToolCalls',
  toolResults: 'chat.contextPartToolResults', reasoning: 'chat.contextPartReasoning',
  systemTools: 'chat.contextPartSystemTools', mcpTools: 'chat.contextPartMcpTools',
  mcpInstructions: 'chat.contextPartMcpInstructions', agents: 'chat.contextPartAgents',
  compactBuffer: 'chat.contextPartCompactBuffer', deferredTools: 'chat.contextPartDeferredTools',
});

/** Render saved numeric estimates separately from measured occupancy and free space. */
export function renderChatContextBreakdownHtml(snapshot, t) {
  const breakdown = snapshot?.breakdown;
  if (!breakdown || !Array.isArray(breakdown.rows)) return '';
  const window = snapshot.contextWindowTokens;
  const hasWindow = typeof window === 'number' && window > 0;
  const rows = [];
  const unavailable = [];
  for (const row of breakdown.rows) {
    if (!row || !Object.hasOwn(CATEGORY_KEYS, row.id)) continue;
    const label = t(CATEGORY_KEYS[row.id]);
    if (typeof row.tokens !== 'number' || !Number.isFinite(row.tokens) || row.tokens < 0) {
      unavailable.push(label);
      continue;
    }
    const tokens = `${row.estimated ? '~' : ''}${formatContextTokenCount(row.tokens)}`;
    const percent = hasWindow ? `~${(row.tokens / window * 100).toFixed(1)}%` : '—';
    rows.push(`<tr><th scope="row">${escapeHtml(label)}</th><td>${escapeHtml(tokens)}</td><td>${escapeHtml(percent)}</td><td class="chat-context-breakdown-blocks">${escapeHtml(String(row.count ?? '—'))}</td></tr>`);
  }
  const used = snapshot.totalTokens;
  const free = hasWindow && typeof used === 'number' && Number.isFinite(used) ? Math.max(0, window - used) : null;
  if (free != null) rows.push(`<tr><th scope="row">${escapeHtml(t('chat.contextPartFree'))}</th><td>${escapeHtml(formatContextTokenCount(free))}</td><td>${(free / window * 100).toFixed(1)}%</td><td class="chat-context-breakdown-blocks">—</td></tr>`);
  return `<h3>${escapeHtml(t('chat.contextBreakdownTitle'))}</h3>`
    + `<p class="chat-context-breakdown-note">${escapeHtml(t('chat.contextBreakdownShort'))}</p>`
    + (breakdown.complete === false ? `<p class="settings-hint">${escapeHtml(t('chat.contextBreakdownPartial'))}</p>` : '')
    + `<div class="chat-context-breakdown-table-scroll"><table class="chat-context-breakdown-table"><thead><tr><th>${escapeHtml(t('chat.contextBreakdownCategory'))}</th><th>${escapeHtml(t('chat.contextBreakdownTokens'))}</th><th>${escapeHtml(t('chat.contextBreakdownWindow'))}</th><th class="chat-context-breakdown-blocks">${escapeHtml(t('chat.contextBreakdownBlocks'))}</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`
    + `<details class="chat-context-measurement-details"><summary>${escapeHtml(t('chat.contextBreakdownMethod'))}</summary><p class="settings-hint">${escapeHtml(t('chat.contextBreakdownEstimate'))}</p></details>`
    + (unavailable.length ? `<details class="chat-context-measurement-details"><summary>${escapeHtml(t('chat.contextBreakdownUnavailable'))}</summary><p class="settings-hint">${escapeHtml(unavailable.join(', '))}</p></details>` : '');
}


function isClaudeSnapshot(snapshot) {
  return snapshot?.transport === 'claude';
}

/** Cached input is already included in prompt/context tokens, never subtracted from occupancy. */
export function renderChatContextCacheHtml(snapshot, t) {
  if (snapshot?.transport !== 'codex' && !isClaudeSnapshot(snapshot)) return '';
  const input = snapshot.transport === 'codex' ? snapshot.inputTokens : snapshot.cacheInputTokens;
  const cached = snapshot.cacheReadTokens;
  const known = typeof input === 'number' && input >= 0 && typeof cached === 'number' && cached >= 0 && cached <= input;
  // Claude reports cache only when a call was measured; stay silent otherwise.
  if (!known && snapshot.transport !== 'codex') return '';
  const heading = `<h3>${escapeHtml(t('chat.contextCacheTitle'))}</h3>`;
  if (!known) return heading + `<p class="settings-hint">${escapeHtml(t('chat.contextCacheUnknown'))}</p>`;
  const percent = input > 0 ? cached / input * 100 : null;
  const level = percent == null ? 'ok' : percent >= 80 ? 'ok' : percent >= 40 ? 'warn' : 'urgent';
  return heading + `<div class="chat-context-card" data-level="${level}"><div class="chat-context-cache-stats"><span>${escapeHtml(t('chat.contextCacheRead', { tokens: formatContextTokenCount(cached) }))}</span>`
    + `<strong class="chat-context-countdown">${percent == null ? '—' : percent.toFixed(1) + '%'}</strong></div>`
    + (percent == null ? '' : `<div class="chat-context-countdown-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(percent)}" aria-label="${escapeHtml(t('chat.contextCacheTitle'))}"><span style="width:${percent.toFixed(1)}%"></span></div>`)
    + `<p class="settings-hint">${escapeHtml(t('chat.contextCacheNew', { tokens: formatContextTokenCount(input - cached) }))}</p>`
    + `<p class="settings-hint">${escapeHtml(t('chat.contextCacheHint'))}</p></div>`;
}
