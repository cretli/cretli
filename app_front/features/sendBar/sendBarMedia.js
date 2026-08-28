import { initDropdown } from '../../lib/dropdown.js';
import { initModal } from '../../lib/modal.js';
import { getCurrentLang, t } from '../../i18n/index.js';
import { readStorageValueWithAlias, writeStorageValueWithAlias } from '../../lib/storageKeyAlias.js';
import { escapeHtml } from '../chat/chatHtmlUtils.js';
import { createMicRecorder, isMediaRecorderAvailable } from '../voice/recorder.js';

const DICTATION_LANGS = { en: 'en-US', pl: 'pl-PL' };
const DICTATION_RESUME_AFTER_SEND_STORAGE_KEY = 'cretli-dictation-resume-after-send';

export function getStoredDictationResumeAfterSend() {
  if (typeof localStorage === 'undefined') return true;
  try {
    const raw = readStorageValueWithAlias(localStorage, DICTATION_RESUME_AFTER_SEND_STORAGE_KEY, '');
    if (raw == null) return true;
    return raw !== 'false';
  } catch {
    return true;
  }
}

export function setStoredDictationResumeAfterSend(enabled) {
  if (typeof localStorage === 'undefined') return;
  try {
    writeStorageValueWithAlias(
      localStorage,
      DICTATION_RESUME_AFTER_SEND_STORAGE_KEY,
      enabled ? 'true' : 'false'
    );
  } catch {}
}

