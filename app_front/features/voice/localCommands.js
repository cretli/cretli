/**
 * Local voice commands for browser voice mode (Web Speech, no model).
 *
 * A whole utterance either is a command or it is a prompt: only short,
 * unambiguous phrases match, so "stop using Redux in the store" still reaches
 * the agent. Every command names the registry action (`action`) the Realtime
 * model would call for the same request, and runs through `commandHandlers`,
 * so the two paths cannot drift (`tests/voice-local-commands.test.js`).
 */

import { parseOptionNumber } from '../car/carChoice.js';
import { commandHandlers } from './commandHandlers.js';
import { describeChatOpsResult } from './voiceChatOpsTools.js';
import { describeInboxResult } from './voiceInboxTools.js';
import { describeOpsResult } from './voiceOpsTools.js';
import { getVoiceSendGate, promptExcerpt } from './voiceSendGate.js';
import { t } from '../../i18n/index.js';

/**
 * Lower-case, strip diacritics (including Polish "ł") and punctuation.
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeSpokenText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/ł/g, 'l')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Lead-in matcher for the original utterance. The normalized matcher ignores case, extra spaces and punctuation
 * between the words, so this one does too; the separator after the lead-in may be spaces, tabs, `:` `,` `;` `.`
 * or a standalone dash, but never a dash glued to the message ("queue this -5.0" keeps "-5.0").
 *
 * @param {string[][]} phrases alternatives, each a list of words
 * @returns {RegExp}
 */
function leadInPattern(phrases) {
  const gap = '[^\\p{L}\\p{N}]+';
  const alternatives = phrases.map((words) => words.join(gap)).join('|');
  return new RegExp(`^[^\\p{L}\\p{N}]*(?:${alternatives})(?:[\\s:,;.]|(?<=[\\s:,;.])[-–—]+(?=\\s))*`, 'iu');
}

const QUEUE_LEAD_IN = leadInPattern([
  ['dopisz', 'do', 'kolejki'], ['dodaj', 'do', 'kolejki'], ['queue', '(?:this|message|up)'], ['add', 'to', '(?:the', ')?queue'],
]);
const STEER_LEAD_IN = leadInPattern([['steruj', 'agentem'], ['popraw', 'kurs', 'agenta'], ['steer', '(?:the', ')?agent']]);

/**
 * @param {string} original the utterance as recognised
 * @param {RegExp} leadIn
 * @returns {string} the words after the lead-in, untouched ('' when the lead-in is not found)
 */
function textAfterLeadIn(original, leadIn) {
  const text = String(original || '');
  return leadIn.test(text) ? text.replace(leadIn, '').trim() : '';
}

const AGENT_NOUN = '(?:agent\\w*|czat\\w*|chat\\w*)';

/**
 * Ordered: the first matching entry wins.
 *
 * @type {ReadonlyArray<{
 *   id: string,
 *   action: string,
 *   pattern: RegExp,
 *   args?: (match: RegExpMatchArray, original: string) => object,
 *   accept?: (match: RegExpMatchArray) => boolean,
 *   needsPendingChoice?: boolean,
 *   notInCarMode?: boolean,
 * }>}
 */
