import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const htmlPath = join(root, 'website', 'index.html');
const html = await readFile(htmlPath, 'utf8');
const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

function localPath(value) {
  return value.startsWith('/') ? join(root, 'website', value.slice(1)) : join(root, 'website', value);
}

function contrastRatio(foreground, background) {
  const channel = (hex, offset) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (hex) => 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test('website home reflects package version and required calls to action', () => {
  assert.match(html, new RegExp('Version ' + packageJson.version));
  assert.match(html, /<h1\b[^>]*>/);
  assert.match(html, /href="\/docs\/"/);
  assert.match(html, /href="\/docs\/getting-started\.html"/);
  assert.match(html, /href="https:\/\/github\.com\/cretli\/cretli"/);
  assert.match(html, /<h2[^>]*>Features<\/h2>/);
  assert.match(html, /<h2[^>]*>New in 0\.5\.0<\/h2>/);
});

test('local resources exist and no external runtime resources are loaded', () => {
  for (const match of html.matchAll(/<img\b[^>]*\bsrc="([^"]+)"|<link\b(?=[^>]*\brel="icon")[^>]*\bhref="([^"]+)"/gi)) {
    const resource = match[1] || match[2];
    if (/^https?:\/\//i.test(resource)) assert.fail('external resource loaded: ' + resource);
    assert.ok(existsSync(localPath(resource)), 'missing local resource: ' + resource);
  }
  assert.doesNotMatch(html, /<script\b[^>]+src=/i);
  assert.doesNotMatch(html, /<link\b[^>]*rel=["'][^"']*stylesheet/i);
});

test('JSON-LD is valid SoftwareApplication metadata', () => {
  const match = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/i);
  assert.ok(match, 'JSON-LD script is required');
  const data = JSON.parse(match[1]);
  assert.equal(data['@type'], 'SoftwareApplication');
  assert.equal(data.softwareVersion, packageJson.version);
});

test('screenshots match the image manifest and use device-scale dimensions', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'website/docs/img/manifest.json'), 'utf8'));
  const images = [...html.matchAll(/<img\b([^>]+)>/gi)];
  assert.ok(images.length >= 4 && images.length <= 6);
  for (const [, attributes] of images) {
    const src = attributes.match(/\bsrc="([^"]+)"/i)?.[1];
    const width = Number(attributes.match(/\bwidth="(\d+)"/i)?.[1]);
    const height = Number(attributes.match(/\bheight="(\d+)"/i)?.[1]);
    const entry = manifest.find((item) => 'docs/img/' + item.name + '.png' === src);
    assert.ok(entry, 'image is not in manifest: ' + src);
    assert.equal(width, entry.width / entry.deviceScaleFactor);
    assert.equal(height, entry.height / entry.deviceScaleFactor);
    assert.ok(attributes.match(/\balt="[^"]+\S[^"]*"/i));
  }
});

test('website favicon is an exact public icon copy', () => {
  assert.deepEqual(readFileSync(join(root, 'website/icon.svg')), readFileSync(join(root, 'public/icon.svg')));
});

test('every relative href and src points to an existing website file', () => {
  const refs = [...html.matchAll(/\b(?:href|src)="([^"]+)"/gi)].map((m) => m[1]);
  for (const ref of refs) {
    if (/^(https?:|mailto:|#)/i.test(ref)) continue;
    let path = ref.split('#')[0].split('?')[0];
    if (path === '' ) continue;
    let file = localPath(path);
    if (path.endsWith('/')) file = join(file, 'index.html');
    else if (path === './') file = join(root, 'website', 'index.html');
    assert.ok(existsSync(file), 'broken local reference: ' + ref);
  }
  assert.ok(html.includes('href="/docs/security-basics.html"'));
});

test('screenshot PNG files exist and are listed in the manifest', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'website/docs/img/manifest.json'), 'utf8'));
  for (const [, src] of html.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/gi)) {
    assert.ok(existsSync(localPath(src)), 'missing PNG: ' + src);
    assert.ok(manifest.some((item) => 'docs/img/' + item.name + '.png' === src), 'not in manifest: ' + src);
  }
});

test('head metadata, single h1 and responsive images', () => {
  assert.match(html, /<link rel="canonical" href="https:\/\/[^"]+">/);
  assert.match(html, /<meta property="og:image" content="https:\/\/[^"]+\.png">/);
  assert.match(html, /<meta property="og:title" content="[^"]+">/);
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.equal([...html.matchAll(/<h1\b/gi)].length, 1);
  assert.match(html, /figure img\s*\{[^}]*max-width:\s*100%|figure img\s*\{[^}]*width:\s*100%/);
  assert.match(html, /@media \(max-width:/);
});

test('quick start builds the front before npm start and the security note links docs', () => {
  const ci = html.indexOf('npm ci');
  const build = html.indexOf('npm run build:front:prod');
  const start = html.indexOf('npm start');
  assert.ok(ci >= 0 && ci < build && build < start);
  assert.match(html, /<aside[^>]*warning[\s\S]*href="\/docs\/security-basics\.html"[\s\S]*<\/aside>/);
});

function parseVars(block) {
  return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{3,6})\b/g)].map((m) => {
    let hex = m[2];
    if (hex.length === 4) hex = '#' + [...hex.slice(1)].map((c) => c + c).join('');
    return [m[1], hex];
  }));
}

test('text, muted and accent colours from CSS tokens meet AA in both themes', () => {
  const dark = parseVars(html.match(/:root\s*\{([^}]*)\}/)[1]);
  const light = { ...dark, ...parseVars(html.match(/prefers-color-scheme:\s*light\)\s*\{\s*:root\s*\{([^}]*)\}/)[1]) };
  assert.match(html, /\.button\.primary\s*\{[^}]*color:\s*var\(--on-accent\)/);
  assert.match(html, /pre\s*\{[^}]*color:\s*var\(--code-text\)[^}]*background:\s*var\(--code-bg\)/);
  for (const [name, t] of [['dark', dark], ['light', light]]) {
    for (const fg of ['text', 'muted', 'accent-strong']) {
      for (const bg of ['bg', 'surface']) {
        assert.ok(contrastRatio(t[fg], t[bg]) >= 4.5, `${name} ${fg} on ${bg}`);
      }
    }
    assert.ok(contrastRatio(t.accent, t.bg) >= 4.5, name + ' accent on bg');
    assert.ok(contrastRatio(t.warning, t.surface) >= 4.5, name + ' warning on surface');
    assert.ok(contrastRatio(t['on-accent'], t.accent) >= 4.5, name + ' primary button text on accent');
    assert.ok(contrastRatio(t['code-text'], t['code-bg']) >= 4.5, name + ' code text on code background');
  }
});
