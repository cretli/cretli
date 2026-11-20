/**
 * UI freeze stage 0.2 — numeric contracts and regression anchors.
 *
 * These exports document targets for later enforcement (stages 1–5). They do
 * not change runtime behaviour by themselves. Diagnostics already use related
 * values in `chatPerfBudget.js` and `chatHistoryReplayLifecycle.js`.
 */

import { CHAT_HISTORY_INITIAL_TAIL, CHAT_HISTORY_OLDER_PAGE } from '../config.js';
import { SIDEBAR_ARCHIVE_MAX_MOUNTED_ROWS } from '../features/sidebar/sidebarArchiveVirtualizer.js';
import {
  HISTORY_REPLAY_CHUNK_SIZE,
  HISTORY_REPLAY_SYNC_HEAD,
} from './chatHistoryReplayLifecycle.js';
import {
  LONG_TASK_IDLE_MS,
  LONG_TASK_RESUME_MS,
  MARKDOWN_CHARS_BUDGET,
  MARKDOWN_FLUSH_BUDGET_MS,
} from './chatPerfBudget.js';
import { DEFAULT_SLICE_BUDGET_MS } from './schedulerYield.js';

export { DEFAULT_SLICE_BUDGET_MS, HISTORY_REPLAY_CHUNK_SIZE, HISTORY_REPLAY_SYNC_HEAD };

/** Wall-clock budget per synchronous slice before yielding the main thread. */
export const UI_FREEZE_SLICE_BUDGET_MS = DEFAULT_SLICE_BUDGET_MS;

/** Repaired hot paths (poll apply, boot-cache slice, archive open harness). */
export const UI_FREEZE_REPAIR_PATH_TASK_MS = LONG_TASK_RESUME_MS;

/** Maximum acceptable interaction queue latency (reference Chrome trace). */
export const UI_FREEZE_INPUT_LATENCY_MS = LONG_TASK_IDLE_MS;

/**
 * Target apply wall time for one replay batch (`HISTORY_REPLAY_CHUNK_SIZE`
 * records) before the rAF / scheduler yield. A single record may exceed this
 * when its Markdown/DOM work is not subdivided — stage 3 caps preview size.
 */
export const UI_FREEZE_REPLAY_BATCH_APPLY_TARGET_MS = UI_FREEZE_SLICE_BUDGET_MS;

/** Existing diag budgets reused by markdown flush during replay. */
export const UI_FREEZE_MARKDOWN_FLUSH_BUDGET_MS = MARKDOWN_FLUSH_BUDGET_MS;
export const UI_FREEZE_MARKDOWN_CHARS_BUDGET = MARKDOWN_CHARS_BUDGET;

/** Server/client paging knobs (semantics unchanged in stage 0). */
export const UI_FREEZE_CHAT_HISTORY_INITIAL_TAIL = CHAT_HISTORY_INITIAL_TAIL;
export const UI_FREEZE_CHAT_HISTORY_OLDER_PAGE = CHAT_HISTORY_OLDER_PAGE;

/**
 * Target maximum mounted history cards in the active SDK rich view after stage
 * 4 window eviction (turn-aligned extension stays within one turn only).
 */
export const UI_FREEZE_CHAT_MOUNTED_RECORD_CAP = CHAT_HISTORY_INITIAL_TAIL;

/** Sidebar archive virtualizer hard cap (enforced in stage 7). */
export const UI_FREEZE_SIDEBAR_ARCHIVE_MAX_MOUNTED_ROWS = SIDEBAR_ARCHIVE_MAX_MOUNTED_ROWS;

/** Chromium trace 2026-10-06 regression ceiling — must not be exceeded post-fix. */
export const UI_FREEZE_TRACE_REGRESSION_DOM_NODES = 509_961;
export const UI_FREEZE_TRACE_REGRESSION_LAYOUT_OBJECTS = 276_323;

/**
 * Soft cap for active chat transcript DOM nodes after stage 4 (prose fixtures,
 * delegation preview capped in stage 3). Measured via `UpdateCounters.nodes`.
 */
export const UI_FREEZE_CHAT_DOM_NODES_SOFT_CAP = 120_000;

/**
 * UTF-8 bytes shown in delegation/mailbox preview DOM; full report remains in
 * store / copy source (stage 3). Trace reference: ~800 KiB single card.
 */
export const UI_FREEZE_DELEGATION_PREVIEW_UTF8_BYTES = 16_384;

/** UTF-8 bytes rendered per “show more” page in delegation/mailbox report expand. */
export const UI_FREEZE_DELEGATION_EXPAND_UTF8_BYTES = UI_FREEZE_DELEGATION_PREVIEW_UTF8_BYTES;

/** Max expand page blocks kept in the DOM per report host (stage 4.2). */
export const UI_FREEZE_DELEGATION_EXPAND_MAX_DOM_PAGES = 2;

/** UTF-8 bytes for tool_call result/stdout preview in the rich view (stage 5.2). */
export const UI_FREEZE_TOOL_CALL_PREVIEW_UTF8_BYTES = UI_FREEZE_DELEGATION_PREVIEW_UTF8_BYTES;

/** UTF-8 bytes for inline JSON args/result snippets on tool cards. */
export const UI_FREEZE_TOOL_CALL_JSON_PREVIEW_UTF8_BYTES = UI_FREEZE_DELEGATION_PREVIEW_UTF8_BYTES;

/** Representative replay fixture (`tests/fixtures/synthetic-history-replay-records.json`). */
export const UI_FREEZE_SYNTHETIC_FIXTURE_RECORD_COUNT = 52;
export const UI_FREEZE_SYNTHETIC_FIXTURE_MAX_RECORD_UTF8_BYTES = 819_311;
export const UI_FREEZE_SYNTHETIC_FIXTURE_TOTAL_JSON_BYTES = 824_255;
