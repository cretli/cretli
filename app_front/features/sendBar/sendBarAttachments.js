import { t } from '../../i18n/index.js';

export function createSendBarAttachments(options) {
  const {
    attachmentsBar,
    sendBtn,
    getInputElement,
    getBasePlaceholder,
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
    const count = pendingAttachments.length;
    const hasPageSelection = pendingAttachments.some((attachment) => attachment.kind === 'page-selection');
    if (count <= 0) return getBasePlaceholder();
    if (hasPageSelection && count === 1) return t('sendBar.placeholderPageSelection');
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
    sendBtn.disabled = uploading;
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
      return;
    }

    attachmentsBar.hidden = false;
    attachmentsBar.textContent = '';
    pendingAttachments.forEach((attachment) => {
      const item = document.createElement('div');
      item.className = 'send-keys-attachment-item';
      if (attachment.kind === 'page-selection') item.classList.add('is-page-selection');
      if (attachment.uploading) item.classList.add('is-uploading');

      const thumb = document.createElement('div');
      thumb.className = 'send-keys-attachment-thumb';
      if (attachment.kind === 'page-selection') {
        thumb.innerHTML = '<span class="mdi mdi-cursor-default-click" aria-hidden="true"></span>';
        thumb.title = attachment.label || t('sendBar.pageElement');
      } else if (attachment.previewUrl) {
        thumb.style.backgroundImage = `url("${attachment.previewUrl}")`;
      } else {
        thumb.textContent = 'IMG';
      }
      if (attachment.kind !== 'page-selection') {
        thumb.title = attachment.path;
      }
      if (attachment.uploading) {
        const spinner = document.createElement('div');
        spinner.className = 'send-keys-attachment-spinner';
        thumb.appendChild(spinner);
      }
      item.appendChild(thumb);
      if (attachment.kind === 'page-selection') {
        const label = document.createElement('span');
        label.className = 'send-keys-attachment-page-label';
        label.textContent = attachment.label || t('sendBar.pageElement');
        item.appendChild(label);
      }

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'send-keys-attachment-remove';
      removeBtn.setAttribute('aria-label', t('sendBar.removeAttachment'));
      removeBtn.title = t('sendBar.removeAttachment');
      removeBtn.innerHTML = '<span class="mdi mdi-close" aria-hidden="true"></span>';
      removeBtn.disabled = !!attachment.uploading;
      removeBtn.addEventListener('click', () => removePendingAttachment(attachment.id));
      item.appendChild(removeBtn);
      attachmentsBar.appendChild(item);
    });

    updateInputPlaceholder();
    updateSendButtonState();
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

  function addUploadingAttachment(previewUrl = '', name = 'uploading') {
    attachmentIdSeq += 1;
    const id = 'att-' + attachmentIdSeq;
    pendingAttachments.push({
      id,
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
      .map((attachment) => '[Screenshot: ' + attachment.path + ']')
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
  };
}

function basenameFromPath(path) {
  if (!path) return '';
  const normalized = String(path).replace(/\\/g, '/');
  const parts = normalized.split('/');
  return parts[parts.length - 1] || normalized;
}
