import { BackendStatus } from './lifecycle.js';

/** Build the tray context-menu template (pure, so tests need no Electron). */
export function buildTrayMenu({ onShow, onQuit, status }, labels = {}) {
  const l = {
    show: 'Show window',
    quit: 'Quit',
    up: 'Backend: running',
    down: 'Backend: not responding',
    restarting: 'Backend: restarting…',
    ...labels
  };
  return [
    { label: l.show, click: onShow },
    { label: l[status] ?? l.up, enabled: false },
    { type: 'separator' },
    { label: l.quit, click: onQuit }
  ];
}

/**
 * Create the tray through injected Electron constructors:
 * electron = { Tray, Menu, icon }.
 */
export function createTrayController({ Tray, Menu, icon, tooltip = 'Cretli' }) {
  return ({ onShow, onQuit, status }) => {
    const tray = new Tray(icon);
    let current = status;
    const render = () => {
      tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenu({ onShow, onQuit, status: current })));
      tray.setToolTip(current === BackendStatus.UP ? tooltip : `${tooltip} — ${current}`);
    };
    tray.on('click', onShow);
    render();
    return {
      setStatus(next) {
        current = next;
        render();
      },
      destroy: () => tray.destroy()
    };
  };
}
