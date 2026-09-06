import assert from 'node:assert/strict';
import {
  collectQuestionPromptText,
  isPlanApprovalQuestion,
  isPlanImplementAnswer,
  shouldExitPlanModeOnQuestionReply,
} from '../lib/sdk/plan-approval-reply.js';
import { HARNESS_PLAN_MODE_HINT } from '../lib/sdk/harness-plan-prompt.js';

const planQuestion = {
  header: 'Zatwierdzenie',
  questions: [{
    question: 'Czy wdrażać plan „fork od tego miejsca” (fork per wiadomość/odpowiedź, ten sam harness, bez modala)?',
    options: [
      { label: 'Tak, implementuj (Recommended)' },
      { label: 'Tylko user messages' },
      { label: 'Z modalem wyboru' },
    ],
  }],
};

assert.match(collectQuestionPromptText(planQuestion), /wdrażać plan/i);
assert.equal(isPlanApprovalQuestion(planQuestion), true);
assert.equal(isPlanApprovalQuestion({ questions: [{ question: 'Which color?' }] }), false);

assert.equal(isPlanImplementAnswer([['Tak, implementuj (Recommended)']]), true);
assert.equal(isPlanImplementAnswer([['Tylko user messages']]), true);
assert.equal(isPlanImplementAnswer([['No, stay in plan']]), false);
assert.equal(isPlanImplementAnswer([]), false);

assert.equal(
  shouldExitPlanModeOnQuestionReply({
    mode: 'plan',
    questionEvent: planQuestion,
    answers: [['Tak, implementuj (Recommended)']],
  }),
  true,
);
assert.equal(
  shouldExitPlanModeOnQuestionReply({
    mode: 'plan',
    questionEvent: planQuestion,
    answers: [['Tak, implementuj (Recommended)']],
    reject: true,
  }),
  false,
);
assert.equal(
  shouldExitPlanModeOnQuestionReply({
    mode: 'ask',
    questionEvent: planQuestion,
    answers: [['Tak, implementuj (Recommended)']],
  }),
  false,
);
assert.equal(
  shouldExitPlanModeOnQuestionReply({
    mode: 'plan',
    questionEvent: { questions: [{ question: 'Pick a color' }] },
    answers: [['Blue']],
  }),
  false,
);
assert.match(HARNESS_PLAN_MODE_HINT, /question-UI approval/i);
assert.match(HARNESS_PLAN_MODE_HINT, /lifts write restrictions/i);

console.log('plan-approval-reply.test.js OK');