export function createSendBarMedia(options) {
  const {
    root,
    micBtn,
    showScreenshotButton = false,
    uploadScreenshot,
    captureHostScreenshot = null,
    getCaptureHostScreenshot = null,
    requestHostPagePick = null,
    getRequestHostPagePick = null,
    getHostPagePickLabel = null,
    getInputElement,
    addUploadingAttachment,
    finishUploadingAttachment,
    removePendingAttachment,
    setPageSelectionAttachment,
  } = options;

  let dictationResumeAfterSend = getStoredDictationResumeAfterSend();
  let resumeDictationAfterSend = false;

  let recognition = null;
  /** Server-side dictation, used only where Web Speech is missing. */
  let micRecorder = null;
  let micListening = false;
  let userRequestedStop = false;
  let skipFlushToInput = false;
  let accumulatedTranscript = [];
  let lastCumulative = '';
  let dictationPrefix = '';

  function updateLiveInput(interimTranscript) {
    const el = getInputElement();
    if (!el) return;
    const base = dictationPrefix + (dictationPrefix ? ' ' : '') + accumulatedTranscript.join(' ');
    const interim = (interimTranscript && interimTranscript.trim()) ? interimTranscript.trim() : '';
    el.value = base + (interim ? ' ' + interim : '');
    if (el.tagName === 'TEXTAREA') el.scrollTop = el.scrollHeight;
    else el.scrollLeft = el.scrollWidth;
    el.selectionStart = el.selectionEnd = el.value.length;
  }

  function appendDictatedText(text) {
    const el = getInputElement();
    const addition = String(text || '').trim();
    if (!el || !addition) return;
    const prefix = el.value ? `${el.value.trimEnd()} ` : '';
    el.value = prefix + addition;
    if (el.tagName === 'TEXTAREA') el.scrollTop = el.scrollHeight;
    else el.scrollLeft = el.scrollWidth;
    el.selectionStart = el.selectionEnd = el.value.length;
  }

  async function finishServerDictation() {
    if (!micRecorder || !micRecorder.isRecording()) return;
    if (micBtn) {
      micBtn.disabled = true;
      micBtn.title = t('voice.transcribing');
    }
    const result = await micRecorder.stop();
    if (micBtn) {
      micBtn.disabled = false;
      micBtn.title = t('voice.dictateServerTitle');
    }
    if (!result.ok) {
      alert(`${t('voice.transcribeFailed')}: ${result.error || ''}`.trim());
      return;
    }
    appendDictatedText(result.text);
  }

  function stopDictation() {
    if (!micListening) return;
    resumeDictationAfterSend = dictationResumeAfterSend;
    skipFlushToInput = true;
    userRequestedStop = true;
    if (recognition) recognition.stop();
  }

  function startDictation() {
    if (micListening) return;
    if (!recognition) {
      // Server-side path: recording is driven by the mic button, not by send.
      if (micRecorder && !micRecorder.isRecording()) void micRecorder.start();
      return;
    }
    accumulatedTranscript = [];
    lastCumulative = '';
    const el = getInputElement();
    dictationPrefix = (el && el.value) ? el.value.trim() : '';
    userRequestedStop = false;
    micListening = true;
    if (micBtn) {
      micBtn.classList.add('listening');
      micBtn.title = t('sendBar.dictatingTitle');
    }
    updateLiveInput('');
    recognition.start();
  }

  function shouldResumeAfterSend() {
    return resumeDictationAfterSend;
  }

  function clearResumeAfterSend() {
    resumeDictationAfterSend = false;
  }

  function getDictationResumeAfterSend() {
    return dictationResumeAfterSend;
  }

  function setDictationResumeAfterSend(enabled) {
    dictationResumeAfterSend = !!enabled;
    setStoredDictationResumeAfterSend(dictationResumeAfterSend);
  }

  if (micBtn && typeof window !== 'undefined') {
    const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRecognitionAPI) {
      recognition = new SpeechRecognitionAPI();
      recognition.lang = DICTATION_LANGS[getCurrentLang()] || DICTATION_LANGS.en;
      recognition.continuous = true;
      recognition.interimResults = true;

      recognition.onresult = (e) => {
        let lastInterim = '';
        for (let i = e.resultIndex; i < e.results.length; i += 1) {
          const result = e.results[i];
          const transcript = (result[0] && result[0].transcript) ? result[0].transcript.trim() : '';
          if (result.isFinal) {
            if (!transcript) continue;
            let toPush = transcript;
            if (transcript.startsWith(lastCumulative)) {
              toPush = transcript.slice(lastCumulative.length).trim();
            }
            lastCumulative = transcript;
            if (!toPush) continue;
            let last = accumulatedTranscript[accumulatedTranscript.length - 1];
            if (last && toPush.startsWith(last)) toPush = toPush.slice(last.length).trim();
            if (!toPush) continue;
            last = accumulatedTranscript[accumulatedTranscript.length - 1];
            if (last === toPush) continue;
            if (last && last.endsWith(toPush)) continue;
            if (last && last.includes(toPush) && toPush.length >= 3) continue;
            accumulatedTranscript.push(toPush);
          } else {
            lastInterim = transcript;
          }
        }
        updateLiveInput(lastInterim);
      };

      recognition.onerror = () => {
        micListening = false;
        userRequestedStop = false;
        if (!micBtn) return;
        micBtn.classList.remove('listening');
        micBtn.title = t('sendBar.dictateTitle');
      };

      recognition.onend = () => {
        if (userRequestedStop) {
          const el = getInputElement();
          if (el && !skipFlushToInput) {
            el.value = dictationPrefix + (dictationPrefix ? ' ' : '') + accumulatedTranscript.join(' ');
            if (el.tagName === 'TEXTAREA') el.scrollTop = el.scrollHeight;
            else el.scrollLeft = el.scrollWidth;
            el.selectionStart = el.selectionEnd = el.value.length;
          }
          accumulatedTranscript = [];
          micListening = false;
          userRequestedStop = false;
          skipFlushToInput = false;
          if (micBtn) {
            micBtn.classList.remove('listening');
            micBtn.title = t('sendBar.dictateTitle');
          }
          return;
        }
        if (!micListening) return;
        setTimeout(() => {
          if (micListening && recognition) recognition.start();
        }, 80);
      };

      micBtn.addEventListener('click', () => {
        if (micListening) {
          userRequestedStop = true;
          recognition.stop();
          return;
        }
        startDictation();
      });
    } else if (isMediaRecorderAvailable()) {
      // Safari and Firefox have no Web Speech: record and transcribe on the server.
      micRecorder = createMicRecorder({
        getLang: () => getCurrentLang(),
        onStateChange: (isRecording) => {
          micBtn.classList.toggle('listening', isRecording);
          micBtn.title = isRecording ? t('voice.recordingTitle') : t('voice.dictateServerTitle');
        },
      });
      micBtn.title = t('voice.dictateServerTitle');
      micBtn.addEventListener('click', () => {
        if (micRecorder.isRecording()) {
          void finishServerDictation();
          return;
        }
        void micRecorder.start().then((result) => {
          if (result.ok) return;
          alert(`${t('voice.recordFailed')}: ${result.error || ''}`.trim());
        });
      });
    } else {
      micBtn.disabled = true;
      micBtn.title = t('sendBar.dictateUnavailable');
    }
  }

  if (showScreenshotButton && typeof uploadScreenshot === 'function') {
    initScreenshotControls({
      root,
      uploadScreenshot,
      captureHostScreenshot: typeof captureHostScreenshot === 'function' ? captureHostScreenshot : null,
      getCaptureHostScreenshot: typeof getCaptureHostScreenshot === 'function' ? getCaptureHostScreenshot : null,
      requestHostPagePick: typeof requestHostPagePick === 'function' ? requestHostPagePick : null,
      getRequestHostPagePick: typeof getRequestHostPagePick === 'function' ? getRequestHostPagePick : null,
      getHostPagePickLabel: typeof getHostPagePickLabel === 'function' ? getHostPagePickLabel : null,
      getInputElement,
      addUploadingAttachment,
      finishUploadingAttachment,
      removePendingAttachment,
      setPageSelectionAttachment,
    });
  }

  return {
    stopDictation,
    startDictation,
    shouldResumeAfterSend,
    clearResumeAfterSend,
    getDictationResumeAfterSend,
    setDictationResumeAfterSend,
  };
}

