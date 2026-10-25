/**
 * Real-browser evidence for the Watcher settings panel (Lit regions + signals):
 *  - markup from the legacy string renderers cannot execute (XSS matrix, incl.
 *    `srcset`, `xlink:href`, `formaction`, SVG animation, `srcdoc`);
 *  - the panel mounts once and re-renders never stack nodes or duplicate ids;
 *  - the live regions re-render from the signal store while the policy form and
 *    a dirty Scout draft keep their DOM nodes (and focus);
 *  - render timings go through `window.__cretliPerf` and long tasks are summed.
 *
 * Runs in headless Chromium (`CHAT_E2E_CHROMIUM_EXECUTABLE_PATH` or
 * /usr/bin/chromium); the test is skipped when no browser is available.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';
import { budgetMs } from './helpers/time-budget.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chromiumPath = process.env.CHAT_E2E_CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium';
const skip = fs.existsSync(chromiumPath) ? false : `no Chromium at ${chromiumPath}`;

/** @type {import('playwright-core').Browser | null} */
let browser = null;
/** @type {import('playwright-core').Page | null} */
let page = null;
let tmpDir = '';

const front = (rel) => path.join(root, 'app_front', rel).split(path.sep).join('/');

/** Markup an attacker could smuggle through a renderer that forgot to escape. */
const XSS_PAYLOADS = [
  '<img src="x" onerror="window.__xss=\'onerror\'">',
  '<a id="x-js" href="javascript:window.__xss=\'href\'">js</a>',
  '<a id="x-js-case" href="  JaVa\tScRiPt:window.__xss=\'case\'">js</a>',
  '<a id="x-data" href="data:text/html,<script>window.__xss=\'data\'</script>">data</a>',
  '<img id="x-srcset" srcset="x.png 1x, javascript:window.__xss=\'srcset\' 2x" src="x.png">',
  '<img id="x-srcset-data" srcset="data:image/svg+xml;base64,AAAA 1x">',
  '<svg><a id="x-xlink" xlink:href="javascript:window.__xss=\'xlink\'"><text>x</text></a></svg>',
  '<svg><use id="x-use" href="data:image/svg+xml,<svg xmlns=\'http://www.w3.org/2000/svg\' onload=\'window.__xss=1\'/>"></use></svg>',
  '<svg><animate id="x-anim" attributeName="href" values="javascript:window.__xss=\'anim\'"></animate></svg>',
  '<svg onload="window.__xss=\'svgonload\'"></svg>',
  '<form id="x-form" action="javascript:window.__xss=\'form\'"><button id="x-fa" formaction="javascript:window.__xss=\'formaction\'">go</button></form>',
  '<iframe id="x-frame" srcdoc="<script>parent.__xss=\'srcdoc\'</script>"></iframe>',
  '<object data="javascript:window.__xss=\'object\'"></object>',
  '<script>window.__xss="script"</script>',
  '<style>@import "javascript:window.__xss=1"</style>',
  '<div id="x-style" style="background:url(javascript:window.__xss=1)">style</div>',
  '<template><img src="x" onerror="window.__xss=\'template\'"></template>',
  '<math><mi xlink:href="javascript:window.__xss=\'math\'">m</mi></math>',
  '<meta http-equiv="refresh" content="0;url=javascript:window.__xss=\'meta\'">',
  '<details open ontoggle="window.__xss=\'ontoggle\'">d</details>',
];

