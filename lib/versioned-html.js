/**
 * Serve login/SPA HTML with a cache-busting asset version token.
 */

import { readFileSync } from 'fs';

export const FRONT_ASSET_VERSION_TOKEN = '__CR_ASSET_VERSION__';

/**
 * @param {{ getAssetVersion: () => string }} options
 */
export function createVersionedHtmlSender(options) {
  function readVersionedHtmlTemplate(filePath) {
    const html = readFileSync(filePath, 'utf8');
    return html.replaceAll(FRONT_ASSET_VERSION_TOKEN, options.getAssetVersion());
  }

  /**
   * @param {import('express').Response} res
   * @param {string} filePath
   */
  function sendVersionedHtml(res, filePath) {
    try {
      const html = readVersionedHtmlTemplate(filePath);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      return res.send(html);
    } catch (err) {
      console.warn('[html] versioned send failed:', err?.message || err);
      return res.sendFile(filePath);
    }
  }

  return { sendVersionedHtml };
}
