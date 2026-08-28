import assert from 'node:assert/strict';
import {
  splitForUtterances,
  takeCompleteSentences,
  toSpeakableText,
} from '../app_front/features/voice/speakableText.js';

const inputWithCode = [
  '## Gotowe',
  '',
  'Poprawiłem `server.js` — teraz działa.',
  '',
  '```js',
  'const x = 1;',
  'console.log(x);',
  '```',
  '',
  'Szczegóły w [dokumentacji](https://example.com/docs).',
].join('\n');
const actualWithCode = toSpeakableText(inputWithCode);
assert.ok(!actualWithCode.includes('console.log'), 'code blocks must not be read aloud');
assert.ok(!actualWithCode.includes('server.js'), 'file names must not be spelled out');
assert.ok(!actualWithCode.includes('https://'), 'URLs must not be read aloud');
assert.ok(actualWithCode.includes('Gotowe'), 'headings keep their prose');
assert.ok(actualWithCode.includes('dokumentacji'), 'link text stays, the target goes');

const inputTitleJson = 'Zrobione.\n{"title": "Cretli: warstwa glosowa"}';
assert.equal(toSpeakableText(inputTitleJson), 'Zrobione.');

const inputTable = ['Wyniki:', '', '| a | b |', '| --- | --- |', '| 1 | 2 |'].join('\n');
assert.equal(toSpeakableText(inputTable), 'Wyniki:');

const inputList = ['- pierwszy punkt', '- drugi punkt'].join('\n');
assert.equal(toSpeakableText(inputList), 'pierwszy punkt\ndrugi punkt');

const inputEmphasis = 'To jest **ważne** i *pilne*.';
assert.equal(toSpeakableText(inputEmphasis), 'To jest ważne i pilne.');

const partial = takeCompleteSentences('Pierwsze zdanie. Drugie jeszcze niedo');
assert.equal(partial.ready, 'Pierwsze zdanie.');
assert.equal('Pierwsze zdanie. Drugie jeszcze niedo'.slice(partial.consumed), 'Drugie jeszcze niedo');

const noBoundary = takeCompleteSentences('Krótki fragment bez kropki');
assert.equal(noBoundary.ready, '');
assert.equal(noBoundary.consumed, 0);

const forced = takeCompleteSentences('Krótki fragment bez kropki', { force: true });
assert.equal(forced.ready, 'Krótki fragment bez kropki');

const decimalsStayTogether = takeCompleteSentences('Wersja 3.5 jest nowsza');
assert.equal(decimalsStayTogether.ready, '', 'a decimal point is not a sentence boundary');

const pieces = splitForUtterances(`${'Zdanie testowe. '.repeat(40)}`);
assert.ok(pieces.length > 1, 'long passages are split into several utterances');
assert.ok(pieces.every((piece) => piece.length <= 220), 'no utterance exceeds the engine limit');

const singlePiece = splitForUtterances('Krótkie zdanie.');
assert.deepEqual(singlePiece, ['Krótkie zdanie.']);

console.log('voice-speakable-text: OK');