before(async () => {
  if (skip) return;
  const { build } = await import('esbuild');
  const { chromium } = await import('playwright-core');
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watcher-settings-browser-'));
  const entry = path.join(tmpDir, 'entry.js');
  fs.writeFileSync(entry, `
    import { installPerfProbe } from '${front('lib/perfProbe.js')}';
    import { ws } from '${front('features/settings/watcher/store.js')}';
    import { watcherFragment } from '${front('features/settings/watcher/safeHtml.js')}';
    import { mountWatcherPanel } from '${front('features/settings/watcher/components/watcherPanel.js')}';
    import { renderWatcherPanel } from '${front('features/settings/watcher/panelView.js')}';
    import { draftFromProfile } from '${front('features/watcher/scoutProfileEditorView.js')}';
    import { EMPTY_SCOUT_EDITOR_STATE } from '${front('features/settings/watcher/constants.js')}';
    installPerfProbe();
    window.__w = { ws, watcherFragment, mountWatcherPanel, renderWatcherPanel, draftFromProfile, EMPTY_SCOUT_EDITOR_STATE };
  `);
  const bundle = path.join(tmpDir, 'bundle.js');
  await build({
    entryPoints: [entry],
    bundle: true,
    format: 'iife',
    outfile: bundle,
    loader: { '.scss': 'empty' },
    logLevel: 'error',
  });
  browser = await chromium.launch({
    executablePath: chromiumPath,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext();
  page = await context.newPage();
  await page.route('http://watcher.test/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') {
      return route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><html><body><div id="settings-watcher-root"></div></body></html>',
      });
    }
    return route.fulfill({ contentType: 'application/json', body: '{"ok":false}' });
  });
  await page.goto('http://watcher.test/');
  await page.evaluate(() => {
    window.__longTaskMs = 0;
    window.__xss = undefined;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) window.__longTaskMs += entry.duration;
    }).observe({ entryTypes: ['longtask'] });
  });
  await page.addScriptTag({ path: bundle });
  // Bundle evaluation is not part of what the panel does; count from here on.
  await page.evaluate(() => { window.__longTaskMs = 0; });
});

