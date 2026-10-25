import assert from 'node:assert/strict';
import {
  TODO_CHANGELOG_EXCERPT_LEN,
  buildChangelogExcerpt,
  stripTitleJsonTrailer,
} from '../lib/todo-changelog-text.js';

let failed = 0;

function runCase(name, fn) {
  try {
    fn();
    console.log('OK:', name);
  } catch (err) {
    failed += 1;
    console.error('FAIL:', name);
    console.error(err && err.stack ? err.stack : String(err));
  }
}

runCase('stripTitleJsonTrailer: empty', () => {
  assert.equal(stripTitleJsonTrailer(''), '');
  assert.equal(stripTitleJsonTrailer(null), '');
});

runCase('stripTitleJsonTrailer: removes finish-summary JSON', () => {
  const inputText = 'Implementation led the agent after the chat switch.\n{"title": "Updated todo card UI"}';
  const actualText = stripTitleJsonTrailer(inputText);
  assert.equal(actualText, 'Implementation led the agent after the chat switch.');
  assert.equal(actualText.includes('"title"'), false);
});

runCase('stripTitleJsonTrailer: removes fenced title JSON', () => {
  const inputText = [
    'Plan is ready.',
    '```json',
    '{"title": "Polish the Todo tab"}',
    '```',
  ].join('\n');
  const actualText = stripTitleJsonTrailer(inputText);
  assert.equal(actualText, 'Plan is ready.');
});

runCase('stripTitleJsonTrailer: removes leftover title JSON fragment', () => {
  const inputText = 'title": "Markdown preview and Todo collapsing"}';
  assert.equal(stripTitleJsonTrailer(inputText), '');
});

runCase('stripTitleJsonTrailer: keeps escaped quotes inside title', () => {
  const inputText = 'Done.\n{"title": "Fixed \\"ready\\" label"}';
  const actualText = stripTitleJsonTrailer(inputText);
  assert.equal(actualText, 'Done.');
});

runCase('buildChangelogExcerpt: prefers heading and truncates', () => {
  const inputText = `# Align toolbar heights\n\n${'step '.repeat(80)}\n{"title": "Align toolbar"}`;
  const actualExcerpt = buildChangelogExcerpt(inputText);
  assert.match(actualExcerpt, /Align toolbar heights/);
  assert.equal(actualExcerpt.includes('{"title"'), false);
  assert.ok(actualExcerpt.length <= TODO_CHANGELOG_EXCERPT_LEN);
  assert.ok(actualExcerpt.endsWith('…'));
});

runCase('buildChangelogExcerpt: short clean text stays intact', () => {
  const inputText = 'Updated server routes and todo card UI.';
  assert.equal(buildChangelogExcerpt(inputText), inputText);
});

process.exit(failed ? 1 : 0);
