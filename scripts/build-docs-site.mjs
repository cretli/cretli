#!/usr/bin/env node
/**
 * Static documentation site generator: docs/user/*.md -> website/docs/*.html.
 *
 * Generation is a pure list "output file -> content" (generateOutputs) shared by
 * the writer and by --check, so every generated file gets drift detection.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js';
import yaml from 'js-yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSET_DIR = path.join(ROOT, 'scripts/docs-site');
const SITE_URL = 'https://cretli.com/docs/';
const SLUG_RE = /^[a-z0-9-]+$/;
const FRONT_KEYS = new Set(['title', 'description']);
const GENERATED_ROOT_FILES = /(\.html|^search-index\.json|^sitemap\.xml)$/;

/** @param {string} s */
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** @param {string} text */
function slugify(text) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '') || 'section';
}

/**
 * Remove HTML comments outside fenced blocks and inline code spans.
 * @param {string} body
 */
export function stripComments(body) {
  const lines = body.split('\n');
  const out = [];
  let chunk = [];
  let fence = null;
  const flush = () => {
    if (!chunk.length) return;
    out.push(chunk.join('\n').replace(/(`+)[\s\S]*?\1|<!--[\s\S]*?-->/g, (m) => (m.startsWith('<!--') ? '' : m)));
    chunk = [];
  };
  for (const line of lines) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      out.push(line);
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
    } else if (m) {
      flush();
      fence = m[1];
      out.push(line);
    } else {
      chunk.push(line);
    }
  }
  flush();
  return out.join('\n');
}

function makeMarkdown() {
  const md = new MarkdownIt({
    html: false,
    linkify: true,
    typographer: false,
    highlight(code, lang) {
      let inner = escapeHtml(code);
      if (lang && hljs.getLanguage(lang)) {
        inner = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
      }
      const cls = lang ? ` class="language-${escapeHtml(lang)}"` : '';
      return `<pre class="hljs"><code${cls}>${inner}</code></pre>`;
    },
  });
  const rules = md.renderer.rules;
  rules.table_open = () => '<div class="table-wrap"><table>\n';
  rules.table_close = () => '</table></div>\n';
  md.core.ruler.push('heading_ids', (state) => {
    const used = new Map();
    const headings = [];
    const { tokens } = state;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.type !== 'heading_open' || (t.tag !== 'h2' && t.tag !== 'h3')) continue;
      const inline = tokens[i + 1];
      const text = (inline.children || []).filter((c) => c.type === 'text' || c.type === 'code_inline').map((c) => c.content).join('');
      const base = slugify(text);
      const n = (used.get(base) || 0) + 1;
      used.set(base, n);
      const id = n === 1 ? base : `${base}-${n}`;
      t.attrSet('id', id);
      headings.push({ id, text, level: Number(t.tag[1]) });
    }
    state.env.headings = headings;
  });
  return md;
}

/**
 * @param {string} raw
 * @param {string} file
 * @param {string[]} errors
 */
function parseFrontMatter(raw, file, errors) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(raw.replace(/\r\n/g, '\n'));
  if (!m) {
    errors.push(`${file}: missing front matter`);
    return null;
  }
  let data;
  try {
    data = yaml.load(m[1], { schema: yaml.JSON_SCHEMA });
  } catch (err) {
    errors.push(`${file}: invalid front matter: ${err.message}`);
    return null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    errors.push(`${file}: front matter must be a mapping`);
    return null;
  }
  for (const key of Object.keys(data)) {
    if (!FRONT_KEYS.has(key)) errors.push(`${file}: unknown front matter key "${key}"`);
  }
  for (const key of FRONT_KEYS) {
    if (typeof data[key] !== 'string' || !data[key].trim()) errors.push(`${file}: front matter "${key}" must be a non-empty string`);
  }
  return { title: String(data.title || ''), description: String(data.description || ''), body: raw.replace(/\r\n/g, '\n').slice(m[0].length) };
}

const pageHref = (slug) => `${slug}.html`;
const canonical = (slug) => (slug === 'index' ? SITE_URL : `${SITE_URL}${slug}.html`);

function fill(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (all, key) => (key in values ? values[key] : all));
}

/**
 * Build the list of generated files (relative to outDir -> content) and errors.
 * @param {{ srcDir?: string, imgDir?: string }} [opts]
 */
export function generateOutputs({ srcDir = path.join(ROOT, 'docs/user'), imgDir = path.join(ROOT, 'website/docs/img') } = {}) {
  const errors = [];
  const outputs = new Map();
  const rel = (f) => path.join(path.basename(path.dirname(srcDir)) === 'docs' ? 'docs/user' : path.basename(srcDir), f);

  let nav = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(srcDir, '_nav.json'), 'utf8'));
    if (!parsed || !Array.isArray(parsed.pages)) throw new Error('"pages" must be an array');
    nav = parsed.pages;
  } catch (err) {
    errors.push(`${rel('_nav.json')}: ${err.message}`);
  }
  const files = fs.existsSync(srcDir) ? fs.readdirSync(srcDir).filter((f) => f.endsWith('.md')).sort() : [];
  const slugs = new Set();
  for (const f of files) {
    const slug = f.slice(0, -3);
    if (!SLUG_RE.test(slug)) errors.push(`${rel(f)}: invalid slug "${slug}" (use [a-z0-9-]+)`);
    else slugs.add(slug);
  }
  const seen = new Set();
  for (const slug of nav) {
    if (seen.has(slug)) errors.push(`${rel('_nav.json')}: duplicate entry "${slug}"`);
    seen.add(slug);
    if (!slugs.has(slug)) errors.push(`${rel('_nav.json')}: entry "${slug}" has no ${slug}.md`);
  }
  for (const slug of slugs) {
    if (!seen.has(slug)) errors.push(`${rel(`${slug}.md`)}: page is not listed in _nav.json`);
  }

  const md = makeMarkdown();
  const pages = [];
  for (const slug of nav.filter((s) => slugs.has(s) && !pages.some((p) => p.slug === s))) {
    const file = rel(`${slug}.md`);
    const fm = parseFrontMatter(fs.readFileSync(path.join(srcDir, `${slug}.md`), 'utf8'), file, errors);
    if (!fm) continue;
    const env = {};
    const tokens = md.parse(stripComments(fm.body), env);
    pages.push({ slug, file, title: fm.title, description: fm.description, tokens, headings: env.headings || [] });
  }
  const bySlug = new Map(pages.map((p) => [p.slug, p]));

  for (const page of pages) {
    const visit = (tokens) => {
      for (const t of tokens) {
        if (t.type === 'link_open') {
          const href = t.attrGet('href') || '';
          if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(href)) continue;
          const [target, hash] = href.split('#');
          if (!target) {
            if (hash && !page.headings.some((h) => h.id === hash)) errors.push(`${page.file}: broken anchor "#${hash}"`);
            continue;
          }
          const m = /^([a-z0-9-]+)\.md$/.exec(target);
          if (!m) {
            errors.push(`${page.file}: unsupported link "${href}" (link pages as slug.md)`);
            continue;
          }
          const dest = bySlug.get(m[1]);
          if (!dest) errors.push(`${page.file}: dead link to "${target}"`);
          else if (hash && !dest.headings.some((h) => h.id === hash)) errors.push(`${page.file}: broken anchor "${href}"`);
          else t.attrSet('href', pageHref(m[1]) + (hash ? `#${hash}` : ''));
        } else if (t.type === 'image') {
          const src = t.attrGet('src') || '';
          if (!/^img\/[^/]+$/.test(src) || !fs.existsSync(path.join(imgDir, src.slice(4)))) errors.push(`${page.file}: missing image "${src}"`);
        }
        if (t.children) visit(t.children);
      }
    };
    visit(page.tokens);
  }

  const template = fs.readFileSync(path.join(ASSET_DIR, 'template.html'), 'utf8');
  const navHtml = (current) => `    <ul>\n${pages
    .map((p) => `      <li><a href="${pageHref(p.slug)}"${p.slug === current ? ' aria-current="page"' : ''}>${escapeHtml(p.title)}</a></li>`)
    .join('\n')}\n    </ul>`;
  pages.forEach((page, i) => {
    const content = md.renderer.render(page.tokens, md.options, {});
    const toc = page.headings.length
      ? `    <p class="toc-title">On this page</p>\n    <ul>\n${page.headings
        .map((h) => `      <li${h.level === 3 ? ' class="toc-sub"' : ''}><a href="#${h.id}">${escapeHtml(h.text)}</a></li>`)
        .join('\n')}\n    </ul>`
      : '';
    const prev = pages[i - 1];
    const next = pages[i + 1];
    const prevNext = prev || next
      ? `    <nav class="prev-next" aria-label="Previous and next page">\n      ${prev ? `<a rel="prev" href="${pageHref(prev.slug)}">&larr; ${escapeHtml(prev.title)}</a>` : '<span></span>'}\n      ${next ? `<a rel="next" href="${pageHref(next.slug)}">${escapeHtml(next.title)} &rarr;</a>` : '<span></span>'}\n    </nav>`
      : '';
    outputs.set(pageHref(page.slug), fill(template, {
      title: escapeHtml(page.title),
      description: escapeHtml(page.description),
      canonical: escapeHtml(canonical(page.slug)),
      nav: navHtml(page.slug),
      toc,
      content: content.trimEnd(),
      prevNext,
    }));
  });
  outputs.set('assets/docs.css', fs.readFileSync(path.join(ASSET_DIR, 'docs.css'), 'utf8'));
  outputs.set('assets/docs.js', fs.readFileSync(path.join(ASSET_DIR, 'docs.js'), 'utf8'));
  outputs.set('search-index.json', `${JSON.stringify(pages.map((p) => ({
    slug: p.slug,
    title: p.title,
    description: p.description,
    headings: p.headings.map((h) => ({ id: h.id, text: h.text })),
  })), null, 2)}\n`);
  outputs.set('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages
    .map((p) => `  <url><loc>${escapeHtml(canonical(p.slug))}</loc></url>\n`).join('')}</urlset>\n`);
  return { outputs, errors, pages: pages.map((p) => p.slug) };
}

/** Generated files currently present in outDir (img/ is never listed). */
function listGenerated(outDir) {
  const found = [];
  if (!fs.existsSync(outDir)) return found;
  for (const e of fs.readdirSync(outDir, { withFileTypes: true })) {
    if (e.isFile() && GENERATED_ROOT_FILES.test(e.name)) found.push(e.name);
  }
  const assets = path.join(outDir, 'assets');
  if (fs.existsSync(assets)) for (const e of fs.readdirSync(assets, { withFileTypes: true })) if (e.isFile()) found.push(`assets/${e.name}`);
  return found.sort();
}

/**
 * @param {{ srcDir?: string, outDir?: string, imgDir?: string, write?: boolean }} [opts]
 * @returns {{ pages: string[], errors: string[], drift: string[] }}
 */
export function buildDocsSite({ srcDir, outDir = path.join(ROOT, 'website/docs'), imgDir = path.join(outDir, 'img'), write = true } = {}) {
  const { outputs, errors, pages } = generateOutputs({ srcDir, imgDir });
  const drift = [];
  if (errors.length) return { pages, errors, drift };
  for (const [name, content] of outputs) {
    const file = path.join(outDir, name);
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== content) drift.push(name);
  }
  const stale = listGenerated(outDir).filter((n) => !outputs.has(n));
  drift.push(...stale);
  if (write) {
    for (const [name, content] of outputs) {
      const file = path.join(outDir, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
    for (const name of stale) fs.rmSync(path.join(outDir, name));
  }
  return { pages, errors, drift: drift.sort() };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  const { pages, errors, drift } = buildDocsSite({ write: !check });
  if (errors.length) {
    for (const e of errors) console.error(e);
    process.exit(1);
  }
  if (check && drift.length) {
    console.error(`Generated docs are out of date:\n${drift.map((d) => `  ${d}`).join('\n')}\nRun: npm run docs:build`);
    process.exit(1);
  }
  console.log(check ? `docs up to date (${pages.length} pages)` : `built ${pages.length} page(s) into website/docs`);
}