function initScreenshotControls(options) {
  const {
    root,
    uploadScreenshot,
    captureHostScreenshot = null,
    getCaptureHostScreenshot = null,
    requestHostPagePick = null,
    getRequestHostPagePick = null,
    getHostPagePickLabel = null,
    getInputElement,
    addUploadingAttachment,
    finishUploadingAttachment,
    removePendingAttachment,
    setPageSelectionAttachment,
  } = options;

  const attachBtn = root.querySelector('.send-keys-screenshot-btn');
  const screenshotInput = root.querySelector('.send-keys-screenshot-input');
  if (!attachBtn || !screenshotInput) return;

  let cameraInput = root.querySelector('.send-keys-camera-input');
  if (!cameraInput) {
    cameraInput = document.createElement('input');
    cameraInput.type = 'file';
    cameraInput.accept = 'image/*';
    cameraInput.setAttribute('capture', 'environment');
    cameraInput.className = 'send-keys-camera-input';
    cameraInput.setAttribute('aria-hidden', 'true');
    cameraInput.tabIndex = -1;
    cameraInput.style.cssText = 'position:absolute;width:0;height:0;opacity:0;';
    root.appendChild(cameraInput);
  }

  let attachLoadingCount = 0;
  const setAttachLoading = (active) => {
    attachLoadingCount += active ? 1 : -1;
    if (attachLoadingCount < 0) attachLoadingCount = 0;
    const isLoading = attachLoadingCount > 0;
    attachBtn.classList.toggle('is-loading', isLoading);
    attachBtn.disabled = isLoading;
    attachBtn.setAttribute('aria-busy', isLoading ? 'true' : 'false');
  };

  const uploadAndHandle = async (task, uploadMeta = {}) => {
    setAttachLoading(true);
    try {
      const uploadingId = addUploadingAttachment(uploadMeta.previewUrl || '', uploadMeta.name || '');
      try {
        const result = await task();
        if (result.ok && result.path) {
          finishUploadingAttachment(uploadingId, result.path, result.file || null);
          return;
        }
        removePendingAttachment(uploadingId);
        if (result.error) showScreenshotError(result);
      } catch (error) {
        removePendingAttachment(uploadingId);
        showScreenshotError({
          error: t('sendBar.uploadImageFailed'),
          debug: buildCaptureDebugInfo({
            reason: 'upload-task-throw',
            errorName: error?.name || '',
            errorMessage: error?.message || String(error || ''),
          }),
        });
      }
    } finally {
      setAttachLoading(false);
    }
  };

  const resolveHostPagePickFn = () => {
    if (typeof getRequestHostPagePick === 'function') {
      const resolved = getRequestHostPagePick();
      if (typeof resolved === 'function') return resolved;
    }
    return typeof requestHostPagePick === 'function' ? requestHostPagePick : null;
  };

  const hasDisplayCapture = typeof navigator?.mediaDevices?.getDisplayMedia === 'function';
  const resolveHostCaptureFn = () => {
    if (typeof getCaptureHostScreenshot === 'function') {
      const resolved = getCaptureHostScreenshot();
      if (typeof resolved === 'function') return resolved;
    }
    return typeof captureHostScreenshot === 'function' ? captureHostScreenshot : null;
  };
  const resolveChromeCaptureAvailability = () => {
    const hostCaptureFn = resolveHostCaptureFn();
    const hasHostCapture = typeof hostCaptureFn === 'function';
    return {
      enabled: hasHostCapture || hasDisplayCapture,
      hasHostCapture,
      hasDisplayCapture,
      hostCaptureFn,
    };
  };
  const screenshotMenu = document.createElement('div');
  screenshotMenu.className = 'chat-list-modal send-keys-screenshot-menu';
  screenshotMenu.hidden = true;
  screenshotMenu.innerHTML =
    '<div class="chat-list-panel send-keys-screenshot-menu-panel">' +
    '<ul class="chat-list-items send-keys-screenshot-menu-items" role="menu">' +
    '<li class="chat-list-item send-keys-screenshot-menu-item" role="menuitem" data-action="page-pick" aria-disabled="false">' +
    '<span class="mdi mdi-cursor-default-click" aria-hidden="true"></span>' +
    '<span class="chat-list-item-title">' + escapeHtml(t('sendBar.pickPageElement')) + '</span>' +
    '</li>' +
    '<li class="chat-list-item send-keys-screenshot-menu-item" role="menuitem" data-action="file">' +
    '<span class="mdi mdi-image-plus" aria-hidden="true"></span>' +
    '<span class="chat-list-item-title">' + escapeHtml(t('sendBar.attachFile')) + '</span>' +
    '</li>' +
    '<li class="chat-list-item send-keys-screenshot-menu-item" role="menuitem" data-action="camera">' +
    '<span class="mdi mdi-camera" aria-hidden="true"></span>' +
    '<span class="chat-list-item-title">' + escapeHtml(t('sendBar.takePhoto')) + '</span>' +
    '</li>' +
    '<li class="chat-list-item send-keys-screenshot-menu-item" role="menuitem" data-action="chrome" aria-disabled="false">' +
    '<span class="mdi mdi-google-chrome" aria-hidden="true"></span>' +
    '<span class="chat-list-item-title">' + escapeHtml(t('sendBar.chromeScreen')) + '</span>' +
    '</li>' +
    '<li class="chat-list-item send-keys-screenshot-menu-item" role="menuitem" data-action="clipboard">' +
    '<span class="mdi mdi-content-paste" aria-hidden="true"></span>' +
    '<span class="chat-list-item-title">' + escapeHtml(t('sendBar.clipboardPaste')) + '</span>' +
    '</li>' +
    '</ul>' +
    '</div>';
  document.body.appendChild(screenshotMenu);

  const pagePickMenuItem = screenshotMenu.querySelector('[data-action="page-pick"]');
  const pagePickMenuLabel = pagePickMenuItem?.querySelector('.chat-list-item-title') || null;
  const refreshPagePickMenuState = () => {
    if (!pagePickMenuItem || !pagePickMenuLabel) return;
    const hostPickFn = resolveHostPagePickFn();
    const enabled = typeof hostPickFn === 'function';
    pagePickMenuItem.classList.toggle('is-disabled', !enabled);
    pagePickMenuItem.setAttribute('aria-disabled', enabled ? 'false' : 'true');
    pagePickMenuLabel.textContent = enabled
      ? t('sendBar.pickPageElement')
      : `${t('sendBar.pickPageElement')} (${t('sendBar.widgetOnly')})`;
  };
  const chromeMenuItem = screenshotMenu.querySelector('[data-action="chrome"]');
  const chromeMenuLabel = chromeMenuItem?.querySelector('.chat-list-item-title') || null;
  const refreshChromeCaptureMenuState = () => {
    if (!chromeMenuItem || !chromeMenuLabel) return;
    const availability = resolveChromeCaptureAvailability();
    chromeMenuItem.classList.toggle('is-disabled', !availability.enabled);
    chromeMenuItem.setAttribute('aria-disabled', availability.enabled ? 'false' : 'true');
    if (availability.hasHostCapture) {
      chromeMenuLabel.textContent = t('sendBar.hostScreen');
      return;
    }
    const suffix = availability.enabled
      ? ''
      : (isMobileLikeDevice() ? t('sendBar.desktopOnly') : t('sendBar.unavailable'));
    chromeMenuLabel.textContent = t('sendBar.chromeScreen') + (suffix ? ' (' + suffix + ')' : '');
  };

  const clipboardMenuItem = screenshotMenu.querySelector('[data-action="clipboard"]');
  const clipboardMenuLabel = clipboardMenuItem?.querySelector('.chat-list-item-title') || null;
  const setClipboardMenuState = (enabled, suffix = '') => {
    if (!clipboardMenuItem || !clipboardMenuLabel) return;
    clipboardMenuItem.classList.toggle('is-disabled', !enabled);
    clipboardMenuItem.setAttribute('aria-disabled', enabled ? 'false' : 'true');
    clipboardMenuLabel.textContent = t('sendBar.clipboardPaste') + (suffix ? ' (' + suffix + ')' : '');
  };

  const refreshClipboardMenuState = async () => {
    if (!navigator?.clipboard?.read) {
      setClipboardMenuState(false, t('sendBar.unavailable'));
      return;
    }
    try {
      const items = await navigator.clipboard.read();
      const hasImage = Array.isArray(items)
        && items.some((item) => Array.isArray(item.types) && item.types.some((type) => type.startsWith('image/')));
      setClipboardMenuState(hasImage, hasImage ? '' : t('sendBar.clipboardEmpty'));
    } catch {
      // Missing clipboard permission: keep the item enabled; click handler shows a modal fallback.
      setClipboardMenuState(true);
    }
  };

  const handleScreenshotMenuAction = async (action) => {
    screenshotMenuApi.close();
    if (action === 'page-pick') {
      const hostPickFn = resolveHostPagePickFn();
      if (typeof hostPickFn !== 'function') {
        showScreenshotError({
          error: t('sendBar.pickPageElementWidgetOnly'),
        });
        return;
      }
      setAttachLoading(true);
      try {
        const context = await hostPickFn();
        const labelFn = typeof getHostPagePickLabel === 'function'
          ? getHostPagePickLabel
          : () => t('sendBar.pickPageElement');
        if (typeof setPageSelectionAttachment === 'function') {
          setPageSelectionAttachment(labelFn(context), context);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error || '');
        if (!/cancel/i.test(message)) {
          showScreenshotError({ error: message || t('sendBar.pickPageElementFailed') });
        }
      } finally {
        setAttachLoading(false);
      }
      return;
    }
    if (action === 'file') {
      screenshotInput.click();
      return;
    }
    if (action === 'camera') {
      cameraInput.click();
      return;
    }
    if (action === 'clipboard') {
      await uploadAndHandle(() => captureClipboardScreenshot(uploadScreenshot));
      return;
    }
    if (action !== 'chrome') return;
    const availability = resolveChromeCaptureAvailability();
    if (!availability.enabled) {
      showScreenshotError({
        error: isMobileLikeDevice()
          ? t('sendBar.chromeCaptureDesktopOnly')
          : t('sendBar.screenCaptureUnsupported'),
        debug: buildCaptureDebugInfo({
          reason: 'chrome-capture-unavailable',
          hasHostCapture: availability.hasHostCapture,
          hasDisplayCapture: availability.hasDisplayCapture,
          isMobileLike: isMobileLikeDevice(),
        }),
      });
      return;
    }
    if (typeof availability.hostCaptureFn === 'function') {
      await uploadAndHandle(async () => {
        const result = await availability.hostCaptureFn();
        if (!result.ok || !result.file) return result;
        const upload = await uploadScreenshot(result.file);
        return { ...upload, file: result.file };
      });
      return;
    }
    await uploadAndHandle(() => captureChromeScreenshot(uploadScreenshot));
  };

  const bindScreenshotMenuItem = (el) => {
    if (!el || el.dataset.bound === '1') return;
    el.dataset.bound = '1';
    el.addEventListener('click', async () => {
      if (el.classList.contains('is-disabled')) return;
      const action = el.getAttribute('data-action');
      await handleScreenshotMenuAction(action);
    });
  };

  const ensureCameraMenuItem = () => {
    if (screenshotMenu.querySelector('[data-action="camera"]')) return;
    const fileItem = screenshotMenu.querySelector('[data-action="file"]');
    if (!fileItem) return;
    const cameraItem = document.createElement('li');
    cameraItem.className = 'chat-list-item send-keys-screenshot-menu-item';
    cameraItem.setAttribute('role', 'menuitem');
    cameraItem.setAttribute('data-action', 'camera');
    cameraItem.innerHTML =
      '<span class="mdi mdi-camera" aria-hidden="true"></span>' +
      '<span class="chat-list-item-title">' + escapeHtml(t('sendBar.takePhoto')) + '</span>';
    fileItem.insertAdjacentElement('afterend', cameraItem);
    bindScreenshotMenuItem(cameraItem);
  };

  const screenshotMenuApi = initDropdown({
    triggerEl: attachBtn,
    floatingEl: screenshotMenu,
    compact: true,
    placement: 'top-end',
    matchTriggerWidth: false,
    offsetPx: 6,
    viewportPadding: 8,
    minWidthPx: 180,
    maxHeightPx: 320,
    onOpen: () => {
      ensureCameraMenuItem();
      refreshPagePickMenuState();
      refreshChromeCaptureMenuState();
      refreshClipboardMenuState().catch(() => {});
    },
  });

  attachBtn.addEventListener('click', () => screenshotMenuApi.toggle());

  if (typeof window !== 'undefined') {
    window.addEventListener('cr-widget-connected', () => {
      refreshChromeCaptureMenuState();
      refreshPagePickMenuState();
    });
  }
  refreshChromeCaptureMenuState();
  refreshPagePickMenuState();

  const handleImageInputChange = async (inputEl) => {
    const files = inputEl.files ? Array.from(inputEl.files) : [];
    inputEl.value = '';
    if (files.length === 0) return;
    const uploads = files.map((file) => {
      const previewUrl = URL.createObjectURL(file);
      return uploadAndHandle(async () => {
        const result = await uploadScreenshot(file);
        return { ...result, file };
      }, { previewUrl, name: file.name });
    });
    await Promise.all(uploads);
  };

  screenshotInput.addEventListener('change', () => {
    void handleImageInputChange(screenshotInput);
  });

  cameraInput.addEventListener('change', () => {
    void handleImageInputChange(cameraInput);
  });

  screenshotMenu.querySelectorAll('.send-keys-screenshot-menu-item').forEach((el) => {
    bindScreenshotMenuItem(el);
  });
  ensureCameraMenuItem();

  const onPaste = async (e) => {
    const el = getInputElement();
    if (!el) return;
    if (e.target !== el && !el.contains(e.target)) return;
    const files = e.clipboardData && e.clipboardData.files;
    if (!files || files.length === 0) return;
    const file = Array.from(files).find((f) => f.type.startsWith('image/'));
    if (!file) return;
    e.preventDefault();
    const previewUrl = URL.createObjectURL(file);
    await uploadAndHandle(async () => {
      const result = await uploadScreenshot(file);
      return { ...result, file };
    }, { previewUrl, name: file.name });
  };
  document.addEventListener('paste', onPaste);
}

