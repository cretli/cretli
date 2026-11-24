import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { generateOutputs } from '../scripts/build-docs-site.mjs';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const docs = path.join(root, 'docs/user');
const expected = ['index', 'getting-started', 'install-docker', 'harness-opencode', 'harness-openrouter', 'harness-deepseek', 'harness-qwen', 'harness-mistral', 'harness-mimo', 'harness-zai', 'harness-codebuddy', 'harness-antigravity', 'harness-claude', 'harness-codex', 'harness-cursor-sdk', 'workspaces', 'settings', 'chat-and-agents', 'todos', 'workspace-watcher', 'delegation-review', 'mcp', 'remote-access', 'security-basics', 'backups-and-data', 'troubleshooting', 'faq'];

function bodyOf(raw) {
  return raw.replace(/^---\n[\s\S]*?\n---\n?/, '').replace(/<!--[\s\S]*?-->/g, '').replace(/```[\s\S]*?```/g, '');
}

describe('user documentation', () => {
  it('satisfies the documentation contract', () => {
    const result = generateOutputs();
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.pages, expected);
    for (const lang of ['en', 'pl']) {
      const nav = JSON.parse(fs.readFileSync(path.join(docs, lang, '_nav.json'), 'utf8'));
      assert.deepEqual(nav.sections.map((section) => section.id), ['getting-started', 'harnesses', 'workspaces', 'working-surfaces', 'todos', 'watcher', 'delegation', 'mcp', 'remote-access', 'backups', 'troubleshooting']);
      assert.ok(nav.sections.every((section) => section.pages.length > 0), `${lang}: every section has a page`);
    }
    const manifest = new Set(JSON.parse(fs.readFileSync(path.join(root, 'website/docs/img/manifest.json'), 'utf8')).map((x) => `${x.name}.png`));

    for (const lang of ['en', 'pl']) for (const slug of expected) {
      const file = path.join(docs, lang, `${slug}.md`);
      const raw = fs.readFileSync(file, 'utf8');
      assert.ok(!/\/(?:home|Users)\//i.test(raw), `${lang}/${slug}: private path or name`);
      const source = raw.match(/<!-- sources: ([^>]+) -->$/m);
      assert.ok(source, `${slug} has a sources comment`);
      for (const listed of source[1].split(',').map((x) => x.trim())) assert.ok(fs.existsSync(path.join(root, listed)), `${slug}: missing source ${listed}`);
      for (const image of raw.matchAll(/!\[[^\]]*\]\(img\/([^/)]+\.png)\)/g)) assert.ok(manifest.has(image[1]), `${slug}: image is not in manifest`);
      for (const ip of bodyOf(raw).matchAll(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g)) {
        const value = ip[0].split('.').map(Number);
        assert.ok(ip[0] === '127.0.0.1' || ip[0] === '0.0.0.0' || (value[0] === 192 && value[1] === 0 && value[2] === 2 && value[3] <= 255), `${slug}: private IP ${ip[0]}`);
      }
      if (slug !== 'index') {
        const words = bodyOf(raw).match(/[\p{L}\p{N}’'-]+/gu) || [];
        assert.ok(words.length >= 120 && words.length <= 500, `${slug}: ${words.length} words`);
      }
    }
  });
  it('keeps generated and source text private and screenshots in the manifest', () => {
    const manifest = new Set(JSON.parse(fs.readFileSync(path.join(root, 'website/docs/img/manifest.json'), 'utf8')).map((image) => `${image.name}.png`));
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(file); continue; }
        if (!/\.(?:md|html|css|js|json|xml|example)$/.test(entry.name)) continue;
        const text = fs.readFileSync(file, 'utf8');
        assert.ok(!/\/(?:home|Users)\//.test(text), file);
        for (const ip of text.matchAll(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g)) {
          const [a, b] = ip[0].split('.').map(Number);
          assert.ok(a !== 10 && !(a === 192 && b === 168) && !(a === 172 && b >= 16 && b <= 31), `${file}: ${ip[0]}`);
        }
        if (entry.name.endsWith('.html')) for (const image of text.matchAll(/<img[^>]+src="[^"]*\/img\/([^"/]+)"/g)) assert.ok(manifest.has(image[1]), `${file}: ${image[1]}`);
      }
    };
    walk(docs);
    walk(path.join(root, 'website'));
  });

});
