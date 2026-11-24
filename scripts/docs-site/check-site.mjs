/**
 * Static quality checks for the generated site: internal link/image resolution
 * and a per-page performance budget. Pure functions over a directory, so the
 * docs:check run and the tests share one implementation. No network, no browser.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Budgets per page, in bytes (uncompressed). Scripts mirror the earlier 30 KiB limit. */
export const BUDGET = { js: 30 * 1024, css: 40 * 1024 };
const SITE_ORIGIN = 'https://cretli.com';

/** @param {string} dir */
function listHtml(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'deploy') walk(p); } else if (e.name.endsWith('.html')) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

const attr = (tag, name) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const isExternal = (u) => /^[a-z][a-z0-9+.-]*:|^\/\//i.test(u);
const SITE_HOST = 'cretli.com';

/**
 * Same-origin absolute URLs (https://cretli.com/...) are internal: rewrite them to a root-relative
 * reference so they get the same file and anchor validation. Returns the input otherwise.
 * @param {string} ref
 */
const normalizeRef = (ref) => {
  if (!/^(?:https?:)?\/\//i.test(ref)) return ref;
  let url;
  try { url = new URL(ref, `https://${SITE_HOST}`); } catch { return ref; }
  // URL normalizes default ports (":443" / ":80" become ""), so a plain host comparison is enough.
  if (url.hostname !== SITE_HOST || url.port !== '' || !/^https?:$/.test(url.protocol)) return ref;
  return `${url.pathname}${url.search}${url.hash}`;
};

/**
 * Resolve a reference found in `fromFile` to a file under `root`, or null when it escapes the root.
 * @param {string} root @param {string} fromFile @param {string} ref
 */
function resolveRef(root, fromFile, ref) {
  const clean = decode(ref).split('#')[0].split('?')[0];
  let target = clean.startsWith('/') ? path.join(root, clean) : path.resolve(path.dirname(fromFile), clean || path.basename(fromFile));
  if (!clean) target = fromFile;
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) target = path.join(target, 'index.html');
  return target;
}

/**
 * @param {string} root site root (the website/ directory)
 * @returns {{ errors: string[], pages: number, links: number }}
 */