async function captureClipboardScreenshot(uploadScreenshot) {
  if (typeof window === 'undefined') {
    return {
      ok: false,
      error: t('sendBar.windowMissing'),
      debug: buildCaptureDebugInfo({ reason: 'window-missing' }),
    };
  }
  if (!navigator?.clipboard?.read) {
    return {
      ok: false,
      error: t('sendBar.clipboardReadUnsupported'),
      debug: buildCaptureDebugInfo({ reason: 'clipboard-read-missing' }),
    };
  }

  try {
    const clipboardItems = await navigator.clipboard.read();
    if (!Array.isArray(clipboardItems) || clipboardItems.length === 0) {
      return {
        ok: false,
        error: t('sendBar.clipboardIsEmpty'),
        debug: buildCaptureDebugInfo({ reason: 'clipboard-empty' }),
      };
    }

    for (const item of clipboardItems) {
      const imageType = (item.types || []).find((type) => type.startsWith('image/'));
      if (!imageType) continue;
      const blob = await item.getType(imageType);
      const file = new File([blob], `clipboard-${Date.now()}.png`, {
        type: blob.type || imageType || 'image/png',
      });
      const result = await uploadScreenshot(file);
      return { ...result, file };
    }

    return {
      ok: false,
      error: t('sendBar.clipboardNoImage'),
      debug: buildCaptureDebugInfo({ reason: 'clipboard-no-image' }),
    };
  } catch (error) {
    const errorName =
      error && typeof error === 'object' && 'name' in error ? String(error.name || '') : '';
    const errorMessage =
      error && typeof error === 'object' && 'message' in error
        ? String(error.message || '')
        : String(error || '');
    if (
      errorName === 'NotAllowedError'
      || errorName === 'SecurityError'
      || /denied|notallowed|permission/i.test(errorMessage)
    ) {
      return {
        ok: false,
        error: t('sendBar.clipboardPermissionDenied'),
        debug: buildCaptureDebugInfo({
          reason: 'clipboard-permission-denied',
          errorName,
          errorMessage,
        }),
      };
    }
    return {
      ok: false,
      error: t('sendBar.clipboardReadFailed'),
      debug: buildCaptureDebugInfo({
        reason: 'clipboard-read-error',
        errorName,
        errorMessage,
      }),
    };
  }
}

