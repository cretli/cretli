// Fixture for run-unit-tests-runner.test.js: marks itself as running, records how many peers are
// running at the same time, holds briefly so overlap is observable, then unmarks itself.
import { appendFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const markDir = process.env.RUNNER_FIXTURE_MARK_DIR;
const marker = path.join(markDir, 'running-hold3');
writeFileSync(marker, '');
const running = readdirSync(markDir).filter((name) => name.startsWith('running-')).length;
appendFileSync(path.join(markDir, 'concurrency.log'), running + '\n');
writeFileSync(path.join(process.env.CRETLI_DATA_DIR, 'scratch.txt'), 'hold3');
console.log('DATA_DIR=' + process.env.CRETLI_DATA_DIR);
await new Promise((resolve) => setTimeout(resolve, 400));
unlinkSync(marker);
