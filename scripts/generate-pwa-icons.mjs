#!/usr/bin/env node
/**
 * Generates the PWA icons (PNG) from public/icon.svg.
 * Requires sharp (already in dependencies).
 *
 * Output:
 *   public/icons/icon-192.png        (purpose: any)
 *   public/icons/icon-512.png        (purpose: any)
 *   public/icons/maskable-192.png    (purpose: maskable, safe zone ~20%)
 *   public/icons/maskable-512.png    (purpose: maskable)
 *   public/icons/monochrome-512.png  (purpose: monochrome, Android 13+)
 *   public/icons/apple-touch-180.png (iOS fallback)
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, mkdirSync, existsSync } from 'fs';
import { loadSharp } from '../lib/load-sharp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(__dirname, '..', 'public');
const ICONS = path.join(PUBLIC, 'icons');
const SRC_SVG = path.join(PUBLIC, 'icon.svg');

const ICON_SVG = existsSync(SRC_SVG) ? readFileSync(SRC_SVG) : null;

// Maskable: full background plus the glyph scaled to ~64% (safe zone).
const MASKABLE_SVG = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
    <rect width="512" height="512" fill="#0d1117"/>
    <g transform="translate(96 96) scale(0.625)" fill="none" stroke="#3b82f6" stroke-width="40" stroke-linecap="round" stroke-linejoin="round">
      <path d="M120 176 L192 256 L120 336"/>
      <path d="M232 360 L392 360"/>
    </g>
  </svg>`
);

// Monochrome: white glyph on a transparent background (Android adaptive icons).
const MONOCHROME_SVG = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
    <g fill="none" stroke="#ffffff" stroke-width="28" stroke-linecap="round" stroke-linejoin="round">
      <path d="M120 176 L192 256 L120 336"/>
      <path d="M232 360 L392 360"/>
    </g>
  </svg>`
);

const TARGETS = [
  { src: 'icon', buffer: ICON_SVG, size: 192, name: 'icon-192.png' },
  { src: 'icon', buffer: ICON_SVG, size: 512, name: 'icon-512.png' },
  { src: 'maskable', buffer: MASKABLE_SVG, size: 192, name: 'maskable-192.png' },
  { src: 'maskable', buffer: MASKABLE_SVG, size: 512, name: 'maskable-512.png' },
  { src: 'monochrome', buffer: MONOCHROME_SVG, size: 512, name: 'monochrome-512.png' },
  { src: 'icon', buffer: ICON_SVG, size: 180, name: 'apple-touch-180.png' },
];

async function main() {
  mkdirSync(ICONS, { recursive: true });
  const sharp = await loadSharp();
  if (!sharp) {
    console.warn('[pwa-icons] Skipping icon generation (sharp unavailable). The SPA build can continue.');
    return;
  }
  if (!ICON_SVG) {
    console.error('[pwa-icons] public/icon.svg is missing — skipping the "any" purpose icons.');
  }
  let ok = 0;
  let failed = 0;
  for (const target of TARGETS) {
    if (!target.buffer) {
      console.warn(`[pwa-icons] skip ${target.name} (no source)`);
      continue;
    }
    const outPath = path.join(ICONS, target.name);
    try {
      await sharp(target.buffer)
        .resize(target.size, target.size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toFile(outPath);
      console.log(`[pwa-icons] ${target.name} -> ${path.relative(process.cwd(), outPath)}`);
      ok++;
    } catch (err) {
      console.error(`[pwa-icons] FAIL ${target.name}:`, err?.message || err);
      failed++;
    }
  }
  if (failed) process.exitCode = 1;
  console.log(`[pwa-icons] done: ${ok} ok, ${failed} failed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
