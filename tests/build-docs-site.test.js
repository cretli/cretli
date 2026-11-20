import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildDocsSite } from '../scripts/build-docs-site.mjs';
import { makeTempDir } from './helpers/temp-dir.js';
import { budgetMs } from './helpers/time-budget.js';

const fm = (title = 'Title', extra = '') => `---\ntitle: ${title}\ndescription: A page\n${extra}---\n`;

/** Create a src/out pair; pages is { slug: markdown }, nav defaults to the keys. */
function setup(pages, nav = Object.keys(pages)) {
  const root = makeTempDir('docs-site-');
  const srcDir = path.join(root, 'user');
  const outDir = path.join(root, 'out');
  const imgDir = path.join(outDir, 'img');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.mkdirSync(imgDir, { recursive: true });
  for (const [slug, text] of Object.entries(pages)) fs.writeFileSync(path.join(srcDir, `${slug}.md`), text);
  fs.writeFileSync(path.join(srcDir, '_nav.json'), JSON.stringify({ pages: nav }));
  return { srcDir, outDir, imgDir, opts: { srcDir, outDir, imgDir } };
}
const read = (outDir, f) => fs.readFileSync(path.join(outDir, f), 'utf8');

describe('build-docs-site', () => {
  it('renders ids, nav order, toc and prev/next', () => {
    const s = setup({
      index: `${fm('Home')}# Home\n\n## Intro\n\n### Deep\n\n## Intro\n`,
      other: `${fm('Other')}# Other\n`,
    }, ['index', 'other']);
    const r = buildDocsSite(s.opts);
    assert.deepEqual(r.errors, []);
    const html = read(s.outDir, 'index.html');
    assert.match(html, /<h2 id="intro">/);
    assert.match(html, /<h2 id="intro-2">/);
    assert.match(html, /<h3 id="deep">/);
    assert.ok(html.indexOf('>Home</a>') < html.indexOf('>Other</a>'));
    assert.match(html, /rel="next" href="other.html"/);
    assert.match(read(s.outDir, 'other.html'), /rel="prev" href="index.html"/);
    assert.match(html, /href="#deep"/);
    assert.match(html, /rel="canonical" href="https:\/\/cretli.com\/docs\/"/);
  });

  it('rewrites .md links and reports bad ones with file names', () => {
    const ok = setup({ a: `${fm()}[b](b.md#x)\n`, b: `${fm()}## X\n` });
    assert.match(buildDocsSite(ok.opts).errors.join() || read(ok.outDir, 'a.html'), /href="b.html#x"/);
    const bad = setup({ a: `${fm()}[d](nope.md) [e](b.md#zz) ![i](img/none.png)\n`, b: `${fm()}## X\n` });
    const errors = buildDocsSite(bad.opts).errors.join('\n');
    assert.match(errors, /a\.md: dead link/);
    assert.match(errors, /a\.md: broken anchor/);
    assert.match(errors, /a\.md: missing image/);
  });

  it('validates front matter and nav', () => {
    assert.match(buildDocsSite(setup({ a: '---\ndescription: d\n---\nx\n' }).opts).errors.join(), /a\.md.*"title"/);
    assert.match(buildDocsSite(setup({ a: fm('T', 'order: 1\n') }).opts).errors.join(), /a\.md.*"order"/);
    assert.match(buildDocsSite(setup({ a: fm(), b: fm() }, ['a']).opts).errors.join(), /b\.md.*not listed/);
    assert.match(buildDocsSite(setup({ a: fm() }, ['a', 'ghost']).opts).errors.join(), /ghost/);
  });

  it('escapes raw html and title, strips comments outside code', () => {
    const s = setup({
      a: `${fm('Say "hi"')}<script>alert(1)</script>\n\n<!-- sources: x\nmore -->\n\n\`\`\`\n<!-- sources: x -->\n\`\`\`\n`,
    });
    assert.deepEqual(buildDocsSite(s.opts).errors, []);
    const html = read(s.outDir, 'a.html');
    assert.ok(!html.includes('<script>alert'));
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /<title>Say &quot;hi&quot;<\/title>/);
    assert.ok(!html.includes('more -->'));
    assert.match(html, /&lt;!-- sources: x --&gt;/);
    assert.ok(!read(s.outDir, 'search-index.json').includes('sources'));
  });

  it('emits sitemap, no external assets, theme and mobile support', () => {
    const s = setup({ a: `${fm()}text\n`, b: `${fm()}text\n` });
    buildDocsSite(s.opts);
    const sitemap = read(s.outDir, 'sitemap.xml');
    assert.match(sitemap, /<loc>https:\/\/cretli.com\/docs\/a.html<\/loc>/);
    assert.match(sitemap, /<loc>https:\/\/cretli.com\/docs\/b.html<\/loc>/);
    for (const f of ['a.html', 'b.html', 'assets/docs.css']) {
      const text = read(s.outDir, f);
      assert.ok(!/<script src="http|<link[^>]+stylesheet[^>]+href="http|url\(http/.test(text), f);
    }
    assert.match(read(s.outDir, 'a.html'), /<meta name="viewport"/);
    const css = read(s.outDir, 'assets/docs.css');
    assert.ok(css.includes('prefers-color-scheme: dark') && css.includes('[data-theme=') && css.includes('@media (max-width: 768px)'));
  });

  it('is deterministic, detects drift and leaves img/ alone', () => {
    const s = setup({ a: `${fm()}text\n` });
    fs.writeFileSync(path.join(s.imgDir, 'x.png'), 'png');
    const started = Date.now();
    buildDocsSite(s.opts);
    const first = read(s.outDir, 'a.html');
    buildDocsSite(s.opts);
    assert.equal(read(s.outDir, 'a.html'), first);
    assert.ok(Date.now() - started < budgetMs(5000));
    assert.deepEqual(buildDocsSite({ ...s.opts, write: false }).drift, []);
    fs.writeFileSync(path.join(s.outDir, 'a.html'), 'changed');
    fs.writeFileSync(path.join(s.outDir, 'stale.html'), 'old');
    const drift = buildDocsSite({ ...s.opts, write: false }).drift;
    assert.deepEqual(drift, ['a.html', 'stale.html']);
    assert.ok(fs.existsSync(path.join(s.outDir, 'stale.html')));
    buildDocsSite(s.opts);
    assert.ok(!fs.existsSync(path.join(s.outDir, 'stale.html')));
    assert.equal(fs.readFileSync(path.join(s.imgDir, 'x.png'), 'utf8'), 'png');
  });

  it('committed website/docs matches docs/user', () => {
    const r = buildDocsSite({ write: false });
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.drift, []);
  });
});
