/** Run ESLint on explicit workspace files without fixes, cache writes, or CLI flags. */
import { ESLint } from 'eslint';
import { resolveReviewLintFiles } from '../lib/sdk/sdk-review-lint.js';

const files = resolveReviewLintFiles(process.argv.slice(2), process.cwd());
if (!files) {
  console.error('Allowed: node scripts/review-lint.js <workspace-source-file> [...files]');
  process.exitCode = 1;
} else {
  const eslint = new ESLint({ fix: false, cache: false });
  const results = await eslint.lintFiles(files);
  const formatter = await eslint.loadFormatter('stylish');
  const output = formatter.format(results);
  if (output) console.log(output);
  process.exitCode = results.some((result) => result.errorCount > 0) ? 1 : 0;
}
