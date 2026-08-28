import { initDropdown } from '../../lib/dropdown.js';

const LONG_PRESS_MS = 520;
const MOVE_CANCEL_PX = 14;

export function createSendBarSendMenu(options) {
  const {
    sendBtn,
    actions = [],
    onShortPress,
    onSelect,
  } = options;
  if (!(sendBtn instanceof HTMLButtonElement) || actions.length === 0) return null;

  const menu = document.createElement('div');
  menu.className = 'chat-list-modal send-keys-send-menu';
  menu.hidden = true;
  const panel = document.createElement('div');
  panel.className = 'chat-list-panel send-keys-send-menu-panel';
  const items = document.createElement('div');
  items.className = 'chat-list-items send-keys-send-menu-items';
  items.setAttribute('role', 'menu');

  actions.forEach((action) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'chat-list-item send-keys-send-menu-item';
    item.setAttribute('role', 'menuitem');
    item.dataset.action = action.id;
    const icon = document.createElement('span');
    icon.className = `mdi ${action.icon || 'mdi-message-outline'}`;
    icon.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'chat-list-item-title';
    label.textContent = action.label;
    item.append(icon, label);
    items.appendChild(item);
  });

  panel.appendChild(items);
  menu.appendChild(panel);
  document.body.appendChild(menu);
  sendBtn.setAttribute('aria-haspopup', 'menu');

  const menuApi = initDropdown({
    triggerEl: sendBtn,
    floatingEl: menu,
    compact: true,
    placement: 'top-end',
    matchTriggerWidth: false,
    offsetPx: 6,
    viewportPadding: 8,
    minWidthPx: 230,
    maxHeightPx: 180,
  });

  let timer = 0;
  let startX = 0;
  let startY = 0;
  let suppressClick = false;
  let suppressClickTimer = 0;

  const cancelPress = () => {
    if (timer) window.clearTimeout(timer);
    timer = 0;
  };

  const onPointerDown = (event) => {
    if (sendBtn.disabled || event.button !== 0) return;
    cancelPress();
    startX = event.clientX;
    startY = event.clientY;
    timer = window.setTimeout(() => {
      timer = 0;
      suppressClick = true;
      window.clearTimeout(suppressClickTimer);
      suppressClickTimer = window.setTimeout(() => {
        suppressClick = false;
      }, 1000);
      menuApi.open();
      navigator.vibrate?.(15);
    }, LONG_PRESS_MS);
  };
  const onPointerMove = (event) => {
    if (!timer) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (Math.hypot(dx, dy) > MOVE_CANCEL_PX) cancelPress();
  };
  const onContextMenu = (event) => {
    event.preventDefault();
  };
  const onClick = (event) => {
    if (suppressClick) {
      event.preventDefault();
      event.stopImmediatePropagation();
      suppressClick = false;
      window.clearTimeout(suppressClickTimer);
      return;
    }
    if (menuApi.isOpen()) {
      event.preventDefault();
      menuApi.close();
      return;
    }
    onShortPress();
  };

  sendBtn.addEventListener('pointerdown', onPointerDown);
  sendBtn.addEventListener('pointermove', onPointerMove);
  sendBtn.addEventListener('pointerup', cancelPress);
  sendBtn.addEventListener('pointercancel', cancelPress);
  sendBtn.addEventListener('lostpointercapture', cancelPress);
  sendBtn.addEventListener('contextmenu', onContextMenu);
  sendBtn.addEventListener('click', onClick);

  menu.querySelectorAll('.send-keys-send-menu-item').forEach((item) => {
    item.addEventListener('click', async () => {
      const actionId = item.dataset.action || '';
      menuApi.close();
      await onSelect(actionId);
    });
  });

  return {
    close: () => menuApi.close(),
    destroy() {
      cancelPress();
      window.clearTimeout(suppressClickTimer);
      sendBtn.removeEventListener('pointerdown', onPointerDown);
      sendBtn.removeEventListener('pointermove', onPointerMove);
      sendBtn.removeEventListener('pointerup', cancelPress);
      sendBtn.removeEventListener('pointercancel', cancelPress);
      sendBtn.removeEventListener('lostpointercapture', cancelPress);
      sendBtn.removeEventListener('contextmenu', onContextMenu);
      sendBtn.removeEventListener('click', onClick);
      menuApi.destroy();
      menu.remove();
    },
  };
}
