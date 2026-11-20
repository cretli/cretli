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

function runBootstrap(script, { savedPreference = null, systemLight = false, storageError = false, cache = null, systemDark = null, systemLightTheme = null } = {}) {
  const root = { dataset: {}, style: {} };
  const meta = { content: '#1e1e1e' };
  const listeners = new Map();
  const styles = new Map();
  const document = {
    head: { appendChild: (style) => styles.set(style.id, style) },
    createElement: () => ({}),
    body: null,
    documentElement: root,
    querySelector: () => meta,
    addEventListener: (name, listener) => listeners.set(name, listener),
  };
  const context = {
    document,
    localStorage: {
      getItem(key) {
        if (storageError) throw new Error('storage unavailable');
        if (key === 'cretli-theme-cache') return JSON.stringify(cache);
        if (key === 'cretli-theme-dark') return systemDark;
        if (key === 'cretli-theme-light') return systemLightTheme;
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
  return { document, listeners, meta, root, styles };
}

test('theme runtime keeps preference separate from the resolved theme', async () => {
  const values = new Map();
  const events = [];
  const windowListeners = new Map();
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
    head: { appendChild(style) { this.style = style; } },
    createElement: () => ({}),
    body: { classList: bodyClassList },
    documentElement: { dataset: {}, style: {} },
    getElementById: (id) => id === 'cr-theme-vars' ? document.head.style : null,
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
    addEventListener: (name, listener) => windowListeners.set(name, listener),
    matchMedia(query) {
      assert.equal(query, LIGHT_QUERY);
      return mediaQuery;
    },
  };

  const theme = await import('../app_front/core/theme/theme.js');

  for (const [legacy, expected] of [['dark', 'cretli-dark'], ['light', 'cretli-light'], ['unknown', 'cretli-dark']]) {
    values.set(THEME_KEY, legacy);
    assert.equal(theme.getTheme(), expected);
    assert.equal(values.get(THEME_KEY), expected);
  }
  values.delete(THEME_KEY);
  assert.equal(theme.getTheme(), 'cretli-dark');
  assert.equal(theme.getResolvedTheme('dark'), 'dark');
  assert.equal(theme.getResolvedTheme('light'), 'light');
  assert.equal(theme.getResolvedTheme('system'), 'light');

  theme.setTheme('light');
  assert.equal(values.get(THEME_KEY), 'cretli-light');
  assert.equal(document.documentElement.dataset.theme, 'light');
  assert.equal(document.documentElement.style.colorScheme, 'light');
  assert.equal(bodyClassList.contains('theme-light'), true);
  assert.equal(themeColor.content, '#f3f3f3');
  assert.deepEqual(events.at(-1).detail, { preference: 'cretli-light', theme: 'light', themeId: 'cretli-light' });

  const eventCount = events.length;
  theme.setTheme('invalid');
  assert.equal(events.length, eventCount + 1);
  assert.equal(theme.getTheme(), 'cretli-dark');
  assert.deepEqual(events.at(-1).detail, { preference: 'cretli-dark', theme: 'dark', themeId: 'cretli-dark' });

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
  assert.deepEqual(events.at(-1).detail, { preference: 'system', theme: 'dark', themeId: 'cretli-dark' });

  theme.setTheme('light');
  const beforeIgnoredSystemChange = events.length;
  mediaQuery.listener();
  assert.equal(events.length, beforeIgnoredSystemChange);

  const { registerTheme, themeCss, isColor } = await import('../app_front/core/theme/themes/index.js');
  const custom = registerTheme({ id: 'test-dark', appearance: 'dark', tokens: { '--cr-bg': '#123456', '--cr-text': 'rgb(1, 2, 3)', '--cr-bad': 'url(evil)', color: '#fff' }, themeColor: '#123456' });
  registerTheme({ id: 'test-light', appearance: 'light', tokens: { '--cr-bg': '#abcdef' }, themeColor: '#abcdef' });
  assert.equal(isColor('rgb(1)'), false);
  assert.equal(isColor('hsl(1 2 3)'), false);
  assert.equal(themeCss(custom), ':root:root:root{--cr-bg:#123456;--cr-text:rgb(1, 2, 3)}');
  values.set('cretli-theme-dark', 'test-dark');
  values.set('cretli-theme-light', 'test-light');
  mediaQuery.matches = false;
  theme.setTheme('system');
  assert.equal(document.documentElement.dataset.themeId, 'test-dark');
  assert.equal(document.head.style.textContent, themeCss(custom));
  assert.equal(events.at(-1).type, 'cr-theme-change');
  const script = extractBootstrap(await readFile(new URL('public/index.html', ROOT), 'utf8'));
  const boot = runBootstrap(script, { savedPreference: 'system', systemDark: 'test-dark', cache: JSON.parse(values.get('cretli-theme-cache')) });
  assert.deepEqual(boot.root.dataset, document.documentElement.dataset);
  assert.equal(boot.styles.get('cr-theme-vars').textContent, document.head.style.textContent);
  assert.equal(boot.meta.content, themeColor.content);
  theme.setTheme('test-dark');
  const explicitBoot = runBootstrap(script, { savedPreference: 'test-dark', cache: JSON.parse(values.get('cretli-theme-cache')) });
  assert.deepEqual(explicitBoot.root.dataset, document.documentElement.dataset);
  assert.equal(explicitBoot.styles.get('cr-theme-vars').textContent, document.head.style.textContent);
  theme.setTheme('system');
  mediaQuery.matches = true;
  theme.applyTheme();
  assert.equal(document.documentElement.dataset.themeId, 'test-light');
  const lightBoot = runBootstrap(script, { savedPreference: 'system', systemLight: true, systemLightTheme: 'test-light', cache: JSON.parse(values.get('cretli-theme-cache')) });
  assert.equal(lightBoot.styles.get('cr-theme-vars').textContent, document.head.style.textContent);
  assert.deepEqual(lightBoot.root.dataset, document.documentElement.dataset);
  // The same single-appearance ID in both slots must fall back in the other OS mode.
  for (const id of ['test-dark', 'test-light', 'cretli-dark', 'cretli-light']) {
    values.set('cretli-theme-dark', id);
    values.set('cretli-theme-light', id);
    for (const systemLight of [false, true]) {
      mediaQuery.matches = systemLight;
      theme.setTheme('system');
      const appearance = systemLight ? 'light' : 'dark';
      const expected = id.endsWith(appearance) ? id : `cretli-${appearance}`;
      assert.equal(theme.getResolvedThemeId(), expected);
      for (const path of ['public/index.html', 'public/login.html', 'public/offline.html']) {
        const bootstrap = extractBootstrap(await readFile(new URL(path, ROOT), 'utf8'));
        const boot = runBootstrap(bootstrap, {
          savedPreference: 'system', systemLight, systemDark: id, systemLightTheme: id,
          cache: JSON.parse(values.get('cretli-theme-cache')),
        });
        assert.deepEqual(boot.root.dataset, document.documentElement.dataset, `${path}: ${id}, OS ${appearance}`);
        assert.equal(boot.root.style.colorScheme, document.documentElement.style.colorScheme);
        assert.equal(boot.styles.get('cr-theme-vars').textContent, document.head.style.textContent);
        assert.equal(boot.meta.content, themeColor.content);
        boot.document.body = { classList: createClassList() };
        boot.listeners.get('DOMContentLoaded')();
        assert.equal(boot.document.body.classList.contains('theme-light'), bodyClassList.contains('theme-light'));
      }
    }
  }
  values.set(THEME_KEY, 'light');
  windowListeners.get('storage')({ key: THEME_KEY });
  assert.equal(document.documentElement.dataset.themeId, 'cretli-light');
  assert.equal(theme.normalizeTheme('unknown', 'light'), 'cretli-light');
  assert.equal(document.head.style.textContent, '');
  values.delete('cretli-theme-dark');
  values.delete('cretli-theme-light');

  globalThis.localStorage = {
    getItem: () => 'light',
    setItem: () => {
      throw new Error('storage unavailable');
    },
  };
  mediaQuery.matches = true;
  theme.setTheme('system');
  assert.equal(theme.getTheme(), 'system');
  assert.deepEqual(events.at(-1).detail, { preference: 'system', theme: 'light', themeId: 'cretli-light' });

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

    const unsafeCache = runBootstrap(bootstraps[index], { savedPreference: 'test-dark', cache: { dark: { themeId: 'test-dark', css: ':root:root:root{--cr-bg:url(evil)}', themeColor: 'url(evil)' } } });
    assert.equal(unsafeCache.styles.get('cr-theme-vars').textContent, '');
    assert.equal(unsafeCache.meta.content, '#1e1e1e');

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
