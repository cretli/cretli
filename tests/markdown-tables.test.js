import test from 'node:test';
import assert from 'node:assert/strict';
import MarkdownIt from 'markdown-it';
import { decorateMarkdownTables, repairLooseTableRows } from '../app_front/lib/render-markdown.js';

const source = [
  '| Harness | Teraz | Werdykt |',
  '|---|---|---|',
  '| Codex | 0.160.0 | Aktualne |',
  '| OpenCode bez kresek w srodku |',
].join('\n');

test('markdown tables get a scroll wrapper and column labels', () => {
  const md = decorateMarkdownTables(new MarkdownIt({ html: false, breaks: true }));
  const html = md.render(source);
  assert.match(html, /^<div class="sdk-rich-table-scroll"><table>/);
  assert.match(html, /<\/table>\s*<\/div>\s*$/);
  assert.match(html, /<th>Harness<\/th>/);
  assert.match(html, /<td data-label="Harness">Codex<\/td>/);
  assert.match(html, /<td data-label="Teraz">0\.160\.0<\/td>/);
  assert.match(html, /<td data-label="Werdykt">Aktualne<\/td>/);
  assert.match(html, /<td data-label="Harness">OpenCode bez kresek w srodku<\/td>/);
  assert.equal(decorateMarkdownTables(md), md);
  assert.equal(md.render(source).match(/sdk-rich-table-scroll/g).length, 1);
});

test('glued table rows get the missing pipes back', () => {
  const broken = [
    '| Harness | Teraz | Najnowsze | Werdykt |',
    '|---|---|---|---|',
    '| OpenCode1.18.26 (1 września)1.18.34 (dziś) Miesiąc poprawek. Modele biorą się z serwera OpenCode. |',
    '| DeepSeek |0.1.2-alpha.5, przypięte na sztywno (2 września) `latest` to0.2.0-rc.2 | Nie ruszać bez decyzji. |',
    '| CodeBuddy | 0.1.30 (17 stycznia) | 0.3.270 (dziś) | Jedyny duży odstęp. |',
  ].join('\n');
  const repaired = repairLooseTableRows(broken);
  assert.match(repaired, /\| OpenCode \| 1\.18\.26 \(1 września\) \| 1\.18\.34 \(dziś\) \| Miesiąc poprawek/);
  assert.match(repaired, /\| DeepSeek \| 0\.1\.2-alpha\.5, przypięte na sztywno \(2 września\) \| `latest` to0\.2\.0-rc\.2 \| Nie ruszać bez decyzji\. \|/);
  assert.match(repaired, /\| CodeBuddy \| 0\.1\.30 \(17 stycznia\) \| 0\.3\.270 \(dziś\) \| Jedyny duży odstęp\. \|/);
  const md = decorateMarkdownTables(new MarkdownIt({ html: false, breaks: true }));
  const html = md.render(repaired);
  assert.match(html, /<td data-label="Harness">OpenCode<\/td>/);
  assert.match(html, /<td data-label="Najnowsze">1\.18\.34 \(dziś\)<\/td>/);
  assert.match(html, /<td data-label="Werdykt">Nie ruszać bez decyzji\.<\/td>/);
});