export function checkLinks(root) {
  const errors = [];
  const ids = new Map();
  const idsOf = (file) => {
    if (!ids.has(file)) ids.set(file, new Set([...fs.readFileSync(file, 'utf8').matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])));
    return ids.get(file);
  };
  const pages = listHtml(root);
  let links = 0;
  for (const file of pages) {
    const rel = path.relative(root, file);
    const html = fs.readFileSync(file, 'utf8');
    const refs = [];
    for (const m of html.matchAll(/<(a|link|img|script|source)\b[^>]*>/g)) {
      const tag = m[0];
      const value = m[1] === 'a' || m[1] === 'link' ? attr(tag, 'href') : attr(tag, 'src');
      if (value !== undefined) refs.push([m[1], value]);
    }
    for (const [kind, rawRef] of refs) {
      const ref = normalizeRef(rawRef);
      if (!ref || isExternal(ref) || (kind === 'link' && /^#/.test(ref))) continue;
      links += 1;
      const target = resolveRef(root, file, ref);
      if (!target || !fs.existsSync(target)) { errors.push(`${rel}: broken ${kind === 'img' ? 'image' : 'link'} "${rawRef}"`); continue; }
      // The fragment starts at the first '#', independent of any query string before it.
      const decoded = decode(ref);
      const hashAt = decoded.indexOf('#');
      const hash = hashAt === -1 ? undefined : decoded.slice(hashAt + 1);
      if (hash && target.endsWith('.html') && !idsOf(target).has(hash)) errors.push(`${rel}: broken anchor "${rawRef}"`);
    }
  }
  const sitemap = path.join(root, 'sitemap.xml');
  if (fs.existsSync(sitemap)) {
    for (const m of fs.readFileSync(sitemap, 'utf8').matchAll(/<loc>([^<]+)<\/loc>/g)) {
      if (!m[1].startsWith(`${SITE_ORIGIN}/`)) { errors.push(`sitemap.xml: unexpected origin "${m[1]}"`); continue; }
      const target = resolveRef(root, path.join(root, 'sitemap.xml'), m[1].slice(SITE_ORIGIN.length));
      if (!target || !fs.existsSync(target)) errors.push(`sitemap.xml: dead URL "${m[1]}"`);
    }
  }
  return { errors, pages: pages.length, links };
}

/**
 * @param {string} root
 * @returns {{ errors: string[], pages: number, stats: Array<{ page: string, js: number, css: number }> }}
 */
export function checkBudget(root) {
  const errors = [];
  const stats = [];
  const pages = listHtml(root);
  for (const file of pages) {
    const rel = path.relative(root, file);
    const html = fs.readFileSync(file, 'utf8');
    let js = 0;
    let css = 0;
    const size = (ref) => {
      const target = resolveRef(root, file, ref);
      return target && fs.existsSync(target) ? fs.statSync(target).size : 0;
    };
    const seenCss = new Set();
    /**
     * Bytes of a stylesheet plus everything it @imports. Imports are render-blocking too, so
     * external ones are rejected; the seen set dedupes and breaks import cycles.
     * @param {string} text @param {string} base file the text lives in (for relative imports)
     * @param {string} label where to report problems
     */
    const importedCss = (text, base, label) => {
      let bytes = 0;
      // A comment is a token separator in CSS, so replace it with a space instead of removing it.
      const bare = text.replace(/\/\*[\s\S]*?\*\//g, ' ');
      for (const m of bare.matchAll(/@import\s*(?:url\(\s*)?(?:"([^"]*)"|'([^']*)'|([^\s)"';]+))/gi)) {
        const raw = (m[1] ?? m[2] ?? m[3] ?? '').trim();
        const ref = normalizeRef(raw);
        if (!raw || isExternal(ref)) { errors.push(`${rel}: third-party CSS import "${raw}" in ${label}`); continue; }
        const target = resolveRef(root, base, ref);
        if (!target || !fs.existsSync(target)) { errors.push(`${rel}: missing CSS import "${raw}" in ${label}`); continue; }
        if (seenCss.has(target)) continue;
        seenCss.add(target);
        const body = fs.readFileSync(target, 'utf8');
        bytes += Buffer.byteLength(body) + importedCss(body, target, path.relative(root, target));
      }
      return bytes;
    };
    for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
      const src = attr(m[1], 'src') === undefined ? undefined : normalizeRef(attr(m[1], 'src'));
      if (src === undefined) { js += Buffer.byteLength(m[2]); continue; }
      if (isExternal(src)) errors.push(`${rel}: third-party script "${src}"`);
      else js += size(src);
    }
    for (const m of html.matchAll(/<link\b[^>]*>/g)) {
      const href = normalizeRef(attr(m[0], 'href') ?? '') || undefined;
      const relAttr = attr(m[0], 'rel') || '';
      if (href === undefined || !/stylesheet|preload|preconnect|prefetch|modulepreload/.test(relAttr)) continue;
      if (isExternal(href)) errors.push(`${rel}: third-party ${relAttr} "${href}"`);
      else if (/stylesheet/.test(relAttr)) {
        const target = resolveRef(root, file, href);
        if (!target || !fs.existsSync(target)) { errors.push(`${rel}: missing stylesheet "${href}"`); continue; }
        if (seenCss.has(target)) continue;
        seenCss.add(target);
        const body = fs.readFileSync(target, 'utf8');
        css += Buffer.byteLength(body) + importedCss(body, target, path.relative(root, target));
      }
    }
    for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)) css += Buffer.byteLength(m[1]) + importedCss(m[1], file, 'inline <style>');
    for (const m of html.matchAll(/<img\b[^>]*>/g)) {
      const tag = m[0];
      const src = normalizeRef(attr(tag, 'src') || '(no src)');
      if (attr(tag, 'alt') === undefined) errors.push(`${rel}: image without alt "${src}"`);
      if (!/^\d+$/.test(attr(tag, 'width') || '') || !/^\d+$/.test(attr(tag, 'height') || '')) errors.push(`${rel}: image without width/height "${src}"`);
      if (isExternal(src)) errors.push(`${rel}: third-party image "${src}"`);
    }
    if (js > BUDGET.js) errors.push(`${rel}: ${js} JS bytes exceed ${BUDGET.js}`);
    if (css > BUDGET.css) errors.push(`${rel}: ${css} CSS bytes exceed ${BUDGET.css}`);
    stats.push({ page: rel, js, css });
  }
  return { errors, pages: pages.length, stats };
}
