import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const ROOT = new URL('../', import.meta.url);
const THEME_KEY = 'cretli-theme';
const LIGHT_QUERY = '(prefers-color-scheme: light)';

function createClassList() {
  const classes = new Set();
  return {
    contains: (name) => classes.has(name),
    toggle(name, enabled) {
      if (enabled) classes.add(name);
      else classes.delete(name);
    },
  };
}

function extractBootstrap(html) {
  const match = html.match(/<script>\s*([\s\S]*?)\s*<\/script>/);
  assert.ok(match, 'theme bootstrap script is present');
  return match[1];
}

function normalizeBootstrap(script) {
  return script
    .split('\n')
    .map((line) => line.trim())
    .join('\n');
}

function runBootstrap(script, { savedPreference = null, systemLight = false, storageError = false } = {}) {
  const root = { dataset: {}, style: {} };
  const meta = { content: '#1e1e1e' };
  const listeners = new Map();
  const document = {
    body: null,
    documentElement: root,
    querySelector: () => meta,
    addEventListener: (name, listener) => listeners.set(name, listener),
  };
  const context = {
    document,
    localStorage: {
      getItem() {
        if (storageError) throw new Error('storage unavailable');
        return savedPreference;
      },
    },
    window: {
      matchMedia(query) {
        assert.equal(query, LIGHT_QUERY);
        return { matches: systemLight };
      },
    },
  };

  vm.runInNewContext(script, context);
  return { document, listeners, meta, root };
}

test('theme runtime keeps preference separate from the resolved theme', async () => {
  const values = new Map();
  const events = [];
  const mediaQuery = {
    matches: true,
    listener: null,
    listenerCount: 0,
    addEventListener(name, listener) {
      assert.equal(name, 'change');
      this.listener = listener;
      this.listenerCount += 1;
    },
  };
  const bodyClassList = createClassList();
  const themeColor = {
    content: null,
    setAttribute(name, value) {
      assert.equal(name, 'content');
      this.content = value;
    },
  };

  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  globalThis.document = {
    body: { classList: bodyClassList },
    documentElement: { dataset: {}, style: {} },
    getElementById: () => null,
    querySelector: () => themeColor,
  };
  globalThis.window = {
    CustomEvent: class {
      constructor(type, options) {
        this.type = type;
        this.detail = options.detail;
      }
    },
    dispatchEvent: (event) => events.push(event),
    matchMedia(query) {
      assert.equal(query, LIGHT_QUERY);
      return mediaQuery;
    },
  };

  const theme = await import('../app_front/theme.js');

  assert.equal(theme.getTheme(), 'dark');
  assert.equal(theme.getResolvedTheme('dark'), 'dark');
  assert.equal(theme.getResolvedTheme('light'), 'light');
  assert.equal(theme.getResolvedTheme('system'), 'light');

  theme.setTheme('light');
  assert.equal(values.get(THEME_KEY), 'light');
  assert.equal(document.documentElement.dataset.theme, 'light');
  assert.equal(document.documentElement.style.colorScheme, 'light');
  assert.equal(bodyClassList.contains('theme-light'), true);
  assert.equal(themeColor.content, '#f3f3f3');
  assert.deepEqual(events.at(-1).detail, { preference: 'light', theme: 'light' });

  const eventCount = events.length;
  theme.setTheme('invalid');
  assert.equal(events.length, eventCount + 1);
  assert.equal(theme.getTheme(), 'dark');
  assert.deepEqual(events.at(-1).detail, { preference: 'dark', theme: 'dark' });

  theme.setTheme('system');
  theme.initTheme();
  theme.initTheme();
  assert.equal(mediaQuery.listenerCount, 1);

  mediaQuery.matches = false;
  const beforeSystemChange = events.length;
  mediaQuery.listener();
  assert.equal(events.length, beforeSystemChange + 1);
  assert.equal(document.documentElement.dataset.theme, 'dark');
  assert.equal(bodyClassList.contains('theme-light'), false);
  assert.equal(themeColor.content, '#1e1e1e');
  assert.deepEqual(events.at(-1).detail, { preference: 'system', theme: 'dark' });

  theme.setTheme('light');
  const beforeIgnoredSystemChange = events.length;
  mediaQuery.listener();
  assert.equal(events.length, beforeIgnoredSystemChange);

  globalThis.localStorage = {
    getItem: () => 'light',
    setItem: () => {
      throw new Error('storage unavailable');
    },
  };
  mediaQuery.matches = true;
  theme.setTheme('system');
  assert.equal(theme.getTheme(), 'system');
  assert.deepEqual(events.at(-1).detail, { preference: 'system', theme: 'light' });

  delete globalThis.localStorage;
  delete globalThis.document;
  delete globalThis.window;
});

test('all pages use the same early, body-safe theme bootstrap', async () => {
  const paths = ['public/index.html', 'public/login.html', 'public/offline.html'];
  const pages = await Promise.all(paths.map((path) => readFile(new URL(path, ROOT), 'utf8')));
  const bootstraps = pages.map(extractBootstrap);

  assert.equal(normalizeBootstrap(bootstraps[0]), normalizeBootstrap(bootstraps[1]));
  assert.equal(normalizeBootstrap(bootstraps[0]), normalizeBootstrap(bootstraps[2]));

  for (const [index, html] of pages.entries()) {
    assert.ok(html.indexOf('<script>') < html.search(/<link rel="stylesheet"|<style>/));

    const light = runBootstrap(bootstraps[index], { savedPreference: 'system', systemLight: true });
    assert.equal(light.root.dataset.theme, 'light');
    assert.equal(light.root.style.colorScheme, 'light');
    assert.equal(light.meta.content, '#f3f3f3');
    assert.equal(light.document.body, null);

    const classList = createClassList();
    light.document.body = { classList };
    light.listeners.get('DOMContentLoaded')();
    assert.equal(classList.contains('theme-light'), true);

    const safeFallback = runBootstrap(bootstraps[index], { storageError: true });
    assert.equal(safeFallback.root.dataset.theme, 'dark');
    assert.equal(safeFallback.meta.content, '#1e1e1e');
  }
});

test('manifest and offline shell use the application theme colors', async () => {
  const manifest = JSON.parse(await readFile(new URL('public/manifest.webmanifest', ROOT), 'utf8'));
  const offline = await readFile(new URL('public/offline.html', ROOT), 'utf8');

  assert.equal(manifest.background_color, '#1e1e1e');
  assert.equal(manifest.theme_color, '#1e1e1e');
  assert.match(offline, /meta name="theme-color" content="#1e1e1e"/);
  assert.match(offline, /html\[data-theme="light"\] body, body\.theme-light/);
});
