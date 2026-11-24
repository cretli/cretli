// Sandboxed preloads must be CommonJS: Electron does not support ESM here.
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('cretliDesktop', Object.freeze({
  platform: process.platform
}));
