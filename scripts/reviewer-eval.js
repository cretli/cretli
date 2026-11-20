#!/usr/bin/env node
/**
 * Manual reviewer evaluation on leaves that passed code review and were fixed later.
 * Never run in CI; results do not feed model_pick.
 *
 * Usage:
 *   node scripts/reviewer-eval.js extract --workspace DIR
 *   node scripts/reviewer-eval.js run --harness H --model M --chat CHAT_ID --workspace DIR [--dry-run]
 *
 * Use a dedicated chat for `--chat` (never the orchestrator of a `doing` todo).
 * `extract` writes data/reviewer-eval/cases.json with `accepted: false`; edit the
 * file to accept cases. `run` only runs accepted cases and starts read-only code
 * reviews through the running server's delegation API (`--dry-run` starts nothing).
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { extractCases } from '../lib/reviewer-eval/extract.js';
import { runEval } from '../lib/reviewer-eval/run.js';
import { aggregateScores, formatScoreTable } from '../lib/reviewer-eval/score.js';
import { readCases, readResultsForDate, writeCases, writeResults } from '../lib/reviewer-eval/store.js';

/** @param {string[]} argv @returns {Map<string, string>} */
function parseFlags(argv) {
  const flags = new Map();
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) flags.set(argv[i].slice(2), 'true');
    else { flags.set(argv[i].slice(2), next); i++; }
  }
  return flags;
}

/** @param {any} todo @returns {string} */
function orchestratorOf(todo) {
  return String(todo?.orchestrator_chat_id || todo?.orchestratorChatId || '');
}

/**
 * @param {string[]} argv
 * @param {{ dataDir: string, log?: (text: string) => void, client?: any, loadSources?: Function, listTodos?: Function, prepareCheckout?: Function, now?: () => Date }} deps
 * @returns {Promise<number>} exit code
 */
export async function main(argv, deps) {
  const log = deps.log || ((text) => console.log(text));
  try {
    return await dispatch(argv, deps, log);
  } catch (err) {
    log(`error: ${String(/** @type {any} */ (err)?.message || err).split('\n')[0]}`);
    return 2;
  }
}

/** @param {string[]} argv @param {any} deps @param {(text: string) => void} log @returns {Promise<number>} */
async function dispatch(argv, deps, log) {
  const [command, ...rest] = argv;
  const flags = parseFlags(rest);
  const workspace = path.resolve(flags.get('workspace') || process.cwd());
  if (command === 'extract') {
    const todos = await deps.listTodos(workspace);
    const sources = await deps.loadSources(workspace, { todos });
    const cases = extractCases({ todos, ...sources, existing: readCases(deps.dataDir) });
    log(`wrote ${writeCases(deps.dataDir, cases)} (${cases.length} cases, ${cases.filter((c) => c.accepted).length} accepted, ${cases.filter((c) => c.stale).length} stale)`);
    return 0;
  }
  if (command === 'run') {
    const harness = flags.get('harness');
    const model = flags.get('model');
    if (!harness || !model) { log('run needs --harness and --model'); return 2; }
    const dryRun = flags.get('dry-run') === 'true';
    const chat = flags.get('chat');
    if (!dryRun) {
      if (!chat) { log('run needs --chat (a dedicated chat for evaluations)'); return 2; }
      // The server may attribute a review to the parent chat's only `doing` leaf.
      const busy = (await deps.listTodos(workspace)).find((t) => String(t.status) === 'doing' && orchestratorOf(t) === chat);
      if (busy) { log(`refusing: chat ${chat} orchestrates the doing todo ${busy.id}; use a dedicated chat for evaluations`); return 2; }
    }
    const out = await runEval({
      cases: readCases(deps.dataDir), harness, model, dryRun,
      client: deps.client, chatId: chat, workspaceFolder: workspace,
      prepareCheckout: deps.prepareCheckout && ((/** @type {any} */ c) => deps.prepareCheckout(c, workspace)),
    });
    if (dryRun) {
      log(`dry-run: would review ${out.plan.length} accepted case(s) on ${harness}/${model}`);
      for (const step of out.plan) log(`  - ${step.caseId}`);
      return 0;
    }
    const date = (deps.now ? deps.now() : new Date()).toISOString().slice(0, 10);
    const summary = aggregateScores(out.results);
    log(`wrote ${writeResults(deps.dataDir, date, { harness, model }, { date, harness, model, results: out.results, summary })}`);
    // Table across every run of that date, not only this one.
    log(formatScoreTable(aggregateScores(readResultsForDate(deps.dataDir, date))));
    return 0;
  }
  log('Usage: reviewer-eval extract --workspace DIR | run --harness H --model M --chat ID [--workspace DIR] [--dry-run]');
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const { resolveDataPath } = await import('../lib/runtime-paths.js');
  const { CretliApiClient, isLoopbackUrl } = await import('../lib/remote-api-client.js');
  const { loadHistorySources } = await import('../lib/reviewer-eval/sources.js');
  const { createPreFixCheckout } = await import('../lib/reviewer-eval/worktree.js');
  const { runGit } = await import('../lib/worktree/git-worktree.ts');
  const client = new CretliApiClient({
    baseUrl: process.env.CRETLI_URL,
    password: process.env.CRETLI_CLI_PASSWORD || process.env.CRETLI_PASSWORD,
    insecureTls: process.env.CRETLI_INSECURE_TLS !== '0' && isLoopbackUrl(process.env.CRETLI_URL || 'https://127.0.0.1:3011'),
  });
  const code = await main(process.argv.slice(2), {
    dataDir: resolveDataPath(),
    client,
    loadSources: loadHistorySources,
    prepareCheckout: (/** @type {any} */ testCase, /** @type {string} */ repo) => {
      if (!testCase.preFixCommit) throw new Error('case has no preFixCommit');
      return createPreFixCheckout({ repo, commit: testCase.preFixCommit, runGit });
    },
    listTodos: (workspaceFolder) => client.listTodos({ workspaceFolder }),
  });
  process.exit(code);
}
