#!/usr/bin/env node
/**
 * Import a nested todo tree (JSON) into Cretli Todo through the REST API.
 *
 *   node scripts/import-todo-tree.mjs docs/cretli-next-steps.todo.json [--workspace <folder>] [--dry-run]
 *
 * Tree node: { title, key, status?, body?, children?: node[] }. `key` becomes
 * the todo idempotency key, so re-running the import does not duplicate todos.
 * Children are created in order with `sibling_index`, under their parent.
 *
 * Auth: CRETLI_CLI_PASSWORD / CRETLI_PASSWORD or an interactive prompt (the
 * same as scripts/chat-cli.js). CRETLI_URL defaults to https://127.0.0.1:3011.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { CretliApiClient } from '../lib/remote-api-client.js';

/**
 * @typedef {{ title: string, key: string, status?: string, body?: string, children?: TodoNode[] }} TodoNode
 */

async function readPassword() {
  if (process.env.CRETLI_CLI_PASSWORD) return process.env.CRETLI_CLI_PASSWORD;
  if (process.env.CRETLI_PASSWORD) return process.env.CRETLI_PASSWORD;
  const rl = readline.createInterface({ input, output });
  try {
    return await rl.question('Cretli password: ');
  } finally {
    rl.close();
  }
}

/**
 * @param {TodoNode} node
 * @param {string} where
 */
function validate(node, where) {
  if (!node || typeof node.title !== 'string' || !node.title.trim()) throw new Error(`${where}: title is required`);
  if (typeof node.key !== 'string' || !node.key.trim()) throw new Error(`${where}: key is required`);
  (node.children || []).forEach((child, index) => validate(child, `${where}.children[${index}]`));
}

/**
 * @param {TodoNode} node
 * @param {number} depth
 */
function printTree(node, depth = 0) {
  console.log(`${'  '.repeat(depth)}- [${node.status || 'idea'}] ${node.title}  (${node.key})`);
  for (const child of node.children || []) printTree(child, depth + 1);
}

/**
 * @param {CretliApiClient} client
 * @param {TodoNode} node
 * @param {{ workspaceFolder: string, parentId?: string, siblingIndex?: number }} at
 * @returns {Promise<number>} created or replayed todos
 */
async function importNode(client, node, at) {
  const res = await client.createTodo({
    workspaceFolder: at.workspaceFolder,
    title: node.title,
    body: node.body || '',
    status: node.status || 'idea',
    idempotencyKey: node.key,
    parentId: at.parentId,
    siblingIndex: at.siblingIndex,
  });
  const id = res?.item?.id;
  if (!id) throw new Error(`No todo id returned for "${node.title}"`);
  console.log(`${res.replayed ? '=' : '+'} ${id.slice(0, 8)} ${node.title}`);
  let count = 1;
  const children = node.children || [];
  for (let index = 0; index < children.length; index += 1) {
    count += await importNode(client, children[index], {
      workspaceFolder: at.workspaceFolder,
      parentId: id,
      siblingIndex: index,
    });
  }
  return count;
}

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((arg) => !arg.startsWith('--'));
  if (!file) {
    console.error('Usage: node scripts/import-todo-tree.mjs <tree.json> [--workspace <folder>] [--dry-run]');
    process.exit(1);
  }
  const workspaceIndex = args.indexOf('--workspace');
  const workspaceFolder = path.resolve(workspaceIndex >= 0 ? args[workspaceIndex + 1] : process.cwd());
  /** @type {TodoNode} */
  const tree = JSON.parse(readFileSync(file, 'utf8'));
  validate(tree, 'root');
  console.log(`Workspace: ${workspaceFolder}`);
  printTree(tree);
  if (args.includes('--dry-run')) return;

  const client = new CretliApiClient({ baseUrl: process.env.CRETLI_URL, password: await readPassword() });
  await client.login();
  const count = await importNode(client, tree, { workspaceFolder });
  console.log(`Done: ${count} todo(s) ('+' created, '=' already present).`);
}

main().catch((err) => {
  console.error(`import-todo-tree: ${err?.message || err}`);
  process.exit(1);
});
