#!/usr/bin/env node
/**
 * Generates placeholder PWA screenshots (public/screenshots/*).
 * Desktop 1280x720 (wide) + mobile 390x844 (narrow).
 * Replace them with real app screenshots for a richer install prompt.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';
import { loadSharp } from '../lib/load-sharp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(__dirname, '..', 'public');
const OUT = path.join(PUBLIC, 'screenshots');
mkdirSync(OUT, { recursive: true });

const DESKTOP = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" width="1280" height="720">
    <rect width="1280" height="720" fill="#0d1117"/>
    <rect x="0" y="0" width="1280" height="48" fill="#161b22"/>
    <text x="24" y="30" font-family="system-ui,sans-serif" font-size="16" fill="#c9d1d9">Cretli</text>
    <g fill="none" stroke="#3b82f6" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">
      <path d="M180 220 L240 290 L180 360"/>
      <path d="M280 380 L420 380"/>
    </g>
    <rect x="480" y="120" width="760" height="520" rx="12" fill="#161b22" stroke="#1c2330"/>
    <rect x="500" y="140" width="720" height="40" rx="6" fill="#0d1117"/>
    <rect x="500" y="200" width="720" height="420" rx="6" fill="#0d1117"/>
    <text x="520" y="230" font-family="monospace" font-size="18" fill="#58a6ff">$ cursor agent --chat</text>
    <text x="520" y="270" font-family="monospace" font-size="18" fill="#7ee787">Agent: ready</text>
    <text x="520" y="310" font-family="monospace" font-size="18" fill="#c9d1d9">> Fix the failing tests</text>
    <text x="520" y="350" font-family="monospace" font-size="18" fill="#d2a8ff">Reading tests/foo.test.js…</text>
  </svg>`
);

const MOBILE = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 390 844" width="390" height="844">
    <rect width="390" height="844" fill="#0d1117"/>
    <rect x="0" y="0" width="390" height="44" fill="#161b22"/>
    <text x="16" y="28" font-family="system-ui,sans-serif" font-size="14" fill="#c9d1d9">Cretli</text>
    <rect x="16" y="60" width="358" height="40" rx="8" fill="#161b22"/>
    <text x="32" y="86" font-family="system-ui,sans-serif" font-size="14" fill="#c9d1d9">Chat • Terminal • Tasks</text>
    <rect x="16" y="116" width="358" height="700" rx="12" fill="#161b22" stroke="#1c2330"/>
    <text x="36" y="160" font-family="monospace" font-size="14" fill="#58a6ff">$ cursor agent</text>
    <text x="36" y="200" font-family="monospace" font-size="14" fill="#7ee787">Agent: ready</text>
    <text x="36" y="240" font-family="monospace" font-size="14" fill="#c9d1d9">> Run tests</text>
    <text x="36" y="280" font-family="monospace" font-size="14" fill="#d2a8ff">Running npm test…</text>
    <text x="36" y="320" font-family="monospace" font-size="14" fill="#7ee787">PASS</text>
    <rect x="36" y="760" width="318" height="36" rx="18" fill="#0d1117" stroke="#1c2330"/>
    <text x="56" y="784" font-family="system-ui,sans-serif" font-size="14" fill="#8b949e">Send a message…</text>
  </svg>`
);

const TARGETS = [
  { svg: DESKTOP, w: 1280, h: 720, name: 'desktop.png' },
  { svg: MOBILE, w: 390, h: 844, name: 'mobile.png' },
];

const sharp = await loadSharp();
if (!sharp) {
  console.warn('[pwa-screenshots] Skipping screenshot generation (sharp unavailable). The SPA build can continue.');
  process.exit(0);
}

let ok = 0;
for (const t of TARGETS) {
  const outPath = path.join(OUT, t.name);
  await sharp(t.svg).resize(t.w, t.h).png().toFile(outPath);
  console.log(`[pwa-screenshots] ${t.name} -> ${path.relative(process.cwd(), outPath)}`);
  ok++;
}
console.log(`[pwa-screenshots] done: ${ok} ok`);
