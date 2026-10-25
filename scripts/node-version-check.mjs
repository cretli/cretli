/**
 * Node version gate for the test runner. The tests need node:sqlite and node:test flags
 * that older runtimes lack, so fail early with a clear message instead of hundreds of failures.
 */
import { readFileSync } from 'node:fs';

/** Extract the minimum "major.minor" from an engines.node range such as ">=22.18". */
export function minimumFromRange(range) {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(range));
  if (!match) return null;
  return match.slice(1, 4).map((part) => Number(part || 0));
}

/** Read the minimum Node version from package.json engines.node (the single source of truth). */
export function readMinimumNode(packageJsonPath) {
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  return minimumFromRange(pkg?.engines?.node);
}

/** Pure check: `current` is a version string (e.g. "20.20.0"), `minimum` is [major, minor, patch]. */
export function checkNodeVersion(current, minimum) {
  if (!minimum) return { ok: true };
  const have = String(current).replace(/^v/, '').split('.').map((part) => Number(part) || 0);
  for (let i = 0; i < 3; i += 1) {
    const a = have[i] || 0;
    const b = minimum[i] || 0;
    if (a !== b) {
      return a > b ? { ok: true } : { ok: false, message: buildMessage(current, minimum) };
    }
  }
  return { ok: true };
}

function buildMessage(current, minimum) {
  const required = minimum[2] ? minimum.join('.') : minimum.slice(0, 2).join('.');
  return (
    `Cretli tests require Node >= ${required} (running v${String(current).replace(/^v/, '')}).\n` +
    'Run `nvm use` (the repo has an .nvmrc) or install Node 22.18+ (native TypeScript type stripping).'
  );
}

/** Exit with code 1 and a message when the running Node is older than engines.node. */
export function assertNodeVersion(packageJsonPath, current = process.versions.node) {
  const result = checkNodeVersion(current, readMinimumNode(packageJsonPath));
  if (result.ok) return;
  console.error(result.message);
  process.exit(1);
}
