/**
 * Terminal/chat state parser. Pure functions with no DOM, shared by the UI and tests.
 */

export const AWAITING_INPUT_SCAN_LEN = 800;
export const STATUS_SCAN_LEN = 4000;
export const STATUS_LAST_LINES = 12;

export const AWAITING_INPUT_PATTERNS = [
  /press\s+enter/i,
  /\(y\/n\)/i,
  /\(y\)es\s*\/\s*\(n\)o/i,
  /continue\?/i,
  /proceed\?/i,
  /select\s+one/i,
  /choose\s+an?\s+option/i,
  /enter\s+your\s+choice/i,
  />\s*$/m,
  /\?\s*$/m,
  /:\s*$/m,
  /\[.*\]\s*$/m,
];

export const TERMINAL_TEXTAREA_MODE_PATTERNS = [
  /add\s+a\s+follow-?up/i,
  /(?:add\s+a\s+)?follow-?up/i,
  /plan,\s*search,\s*build\s+anything/i,
  /type\s+your\s+response/i,
  /enter\s+your\s+message/i,
  /write\s+your\s+answer/i,
];
export const TERMINAL_CHOICE_MODE_PATTERNS = [
  /\(y\/n\)/i,
  /select\s+one/i,
  /choose\s+an?\s+option/i,
  /enter\s+your\s+choice/i,
  /continue\?/i,
  /proceed\?/i,
  /press\s+enter/i,
];
// Agents reply in the user's language, so detection covers Polish phrasing too.
// Adding another language means adding its patterns here.
export const TERMINAL_QUESTION_PATTERNS = [
  /(?:^|\n).{0,180}\?\s*(?:$|\n)/m,
  /\b(what|which|who|why|when|where|how)\b.{0,120}\?/i,
  /\b(czy|jak|który|ktora|które|kiedy|gdzie|dlaczego|po co)\b.{0,120}\?/i,
  /\b(would\s+you\s+like|do\s+you\s+want|do\s+you\s+wish)\b/i,
  /\b(czy\s+chcesz|czy\s+wolisz|czy\s+mam|czy\s+powinienem)\b/i,
  /\b(please\s+confirm|potwierd[źz])\b/i,
];
export const TERMINAL_APPROVAL_PATTERNS = [
  /run\s+this\s+command\?/i,
  /write\s+to\s+this\s+file\?/i,
  /not\s+in\s+allowlist/i,
  /add\s+write\(.+\)\s+to\s+allowlist\?/i,
  /run\s*\(once\)\s*\(y\)/i,
  /proceed\s*\(y\)/i,
  /reject\s*&\s*propose\s+changes/i,
  /run\s+everything/i,
  /\bskip\b.*\besc\b/i,
  /waiting\s+for\s+approval/i,
];
export const TERMINAL_GENERATING_PATTERNS = [
  /(?:^|\n)\s*(?:[^\r\nA-Za-z0-9]{0,4}\s*)?generating\b(?:[^\w\r\n]+.*)?(?:$|\n)/i,
];
export const TERMINAL_RUNNING_PATTERNS = [
  /(?:^|\n)\s*(?:[^\r\nA-Za-z0-9]{0,4}\s*)?running\b(?:[^\w\r\n]+.*)?(?:$|\n)/i,
  /(?:^|\n)\s*status\s*:\s*running\b/i,
];
export const TERMINAL_READING_PATTERNS = [
  /(?:^|\n)\s*(?:[^\r\nA-Za-z0-9]{0,4}\s*)?reading\b(?:[^\w\r\n]+.*)?(?:$|\n)/i,
  /:\s*reading\b(?:[^\w\r\n].*)?/i,
  /reading\s+file/i,
];
export const TERMINAL_GREPPING_PATTERNS = [
  /(?:^|\n)\s*(?:[•●·:>-]\s*)?grepping\b(?:[^\w\r\n]+.*)?(?:$|\n)/i,
  /:\s*grepping\b(?:[^\w\r\n].*)?/i,
  /\bgrepping\b/i,
];
export const TERMINAL_THINKING_PATTERNS = [
  /(?:^|\n)\s*(?:[^\r\nA-Za-z0-9]{0,4}\s*)?thinking\b(?:[^\w\r\n]+.*)?(?:$|\n)/i,
  /thinking\s+about/i,
];
export const TERMINAL_EDITING_PATTERNS = [
  /(?:^|\n)\s*(?:[^\r\nA-Za-z0-9]{0,4}\s*)?editing\b(?:[^\w\r\n]+.*)?(?:$|\n)/i,
  /:\s*editing\b(?:[^\w\r\n].*)?/i,
  /applying\s+edits?/i,
  /editing\s+file/i,
  /\bupdating\s+file\b/i,
  /\bwriting\s+changes\b/i,
];

