/**
 * Shared ask_user_question (Claude `AskUserQuestion`, Qwen `ask_user_question`) — map CLI tool input to the shared question UI
 * (`opencode_question`) and return answers through `canUseTool`.
 */

export const ASK_USER_QUESTION_TIMEOUT_MS = 600000;

export function isAskUserQuestionTool(name: unknown): boolean {
  const raw = String(name || '').trim().toLowerCase().replace(/_/g, '');
  return raw === 'askuserquestion';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function normalizeQuestionItems(raw: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const item of raw) {
    const rec = asRecord(item);
    if (!rec) continue;
    const question = typeof rec.question === 'string' ? rec.question.trim() : '';
    if (!question) continue;
    const header = typeof rec.header === 'string' ? rec.header.trim() : '';
    const options = Array.isArray(rec.options)
      ? rec.options
        .filter((option) => option && typeof option === 'object')
        .map((option) => {
          const row = option as Record<string, unknown>;
          return {
            label: typeof row.label === 'string' ? row.label.trim() : '',
            description: typeof row.description === 'string' ? row.description.trim() : '',
          };
        })
        .filter((option) => option.label)
      : [];
    out.push({
      question,
      header: header || question.slice(0, 30),
      options,
      multiple: rec.multiple === true || rec.multiSelect === true,
      custom: rec.custom !== false,
    });
  }
  return out;
}

export function buildQuestionSdkEvent(input: { requestId?: string, questions?: unknown }): Record<string, unknown> | null {
  const requestId = typeof input?.requestId === 'string' ? input.requestId.trim() : '';
  const questions = normalizeQuestionItems(input?.questions);
  if (!requestId || questions.length === 0) return null;
  return {
    type: 'opencode_question',
    requestId,
    questions,
  };
}

/**
 * @param options `keyBy: 'question'` is what the
 *   Claude AskUserQuestion tool expects (answers keyed by question text).
 */
export function buildQuestionAnswers(questions: unknown, uiAnswers: unknown, options: { keyBy?: 'index' | 'question' } = {}): Record<string, string> {
  const items = Array.isArray(questions) ? questions : [];
  const rows = Array.isArray(uiAnswers) ? uiAnswers : [];
  const answers: Record<string, string> = {};
  for (let i = 0; i < items.length; i += 1) {
    const row: unknown[] = Array.isArray(rows[i]) ? rows[i] : [];
    const labels = row
      .map((entry) => String(entry || '').trim())
      .filter(Boolean);
    if (labels.length === 0) continue;
    const item = asRecord(items[i]);
    const questionText = typeof item?.question === 'string' ? item.question : '';
    const key = options.keyBy === 'question' && questionText ? questionText : String(i);
    answers[key] = labels.join(', ');
  }
  return answers;
}

export function buildCanUseToolResult(input: {
  behavior: 'allow' | 'deny',
  input?: Record<string, unknown> | null,
  answers?: Record<string, string>,
  message?: string,
}): { behavior: 'allow', updatedInput: Record<string, unknown> } | { behavior: 'deny', message: string } {
  if (input.behavior === 'deny') {
    return {
      behavior: 'deny',
      message: String(input.message || 'User declined to answer').trim() || 'User declined to answer',
    };
  }
  const base = asRecord(input.input) || {};
  return {
    behavior: 'allow',
    updatedInput: {
      ...base,
      answers: input.answers && typeof input.answers === 'object' ? input.answers : {},
    },
  };
}

export function createAskUserQuestionCanUseTool(deps: {
  emitQuestion: (event: Record<string, unknown>) => void,
  waitForReply: (requestId: string, options?: { signal?: AbortSignal }) => Promise<{
    answers?: Array<Array<string>>,
    reject?: boolean,
    reason?: string,
  }>,
  generateId?: () => string,
  answerKeyBy?: 'index' | 'question',
}): (toolName: string, input: Record<string, unknown>, options: { signal?: AbortSignal }) => Promise<{
  behavior: 'allow' | 'deny',
  updatedInput?: Record<string, unknown>,
  message?: string,
}> {
  const emitQuestion = deps.emitQuestion;
  const waitForReply = deps.waitForReply;
  const generateId = typeof deps.generateId === 'function'
    ? deps.generateId
    : () => `ask-q-${Date.now()}`;
  return async (toolName: string, input: Record<string, unknown>, options: { signal?: AbortSignal } = {}) => {
    const toolInput = asRecord(input) || {};
    if (!isAskUserQuestionTool(toolName)) {
      return { behavior: 'allow', updatedInput: toolInput };
    }
    const questions = normalizeQuestionItems(toolInput.questions);
    if (questions.length === 0) {
      return buildCanUseToolResult({
        behavior: 'deny',
        message: 'ask_user_question had no valid questions',
      });
    }
    const requestId = String(generateId() || '').trim() || `ask-q-${Date.now()}`;
    const event = buildQuestionSdkEvent({ requestId, questions });
    if (event) emitQuestion(event);
    const reply = await waitForReply(requestId, { signal: options.signal });
    if (!reply || reply.reject === true) {
      return buildCanUseToolResult({
        behavior: 'deny',
        message: String(reply?.reason || 'User declined to answer').trim() || 'User declined to answer',
      });
    }
    return buildCanUseToolResult({
      behavior: 'allow',
      input: toolInput,
      answers: buildQuestionAnswers(questions, reply.answers, {
        keyBy: deps.answerKeyBy === 'question' ? 'question' : 'index',
      }),
    });
  };
}