export const LOCAL_COMMANDS = Object.freeze([
  // Only while a car-view pick waits: a bare "yes" or "cancel" is otherwise a prompt.
  {
    id: 'confirm_choice_yes',
    action: 'confirm_choice',
    pattern: /^(?:tak|potwierdzam|potwierdz|zatwierdzam|yes|yep|confirm|confirmed)$/,
    args: () => ({ confirm: true }),
    needsPendingChoice: true,
  },
  {
    id: 'confirm_choice_no',
    action: 'confirm_choice',
    pattern: /^(?:nie|anuluj|odwolaj|no|nope|cancel|never mind)$/,
    args: () => ({ confirm: false }),
    needsPendingChoice: true,
  },
  {
    id: 'choose_option',
    action: 'choose_option',
    pattern: /^(?:opcja|opcje|opcji|wybieram|wybierz|option|choose|select|pick)(?: (?:opcje|numer|number|option))? (.+)$/,
    args: (match) => ({ option: parseOptionNumber(match[1]) }),
    accept: (match) => parseOptionNumber(match[1]) > 0,
  },
  {
    id: 'cycle_card_next',
    action: 'cycle_card',
    pattern: /^(?:nastepn\w+ (?:karta|karte|decyzja|decyzje)|next (?:card|decision))$/,
    args: () => ({ direction: 'next' }),
  },
  {
    id: 'cycle_card_previous',
    action: 'cycle_card',
    pattern: /^(?:poprzedni\w* (?:karta|karte|decyzja|decyzje)|(?:previous|prev) (?:card|decision))$/,
    args: () => ({ direction: 'previous' }),
  },
  {
    id: 'orchestrator_close',
    action: 'orchestrator',
    pattern: /^(?:(?:zamknij|wylacz|wyjdz z) (?:orkiestrator\w*|liste agentow)|(?:close|exit|leave) (?:orchestrator|agents? (?:list|screen|view)))$/,
    args: () => ({ enable: false }),
  },
  {
    id: 'orchestrator_open',
    action: 'orchestrator',
    pattern: /^(?:(?:wlacz |otworz |pokaz )?(?:orkiestrator\w*|wszystkich agentow|wszyscy agenci|liste agentow)|(?:open |show )?(?:orchestrator|all agents|agents (?:list|screen|view)))$/,
    args: () => ({ enable: true }),
  },
  {
    id: 'list_agents',
    action: 'list_agents',
    pattern: /^(?:co robia agenci|co sie dzieje|status agentow|list agents|what are the agents doing|agents status)$/,
  },
  {
    id: 'switch_agent_waiting',
    action: 'switch_agent',
    pattern: /^(?:ktory agent czeka|kto czeka|agent czekajacy|przelacz na czekajacego(?: agenta)?|who is waiting|which agent is waiting|switch to (?:the )?waiting(?: agent)?|waiting agent)$/,
    args: () => ({ waiting: true }),
  },
  // Right after a car-mode announcement: go to the chat it was about.
  {
    id: 'switch_announced',
    action: 'switch_agent',
    pattern: /^(?:przelacz(?: sie)?(?: tam)?|switch(?: there| to it)?|go there)$/,
    args: () => ({ announced: true }),
  },
  {
    id: 'whats_new',
    action: 'whats_new',
    pattern: /^(?:co nowego|powtorz(?: to| ostatnie)?|jeszcze raz|what s new|what is new|repeat(?: that| it)?|say that again)$/,
  },
  {
    id: 'car_mode_close',
    action: 'car_mode',
    pattern: /^(?:(?:zamknij|wylacz|wyjdz z) tryb(?:u)? samochodow\w*|(?:close|exit|leave|stop) car mode)$/,
    args: () => ({ enable: false }),
  },
  {
    id: 'car_mode_open',
    action: 'car_mode',
    pattern: /^(?:(?:wlacz |otworz |uruchom )?tryb samochodowy|(?:open |start )?car mode)$/,
    args: () => ({ enable: true }),
  },
  // Stopping an agent needs a clear phrase. A bare "cancel" / "anuluj" is never one: it means "undo"
  // (see matchSendWindowCommand) or answers a pending pick above.
  {
    id: 'stop_agent',
    action: 'stop_agent',
    pattern: new RegExp(`^(?:stop|zatrzymaj|przerwij|wstrzymaj)(?: (?:to|the|tego))? ${AGENT_NOUN}$`),
  },
  // A bare "stop" is the likeliest misheard or overheard word in a moving car, so it only works outside car mode.
  {
    id: 'stop_agent_bare',
    action: 'stop_agent',
    pattern: /^(?:stop|zatrzymaj|przerwij|wstrzymaj)(?: (?:to|the|tego))?$/,
    notInCarMode: true,
  },
  {
    id: 'cycle_agent_next',
    action: 'cycle_agent',
    pattern: new RegExp(`^(?:nastepn\\w+|next) ${AGENT_NOUN}$`),
    args: () => ({ direction: 'next' }),
  },
  {
    id: 'cycle_agent_previous',
    action: 'cycle_agent',
    pattern: new RegExp(`^(?:poprzedn\\w+|previous|prev) ${AGENT_NOUN}$`),
    args: () => ({ direction: 'previous' }),
  },
  // Explicit phrases only, and a short subject: "find chat.js and fix the import" or "restore chat scroll
  // position after reload" are prompts. Punctuation is stripped before matching.
  {
    id: 'chat_search',
    action: 'chat_ops',
    pattern: /^(?:(?:szukaj|wyszukaj) (?:czatu|czatow|czaty)|(?:search|find) (?:my |all )?chats (?:for|about|named|called)) ((?:\S+ ?){1,6})$/,
    args: (match) => ({ action: 'search', query: match[1].trim() }),
  },
  {
    id: 'chat_restore',
    action: 'chat_ops',
    pattern: /^(?:przywroc (?:z archiwum )?czat(?:u)?|odarchiwizuj czat|restore (?:the )?archived chat|unarchive (?:the )?chat) ((?:\S+ ?){1,5})$/,
    args: (match) => ({ action: 'restore', query: match[1].trim() }),
  },
  // The queued / steered text is the user's own words: it is cut from the original utterance after the lead-in
  // (case, diacritics and punctuation kept), the normalized form only recognises the command.
  {
    id: 'chat_queue',
    action: 'chat_ops',
    pattern: /^(?:dopisz do kolejki|dodaj do kolejki|queue (?:this|message|up)|add to (?:the )?queue) (.+)$/,
    args: (match, original) => ({ action: 'queue', text: textAfterLeadIn(original, QUEUE_LEAD_IN) || match[1] }),
  },
  {
    id: 'chat_steer',
    action: 'chat_ops',
    pattern: /^(?:steruj agentem|popraw kurs agenta|steer (?:the )?agent) (.+)$/,
    args: (match, original) => ({ action: 'steer', text: textAfterLeadIn(original, STEER_LEAD_IN) || match[1] }),
  },
  // Read-only and exact: "git status" inside a longer sentence ("run git status and fix the conflict") is a prompt.
  {
    id: 'git_status',
    action: 'ops',
    pattern: /^(?:git status|status gita|stan gita|jaki jest status gita|co w gicie|pokaz status gita|what s the git status|what is the git status|show git status)$/,
    args: () => ({ action: 'git_status' }),
  },
  {
    id: 'quick_list',
    action: 'ops',
    pattern: /^(?:szybkie komendy|lista szybkich komend|pokaz szybkie komendy|jakie mam szybkie komendy|quick commands|list quick commands|show quick commands|what quick commands do i have)$/,
    args: () => ({ action: 'quick_list' }),
  },
  // Inbox: reading and marking read only; Scout accept / reject need a model for the two-step confirmation.
  {
    id: 'notifications_list',
    action: 'inbox',
    pattern: /^(?:powiadomienia|pokaz powiadomienia|jakie mam powiadomienia|czy mam powiadomienia|notifications|show notifications|any notifications|what notifications do i have)$/,
    args: () => ({ action: 'list_notifications' }),
  },
  {
    id: 'notifications_mark_read',
    action: 'inbox',
    pattern: /^(?:oznacz powiadomienia jako przeczytane|oznacz wszystkie powiadomienia jako przeczytane|mark notifications as read|mark all notifications as read)$/,
    args: () => ({ action: 'mark_read', id: 'all' }),
  },
  {
    id: 'scout_list',
    action: 'inbox',
    pattern: /^(?:propozycje scouta|pokaz propozycje scouta|jakie sa propozycje scouta|scout proposals|show scout proposals|list scout proposals|what has scout found)$/,
    args: () => ({ action: 'list_scout' }),
  },
  {
    id: 'switch_to',
    action: 'switch_chat',
    pattern: /^(?:przelacz sie na|przelacz na|przejdz do|przejdz na|switch to|go to) (.+)$/,
    args: (match) => ({ title: match[1] }),
  },
]);

