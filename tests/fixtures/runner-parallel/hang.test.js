// Fixture for run-unit-tests-runner.test.js: never exits on its own, so the runner's per-file timeout must kill it.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
writeFileSync(path.join(process.env.CRETLI_DATA_DIR, 'scratch.txt'), 'hang');
console.log('DATA_DIR=' + process.env.CRETLI_DATA_DIR);
setInterval(() => {}, 1000);
