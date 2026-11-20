import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { generateOutputs } from '../scripts/build-docs-site.mjs';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const docs = path.join(root, 'docs/user');
const expected = ['index', 'getting-started', 'install-docker', 'chat-and-agents', 'todos', 'workspace-watcher', 'settings', 'security-basics', 'troubleshooting'];

function bodyOf(raw) {
  return raw.replace(/^---\n[\s\S]*?\n---\n?/, '').replace(/<!--[\s\S]*?-->/g, '').replace(/```[\s\S]*?```/g, '');
}

describe('user documentation', () => {
  it('satisfies the documentation contract', () => {
    const result = generateOutputs();
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.pages, expected);
    const manifest = new Set(JSON.parse(fs.readFileSync(path.join(root, 'website/docs/img/manifest.json'), 'utf8')).map((x) => x.name));

    for (const slug of expected) {
      const file = path.join(docs, `${slug}.md`);
      const raw = fs.readFileSync(file, 'utf8');
      const source = raw.match(/<!-- sources: ([^>]+) -->$/m);
      assert.ok(source, `${slug} has a sources comment`);
      for (const listed of source[1].split(',').map((x) => x.trim())) assert.ok(fs.existsSync(path.join(root, listed)), `${slug}: missing source ${listed}`);
      for (const image of raw.matchAll(/!\[[^]]*\]\(img\/([^/)]+\.png)\)/g)) assert.ok(manifest.has(image[1]), `${slug}: image is not in manifest`);
      for (const ip of bodyOf(raw).matchAll(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g)) {
        const value = ip[0].split('.').map(Number);
        assert.ok(ip[0] === '127.0.0.1' || ip[0] === '0.0.0.0' || (value[0] === 192 && value[1] === 0 && value[2] === 2 && value[3] <= 255), `${slug}: private IP ${ip[0]}`);
      }
      if (slug !== 'index') {
        const words = bodyOf(raw).match(/\b[\w’'-]+\b/g) || [];
        assert.ok(words.length >= 120 && words.length <= 500, `${slug}: ${words.length} words`);
      }
    }
  });
});
