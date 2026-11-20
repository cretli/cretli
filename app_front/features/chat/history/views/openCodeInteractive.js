import { PERMISSION_HARNESS_LABELS } from '../../../../../lib/approval/harness-permission-controls.ts';
import { t } from '../../../../i18n/index.js';

/**
 * OpenCode question and permission cards.
 *
 * @param {any} rv Shared view scope created by `createSdkRichView`.
 */
export function installOpenCodeInteractive(rv) {
  const { hooks } = rv;
  rv.markOpenCodeQuestionResolved = markOpenCodeQuestionResolved;
  rv.renderOpenCodeQuestion = renderOpenCodeQuestion;
  rv.renderOpenCodePermission = renderOpenCodePermission;
  rv.resolveQuestionCardsForTool = resolveQuestionCardsForTool;

  /**
   * @param {unknown} questions
   * @returns {string}
   */
  function questionSignature(questions) {
    const first = Array.isArray(questions) ? questions[0] : null;
    const text = first && typeof first === 'object' ? /** @type {Record<string, unknown>} */ (first).question : '';
    return typeof text === 'string' ? text.trim() : '';
  }

  /**
   * @param {unknown} raw
   * @returns {string[][]}
   */
  function normalizeQuestionAnswers(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.map((entry) => (Array.isArray(entry)
      ? entry.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim())
      : []));
  }

  /**
   * Reads the answers out of a finished AskUserQuestion result, which the SDK writes as
   * `"<question>"="<answer>"` pairs. Unparseable text yields no answers, not an error.
   *
   * @param {unknown} result
   * @param {unknown} questions tool_call `args.questions`
   * @returns {string[][]}
   */
  function parseAskUserQuestionAnswers(result, questions) {
    const text = typeof result === 'string' ? result : '';
    const list = Array.isArray(questions) ? questions : [];
    if (!text || list.length === 0) return [];
    /** @type {Map<string, string>} */
    const byQuestion = new Map();
    for (const match of text.matchAll(/"([^"]*)"="([^"]*)"/g)) {
      byQuestion.set(match[1].trim(), match[2].trim());
    }
    return list.map((item) => {
      const question = item && typeof item === 'object'
        ? String(/** @type {Record<string, unknown>} */ (item).question || '').trim()
        : '';
      const answer = byQuestion.get(question);
      return answer ? [answer] : [];
    });
  }

  /**
   * @returns {HTMLElement[]}
   */
  function listQuestionCards() {
    const roots = new Set([rv.stream, rv.realStream].filter(Boolean));
    return [...roots].flatMap((root) => [...root.querySelectorAll('.sdk-rich-opencode-question')]);
  }

  /**
   * A finished AskUserQuestion call closes its card and shows the chosen answer. The
   * persisted `questionResolved` record can be missing (older chats never saved it) or
   * carry no answers, and without this the answered question reloads with live buttons.
   *
   * @param {unknown} args tool_call args
   * @param {string} status terminal tool status
   * @param {unknown} [result] tool_call result
   */
  function resolveQuestionCardsForTool(args, status, result) {
    const questions = args && typeof args === 'object'
      ? /** @type {Record<string, unknown>} */ (args).questions
      : null;
    const signature = questionSignature(questions);
    if (!signature) return;
    const resolvedStatus = status === 'completed' ? 'answered' : 'cancelled';
    const answers = resolvedStatus === 'answered' ? parseAskUserQuestionAnswers(result, questions) : [];
    for (const block of listQuestionCards()) {
      if (block.dataset.questionSignature !== signature) continue;
      applyResolvedQuestionState(block, resolvedStatus, answers);
      const requestId = block.dataset.requestId || '';
      if (requestId && rv.openCodeQuestionByRequestId.get(requestId) === block) {
        rv.openCodeQuestionByRequestId.delete(requestId);
      }
    }
  }

  /**
   * Turns a question card into its read-only record: the inputs go away, the chosen
   * options stay highlighted and each question shows its answer. Safe to call again
   * when a later source knows the answers the first one did not.
   *
   * @param {HTMLElement} block
   * @param {string} status answered | expired | cancelled
   * @param {string[][]} answers one label list per question
   */
  function applyResolvedQuestionState(block, status, answers) {
    const body = block.querySelector('.sdk-rich-opencode-question-body');
    if (!body) return;
    const answered = status !== 'expired' && status !== 'cancelled';
    block.classList.add('sdk-rich-opencode-question--resolved');
    block.classList.toggle('sdk-rich-opencode-question--answered', answered);
    body.querySelectorAll('.sdk-rich-opencode-question-custom, .sdk-rich-opencode-question-actions')
      .forEach((el) => el.remove());
    body.querySelectorAll('button').forEach((el) => {
      /** @type {HTMLButtonElement} */ (el).disabled = true;
    });
    if (!answered) {
      block.classList.add('sdk-rich-opencode-question--expired');
      if (!body.querySelector('.sdk-rich-opencode-question-expired')) {
        const notice = document.createElement('p');
        notice.className = 'sdk-rich-opencode-question-expired';
        notice.textContent = t('sdkView.questionExpired');
        body.appendChild(notice);
      }
      return;
    }
    let shownAnswers = 0;
    body.querySelectorAll('.sdk-rich-opencode-question-item').forEach((section, index) => {
      const chosen = Array.isArray(answers[index]) ? answers[index] : [];
      if (chosen.length === 0) {
        if (section.querySelector('.sdk-rich-opencode-question-answer')) shownAnswers += 1;
        return;
      }
      section.querySelectorAll('.sdk-rich-opencode-question-option').forEach((option) => {
        option.classList.toggle('is-selected', chosen.includes(String(option.textContent || '').trim()));
      });
      let line = section.querySelector('.sdk-rich-opencode-question-answer');
      if (!line) {
        line = document.createElement('p');
        line.className = 'sdk-rich-opencode-question-answer';
        section.appendChild(line);
      }
      line.textContent = t('sdkView.questionAnswerSummary', { answer: chosen.join(', ') });
      shownAnswers += 1;
    });
    const generic = body.querySelector(':scope > .sdk-rich-opencode-question-answer');
    if (shownAnswers > 0) {
      generic?.remove();
    } else if (!generic) {
      const line = document.createElement('p');
      line.className = 'sdk-rich-opencode-question-answer';
      line.textContent = t('sdkView.questionAnswered');
      body.appendChild(line);
    }
  }

  /**
   * @param {string} requestId
   * @param {{ status?: string, answers?: unknown }} [meta]
   */
  function markOpenCodeQuestionResolved(requestId, meta = {}) {
    const id = String(requestId || '').trim();
    if (!id) return;
    const block = rv.openCodeQuestionByRequestId.get(id)
      || listQuestionCards().find((card) => card.dataset.requestId === id);
    if (!block) return;
    const status = typeof meta.status === 'string' && meta.status.trim() ? meta.status.trim() : 'answered';
    applyResolvedQuestionState(block, status, normalizeQuestionAnswers(meta.answers));
    rv.openCodeQuestionByRequestId.delete(id);
  }

  /**
   * @param {Record<string, unknown>} ev
   * @param {{ persist?: boolean }} [options]
   */
  function renderOpenCodeQuestion(ev, options = {}) {
    rv.stopTimeoutProgressSeries();
    const requestId = typeof ev.requestId === 'string' ? ev.requestId.trim() : '';
    const questions = Array.isArray(ev.questions) ? ev.questions : [];
    if (!requestId || questions.length === 0) return;
    if (rv.openCodeQuestionByRequestId.has(requestId)) {
      const existing = rv.openCodeQuestionByRequestId.get(requestId);
      if (existing?.isConnected) return;
      rv.openCodeQuestionByRequestId.delete(requestId);
    }
    const block = rv.createSdkBlock({
      variant: 'question',
      label: t('sdkView.openCodeQuestion'),
      name: 'question',
      open: true,
    });
    block.dataset.requestId = requestId;
    block.dataset.questionSignature = questionSignature(questions);
    block.classList.add('sdk-rich-opencode-question');
    const body = document.createElement('div');
    body.className = 'sdk-rich-opencode-question-body';
    /** @type {Array<Array<string>>} */
    const answers = questions.map(() => []);
    questions.forEach((rawQuestion, questionIndex) => {
      if (!rawQuestion || typeof rawQuestion !== 'object') return;
      const item = /** @type {Record<string, unknown>} */ (rawQuestion);
      const section = document.createElement('section');
      section.className = 'sdk-rich-opencode-question-item';
      const header = document.createElement('h4');
      header.className = 'sdk-rich-opencode-question-header';
      header.textContent = typeof item.header === 'string' && item.header.trim()
        ? item.header.trim()
        : t('sdkView.questionNumbered', { n: questionIndex + 1 });
      section.appendChild(header);
      const prompt = document.createElement('p');
      prompt.className = 'sdk-rich-opencode-question-text';
      prompt.textContent = typeof item.question === 'string' ? item.question : '';
      section.appendChild(prompt);
      const optionsWrap = document.createElement('div');
      optionsWrap.className = 'sdk-rich-opencode-question-options';
      const options = Array.isArray(item.options) ? item.options : [];
      const multiple = item.multiple === true;
      options.forEach((rawOption) => {
        if (!rawOption || typeof rawOption !== 'object') return;
        const option = /** @type {Record<string, unknown>} */ (rawOption);
        const label = typeof option.label === 'string' ? option.label.trim() : '';
        if (!label) return;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'sdk-rich-opencode-question-option';
        button.textContent = label;
        const description = typeof option.description === 'string' ? option.description.trim() : '';
        if (description) button.title = description;
        button.addEventListener('click', () => {
          if (multiple) {
            const idx = answers[questionIndex].indexOf(label);
            if (idx >= 0) {
              answers[questionIndex].splice(idx, 1);
              button.classList.remove('is-selected');
            } else {
              answers[questionIndex].push(label);
              button.classList.add('is-selected');
            }
            return;
          }
          answers[questionIndex] = [label];
          optionsWrap.querySelectorAll('.sdk-rich-opencode-question-option').forEach((el) => {
            el.classList.toggle('is-selected', el === button);
          });
        });
        optionsWrap.appendChild(button);
      });
      section.appendChild(optionsWrap);
      if (item.custom === true) {
        const customInput = document.createElement('input');
        customInput.type = 'text';
        customInput.className = 'sdk-rich-opencode-question-custom';
        customInput.placeholder = t('sdkView.customAnswerPlaceholder');
        customInput.addEventListener('input', () => {
          const value = customInput.value.trim();
          if (!value) return;
          if (multiple) {
            const withoutCustom = answers[questionIndex].filter((entry) => options.some((raw) => {
              if (!raw || typeof raw !== 'object') return false;
              return String(/** @type {Record<string, unknown>} */ (raw).label || '').trim() === entry;
            }));
            answers[questionIndex] = [...withoutCustom, value];
            return;
          }
          answers[questionIndex] = [value];
          optionsWrap.querySelectorAll('.sdk-rich-opencode-question-option').forEach((el) => {
            el.classList.remove('is-selected');
          });
        });
        section.appendChild(customInput);
      }
      body.appendChild(section);
    });
    const actions = document.createElement('div');
    actions.className = 'sdk-rich-opencode-question-actions';
    const submitBtn = document.createElement('button');
    submitBtn.type = 'button';
    submitBtn.className = 'sdk-rich-opencode-question-submit';
    submitBtn.textContent = t('sdkView.submitAnswer');
    submitBtn.addEventListener('click', () => {
      if (typeof hooks.onOpenCodeQuestionReply !== 'function') return;
      const normalized = answers.map((entry) => entry.filter(Boolean));
      if (normalized.some((entry) => entry.length === 0)) return;
      hooks.onOpenCodeQuestionReply({ requestId, answers: normalized });
      // Show the reply right away; the server's questionResolved confirms the same state.
      applyResolvedQuestionState(block, 'answered', normalized);
    });
    const rejectBtn = document.createElement('button');
    rejectBtn.type = 'button';
    rejectBtn.className = 'sdk-rich-opencode-question-reject';
    rejectBtn.textContent = t('sdkView.rejectAnswer');
    rejectBtn.addEventListener('click', () => {
      if (typeof hooks.onOpenCodeQuestionReply !== 'function') return;
      hooks.onOpenCodeQuestionReply({ requestId, reject: true });
      block.classList.add('sdk-rich-opencode-question--rejected');
      submitBtn.disabled = true;
      rejectBtn.disabled = true;
    });
    actions.appendChild(submitBtn);
    actions.appendChild(rejectBtn);
    body.appendChild(actions);
    block.appendChild(body);
    rv.openCodeQuestionByRequestId.set(requestId, block);
    rv.scrollToBottom();
    if (options.persist !== false) rv.persistThisSdkEvent(ev);
  }

  /**
   * @param {Record<string, unknown>} ev
   */
  function renderOpenCodePermission(ev) {
    rv.stopTimeoutProgressSeries();
    const requestId = typeof ev.requestId === 'string' ? ev.requestId.trim() : '';
    const action = typeof ev.action === 'string' ? ev.action.trim() : 'Permission required';
    if (!requestId) return;
    const block = rv.createSdkBlock({
      variant: 'question',
      label: PERMISSION_HARNESS_LABELS[ev.harness]
        ? t('sdkView.harnessPermission', { harness: PERMISSION_HARNESS_LABELS[ev.harness] || ev.harness })
        : t('sdkView.openCodePermission'),
      name: action === 'Permission required' ? '' : action,
      open: true,
    });
    block.dataset.requestId = requestId;
    block.classList.add('sdk-rich-opencode-permission');
    const body = document.createElement('div');
    body.className = 'sdk-rich-opencode-permission-body';
    const title = document.createElement('p');
    title.className = 'sdk-rich-opencode-permission-text';
    title.textContent = action;
    body.appendChild(title);
    const resources = Array.isArray(ev.resources) ? ev.resources : [];
    if (resources.length > 0) {
      const list = document.createElement('ul');
      list.className = 'sdk-rich-opencode-permission-resources';
      resources.forEach((entry) => {
        if (typeof entry !== 'string' || !entry.trim()) return;
        const li = document.createElement('li');
        li.textContent = entry.trim();
        list.appendChild(li);
      });
      body.appendChild(list);
    }
    const actions = document.createElement('div');
    actions.className = 'sdk-rich-opencode-permission-actions';
    const replyButtons = [
      { reply: 'once', label: 'Once', className: 'sdk-rich-opencode-permission-once' },
      { reply: 'always', label: 'Always', className: 'sdk-rich-opencode-permission-always' },
      { reply: 'harness', label: t('sdkView.harnessPermanentGrant', { harness: PERMISSION_HARNESS_LABELS[ev.harness] || ev.harness }), className: 'sdk-rich-opencode-permission-harness' },
      { reply: 'reject', label: 'Reject', className: 'sdk-rich-opencode-permission-reject' },
    ];
    replyButtons.forEach(({ reply, label, className }) => {
      // Persistent callback grants are offered only when the host provides a scope.
      if (reply === 'harness' && ev.allowHarnessGrant !== true) return;
      if (reply === 'always' && ev.allowAlways === false) return;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = className;
      button.textContent = label;
      if (reply === 'always' && ev.allowHarnessGrant === true) button.title = t('sdkView.exactPermissionGrant');
      button.addEventListener('click', () => {
        if (typeof hooks.onOpenCodePermissionReply !== 'function') return;
        rv.clearAdvisorPermissionPick(requestId);
        hooks.onOpenCodePermissionReply({ requestId, reply });
        block.classList.add('sdk-rich-opencode-permission--answered');
        actions.querySelectorAll('button').forEach((el) => {
          el.disabled = true;
        });
      });
      actions.appendChild(button);
    });
    body.appendChild(actions);
    block.appendChild(body);
    rv.openCodePermissionByRequestId.set(requestId, block);
    const buffered = rv.openCodePermissionAdvisorMetaByRequestId.get(requestId);
    if (buffered) rv.markOpenCodePermissionAdvisorStatus(block, requestId, buffered);
    rv.scrollToBottom();
    rv.persistThisSdkEvent(ev);
  }
}