export function stripAnsi(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b[PX^_][^\x1b]*(\x1b\\)?/g, '');
}

export function detectAwaitingInputFromBuffer(buffer) {
  const buf = (buffer || '').slice(-AWAITING_INPUT_SCAN_LEN);
  if (!buf.trim()) return false;
  return AWAITING_INPUT_PATTERNS.some((re) => re.test(buf));
}

export function parseTerminalInteraction(buffer) {
  const tail = stripAnsi((buffer || '').slice(-STATUS_SCAN_LEN));
  const normalizedTail = tail.replace(/\r/g, '\n');
  const hasTail = !!normalizedTail.trim();
  const lastLines = normalizedTail.split(/\n/).slice(-STATUS_LAST_LINES).join('\n');
  const recentTail = normalizedTail.slice(-1200);

  const approval = hasTail && TERMINAL_APPROVAL_PATTERNS.some((re) => re.test(lastLines));
  const grepping = hasTail && TERMINAL_GREPPING_PATTERNS.some((re) => re.test(normalizedTail));
  const reading = hasTail && TERMINAL_READING_PATTERNS.some((re) => re.test(normalizedTail));
  const thinking = hasTail && TERMINAL_THINKING_PATTERNS.some((re) => re.test(lastLines) || re.test(normalizedTail));
  const editing = hasTail && TERMINAL_EDITING_PATTERNS.some((re) => re.test(normalizedTail));
  const generatingLineMatch =
    hasTail &&
    TERMINAL_GENERATING_PATTERNS.some((re) => re.test(lastLines));
  const runningLineMatch =
    hasTail &&
    TERMINAL_RUNNING_PATTERNS.some((re) => re.test(lastLines));
  const generatingInlineFallback =
    hasTail &&
    /(?:^|[\s\u0000-\u001f])(?:[^\r\nA-Za-z0-9]{0,4}\s*)?generating\b(?:[^\w\r\n]+)?(?:\s*\d+\s+tokens?)?/i.test(recentTail) &&
    /(add\s+a\s+follow-?up|ctrl\+c\s+to\s+stop)/i.test(recentTail);
  const runningInlineFallback =
    hasTail &&
    /(?:^|[\s\u0000-\u001f])(?:[^\r\nA-Za-z0-9]{0,4}\s*)?running\b(?:[^\w\r\n]+)?(?:\s*\d+\s+tokens?)?/i.test(recentTail) &&
    /(add\s+a\s+follow-?up|ctrl\+c\s+to\s+stop)/i.test(recentTail);
  const generatingRaw = generatingLineMatch || generatingInlineFallback;
  const runningRaw = runningLineMatch || runningInlineFallback;
  const stopHintVisible = hasTail && /ctrl\+c\s+to\s+stop/i.test(lastLines);
  const textarea =
    hasTail &&
    TERMINAL_TEXTAREA_MODE_PATTERNS.some((re) => re.test(lastLines) || re.test(normalizedTail));
  const explicitInputPrompt =
    hasTail &&
    (/>\s*$/m.test(lastLines) || /(?:^|\n)\s*→\s*plan,\s*search,\s*build\s+anything\s*$/im.test(lastLines));
  const hasFollowupUi =
    hasTail &&
    textarea &&
    /(add\s+a\s+follow-?up|ctrl\+c\s+to\s+stop)/i.test(recentTail);
  const loadingConversation = hasTail && /\bloading\s+conversation\b/i.test(normalizedTail);
  const hasReviewFooter =
    hasTail &&
    /(ctrl\+r\s+to\s+review\s+edits|\/\s*commands\s*·\s*@\s*files)/i.test(normalizedTail);
  const staleStatusWithFollowup =
    hasFollowupUi &&
    /\bgenerating\b/i.test(recentTail);
  const staleRunningWithReviewFooter =
    hasFollowupUi &&
    /\brunning\b/i.test(recentTail) &&
    hasReviewFooter;
  const staleRunningAfterCatchup =
    hasFollowupUi &&
    /\brunning\b/i.test(recentTail) &&
    loadingConversation;
  const staleFollowupCandidate =
    staleStatusWithFollowup || staleRunningAfterCatchup || staleRunningWithReviewFooter;
  const choice = hasTail && !textarea && TERMINAL_CHOICE_MODE_PATTERNS.some((re) => re.test(normalizedTail));
  const question = hasTail && !textarea && TERMINAL_QUESTION_PATTERNS.some((re) => re.test(lastLines));
  const awaiting = hasTail && (approval || textarea || choice || question || detectAwaitingInputFromBuffer(normalizedTail));
  // The status line wins: "Generating/Running" means the agent is working,
  // even when the "Add a follow-up" input is on screen.
  // Exception: a literal ">" prompt at the end means the agent waits for user input.
  const runningActive =
    runningLineMatch || (runningInlineFallback && stopHintVisible);
  const generatingActive =
    generatingLineMatch || (generatingInlineFallback && stopHintVisible);
  const running = runningActive && !grepping && !reading && !editing && !approval && !explicitInputPrompt;
  const generating = generatingActive && !running && !grepping && !reading && !editing && !approval && !explicitInputPrompt;

  return {
    approval,
    grepping,
    reading,
    thinking,
    running,
    generating,
    editing,
    textarea,
    choice,
    question,
    awaiting,
    hasTail,
    runningRaw,
    generatingRaw,
    staleFollowupCandidate,
    staleCatchupCandidate: staleRunningAfterCatchup,
    normalizedTail,
    lastLines,
  };
}

