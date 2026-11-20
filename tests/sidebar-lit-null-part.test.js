import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, extname } from 'node:path';
import { chromium } from 'playwright-core';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const exe = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, '/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome']
  .filter(Boolean).find((p) => existsSync(p));

const PAGE = `<!doctype html><script type="importmap">{"imports":{
"lit":"/node_modules/lit/index.js","lit/":"/node_modules/lit/",
"lit-html":"/node_modules/lit-html/lit-html.js","lit-html/":"/node_modules/lit-html/",
"lit-element/":"/node_modules/lit-element/","@lit/reactive-element":"/node_modules/@lit/reactive-element/reactive-element.js",
"@lit/reactive-element/":"/node_modules/@lit/reactive-element/"}}</script><body></body>`;

async function withServer(run) {
  const server = createServer(async (req, res) => {
    const url = (req.url || '/').split('?')[0];
    if (url === '/') { res.setHeader('content-type', 'text/html'); res.end(PAGE); return; }
    try {
      const file = resolve(repoRoot, '.' + url);
      if (!file.startsWith(repoRoot)) throw new Error('outside');
      res.setHeader('content-type', extname(file) === '.js' ? 'text/javascript' : 'text/plain');
      res.end(await readFile(file));
    } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try { await run(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}

test('group summary patch keeps Lit text part valid across a later rebuild', { skip: !exe && 'no chromium' }, async () => {
  await withServer(async (base) => {
    const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
    try {
      const page = await browser.newPage();
      await page.goto(base);
      const result = await page.evaluate(async () => {
        const { html, render } = await import('lit');
        const { setSingleBindingText } = await import('/app_front/features/sidebar/views/sidebarLitText.js');
        const host = document.body.appendChild(document.createElement('div'));
        const tpl = (s) => html`<span class="sidebar-subchat-group-summary">${s}</span>`;
        render(tpl('1 running'), host);
        const span = host.querySelector('span');
        // Patch (as sidebarPatch does), then rebuild the group through Lit.
        setSingleBindingText(span, '2 running');
        const afterPatch = span.textContent;
        render(tpl('3 done'), host);
        const afterRebuild = host.querySelector('span')?.textContent;
        // The old imperative form must be the failing one.
        let legacyError = '';
        span.textContent = 'b';
        try { render(tpl('c'), host); } catch (e) { legacyError = String(e.message); }
        return { afterPatch, afterRebuild, legacyError };
      });
      assert.equal(result.afterPatch, '2 running');
      assert.equal(result.afterRebuild, '3 done');
      assert.match(result.legacyError, /null/, 'textContent= reproduces the Lit null-part crash');
    } finally { await browser.close(); }
  });
});

test('setSingleBindingText handles empty strings and leaves multi-node content untouched', { skip: !exe && 'no chromium' }, async () => {
  await withServer(async (base) => {
    const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
    try {
      const page = await browser.newPage();
      await page.goto(base);
      const r = await page.evaluate(async () => {
        const { html, render } = await import('lit');
        const { setSingleBindingText } = await import('/app_front/features/sidebar/views/sidebarLitText.js');
        const host = document.body.appendChild(document.createElement('div'));
        // Single binding: empty string write, then a Lit rebuild must not throw.
        render(html`<span>${'x'}</span>`, host);
        const single = host.querySelector('span');
        const okEmpty = setSingleBindingText(single, '');
        const emptyText = single.textContent;
        render(html`<span>${'y'}</span>`, host);
        const rebuilt = host.querySelector('span').textContent;
        // Static prefix + binding + suffix: must be untouched.
        render(html`<span>pre ${'v'} post</span>`, host);
        const multi = host.querySelector('span');
        const okMulti = setSingleBindingText(multi, 'zzz');
        const multiText = multi.textContent;
        render(html`<span>pre ${'w'} post</span>`, host);
        const multiRebuilt = host.querySelector('span').textContent;
        // Two bindings: untouched as well.
        render(html`<span>${'a'}${'b'}</span>`, host);
        const two = host.querySelector('span');
        const okTwo = setSingleBindingText(two, 'zzz');
        return { okEmpty, emptyText, rebuilt, okMulti, multiText, multiRebuilt, okTwo, twoText: two.textContent };
      });
      assert.equal(r.okEmpty, true);
      assert.equal(r.emptyText, '');
      assert.equal(r.rebuilt, 'y');
      assert.equal(r.okMulti, false);
      assert.equal(r.multiText, 'pre v post');
      assert.equal(r.multiRebuilt, 'pre w post');
      assert.equal(r.okTwo, false);
      assert.equal(r.twoText, 'ab');
    } finally { await browser.close(); }
  });
});
