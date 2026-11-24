import { app, BrowserWindow, ipcMain, Menu, nativeImage, powerMonitor, shell, Tray } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildWindowOptions,
  createNavigationGuard,
  guardIpcHandler,
  isAllowedNavigation,
  parseServerUrl
} from './lib/security.js';
import { createExternalBackend } from './lib/backend.js';
import { createLifecycle } from './lib/lifecycle.js';
import { createTrayController } from './lib/tray.js';

const here = path.dirname(fileURLToPath(import.meta.url));

let trustedOrigin = null;

/**
 * Register an IPC handler that rejects callers outside the configured origin.
 * All future IPC must go through this helper, never ipcMain.handle directly.
 */
export function guardedHandle(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!trustedOrigin) throw new Error('IPC sender is not trusted');
    return guardIpcHandler(handler, trustedOrigin)(event, ...args);
  });
}

export function createMainWindow(serverUrl = parseServerUrl(process.env.CRETLI_URL)) {
  const origin = serverUrl.origin;
  trustedOrigin = origin;
  const window = new BrowserWindow(buildWindowOptions(path.join(here, 'preload.cjs')));
  const contents = window.webContents;

  // Block top-level navigation, server redirects and subframe navigation
  // that would leave the configured origin.
  const blockForeign = createNavigationGuard(origin);
  contents.on('will-navigate', blockForeign);
  contents.on('will-redirect', blockForeign);
  contents.on('will-frame-navigate', blockForeign);

  contents.setWindowOpenHandler(({ url }) => {
    if (!isAllowedNavigation(url, origin)) {
      try {
        const parsed = new URL(url);
        if (['http:', 'https:'].includes(parsed.protocol)) void shell.openExternal(url);
      } catch {}
    }
    return { action: 'deny' };
  });
  window.loadURL(serverUrl.href);
  return window;
}

/** 16x16 solid tray icon built in memory (BGRA), so no binary asset is needed. */
function buildTrayIcon() {
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let i = 0; i < buf.length; i += 4) buf.writeUInt32LE(0xffd9822b >>> 0, i);
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

if (process.versions.electron) {
  const serverUrl = parseServerUrl(process.env.CRETLI_URL);
  // External backend today; task 1.4 swaps in createManagedBackend here. Quit
  // only ever stops what the adapter owns, so an external server keeps running.
  const backend = createExternalBackend({ url: serverUrl.href });
  const lifecycle = createLifecycle({
    app,
    powerMonitor,
    backend,
    createWindow: () => createMainWindow(serverUrl),
    createTray: createTrayController({ Tray, Menu, icon: buildTrayIcon() }),
    log: (msg) => console.log(`[desktop] ${msg}`)
  });
  app.whenReady().then(() => lifecycle.start());
}