export function resolveTerminalState(interaction, connection, agent, recentOutput) {
  const i = interaction || {};
  const stopHintVisible = /ctrl\+c\s+to\s+stop/i.test(i.lastLines || '');
  if ((connection === 'connecting' || connection === 'reconnecting') && !recentOutput) {
    return { tone: 'connecting', label: 'Connecting…', labelKey: 'status.connecting' };
  }
  if (connection === 'disconnected') return { tone: 'disconnected', label: 'Disconnected', labelKey: 'status.disconnected' };
  if (i.approval) return { tone: 'approval', label: 'Waiting for consent', labelKey: 'status.waitingConsent' };
  if (i.grepping) return { tone: 'grepping', label: 'Grepping…', labelKey: 'status.grepping' };
  if (i.editing) return { tone: 'editing', label: 'Editing…', labelKey: 'status.editing' };
  if (i.reading) return { tone: 'reading', label: 'Reading…', labelKey: 'status.reading' };
  if (i.thinking) return { tone: 'thinking', label: 'Thinking…', labelKey: 'status.thinking' };
  // After a page reload a stale "Running" often stays in the buffer next to "Add a follow-up".
  // Without fresh output, treat that as waiting for input.
  if (i.running && i.textarea && i.awaiting && !recentOutput) {
    return { tone: 'textarea', label: 'Waiting for command', labelKey: 'status.waitingCommand' };
  }
  if ((i.running || i.generating) && i.textarea && i.awaiting && !stopHintVisible) {
    return { tone: 'textarea', label: 'Waiting for command', labelKey: 'status.waitingCommand' };
  }
  // After a page reload the "Generating/Running" status may be an old buffer fragment.
  // For a detected stale-followup candidate with no fresh output, report waiting for input.
  if (
    (i.running || i.generating) &&
    i.staleFollowupCandidate &&
    !recentOutput &&
    (agent !== 'active' || i.staleCatchupCandidate === true)
  ) {
    return { tone: 'textarea', label: 'Waiting for command', labelKey: 'status.waitingCommand' };
  }
  if (i.running) return { tone: 'running', label: 'Running…', labelKey: 'status.running' };
  if (i.generating) return { tone: 'generating', label: 'Generating…', labelKey: 'status.generating' };
  if (i.question || i.choice) return { tone: 'question', label: 'Asking…', labelKey: 'status.asking' };
  if (i.textarea && i.awaiting) return { tone: 'textarea', label: 'Waiting for command', labelKey: 'status.waitingCommand' };
  // The generic "awaiting" flag produces false positives while output is streaming.
  // With an active agent and fresh output, do not surface the "needs action" state.
  if (i.awaiting && agent === 'active' && recentOutput) {
    return { tone: 'active', label: 'Agent working', labelKey: 'status.agentWorking' };
  }
  if (i.awaiting) return { tone: 'awaiting', label: 'Needs action', labelKey: 'status.needsAction' };
  if (agent === 'active') return { tone: 'active', label: 'Agent working', labelKey: 'status.agentWorking' };
  return { tone: 'idle', label: 'Ready', labelKey: 'status.ready' };
}