/**
 * @param {string} text
 * @param {{ commands?: ReadonlyArray<typeof LOCAL_COMMANDS[number]>, hasPendingChoice?: boolean, carMode?: boolean }} [options]
 * @returns {{ id: string, action: string, args: object, spoken: string } | null}
 */
export function matchLocalCommand(text, options = {}) {
  const spoken = normalizeSpokenText(text);
  if (!spoken) return null;
  const commands = options.commands || LOCAL_COMMANDS;
  for (const command of commands) {
    if (command.needsPendingChoice && options.hasPendingChoice !== true) continue;
    if (command.notInCarMode && options.carMode === true) continue;
    const match = spoken.match(command.pattern);
    if (match && (!command.accept || command.accept(match))) {
      return { id: command.id, action: command.action, args: command.args ? command.args(match, String(text || '')) : {}, spoken };
    }
  }
  return null;
}

const UNDO_SEND_PATTERN = /^(?:cofnij|anuluj|odwolaj|nie wysylaj|nie|no|cancel|undo|never mind|do not send|don t send|dont send)(?: (?:to|that|it|this|wysylanie|send|sending))?$/;
const SEND_NOW_PATTERN = /^(?:wyslij|wysylaj|wyslij to|wyslij teraz|send|send it|send that|send now)$/;

