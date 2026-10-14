import fs from 'node:fs';
import path from 'node:path';
import { createTempRepo, git } from './temp-git-repo.js';

// This fixture includes a checkpoint commit, so working-tree status alone cannot be the oracle.
export function seedScopeFixture(dir = createTempRepo().dir) {
  const initial = ['modify.txt', 'rename old.txt', 'copy source.txt', 'delete.txt', 'mode.sh', 'space name.txt', 'zażółć.txt', 'tab\tquote".txt', 'ambiguous b/name.txt'];
  fs.mkdirSync(path.join(dir, 'ambiguous b'), { recursive: true });
  for (const name of initial) fs.writeFileSync(path.join(dir, name), `unique ${name}\n`.repeat(8));
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'fixture base']);
  const baseCommit = git(dir, ['rev-parse', 'HEAD']).trim();
  return { dir, baseCommit };
}

export function applyScopeChanges(dir) {
  fs.writeFileSync(path.join(dir, 'checkpoint.txt'), 'committed task change\n');
  git(dir, ['mv', 'rename old.txt', 'rename new.txt']);
  fs.copyFileSync(path.join(dir, 'copy source.txt'), path.join(dir, 'copy target.txt'));
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'checkpoint']);
  fs.appendFileSync(path.join(dir, 'modify.txt'), 'task edit\n');
  fs.appendFileSync(path.join(dir, 'space name.txt'), 'space edit\n');
  fs.appendFileSync(path.join(dir, 'zażółć.txt'), 'unicode edit\n');
  fs.appendFileSync(path.join(dir, 'tab\tquote".txt'), 'quoted edit\n');
  fs.appendFileSync(path.join(dir, 'ambiguous b/name.txt'), 'ambiguous edit\n');
  fs.unlinkSync(path.join(dir, 'delete.txt'));
  fs.chmodSync(path.join(dir, 'mode.sh'), 0o755);
  fs.writeFileSync(path.join(dir, 'binary.bin'), Buffer.from([0, 1, 255, 0]));
  fs.writeFileSync(path.join(dir, 'untracked.txt'), 'untracked\n');
  fs.writeFileSync(path.join(dir, 'empty.txt'), '');
  fs.symlinkSync('modify.txt', path.join(dir, 'link.txt'));
}

export function createScopeFixture() {
  const fixture = seedScopeFixture();
  applyScopeChanges(fixture.dir);
  return fixture;
}
