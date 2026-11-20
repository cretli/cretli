import { t } from '../../i18n/index.js';
import { openSdkImageLightbox } from '../chat/history/services/inlineImages.js';

/**
 * Replaces the element's content with a decorative Material Design icon (no HTML parsing).
 * @param {HTMLElement} el
 * @param {string} icon e.g. `mdi-close`
 */
function setIcon(el, icon) {
  const span = document.createElement('span');
  span.className = `mdi ${icon}`;
  span.setAttribute('aria-hidden', 'true');
  el.replaceChildren(span);
}

export function createSendBarAttachments(options) {
  const {
    attachmentsBar,
    sendBtn,
    getInputElement,
    getBasePlaceholder,
    onVisibilityChange = () => {},
    isReadOnly = () => false,
  } = options;

  if (!(attachmentsBar instanceof HTMLElement)) {
    throw new Error('sendBarAttachments: attachmentsBar is required');
  }

  let attachmentIdSeq = 0;
  const pendingAttachments = [];

  function hasUploadingAttachments() {
    return pendingAttachments.some((attachment) => attachment.uploading);
  }

  function getAttachmentPlaceholder() {
    if (isReadOnly()) return getBasePlaceholder();
    const count = pendingAttachments.length;
    const hasPageSelection = pendingAttachments.some((attachment) => attachment.kind === 'page-selection');
    if (count <= 0) return getBasePlaceholder();
    if (hasPageSelection && count === 1) return t('sendBar.placeholderPageSelection');
    const videoCount = pendingAttachments.filter((attachment) => attachment.kind === 'video').length;
    if (videoCount > 0 && videoCount === count) return t('sendBar.placeholderVideo');
    const imageCount = pendingAttachments.filter((attachment) => attachment.kind !== 'page-selection').length;
    if (imageCount <= 0) return t('sendBar.placeholderPageSelection');
    return imageCount === 1
      ? t('sendBar.placeholderOneImage')
      : t('sendBar.placeholderManyImages', { count: imageCount });
  }

  function updateInputPlaceholder() {
    if (typeof getInputElement !== 'function') return;
    const el = getInputElement();
    if (!el) return;
    el.placeholder = getAttachmentPlaceholder();
  }

  function updateSendButtonState() {
    if (!sendBtn) return;
    const uploading = hasUploadingAttachments();
    sendBtn.disabled = uploading || isReadOnly();
    sendBtn.setAttribute('aria-busy', uploading ? 'true' : 'false');
    sendBtn.title = uploading ? t('sendBar.uploadingImage') : '';
  }

  function removePendingAttachment(id) {
    const idx = pendingAttachments.findIndex((attachment) => attachment.id === id);
    if (idx === -1) return;
    const attachment = pendingAttachments[idx];
    if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    pendingAttachments.splice(idx, 1);
    renderAttachmentsBar();
  }

  function clearPendingAttachments() {
    pendingAttachments.forEach((attachment) => {
      if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    });
    pendingAttachments.length = 0;
    renderAttachmentsBar();
  }

  function renderAttachmentsBar() {
    if (pendingAttachments.length === 0) {
      attachmentsBar.hidden = true;
      attachmentsBar.textContent = '';
      updateInputPlaceholder();
      updateSendButtonState();
      onVisibilityChange();
      return;
    }

    attachmentsBar.hidden = false;
    attachmentsBar.textContent = '';
    pendingAttachments.forEach((attachment) => {
      const item = document.createElement('div');
      item.className = 'send-keys-attachment-item';
      if (attachment.kind === 'page-selection') item.classList.add('is-page-selection');
      if (attachment.kind === 'video') item.classList.add('is-video');
      if (attachment.uploading) item.classList.add('is-uploading');

      const thumb = document.createElement('div');
      thumb.className = 'send-keys-attachment-thumb';
      if (attachment.kind === 'page-selection') {
        setIcon(thumb, 'mdi-cursor-default-click');
        thumb.title = attachment.label || t('sendBar.pageElement');
      } else if (attachment.kind === 'video') {
        if (attachment.previewUrl) {
          const frame = document.createElement('video');
          frame.className = 'send-keys-attachment-video';
          frame.src = `${attachment.previewUrl}#t=0.1`;
          frame.muted = true;
          frame.preload = 'metadata';
          frame.playsInline = true;
          frame.addEventListener('error', () => {
            frame.remove();
            setIcon(thumb, 'mdi-video');
          });
          thumb.appendChild(frame);
        } else {
          setIcon(thumb, 'mdi-video');
        }
        thumb.title = attachment.name || attachment.path;
      } else if (attachment.previewUrl) {
        thumb.style.backgroundImage = `url("${attachment.previewUrl}")`;
        if (!attachment.uploading) {
          thumb.classList.add('is-previewable');
          thumb.addEventListener('click', () => openSdkImageLightbox(attachment.previewUrl, attachment.name || ''));
        }
      } else {
        thumb.textContent = 'IMG';
      }
      if (attachment.kind !== 'page-selection' && attachment.kind !== 'video') {
        thumb.title = attachment.path;
      }
      if (attachment.uploading) {
        const spinner = document.createElement('div');
        spinner.className = 'send-keys-attachment-spinner';
        thumb.appendChild(spinner);
      }
      item.appendChild(thumb);
      if (attachment.kind === 'page-selection' || attachment.kind === 'video') {
        const label = document.createElement('span');
        label.className = 'send-keys-attachment-page-label';
        label.textContent = attachment.kind === 'video' ? (attachment.name || t('sendBar.videoLabel')) : (attachment.label || t('sendBar.pageElement'));
        item.appendChild(label);
      }

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'send-keys-attachment-remove';
      removeBtn.setAttribute('aria-label', t('sendBar.removeAttachment'));
      removeBtn.title = t('sendBar.removeAttachment');
      setIcon(removeBtn, 'mdi-close');
      removeBtn.disabled = !!attachment.uploading;
      removeBtn.addEventListener('click', () => removePendingAttachment(attachment.id));
      item.appendChild(removeBtn);
      attachmentsBar.appendChild(item);
    });

    updateInputPlaceholder();
    updateSendButtonState();
    onVisibilityChange();
  }

  function setPageSelectionAttachment(label, context) {
    const existingIdx = pendingAttachments.findIndex((attachment) => attachment.kind === 'page-selection');
    if (existingIdx !== -1) pendingAttachments.splice(existingIdx, 1);
    attachmentIdSeq += 1;
    pendingAttachments.unshift({
      id: 'att-' + attachmentIdSeq,
      kind: 'page-selection',
      label: label || t('sendBar.pageElement'),
      context: context || null,
      path: '',
      name: 'page-selection',
      uploading: false,
    });
    renderAttachmentsBar();
  }

  function getPageSelectionContext() {
    const attachment = pendingAttachments.find((item) => item.kind === 'page-selection');
    return attachment?.context || null;
  }

  function addUploadingAttachment(previewUrl = '', name = 'uploading', kind = 'image') {
    attachmentIdSeq += 1;
    const id = 'att-' + attachmentIdSeq;
    pendingAttachments.push({
      id,
      kind,
      path: '',
      name,
      previewUrl,
      uploading: true,
    });
    renderAttachmentsBar();
    return id;
  }

  function finishUploadingAttachment(id, path, file = null) {
    const attachment = pendingAttachments.find((item) => item.id === id);
    if (!attachment) return;
    attachment.path = path || '';
    attachment.name = file?.name || basenameFromPath(path || '');
    if (!attachment.previewUrl && file instanceof File) {
      attachment.previewUrl = URL.createObjectURL(file);
    }
    attachment.uploading = false;
    renderAttachmentsBar();
  }

  function getAttachmentSuffix() {
    return pendingAttachments
      .filter((attachment) => !!attachment.path)
      .map((attachment) => (attachment.kind === 'video' ? '[Video: ' : '[Screenshot: ') + attachment.path + ']')
      .join('\n');
  }

  function getAttachmentPaths() {
    return pendingAttachments
      .filter((attachment) => attachment.kind !== 'page-selection')
      .map((attachment) => attachment.path);
  }

  renderAttachmentsBar();

  return {
    hasUploadingAttachments,
    getAttachmentPlaceholder,
    renderAttachmentsBar,
    addUploadingAttachment,
    finishUploadingAttachment,
    removePendingAttachment,
    clearPendingAttachments,
    getAttachmentSuffix,
    getAttachmentPaths,
    getPageSelectionContext,
    setPageSelectionAttachment,
    updateInputPlaceholder,
    updateSendButtonState,
  };
}

function basenameFromPath(path) {
  if (!path) return '';
  const normalized = String(path).replace(/\\/g, '/');
  const parts = normalized.split('/');
  return parts[parts.length - 1] || normalized;
}