/**
 * Phrases for the car-mode undo window, checked only while a spoken prompt
 * waits (it has priority over a pending pick and every other command). They
 * steer local state, not an agent, so they are not registry actions.
 *
 * @param {string} text
 * @returns {'undo_send'|'send_now'|null}
 */
export function matchSendWindowCommand(text) {
  const spoken = normalizeSpokenText(text);
  if (UNDO_SEND_PATTERN.test(spoken)) return 'undo_send';
  if (SEND_NOW_PATTERN.test(spoken)) return 'send_now';
  return null;
}

/**
 * Registry action id -> executor. Mirrors the Realtime handlers but is the
 * only place that knows the browser-voice phrasing.
 *
 * @param {typeof commandHandlers} handlers
 * @param {{ getGate?: () => ReturnType<typeof getVoiceSendGate> }} [options] send gate for queued / steered text
 * @returns {Record<string, (args: any) => Promise<import('./voiceCommandTypes.js').VoiceCommandResult>>}
 */
export function createLocalExecutors(handlers = commandHandlers, options = {}) {
  const getGate = options.getGate || getVoiceSendGate;
  return {
    chat_ops: async (args) => describeChatOpsResult(await handlers.chatOps(args, {
      // Same gate as a spoken prompt: in car mode the text waits in the undo window with a read-back.
      submit: async ({ text, steer }) => {
        const gate = getGate();
        const result = await gate.submit(text, { source: 'speech', steer });
        return result?.ok && result.pending_undo
          ? { ...result, message: t('car.undo.readback', { chat: result.chat, text: promptExcerpt(text) }) }
          : result;
      },
    }), args, t),
    // Only the safe actions (git status, quick list) have a local phrase; the confirm actions need a model.
    ops: async (args) => describeOpsResult(await handlers.ops(args), args, t),
    inbox: async (args) => describeInboxResult(await handlers.inbox(args), args, t),
    stop_agent: () => handlers.stopAgent(),
    cycle_agent: (args) => handlers.cycleChat(args?.direction === 'previous' ? -1 : 1),
    // Browser voice has no model to disambiguate, so a spoken name may also be a workspace.
    switch_chat: (args) => (args?.chat_id ? handlers.switchChat(args) : handlers.switchTo(args?.title)),
    cycle_card: (args) => handlers.cycleCard(args?.direction === 'previous' ? -1 : 1),
    car_mode: (args) => handlers.setCarMode(args?.enable !== false),
    orchestrator: (args) => handlers.setOrchestrator(args?.enable !== false),
    list_agents: () => handlers.listAgents(),
    switch_agent: (args) => handlers.switchAgent(args),
    whats_new: () => handlers.whatsNew(),
    choose_option: (args) => handlers.chooseOption(args),
    confirm_choice: (args) => handlers.confirmChoice(args),
  };
}

/**
 * @param {{ action: string, args: object }} command
 * @param {Record<string, (args: any) => Promise<import('./voiceCommandTypes.js').VoiceCommandResult>>} [executors]
 * @returns {Promise<import('./voiceCommandTypes.js').VoiceCommandResult>}
 */
export async function runLocalCommand(command, executors = createLocalExecutors()) {
  const executor = executors[command.action];
  if (!executor) return { ok: false, error: `No executor for ${command.action}` };
  try {
    return await executor(command.args);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
