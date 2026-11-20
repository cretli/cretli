import fs from 'node:fs';
import path from 'node:path';

/**
 * Source text of one UI dictionary: the base file plus the per-harness packs
 * (app_front/i18n/harness/<id>.<lang>.js and the packs plugins ship as
 * harnesses/<id>/<id>.<lang>.js), for tests that scan the dictionary source for
 * a key instead of importing the merged object.
 *
 * @param {string} projectRoot
 * @param {string} lang
 * @returns {string}
 */
export function readI18nSource(projectRoot, lang) {
  const i18nDir = path.join(projectRoot, 'app_front/i18n');
  const packDir = path.join(i18nDir, 'harness');
  const packs = fs.readdirSync(packDir)
    .filter((name) => name.endsWith(`.${lang}.js`) && !name.startsWith('packs.'))
    .sort()
    .map((name) => fs.readFileSync(path.join(packDir, name), 'utf8'));
  const pluginRoot = path.join(projectRoot, 'harnesses');
  const pluginPacks = fs.readdirSync(pluginRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(pluginRoot, entry.name, `${entry.name}.${lang}.js`)))
    .map((entry) => fs.readFileSync(path.join(pluginRoot, entry.name, `${entry.name}.${lang}.js`), 'utf8'));
  return [fs.readFileSync(path.join(i18nDir, `${lang}.js`), 'utf8'), ...packs, ...pluginPacks].join('\n');
}
