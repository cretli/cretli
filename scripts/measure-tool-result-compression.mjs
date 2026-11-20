import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { compressToolResult } from '../lib/tool-result-compression/index.js';

const fixtureDir = fileURLToPath(new URL('../tests/fixtures/tool-result-compression/', import.meta.url));
console.log('Estimated tokens (characters / 4, rounded up; not a tokenizer)');
for (const name of readdirSync(fixtureDir).sort()) {
  const original = readFileSync(join(fixtureDir, name), 'utf8');
  const compressed = compressToolResult(original, { enabled: true });
  console.log(`${name}: ${Math.ceil(original.length / 4)} -> ${Math.ceil(compressed.length / 4)}`);
}
