/** Send-bar helpers that ask the embedding host page for a screenshot or a page pick. */
import { t } from '../../../i18n/index.js';
import {
  hostScreenshotResultToFile,
  isWidgetHostScreenshotAvailable,
  requestWidgetHostScreenshot,
} from '../../../embed/widgetHostScreenshot.js';
import {
  isWidgetHostPagePickAvailable,
  requestWidgetHostPagePick,
} from '../../../embed/widgetHostPagePick.js';

async function captureWidgetHostScreenshotForSendBar() {
  if (!isWidgetHostScreenshotAvailable()) {
    return {
      ok: false,
      error: t('chat.hostPageNotConnected'),
      debug: { reason: 'widget-host-port-missing' },
    };
  }
  const isMobileLike = typeof navigator !== 'undefined'
    && /Android|iPhone|iPad|iPod|Mobi/i.test(navigator.userAgent || '');
  /** @type {Array<{ mode: 'display' | 'dom', label: string }>} */
  const attempts = isMobileLike
    ? [
      { mode: 'dom', label: 'dom' },
      { mode: 'display', label: 'display' },
    ]
    : [
      { mode: 'display', label: 'display' },
      { mode: 'dom', label: 'dom' },
    ];
  /** @type {Error | null} */
  let lastError = null;
  for (const attempt of attempts) {
    try {
      const result = await requestWidgetHostScreenshot(attempt.mode);
      const file = await hostScreenshotResultToFile(result);
      return { ok: true, file };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error || 'Screenshot failed'));
    }
  }
  return {
    ok: false,
    error: lastError?.message || t('chat.hostPageScreenshotFailed'),
    debug: {
      reason: 'widget-host-screenshot-failed',
      errorMessage: lastError?.message || '',
    },
  };
}

export function resolveSendBarHostScreenshotCapture() {
  if (!isWidgetHostScreenshotAvailable()) return null;
  return captureWidgetHostScreenshotForSendBar;
}

export function resolveSendBarHostPagePick() {
  if (!isWidgetHostPagePickAvailable()) return null;
  return requestWidgetHostPagePick;
}
