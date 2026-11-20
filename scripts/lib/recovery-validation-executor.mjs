/**
 * Child process for `scripts/validate-recovery-adapter.mjs`: runs ONE real SDK
 * turn and prints JSON lines on stdout (`session`, `tool`, `text`, `done`).
 * The parent may SIGKILL it mid-turn. Config arrives as JSON in argv[3]:
 * `{ cwd, prompt, sessionId? }`; argv[2] is the harness id.
 */

const [, , harness, rawConfig] = process.argv;
const config = JSON.parse(rawConfig || '{}');

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

async function runClaude({ cwd, prompt, sessionId }) {
  const { loadClaudeSdk } = await import('../../lib/claude/claude-sdk.ts');
  const sdk = await loadClaudeSdk();
  const query = sdk.query({
    prompt,
    options: {
      cwd,
      ...(sessionId ? { resume: sessionId } : {}),
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      maxTurns: 6,
    },
  });
  for await (const message of query) {
    if (message?.session_id) emit({ type: 'session', id: message.session_id });
    if (message?.type === 'assistant') {
      for (const block of message.message?.content || []) {
        if (block?.type === 'tool_use') emit({ type: 'tool', name: block.name });
        if (block?.type === 'text') emit({ type: 'text', text: block.text });
      }
    }
    if (message?.type === 'result' && typeof message.result === 'string') emit({ type: 'text', text: message.result });
  }
}

async function runCodex({ cwd, prompt, sessionId }) {
  const { Codex } = await import('@openai/codex-sdk');
  const codex = new Codex();
  /** @type {import('@openai/codex-sdk').ThreadOptions} */
  const options = {
    workingDirectory: cwd,
    skipGitRepoCheck: true,
    sandboxMode: 'danger-full-access',
    approvalPolicy: 'never',
  };
  const thread = sessionId ? codex.resumeThread(sessionId, options) : codex.startThread(options);
  const { events } = await thread.runStreamed(prompt);
  for await (const event of events) {
    if (event.type === 'thread.started') emit({ type: 'session', id: event.thread_id });
    if (event.type === 'item.started' && event.item?.type === 'command_execution') emit({ type: 'tool', name: 'command' });
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') emit({ type: 'text', text: event.item.text });
  }
}

const runners = { claude: runClaude, codex: runCodex };
if (!runners[harness]) {
  process.stderr.write(`No live validation driver for harness "${harness}".\n`);
  process.exit(2);
}
try {
  await runners[harness](config);
  emit({ type: 'done' });
} catch (err) {
  emit({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  process.exit(1);
}