after(async () => {
  await browser?.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Let signal-driven Lit updates settle. */
async function settle() {
  await page.evaluate(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
    await Promise.all([...document.querySelectorAll('cr-watcher-panel, [data-watcher-region]')]
      .map((el) => /** @type {any} */ (el).updateComplete));
  });
}

const VIEW = {
  ok: true,
  watcher: { mode: 'observe', policy: {}, decisions: [] },
  guardrails: { kind: 'ok', reason: 'fine' },
  schedule: {},
  scout: {},
  snapshot: {},
  workspaceFolder: '/work/my-app',
};

test('sanitiser strips every executable construct, in a real browser', { skip }, async () => {
  await page.evaluate(({ payloads }) => {
    const w = /** @type {any} */ (window).__w;
    const host = document.createElement('div');
    host.id = 'xss-host';
    document.body.append(host);
    host.append(w.watcherFragment(payloads.join('')));
  }, { payloads: XSS_PAYLOADS });
  // Give image loads / error handlers a chance to fire, then click everything.
  await page.waitForTimeout(150);
  for (const selector of ['#x-js', '#x-js-case', '#x-data', '#x-xlink']) {
    const el = await page.$(`#xss-host ${selector}`);
    if (el) await el.click({ force: true, noWaitAfter: true, timeout: 1000 }).catch(() => {});
  }
  await page.waitForTimeout(100);
  const report = await page.evaluate(() => {
    const host = document.getElementById('xss-host');
    const all = [...host.querySelectorAll('*')];
    return {
      xss: /** @type {any} */ (window).__xss ?? null,
      dangerousTags: all.filter((el) => /^(script|style|iframe|object|embed|meta|template|animate|set)$/i.test(el.localName)).length,
      handlers: all.filter((el) => [...el.attributes].some((a) => a.name.toLowerCase().startsWith('on'))).length,
      urlAttrs: all.flatMap((el) => [...el.attributes])
        .filter((a) => /^(href|src|srcset|xlink:href|action|formaction|data|srcdoc)$/i.test(a.name))
        .map((a) => `${a.name}=${a.value}`),
      styleUrl: host.querySelector('#x-style')?.getAttribute('style') ?? null,
      srcdoc: host.querySelector('#x-frame'),
    };
  });
  assert.equal(report.xss, null, 'no payload ran script');
  assert.equal(report.dangerousTags, 0, 'executable elements are removed');
  assert.equal(report.handlers, 0, 'no inline event handler survives');
  assert.equal(report.srcdoc, null, 'iframe (and its srcdoc) is removed');
  assert.equal(report.styleUrl, null, 'a style that fetches a URL is dropped');
  for (const attr of report.urlAttrs) {
    assert.doesNotMatch(attr, /javascript:|data:|vbscript:/i, `unsafe URL attribute survived: ${attr}`);
  }
  await page.evaluate(() => document.getElementById('xss-host').remove());
});

test('sanitiser keeps ordinary markup, safe URLs and srcset', { skip }, async () => {
  const out = await page.evaluate(() => {
    const w = /** @type {any} */ (window).__w;
    const host = document.createElement('div');
    host.append(w.watcherFragment(
      '<a href="https://example.com/a?b=1" data-scout-action="run">ok</a>'
      + '<a href="/relative">rel</a><a href="#frag">frag</a><a href="mailto:a@example.com">mail</a>'
      + '<img srcset="a.png 1x, b.png 2x" src="a.png" alt="x">'
      + '<input id="keep" type="number" value="3" data-x="1">'
      + '<cr-watcher-status-card id="watcher-status-card"></cr-watcher-status-card>',
    ));
    return {
      hrefs: [...host.querySelectorAll('a')].map((a) => a.getAttribute('href')),
      srcset: host.querySelector('img').getAttribute('srcset'),
      action: host.querySelector('[data-scout-action]').getAttribute('data-scout-action'),
      input: host.querySelector('#keep').getAttribute('value'),
      custom: !!host.querySelector('cr-watcher-status-card'),
    };
  });
  assert.deepEqual(out.hrefs, ['https://example.com/a?b=1', '/relative', '#frag', 'mailto:a@example.com']);
  assert.equal(out.srcset, 'a.png 1x, b.png 2x');
  assert.equal(out.action, 'run');
  assert.equal(out.input, '3');
  assert.equal(out.custom, true);
});

test('the panel mounts once and re-renders never duplicate nodes or ids', { skip }, async () => {
  const result = await page.evaluate(async ({ view }) => {
    const w = /** @type {any} */ (window).__w;
    const root = document.getElementById('settings-watcher-root');
    const first = w.mountWatcherPanel(root);
    const second = w.mountWatcherPanel(root);
    const third = w.mountWatcherPanel(root);
    const sameElement = first === second && second === third;
    const render = (rev) => {
      w.ws.lastView = view;
      w.ws.panelModel = { kind: 'ready', rev, data: view, html: w.renderWatcherPanel(view) };
    };
    const snapshot = () => {
      const ids = [...root.querySelectorAll('[id]')].map((el) => el.id);
      return {
        panels: root.querySelectorAll('cr-watcher-panel').length,
        children: root.children.length,
        tabPanels: root.querySelectorAll('[data-watcher-panel]').length,
        statusCards: root.querySelectorAll('#watcher-status-card').length,
        duplicateIds: ids.filter((id, i) => ids.indexOf(id) !== i),
      };
    };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
    render(1);
    await settle();
    const afterFirst = snapshot();
    render(2);
    await settle();
    render(3);
    await settle();
    const afterThird = snapshot();
    // A tab change re-runs the panel without rebuilding the form.
    const maxCycles = root.querySelector('#watcher-max-cycles');
    maxCycles.__keep = true;
    w.ws.tab = 'settings';
    await settle();
    const sameNodeAfterTab = root.querySelector('#watcher-max-cycles') === maxCycles
      && root.querySelector('#watcher-max-cycles').__keep === true;
    const settingsVisible = root.querySelector('#watcher-panel-settings').hidden === false
      && root.querySelector('#watcher-panel-status').hidden === true;
    return { sameElement, afterFirst, afterThird, sameNodeAfterTab, settingsVisible };
  }, { view: VIEW });
  assert.equal(result.sameElement, true, 'mount is idempotent');
  for (const snap of [result.afterFirst, result.afterThird]) {
    assert.equal(snap.panels, 1);
    assert.equal(snap.children, 1);
    assert.equal(snap.tabPanels, 5, 'one copy of each of the five tab panels');
    assert.equal(snap.statusCards, 1);
    assert.deepEqual(snap.duplicateIds, [], 'ids stay unique across re-renders');
  }
  assert.equal(result.sameNodeAfterTab, true, 'a tab change does not rebuild the form');
  assert.equal(result.settingsVisible, true, 'the active tab follows the signal');
});

test('live regions re-render from signals; the form and a dirty draft keep their nodes', { skip }, async () => {
  await page.evaluate(() => {
    const w = /** @type {any} */ (window).__w;
    w.ws.tab = 'scout';
    w.ws.scoutProfilesState = { ...w.ws.scoutProfilesState, loading: false, profiles: [] };
    w.ws.scoutEditorState = {
      ...w.EMPTY_SCOUT_EDITOR_STATE,
      mode: 'create',
      draft: w.draftFromProfile(null),
    };
  });
  await settle();
  // Mark the form and the editor input, then drive state through the store.
  await page.evaluate(() => {
    document.querySelector('#watcher-max-cycles').__keep = true;
    const nameInput = document.querySelector('#watcher-scout-editor [data-scout-editor-field="name"]');
    nameInput.__keep = true;
  });
  // The policy form lives in the (hidden) Settings tab; edit it directly.
  await page.evaluate(() => { document.querySelector('#watcher-max-cycles').value = '77'; });
  await page.fill('#watcher-scout-editor [data-scout-editor-field="name"]', 'My scout');
  await page.focus('#watcher-scout-editor [data-scout-editor-field="name"]');

  const before = await page.evaluate(() => ({
    status: document.querySelector('#watcher-status-card').textContent,
    profiles: document.querySelector('#watcher-scout-profiles').textContent,
  }));
  await page.evaluate(() => {
    const w = /** @type {any} */ (window).__w;
    w.ws.lastView = { ...w.ws.lastView, watcher: { ...w.ws.lastView.watcher, mode: 'autopilot' } };
    w.ws.scoutProfilesState = {
      ...w.ws.scoutProfilesState,
      loading: false,
      profiles: [{ id: 'p1', name: 'Alpha scout', revision: 1, enabled: true, state: { key: 'idle' } }],
    };
  });
  await settle();
  const after = await page.evaluate(() => ({
    status: document.querySelector('#watcher-status-card').textContent,
    profiles: document.querySelector('#watcher-scout-profiles').textContent,
    maxCycles: document.querySelector('#watcher-max-cycles').value,
    formNodeKept: document.querySelector('#watcher-max-cycles').__keep === true,
    editorNodeKept: document.querySelector('#watcher-scout-editor [data-scout-editor-field="name"]')?.__keep === true,
    editorFocused: document.activeElement?.getAttribute?.('data-scout-editor-field') === 'name',
    editorValue: document.querySelector('#watcher-scout-editor [data-scout-editor-field="name"]')?.value,
    dirty: window.__w.ws.peek('scoutEditorState').dirty,
  }));
  assert.match(before.status, /OBSERVE/);
  assert.match(after.status, /AUTOPILOT/, 'the status region re-rendered from the signal');
  assert.match(after.profiles, /Alpha scout/, 'the profile region re-rendered from the signal');
  assert.equal(after.maxCycles, '77', 'unsaved form edit survives a live update');
  assert.equal(after.formNodeKept, true, 'the policy form was not rebuilt');
  assert.equal(after.dirty, true, 'typing marks the draft dirty without re-rendering');
  assert.equal(after.editorNodeKept, true, 'the dirty editor input was not rebuilt');
  assert.equal(after.editorFocused, true, 'focus stays in the editor input');
  assert.equal(after.editorValue, 'My scout');
});

test('render timings reach window.__cretliPerf and long tasks stay bounded', { skip }, async (t) => {
  // Drive a burst of store updates so the probes have samples.
  await page.evaluate(async () => {
    const w = /** @type {any} */ (window).__w;
    for (let i = 0; i < 20; i += 1) {
      w.ws.lastView = { ...w.ws.lastView, watcher: { ...w.ws.lastView.watcher, cycleCount: i } };
      w.ws.lastStats = { ...(w.ws.lastStats || {}), n: i };
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  });
  await settle();
  const perf = await page.evaluate(() => ({
    entries: /** @type {any} */ (window).__cretliPerf.entries,
    longTaskMs: Math.round(window.__longTaskMs),
  }));
  const region = perf.entries.filter((e) => e.name.startsWith('watcher.region.'));
  const parse = perf.entries.find((e) => e.name === 'watcher.panel.parse');
  assert.ok(region.length > 0, 'region renders are recorded on window.__cretliPerf');
  assert.ok(parse && parse.count >= 1, 'the form parse is recorded');
  const worstMs = Math.max(...region.map((e) => e.maxMs));
  const regionTotalMs = Math.round(region.reduce((sum, e) => sum + e.durationMs, 0) * 100) / 100;
  t.diagnostic(`regions: ${region.length}, renders: ${region.reduce((s, e) => s + e.count, 0)}, total ${regionTotalMs} ms, worst ${worstMs} ms`);
  t.diagnostic(`panel parse: ${parse.count}x, max ${parse.maxMs} ms; long tasks total: ${perf.longTaskMs} ms`);
  assert.ok(worstMs < budgetMs(100), `a single region render must stay under 100 ms (worst ${worstMs} ms)`);
  assert.ok(perf.longTaskMs < budgetMs(500), `summed long tasks must stay under 500 ms (got ${perf.longTaskMs} ms)`);
});
