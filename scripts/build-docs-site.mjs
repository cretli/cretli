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
import { checkLinks, checkBudget } from './docs-site/check-site.mjs';

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

/**
 * Read pixel dimensions from a PNG header so rendered images reserve their space (no layout shift).
 * @param {string} file
 */
function pngSize(file) {
  try {
    const buf = fs.readFileSync(file);
    if (buf.length < 24 || buf.toString('latin1', 1, 4) !== 'PNG') return null;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  } catch {
    return null;
  }
}

const pageHref = (slug) => `${slug}.html`;
const canonical = (lang, slug) => `${SITE_URL}${lang}/${slug}.html`;

function fill(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (all, key) => (key in values ? values[key] : all));
}

/**
 * Build the list of generated files (relative to outDir -> content) and errors.
 * @param {{ srcDir: string, imgDir: string, lang: string }} opts
 */
function generateLanguage({ srcDir, imgDir, lang }) {
  const errors = [];
  const outputs = new Map();
  const rel = (f) => path.join(path.basename(path.dirname(srcDir)) === 'docs' ? 'docs/user' : path.basename(srcDir), f);

  let nav = [];
  let sections = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(srcDir, '_nav.json'), 'utf8'));
    if (!parsed || !Array.isArray(parsed.sections)) throw new Error('"sections" must be an array');
    sections = parsed.sections;
    const ids = new Set();
    for (const section of sections) {
      if (!section || !SLUG_RE.test(section.id) || ids.has(section.id) || typeof section.title !== 'string' || !section.title.trim() || !Array.isArray(section.pages) || section.pages.some((slug) => typeof slug !== 'string')) throw new Error('invalid or duplicate section');
      ids.add(section.id);
    }
    nav = sections.flatMap((section) => section.pages);
  } catch (err) {
    errors.push(`${rel('_nav.json')}: ${err.message}`);
    sections = [];
    nav = [];
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
    const raw = fs.readFileSync(path.join(srcDir, `${slug}.md`), 'utf8');
    const sources = [...raw.matchAll(/<!-- sources: ([^>]+) -->/g)];
    if (!sources.length) errors.push(`${file}: missing sources comment`);
    for (const match of sources) for (const source of match[1].split(',').map((value) => value.trim())) {
      const resolved = path.resolve(ROOT, source);
      if (!source || !resolved.startsWith(ROOT + path.sep) || !fs.existsSync(resolved)) errors.push(`${file}: missing source "${source}"`);
    }
    const fm = parseFrontMatter(raw, file, errors);
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
          else {
            t.attrSet('src', `../${src}`);
            const size = pngSize(path.join(imgDir, src.slice(4)));
            if (size) {
              t.attrSet('width', String(size.width));
              t.attrSet('height', String(size.height));
            }
            t.attrSet('loading', 'lazy');
          }
        }
        if (t.children) visit(t.children);
      }
    };
    visit(page.tokens);
  }

  const template = fs.readFileSync(path.join(ASSET_DIR, 'template.html'), 'utf8');
  const navHtml = (current) => sections.map((section) => `<section class="nav-section"><h2>${escapeHtml(section.title)}</h2><ul>${section.pages.map((slug) => {
    const p = bySlug.get(slug);
    return p ? `<li><a href="${pageHref(slug)}"${slug === current ? ' aria-current="page"' : ''}>${escapeHtml(p.title)}</a></li>` : '';
  }).join('')}</ul></section>`).join('\n');
  pages.forEach((page, i) => {
    const content = md.renderer.render(page.tokens, md.options, {});
    const toc = page.headings.length
      ? `    <p class="toc-title">${labels[lang].onPage}</p>\n    <ul>\n${page.headings
        .map((h) => `      <li${h.level === 3 ? ' class="toc-sub"' : ''}><a href="#${h.id}">${escapeHtml(h.text)}</a></li>`)
        .join('\n')}\n    </ul>`
      : '';
    const prev = pages[i - 1];
    const next = pages[i + 1];
    const prevNext = prev || next
      ? `    <nav class="prev-next" aria-label="${labels[lang].pagination}">\n      ${prev ? `<a rel="prev" href="${pageHref(prev.slug)}">&larr; ${escapeHtml(prev.title)}</a>` : '<span></span>'}\n      ${next ? `<a rel="next" href="${pageHref(next.slug)}">${escapeHtml(next.title)} &rarr;</a>` : '<span></span>'}\n    </nav>`
      : '';
    outputs.set(pageHref(page.slug), fill(template, {
      ...labels[lang],
      lang,
      homeHref: lang === 'en' ? '/' : '/pl/',
      otherLang: lang === 'en' ? 'pl' : 'en',
      alternates: alternates((language) => canonical(language, page.slug)),
      languageHref: `../${lang === 'en' ? 'pl' : 'en'}/${pageHref(page.slug)}`,
      languageName: lang === 'en' ? 'Polski' : 'English',
      title: escapeHtml(page.title),
      description: escapeHtml(page.description),
      canonical: escapeHtml(canonical(lang, page.slug)),
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
    .map((p) => `  <url><loc>${escapeHtml(canonical(lang, p.slug))}</loc></url>\n`).join('')}</urlset>\n`);
  return { outputs, errors, pages: pages.map((p) => p.slug), sections: sections.map((s) => s.id) };
}

function landing(lang) {
  const pl = lang === 'pl';
  const text = (en, polish) => pl ? polish : en;
  const title = text('Cretli — your agents, your machine', 'Cretli — Twoi agenci, Twój komputer');
  const description = text('A self-hosted terminal and agent workspace, shared live across your devices.', 'Samodzielnie hostowany terminal i obszar pracy agentów, dostępny na Twoich urządzeniach.');
  const url = pl ? 'https://cretli.com/pl/' : 'https://cretli.com/';
  const docs = `/docs/${lang}/`;
  const features = [
    [text('Terminal, anywhere', 'Terminal pod ręką'), text('Run commands on your own machine from a desktop or phone.', 'Wykonuj polecenia na swoim komputerze z przeglądarki lub telefonu.')],
    [text('Choose your agent', 'Wybierz agenta'), text('Connect a supported harness and use the models that suit your work.', 'Podłącz obsługiwany silnik i wybierz modele odpowiednie do zadania.')],
    [text('Plan and review', 'Planuj i sprawdzaj'), text('Keep tasks, plans, implementation and independent reviews together.', 'Trzymaj zadania, plany, implementację i niezależne przeglądy w jednym miejscu.')],
    [text('One live session', 'Jedna sesja na żywo'), text('Move between devices while keeping the same terminal and conversation.', 'Zmieniaj urządzenia, zachowując ten sam terminal i rozmowę.')],
    [text('Files and browser', 'Pliki i przeglądarka'), text('Inspect workspace files and preview your app in the built-in browser.', 'Przeglądaj pliki projektu i sprawdzaj aplikację we wbudowanej przeglądarce.')],
    [text('Stay in control', 'Zachowaj kontrolę'), text('Self-hosted and localhost by default. You choose how to enable trusted remote access.', 'Własny serwer i domyślny dostęp lokalny. Ty decydujesz o dostępie zdalnym.')],
  ];
  const flow = [text('Your browser', 'Przeglądarka'), text('Your Cretli server', 'Serwer Cretli'), text('Workspace + agents', 'Projekt i agenci')];
  const template = fs.readFileSync(path.join(ASSET_DIR, 'landing.html'), 'utf8');
  return fill(template, {
    ...labels[lang], lang, title, description, canonical: url,
    alternates: alternates((language) => language === 'en' ? 'https://cretli.com/' : 'https://cretli.com/pl/'),
    docsLabel: labels[lang].docs,
    languageHref: pl ? '/' : '/pl/', languageName: pl ? 'English' : 'Polski', otherLang: pl ? 'en' : 'pl', docs,
    headline: text('Your coding workspace. On every screen.', 'Twój warsztat programisty. Na każdym ekranie.'),
    eyebrow: text('Open source · self-hosted', 'Otwarty kod · własny serwer'),
    install: text('Get started', 'Zacznij pracę'),
    featuresTitle: text('Built for work that keeps moving', 'Praca, która nie stoi w miejscu'),
    features: features.map(([heading, body]) => `<article class="feature"><h3>${heading}</h3><p>${body}</p></article>`).join('\n'),
    howTitle: text('How it works', 'Jak to działa'),
    diagram: `<svg class="flow" viewBox="0 0 900 130" role="img" aria-label="${flow.join(' → ')}"><title>${flow.join(' → ')}</title>${flow.map((label, i) => `<rect x="${i * 310 + 5}" y="20" width="265" height="80" rx="12"/><text x="${i * 310 + 137}" y="67" text-anchor="middle">${label}</text>`).join('')}<path d="M275 60h35m-10-7 10 7-10 7M585 60h35m-10-7 10 7-10 7"/></svg>`,
    screensTitle: text('A familiar view, wherever you are', 'Znajomy widok, gdziekolwiek jesteś'),
    screenshots: ['chat-desktop.png', 'todo-tree.png', 'watcher-panel.png'].map((name, i) => `<figure><img src="/docs/img/${name}" width="1280" height="720" loading="lazy" alt="${[text('Agent chat', 'Czat agenta'), text('Task tree', 'Drzewo zadań'), 'Watcher'][i]}"></figure>`).join(''),
    startTitle: text('Start on your own machine', 'Uruchom na swoim komputerze'),
    installNote: text('Run this in a terminal with Git and Node.js 22.18 or newer. Then open https://localhost:3011 and complete setup.', 'Uruchom w terminalu z Git i Node.js 22.18 lub nowszym. Otwórz https://localhost:3011 i dokończ konfigurację.'),
    security: text('Cretli provides a full shell. Keep the default local bind; configure HTTPS and authentication before enabling trusted LAN access.', 'Cretli udostępnia pełny terminal. Zachowaj domyślny dostęp lokalny; przed udostępnieniem w zaufanej sieci LAN skonfiguruj HTTPS i uwierzytelnianie.'),
  });
}

const labels = {
  en: { skip: 'Skip to content', search: 'Search docs', theme: 'Theme', onPage: 'On this page', docs: 'Documentation', home: 'Home', pagination: 'Previous and next page' },
  pl: { skip: 'Przejdź do treści', search: 'Szukaj w dokumentacji', theme: 'Motyw', onPage: 'Na tej stronie', docs: 'Dokumentacja', home: 'Strona główna', pagination: 'Poprzednia i następna strona' },
};
const alternates = (url) => ['en', 'pl', 'x-default'].map((lang) => `<link rel="alternate" hreflang="${lang}" href="${url(lang === 'x-default' ? 'en' : lang)}">`).join('\n');

export function generateOutputs({ srcDir = path.join(ROOT, 'docs/user'), imgDir = path.join(ROOT, 'website/docs/img') } = {}) {
  const outputs = new Map();
  const errors = [];
  const languages = ['en', 'pl'].map((lang) => generateLanguage({ srcDir: path.join(srcDir, lang), imgDir, lang }));
  if (JSON.stringify([...languages[0].pages].sort()) !== JSON.stringify([...languages[1].pages].sort())) errors.push('Language slug parity mismatch');
  if (JSON.stringify(languages[0].sections) !== JSON.stringify(languages[1].sections)) errors.push('Language section order parity mismatch');
  for (const [i, lang] of ['en', 'pl'].entries()) {
    const result = languages[i];
    errors.push(...result.errors);
    for (const [name, content] of result.outputs) if (name !== 'sitemap.xml' && !name.startsWith('assets/')) outputs.set(`docs/${lang}/${name}`, content);
    outputs.set(lang === 'en' ? 'index.html' : 'pl/index.html', landing(lang));
  }
  // Keep the published documentation entry URL useful after the language migration.
  if (outputs.has('docs/en/index.html')) {
    const defaultPage = outputs.get('docs/en/index.html')
      .replace('href="../assets/docs.css"', 'href="assets/docs.css"')
      .replace('src="../assets/docs.js"', 'src="assets/docs.js"')
      .replace('class="search"', 'class="search-redirect"')
      .replace(/href="([a-z0-9-]+\.html(?:#[^"]*)?)"/g, 'href="en/$1"')
      .replace('href="../pl/index.html"', 'href="pl/index.html"')
      .replace('<meta charset="utf-8">', '<meta charset="utf-8">\n<meta http-equiv="refresh" content="0;url=en/index.html">');
    outputs.set('docs/index.html', defaultPage);
  }
  for (const asset of ['docs.css', 'docs.js']) outputs.set(`docs/assets/${asset}`, fs.readFileSync(path.join(ASSET_DIR, asset), 'utf8'));
  const urls = ['https://cretli.com/', 'https://cretli.com/pl/', 'https://cretli.com/docs/', ...languages.flatMap((result, i) => result.pages.map((slug) => canonical(['en', 'pl'][i], slug)))];
  outputs.set('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((url) => `  <url><loc>${url}</loc></url>`).join('\n')}\n</urlset>\n`);
  return { outputs, errors, pages: languages[0].pages };
}

/** Only generator-owned directories are traversed; screenshots and deployment files are preserved. */
function listGenerated(outDir) {
  const found = [];
  const scan = (dir, prefix = '') => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const name = prefix + e.name;
      if (e.isFile() && (GENERATED_ROOT_FILES.test(e.name) || prefix.endsWith('assets/'))) found.push(name);
      if (e.isDirectory() && ['docs', 'en', 'pl', 'assets'].includes(e.name)) scan(path.join(dir, e.name), name + '/');
    }
  };
  scan(outDir);
  return found.sort();
}

/**
 * @param {{ srcDir?: string, outDir?: string, imgDir?: string, write?: boolean }} [opts]
 * @returns {{ pages: string[], errors: string[], drift: string[] }}
 */
export function buildDocsSite({ srcDir, outDir = path.join(ROOT, 'website'), imgDir = path.join(outDir, 'docs/img'), write = true } = {}) {
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
  if (check) {
    const site = path.join(ROOT, 'website');
    const problems = [...checkLinks(site).errors, ...checkBudget(site).errors];
    if (problems.length) {
      for (const e of problems) console.error(e);
      process.exit(1);
    }
  }
  console.log(check ? `docs up to date (${pages.length} pages), links and budgets ok` : `built ${pages.length} page(s) per language and landing pages into website`);
}