async function captureChromeScreenshot(uploadScreenshot) {
  if (typeof window === 'undefined') {
    return {
      ok: false,
      error: t('sendBar.windowMissing'),
      debug: buildCaptureDebugInfo({ reason: 'window-missing' }),
    };
  }
  if (!navigator?.mediaDevices?.getDisplayMedia) {
    return {
      ok: false,
      error: t('sendBar.getDisplayMediaMissing'),
      debug: buildCaptureDebugInfo({ reason: 'getDisplayMedia-missing' }),
    };
  }

  let stream = null;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: isMobileLikeDevice() ? true : { displaySurface: 'browser' },
      audio: false,
    });
    const track = stream.getVideoTracks && stream.getVideoTracks()[0];
    if (!track) {
      return {
        ok: false,
        error: t('sendBar.videoTrackMissing'),
        debug: buildCaptureDebugInfo({ reason: 'video-track-missing' }),
      };
    }
    const bitmap = await grabFrameFromTrack(track);
    if (!bitmap) {
      return {
        ok: false,
        error: t('sendBar.frameGrabFailed'),
        debug: buildCaptureDebugInfo({ reason: 'frame-grab-failed' }),
      };
    }
    const file = await imageBitmapToPngFile(bitmap);
    if (typeof bitmap.close === 'function') bitmap.close();
    const result = await uploadScreenshot(file);
    return { ...result, file };
  } catch (error) {
    const errorName =
      error && typeof error === 'object' && 'name' in error ? String(error.name || '') : '';
    const message =
      error && typeof error === 'object' && 'message' in error
        ? String(error.message || '')
        : String(error || '');
    if (
      errorName === 'NotAllowedError'
      || errorName === 'PermissionDeniedError'
      || /denied|notallowed|cancel/i.test(message)
    ) {
      return {
        ok: false,
        error: t('sendBar.captureCancelled'),
        debug: buildCaptureDebugInfo({
          reason: 'permission-denied-or-cancelled',
          errorName,
          errorMessage: message,
        }),
      };
    }
    return {
      ok: false,
      error: message || t('sendBar.chromeCaptureFailed'),
      debug: buildCaptureDebugInfo({
        reason: 'getDisplayMedia-throw',
        errorName,
        errorMessage: message,
      }),
    };
  } finally {
    stream?.getTracks?.().forEach((track) => track.stop());
  }
}