export const STATUS_TEST_FIXTURES = [
  {
    id: 'generating-with-followup',
    name: 'Generating + follow-up',
    group: 'Generating',
    input: '• Generating.\n→ Add a follow-up\nctrl+c to stop',
    expectedTone: 'generating',
    expectedGenerating: true,
    connection: 'connected',
    agent: 'active',
  },
  {
    id: 'running-cr',
    name: 'Running with CR',
    group: 'Generating',
    input: 'something...\r• Running...\r',
    expectedTone: 'running',
    expectedGenerating: false,
    connection: 'connected',
    agent: 'active',
  },
  {
    id: 'generating-ansi-spinner',
    name: 'Generating with ANSI + spinner ⬢',
    group: 'Generating',
    input:
      '\x1b[32m⬢\x1b[39m \x1b[1mGenerating...\x1b[22m\n│ \x1b[2m→ \x1b[22m\x1b[7mA\x1b[27mdd a follow-up \x1b[90mctrl+c to stop\x1b[39m',
    expectedTone: 'generating',
    expectedGenerating: true,
    connection: 'connected',
    agent: 'active',
  },
  {
    id: 'generating-raw-cursor-stream',
    name: 'Generating from a raw Cursor stream',
    group: 'Generating',
    input:
      '\x1b[2K\x1b[1A\x1b[2K\x1b[1A\x1b[2K\x1b[G  \x1b[32m⬢\x1b[39m \x1b[1mGenerating.. \x1b[22m  ┌────────────────────┐\n' +
      '  │ \x1b[2m→ \x1b[22m\x1b[7mA\x1b[27m\x1b[90mdd a follow-up\x1b[39m   \x1b[90mctrl+c to stop\x1b[39m │\n' +
      '  └────────────────────┘\n',
    expectedTone: 'generating',
    expectedGenerating: true,
    connection: 'connected',
    agent: 'active',
  },
  {
    id: 'generating-different-spinner',
    name: 'Generating with a different spinner',
    group: 'Generating',
    input:
      '◇ Generating.\n' +
      '┌───────────────────────────────────────────────┐\n' +
      '│ → Add a follow-up                  ctrl+c to stop │\n' +
      '└───────────────────────────────────────────────┘\n',
    expectedTone: 'generating',
    expectedGenerating: true,
    connection: 'connected',
    agent: 'active',
  },
  {
    id: 'generating-inline-fallback',
    name: 'Generating inline after a refresh',
    group: 'Generating',
    input:
      '... previous content ... \x1b[2K\x1b[G◇ Generating. 445 tokens  → Add a follow-up  ctrl+c to stop',
    expectedTone: 'generating',
    expectedGenerating: true,
    connection: 'connected',
    agent: 'active',
    recentOutput: true,
  },
  {
    id: 'reading',
    name: 'Reading file',
    group: 'Agent actions',
    input: '• Reading file app_front/chat.js...',
    expectedTone: 'reading',
    connection: 'connected',
    agent: 'active',
  },
  {
    id: 'reading-single-dot',
    name: 'Reading with one dot',
    group: 'Agent actions',
    input: '• Reading. 1.35k tokens\n→ Add a follow-up\nctrl+c to stop',
    expectedTone: 'reading',
    expectedGenerating: false,
    connection: 'connected',
    agent: 'active',
  },
  {
    id: 'reading-dot-k-tokens',
    name: 'Reading with 8.21k tokens',
    group: 'Agent actions',
    input: '◦ Reading. 8.21k tokens\n→ Add a follow-up\nctrl+c to stop',
    expectedTone: 'reading',
    expectedGenerating: false,
    connection: 'connected',
    agent: 'active',
  },
  {
    id: 'grepping',
    name: 'Grepping source',
    group: 'Agent actions',
    input: '• Grepping for "updateAwaitingInput"...',
    expectedTone: 'grepping',
    connection: 'connected',
    agent: 'active',
  },
  {
    id: 'editing',
    name: 'Editing file',
    group: 'Agent actions',
    input: '• Editing...\nApplying edits to app_front/chat.js',
    expectedTone: 'editing',
    connection: 'connected',
    agent: 'active',
  },
  {
    id: 'editing-double-dot',
    name: 'Editing with two dots',
    group: 'Agent actions',
    input: '◦ Editing.. 886 tokens\n→ Add a follow-up\nctrl+c to stop',
    expectedTone: 'editing',
    expectedGenerating: false,
    connection: 'connected',
    agent: 'active',
  },
  {
    id: 'thinking',
    name: 'Thinking',
    group: 'Agent actions',
    input: '• Thinking...',
    expectedTone: 'thinking',
    connection: 'connected',
    agent: 'active',
  },
  {
    id: 'textarea-awaiting',
    name: 'Follow-up mode (awaiting)',
    group: 'Waiting for input',
    input: '→ Add a follow-up\n> ',
    expectedTone: 'textarea',
    expectedGenerating: false,
    connection: 'connected',
    agent: 'active',
  },
  {
    id: 'textarea-no-generating-word-only-stop',
    name: 'Follow-up + ctrl+c (no Generating)',
    group: 'Waiting for input',
    input: '→ Add a follow-up\nctrl+c to stop\n',
    expectedTone: 'textarea',
    expectedGenerating: false,
    connection: 'connected',
    agent: 'active',
  },
  {
    id: 'textarea-stale-generating-refresh',
    name: 'Stale Generating after F5 -> textarea',
    group: 'Waiting for input',
    input: '◇ Generating... 445 tokens\n→ Add a follow-up\nctrl+c to stop',
    expectedTone: 'textarea',
    expectedGenerating: true,
    connection: 'connected',
    agent: 'idle',
    recentOutput: false,
  },
  {
    id: 'textarea-running-tokens-stale',
    name: 'Running + tokens + follow-up after F5 = textarea',
    group: 'Waiting for input',
    input:
      '● Running 425 tokens\n┌────────────────────────────────────────────────┐\n│ → Add a follow-up                    ctrl+c to stop │\n└────────────────────────────────────────────────┘',
    expectedTone: 'textarea',
    expectedGenerating: false,
    connection: 'connected',
    agent: 'idle',
    recentOutput: false,
  },
  {
    id: 'approval',
    name: 'Approval Y/N',
    group: 'Waiting for input',
    input: 'Run this command? (y/n)',
    expectedTone: 'approval',
    expectedGenerating: false,
    connection: 'connected',
    agent: 'active',
  },
  {
    id: 'question',
    name: 'Question from the agent',
    group: 'Waiting for input',
    input: 'Czy chcesz kontynuować?',
    expectedTone: 'question',
    expectedGenerating: false,
    connection: 'connected',
    agent: 'active',
  },
  {
    id: 'awaiting-generic',
    name: 'Awaiting generic (no textarea/question)',
    group: 'Waiting for input',
    input: 'Podaj wartość:\n',
    expectedTone: 'awaiting',
    expectedGenerating: false,
    connection: 'connected',
    agent: 'active',
  },
  {
    id: 'awaiting-generic-while-active-with-recent-output',
    name: 'Awaiting generic with fresh output',
    group: 'Waiting for input',
    input: 'Podaj wartość:\n',
    expectedTone: 'active',
    expectedGenerating: false,
    connection: 'connected',
    agent: 'active',
    recentOutput: true,
  },
  {
    id: 'connecting',
    name: 'Connecting',
    group: 'Connection',
    input: '',
    expectedTone: 'connecting',
    expectedGenerating: false,
    connection: 'connecting',
    agent: 'disconnected',
    recentOutput: false,
  },
  {
    id: 'reconnecting',
    name: 'Reconnecting',
    group: 'Connection',
    input: '',
    expectedTone: 'connecting',
    expectedGenerating: false,
    connection: 'reconnecting',
    agent: 'disconnected',
    recentOutput: false,
  },
  {
    id: 'disconnected',
    name: 'Disconnected',
    group: 'Connection',
    input: '',
    expectedTone: 'disconnected',
    expectedGenerating: false,
    connection: 'disconnected',
    agent: 'disconnected',
  },
  {
    id: 'idle',
    name: 'Idle',
    group: 'Basics',
    input: 'Done.',
    expectedTone: 'idle',
    expectedGenerating: false,
    connection: 'connected',
    agent: 'idle',
  },
  {
    id: 'active-fallback',
    name: 'Active fallback',
    group: 'Basics',
    input: 'Done.',
    expectedTone: 'active',
    expectedGenerating: false,
    connection: 'connected',
    agent: 'active',
  },
];

