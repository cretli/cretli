// Fixture for run-unit-tests-runner.test.js: prints lines slowly, then checks its data dir is private.
import { writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
for (let i = 0; i < 5; i += 1) {
  console.log('fixture-a line ' + i);
  await new Promise((r) => setTimeout(r, 20));
}
const dir = process.env.CRETLI_DATA_DIR;
writeFileSync(path.join(dir, 'owner.txt'), 'a');
console.log('fixture-a data-dir ' + dir + ' files=' + readdirSync(dir).join(','));