function grabFrameFromTrack(track) {
  if (typeof ImageCapture === 'function') {
    try {
      const imageCapture = new ImageCapture(track);
      return imageCapture.grabFrame();
    } catch {}
  }
  return captureFrameWithVideo(track);
}

function captureFrameWithVideo(track) {
  return new Promise((resolve) => {
    const stream = new MediaStream([track]);
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    video.onloadeddata = async () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, video.videoWidth || 1);
        canvas.height = Math.max(1, video.videoHeight || 1);
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(null);
          return;
        }
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const bitmap = await createImageBitmap(canvas);
        resolve(bitmap);
      } catch {
        resolve(null);
      } finally {
        stream.getTracks().forEach((streamTrack) => streamTrack.stop());
      }
    };
    video.onerror = () => {
      stream.getTracks().forEach((streamTrack) => streamTrack.stop());
      resolve(null);
    };
    video.play().catch(() => {
      stream.getTracks().forEach((streamTrack) => streamTrack.stop());
      resolve(null);
    });
  });
}

function imageBitmapToPngFile(bitmap) {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width || 1;
    canvas.height = bitmap.height || 1;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      reject(new Error(t('sendBar.canvasContextMissing')));
      return;
    }
    ctx.drawImage(bitmap, 0, 0);
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error(t('sendBar.pngCreateFailed')));
        return;
      }
      resolve(new File([blob], `chrome-screen-${Date.now()}.png`, { type: 'image/png' }));
    }, 'image/png');
  });
}

