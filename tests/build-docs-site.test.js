import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildDocsSite } from '../scripts/build-docs-site.mjs';
import { checkLinks, checkBudget } from '../scripts/docs-site/check-site.mjs';
import { makeTempDir } from './helpers/temp-dir.js';
import { budgetMs } from './helpers/time-budget.js';

const fm = (title = 'Title', extra = '') => `---\ntitle: ${title}\ndescription: A page\n${extra}---\n`;

/** Create a src/out pair; pages is { slug: markdown }, nav defaults to the keys. */
function setup(pages, nav = Object.keys(pages)) {
  const root = makeTempDir('docs-site-');
  const srcDir = path.join(root, 'user');
  const outDir = path.join(root, 'out');
  const imgDir = path.join(outDir, 'img');
  fs.mkdirSync(imgDir, { recursive: true });
  for (const lang of ['en', 'pl']) {
    const dir = path.join(srcDir, lang);
    fs.mkdirSync(dir, { recursive: true });
    for (const [slug, text] of Object.entries(pages)) fs.writeFileSync(path.join(dir, `${slug}.md`), text + '\n<!-- sources: README.md -->\n');
    fs.writeFileSync(path.join(dir, '_nav.json'), JSON.stringify({ sections: [{ id: 'start', title: 'Start', pages: nav }] }));
  }
  return { srcDir, outDir, imgDir, opts: { srcDir, outDir, imgDir } };
}
const read = (outDir, f) => fs.readFileSync(path.join(outDir, f === 'sitemap.xml' ? f : f.startsWith('assets/') ? `docs/${f}` : `docs/en/${f}`), 'utf8');

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
    assert.match(html, /rel="canonical" href="https:\/\/cretli.com\/docs\/en\/index.html"/);
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
      a: `${fm('Say "hi"')}<script>alert(1)</script>\n\n<!-- internal: x\nmore -->\n\n\`\`\`\n<!-- sources: README.md -->\n\`\`\`\n`,
    });
    assert.deepEqual(buildDocsSite(s.opts).errors, []);
    const html = read(s.outDir, 'a.html');
    assert.ok(!html.includes('<script>alert'));
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /<title>Say &quot;hi&quot;<\/title>/);
    assert.ok(!html.includes('more -->'));
    assert.match(html, /&lt;!-- sources: README.md --&gt;/);
    assert.ok(!read(s.outDir, 'search-index.json').includes('sources'));
  });

  it('emits sitemap, no external assets, theme and mobile support', () => {
    const s = setup({ a: `${fm()}text\n`, b: `${fm()}text\n` });
    buildDocsSite(s.opts);
    const sitemap = read(s.outDir, 'sitemap.xml');
    assert.match(sitemap, /<loc>https:\/\/cretli.com\/docs\/en\/a.html<\/loc>/);
    assert.match(sitemap, /<loc>https:\/\/cretli.com\/docs\/en\/b.html<\/loc>/);
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
    fs.writeFileSync(path.join(s.outDir, 'docs/en/a.html'), 'changed');
    fs.writeFileSync(path.join(s.outDir, 'stale.html'), 'old');
    const drift = buildDocsSite({ ...s.opts, write: false }).drift;
    assert.deepEqual(drift, ['docs/en/a.html', 'stale.html']);
    assert.ok(fs.existsSync(path.join(s.outDir, 'stale.html')));
    buildDocsSite(s.opts);
    assert.ok(!fs.existsSync(path.join(s.outDir, 'stale.html')));
    assert.equal(fs.readFileSync(path.join(s.imgDir, 'x.png'), 'utf8'), 'png');
  });


  it('rejects language slug and section order mismatches and invalid source paths', () => {
    const s = setup({ a: `${fm()}text`, b: `${fm()}text` });
    fs.rmSync(path.join(s.srcDir, 'pl/b.md'));
    assert.match(buildDocsSite(s.opts).errors.join(), /slug parity mismatch/);
    const t = setup({ a: `${fm()}text` });
    fs.writeFileSync(path.join(t.srcDir, 'pl/_nav.json'), JSON.stringify({ sections: [{ id: 'different', title: 'Different', pages: ['a'] }] }));
    assert.match(buildDocsSite(t.opts).errors.join(), /section order parity mismatch/);
    fs.appendFileSync(path.join(t.srcDir, 'en/a.md'), '\n<!-- sources: missing-source-file -->');
    assert.match(buildDocsSite(t.opts).errors.join(), /missing source/);
    fs.writeFileSync(path.join(t.srcDir, 'pl/_nav.json'), JSON.stringify({ sections: [null] }));
    assert.match(buildDocsSite(t.opts).errors.join(), /invalid or duplicate section/);
  });

  it('emits bilingual SEO, landmarks, local assets and scripts within the budget', () => {
    const r = buildDocsSite({ write: false });
    assert.deepEqual(r.errors, []);
    const website = path.resolve('website');
    const sitemap = fs.readFileSync(path.join(website, 'sitemap.xml'), 'utf8');
    for (const lang of ['en', 'pl']) {
      assert.ok(fs.existsSync(path.join(website, `docs/${lang}/search-index.json`)));
      const pages = r.pages.map((slug) => `docs/${lang}/${slug}.html`);
      pages.push(lang === 'en' ? 'index.html' : 'pl/index.html');
      for (const name of pages) {
        const html = fs.readFileSync(path.join(website, name), 'utf8');
        assert.match(html, new RegExp(`<html lang="${lang}"`));
        for (const marker of ['rel="canonical"', 'hreflang="en"', 'hreflang="pl"', 'hreflang="x-default"', 'property="og:title"', 'property="og:description"', 'class="skip-link"', '<main', '<header', '<footer']) assert.ok(html.includes(marker), `${name}: ${marker}`);
        assert.ok(!/\{\{\w+\}\}/.test(html), `${name}: unresolved template`);
        const canonical = html.match(/rel="canonical" href="([^"]+)"/)[1];
        assert.ok(sitemap.includes(`<loc>${canonical}</loc>`), name);
        assert.ok(!/<(?:script|img)[^>]+src="(?:https?:)?\/\/|<link[^>]+(?:stylesheet|preload)[^>]+href="(?:https?:)?\/\//.test(html));
        let bytes = 0;
        for (const script of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
          const src = script[1].match(/src="([^"]+)"/);
          bytes += src ? fs.statSync(src[1].startsWith('/') ? path.join(website, src[1]) : path.resolve(website, path.dirname(name), src[1])).size : Buffer.byteLength(script[2]);
        }
        assert.ok(bytes <= 30 * 1024, `${name}: ${bytes} JS bytes`);
      }
    }
    const defaultDocs = fs.readFileSync(path.join(website, 'docs/index.html'), 'utf8');
    assert.match(defaultDocs, /http-equiv="refresh" content="0;url=en\/index.html"/);
    assert.match(defaultDocs, /href="en\/getting-started.html"/);
    const js = fs.readFileSync(path.join(website, 'docs/assets/docs.js'), 'utf8');
    assert.match(js, /localStorage.setItem/);
    assert.match(js, /prefers-color-scheme/);
    assert.match(js, /fetch\('search-index.json'\)/);
    const css = fs.readFileSync(path.join(website, 'docs/assets/docs.css'), 'utf8');
    assert.ok(!/@import|url\(\s*['"]?(?:https?:)?\/\//.test(css));
  });

  it('committed website/docs matches docs/user', () => {
    const r = buildDocsSite({ write: false });
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.drift, []);
  });

  it('site checker reports zero broken links and budget violations for the committed site', () => {
    const website = path.resolve('website');
    const links = checkLinks(website);
    assert.deepEqual(links.errors, []);
    assert.ok(links.pages >= 55 && links.links > 500, `${links.pages} pages, ${links.links} links`);
    const budget = checkBudget(website);
    assert.deepEqual(budget.errors, []);
    assert.equal(budget.pages, links.pages);
  });

  it('site checker detects broken links, anchors, images, third-party assets and missing dimensions', () => {
    const root = makeTempDir('docs-check-');
    fs.mkdirSync(path.join(root, 'a'), { recursive: true });
    fs.writeFileSync(path.join(root, 'b.html'), '<h2 id="ok">x</h2>');
    fs.writeFileSync(path.join(root, 'a/p.html'), [
      '<a href="../b.html#ok">fine</a><a href="/b.html">fine</a><a href="../b.html#nope">anchor</a>',
      '<a href="missing.html">dead</a><a href="https://example.org/">external</a><img src="none.png" width="1" height="1" alt="">',
      '<img src="https://cdn.example/x.png" alt="x"><img src="../b.html" width="2" height="2">',
      '<script src="https://cdn.example/x.js"></script><link rel="stylesheet" href="https://cdn.example/x.css">',
    ].join('\n'));
    const links = checkLinks(root).errors.join('\n');
    assert.match(links, /broken anchor "..\/b.html#nope"/);
    assert.match(links, /broken link "missing.html"/);
    assert.match(links, /broken image "none.png"/);
    assert.ok(!/b\.html#ok|"\/b.html"/.test(links));
    const budget = checkBudget(root).errors.join('\n');
    assert.match(budget, /third-party script/);
    assert.match(budget, /third-party stylesheet/);
    assert.match(budget, /third-party image/);
    assert.match(budget, /image without width\/height "https:\/\/cdn/);
    assert.match(budget, /image without alt "..\/b.html"/);
    fs.writeFileSync(path.join(root, 'big.js'), 'x'.repeat(31 * 1024));
    fs.writeFileSync(path.join(root, 'c.html'), '<script src="big.js" defer></script>');
    assert.match(checkBudget(root).errors.join('\n'), /c\.html: \d+ JS bytes exceed/);
  });

  it('site checker validates absolute same-origin links and files like relative ones', () => {
    const root = makeTempDir('docs-origin-');
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs/ok.html'), '<h2 id="x">x</h2>');
    fs.writeFileSync(path.join(root, 'index.html'), [
      '<a href="https://cretli.com/docs/ok.html#x">ok</a><a href="https://cretli.com/">home</a><a href="//cretli.com/docs/ok.html">ok</a>',
      '<a href="https://cretli.com/docs/missing.html">dead</a><a href="https://cretli.com/docs/ok.html#nope">anchor</a>',
      '<a href="https://cretli.com.evil.example/docs/missing.html">other host</a><img src="https://cretli.com/docs/none.png" width="1" height="1" alt="">',
    ].join('\n'));
    const errors = checkLinks(root).errors.join('\n');
    assert.match(errors, /broken link "https:\/\/cretli.com\/docs\/missing.html"/);
    assert.match(errors, /broken anchor "https:\/\/cretli.com\/docs\/ok.html#nope"/);
    assert.match(errors, /broken image "https:\/\/cretli.com\/docs\/none.png"/);
    assert.equal(errors.split('\n').length, 3, errors);
  });

  it('site checker normalizes default ports and keeps fragments after a query string', () => {
    const root = makeTempDir('docs-port-');
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs/ok.html'), '<h2 id="x">x</h2>');
    fs.writeFileSync(path.join(root, 'index.html'), [
      '<a href="https://cretli.com:443/docs/missing.html">p443</a><a href="http://cretli.com:80/docs/missing2.html">p80</a>',
      '<a href="https://cretli.com:443/docs/ok.html#x">fine</a><a href="https://cretli.com:8443/docs/missing.html">other port</a>',
      '<a href="/docs/ok.html?source=nav#missing">q</a><a href="/docs/ok.html?source=nav#x">qok</a>',
    ].join('\n'));
    const errors = checkLinks(root).errors.join('\n');
    assert.match(errors, /broken link "https:\/\/cretli.com:443\/docs\/missing.html"/);
    assert.match(errors, /broken link "http:\/\/cretli.com:80\/docs\/missing2.html"/);
    assert.match(errors, /broken anchor "\/docs\/ok.html\?source=nav#missing"/);
    assert.equal(errors.split('\n').length, 3, errors);
  });

  it('site checker follows CSS @import chains: budgets, cycles, dedupe and third-party imports', () => {
    const root = makeTempDir('docs-css-');
    const w = (name, text) => fs.writeFileSync(path.join(root, name), text);
    w('a.css', '@import "b.css";\n/* @import "https://cdn.example/commented.css"; */\n' + 'a{}'.repeat(10));
    w('b.css', '@import url(c.css);\n@import url("a.css");\n' + 'b{}'.repeat(10));
    w('c.css', 'c{}'.repeat(10));
    w('ok.html', '<link rel="stylesheet" href="a.css"><style>@import "c.css"; x{}</style>');
    const ok = checkBudget(root);
    assert.deepEqual(ok.errors, []);
    const total = ['a.css', 'b.css', 'c.css'].reduce((n, f) => n + fs.statSync(path.join(root, f)).size, 0);
    assert.equal(ok.stats[0].css, total + Buffer.byteLength('@import "c.css"; x{}'));
    w('bad.html', '<link rel="stylesheet" href="https://cretli.com/a.css"><style>@import url(https://cdn.example/x.css); @import "gone.css";</style>');
    w('d.css', '@import "//fonts.example/f.css"; @import \'https://cretli.com/c.css\';');
    w('bad2.html', '<link rel="stylesheet" href="d.css">');
    const errors = checkBudget(root).errors.join('\n');
    assert.match(errors, /bad\.html: third-party CSS import "https:\/\/cdn.example\/x.css" in inline <style>/);
    assert.match(errors, /bad\.html: missing CSS import "gone.css"/);
    assert.match(errors, /bad2\.html: third-party CSS import "\/\/fonts.example\/f.css" in d.css/);
    assert.ok(!/commented/.test(errors) && !/bad2.*c\.css/.test(errors) && !/bad\.html: third-party stylesheet/.test(errors));
    w('e.css', '@import"https://cdn.example/x.css";@import/**/url(https://cdn.example/y.css);@import"gone2.css";');
    w('bad3.html', '<link rel="stylesheet" href="e.css">');
    const zero = checkBudget(root).errors.join('\n');
    assert.match(zero, /bad3\.html: third-party CSS import "https:\/\/cdn.example\/x.css" in e.css/);
    assert.match(zero, /bad3\.html: third-party CSS import "https:\/\/cdn.example\/y.css" in e.css/);
    assert.match(zero, /bad3\.html: missing CSS import "gone2.css"/);
    w('huge.css', '@import"big.css";');
    w('big.css', 'x'.repeat(41 * 1024));
    w('huge.html', '<link rel="stylesheet" href="huge.css">');
    assert.match(checkBudget(root).errors.join('\n'), /huge\.html: \d+ CSS bytes exceed/);
  });
});