let screenshotErrorModalApi = null;
let screenshotErrorTextEl = null;

function ensureScreenshotErrorModal() {
  if (typeof document === 'undefined') return null;
  if (screenshotErrorModalApi) return screenshotErrorModalApi;

  const modal = document.createElement('div');
  modal.className = 'chat-settings-modal sendbar-error-modal';
  modal.hidden = true;
  modal.innerHTML =
    '<div class="chat-settings-backdrop" aria-hidden="true"></div>' +
    '<div class="chat-settings-dialog sendbar-error-dialog" role="dialog" aria-modal="true" aria-label="'
    + escapeHtml(t('sendBar.screenshotError')) + '">' +
    '<h3 class="chat-settings-title">' + escapeHtml(t('sendBar.screenshotError')) + '</h3>' +
    '<p class="settings-hint sendbar-error-text"></p>' +
    '<div class="chat-settings-actions">' +
    '<button type="button" class="chat-settings-btn-primary sendbar-error-close-btn">OK</button>' +
    '</div>' +
    '</div>';
  document.body.appendChild(modal);
  screenshotErrorTextEl = modal.querySelector('.sendbar-error-text');
  screenshotErrorModalApi = initModal(modal, {
    backdropSelector: '.chat-settings-backdrop',
  });
  const closeBtn = modal.querySelector('.sendbar-error-close-btn');
  if (closeBtn) {
    closeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      screenshotErrorModalApi?.close();
    });
  }
  return screenshotErrorModalApi;
}

function showScreenshotError(errorPayload) {
  const modalMessage = formatScreenshotError(errorPayload);
  if (!modalMessage) return;
  const modalApi = ensureScreenshotErrorModal();
  if (!modalApi || !screenshotErrorTextEl) return;
  screenshotErrorTextEl.textContent = modalMessage;
  modalApi.open();
}

function formatScreenshotError(errorPayload) {
  const errorText =
    typeof errorPayload === 'string'
      ? errorPayload
      : String(errorPayload?.error || '').trim();
  if (!errorText) return '';
  const debug = errorPayload && typeof errorPayload === 'object' ? errorPayload.debug : null;
  const prefix = t('sendBar.screenshotPrefix');
  if (!debug || typeof debug !== 'object') return prefix + errorText;

  const lines = [prefix + errorText, '', t('sendBar.diagnostics')];
  const orderedKeys = [
    'reason',
    'errorName',
    'errorMessage',
    'isSecureContext',
    'protocol',
    'origin',
    'host',
    'hasMediaDevices',
    'hasGetDisplayMedia',
    'documentHasFocus',
    'visibilityState',
  ];
  for (const key of orderedKeys) {
    if (!(key in debug)) continue;
    lines.push('- ' + key + ': ' + String(debug[key]));
  }
  return lines.join('\n');
}

function isMobileLikeDevice() {
  if (typeof navigator === 'undefined') return false;
  return /Android|iPhone|iPad|iPod|Mobi/i.test(navigator.userAgent || '');
}

function buildCaptureDebugInfo(extra = {}) {
  return {
    ...extra,
    isSecureContext: typeof window !== 'undefined' ? window.isSecureContext : false,
    protocol: typeof location !== 'undefined' ? location.protocol : '',
    origin: typeof location !== 'undefined' ? location.origin : '',
    host: typeof location !== 'undefined' ? location.host : '',
    hasMediaDevices: !!navigator?.mediaDevices,
    hasGetDisplayMedia: typeof navigator?.mediaDevices?.getDisplayMedia === 'function',
    documentHasFocus: typeof document !== 'undefined' ? document.hasFocus() : false,
    visibilityState: typeof document !== 'undefined' ? document.visibilityState : '',
  };
}
