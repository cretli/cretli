/**
 * API-side messages (EN default + PL).
 * Language is chosen from the Accept-Language header (EN fallback).
 * The frontend sends Accept-Language matching the user's choice.
 */

const SUPPORTED = ['en', 'pl'];
const DEFAULT_LANG = 'en';

const messages = {
  en: {
    auth: {
      passwordTooShort: 'Password must be at least 8 characters',
      passwordTooLong: 'Password too long',
      noPassword: 'No password set — open /login',
      loginRequired: 'Login required',
      alreadyConfigured: 'Password is already set',
      invalidSetupToken: 'Invalid setup token',
      setupTokenRequired: 'LAN setup requires CRETLI_SETUP_TOKEN',
      passwordNotSet: 'Password is not set — open /login',
      invalidPassword: 'Incorrect password',
      tooManyAttempts: 'Too many attempts — try again in a moment',
    },
    callback: {
      invalidToken: 'Invalid or missing token',
      requiredTodoId: 'Required: todoId',
      noFieldsToUpdate: 'No fields to update',
      requiredChatIdTitle: 'Required: chatId, title',
      requiredChatId: 'Required: chatId',
      requiredSummaryOrTitle: 'Required: summary or title',
    },
    chat: {
      notFound: 'Chat not found',
      sdkOnly: 'SDK transport chats only',
      noSdkAgentId: 'No sdkAgentId — send the first message…',
      noApiKey: 'No API key (CURSOR_API_KEY or Settings).',
      noCursorSessionId: 'Chat has no cursorSessionId',
      forAgentRunRequires: 'forAgentRun requires agentName',
      createFailed: 'Failed to create a session (agent create-chat). {detail}',
      tooLittleContent: 'Too little content in the chat (min. {n} characters). Write something with the agent and try again.',
      missingTextField: 'Missing field: text',
      missingChatId: 'Missing field: chatId',
      forkRequiresMessage: 'Fork requires a message or attachment.',
      forkCopyHistoryFailed: 'Failed to copy chat history.',
      forkRequiresApiKey: 'SDK chat fork requires a configured API key.',
      tempAgentRequiresApiKey:
        'A temporary agent requires an API key: set CURSOR_API_KEY or save the key in Settings (Cursor → Integrations).',
    },
    upload: {
      missingBase64: 'Missing base64 field',
      invalidBase64: 'Invalid base64',
      tooLarge: 'Image too large (max 5 MB)',
      tooSmall: 'File too small',
      unsupportedFormat: 'Unsupported image format',
      processFailed: 'Failed to process the image',
      missingFileName: 'Missing file name',
      invalidFileName: 'Invalid file name',
      invalidFilePath: 'Invalid file path',
    },
    files: {
      noWorkspace: 'No workspace folder',
      outsideWorkspace: 'Path outside the workspace',
      notDirOrMissing: 'Not a directory or does not exist',
      missingPath: 'Missing path parameter',
      fileNotFound: 'File does not exist',
      tooLargeForPreview: 'File too large to preview',
    },
    git: {
      noCommand: 'No git command.',
      runError: 'Git run error.',
      noRepo: 'No git repository in the workspace folder.',
      statusError: 'Git status error.',
      diffError: 'Git diff error.',
      unknownAction: 'Unknown git action.',
      missingValue: 'Missing required value (e.g. branch name).',
      executeError: 'Git execution error.',
    },
    todo: {
      saveError: 'Todo save error',
      notFound: 'Item not found',
      titleRequired: 'Title is required',
      titleEmpty: 'Title cannot be empty',
      missingId: 'Missing id',
      limitReached: 'Limit of {n} items reached',
    },
    tasks: {
      noRunId: 'Missing runId',
      runNotFound: 'Run not found',
      schedulesRequired: 'schedules (array) required',
      workspaceNotFound: 'Workspace not found',
      noTasksFile: 'No .vscode/tasks.json in the workspace.',
      taskNotFound: 'Task "{name}" not found in .vscode/tasks.json',
      runFailed: 'Run error: {detail}',
    },
    pty: {
      sessionEnded: '[Session ended.]',
      taskFinished: '[Task finished.]',
      agentFinished: '[Agent finished.]',
      buildFinished: '[Build finished.]',
      noAgents: 'No agents in .cursor/agents',
    },
    sdk: {
      noApiKey: 'No API key: set CURSOR_API_KEY or save the key in Settings…',
      chatNotFound: 'No SDK chat found for this session.',
      noWorkspaceDir: 'No working directory (workspace / workspaceFolder).',
      activeRunDetected: 'Active run detected. Trying to unlock the session and retry.',
      planBlocked: 'Plan mode blocked execution. The agent should prepare a plan instead of implementing. Switch to Agent to apply changes.',
    },
    generic: {
      invalidAction: 'Invalid action',
      forbidden: 'Access denied',
    },
    widget: {
      endpointUnavailable: 'Endpoint unavailable in a widget session',
      invalidChatId: 'Invalid chat id',
      chatOutOfScope: 'Chat is outside the widget scope',
      invalidOrExpiredSession: 'Invalid or expired widget session',
      invalidSession: 'Invalid widget session',
      pageBridgeAuthMissing: 'Page bridge authorization missing',
      pageBridgeAuthInvalid: 'Invalid page bridge authorization',
      pageBridgeAccessDenied: 'No access to page bridge',
    },
    dev: {
      restartInProgress: 'Server restart is already in progress.',
      restartDisabled: 'In-process restart is disabled in production. Restart the Cretli process or container.',
    },
    settings: {
      sdkTimeoutInvalid: 'SDK timeout must be a whole number of seconds from 15 to 86400.',
    },
  },
  pl: {
    auth: {
      passwordTooShort: 'Hasło musi mieć min. 8 znaków',
      passwordTooLong: 'Hasło za długie',
      noPassword: 'Brak hasła — ustaw przez /login',
      loginRequired: 'Wymagane zalogowanie',
      alreadyConfigured: 'Hasło jest już ustawione',
      invalidSetupToken: 'Nieprawidłowy token instalacyjny',
      setupTokenRequired: 'Konfiguracja w LAN wymaga CRETLI_SETUP_TOKEN',
      passwordNotSet: 'Hasło nie zostało ustawione — otwórz /login',
      invalidPassword: 'Nieprawidłowe hasło',
      tooManyAttempts: 'Zbyt wiele prób — spróbuj za chwilę',
    },
    callback: {
      invalidToken: 'Brak lub nieprawidłowy token',
      requiredTodoId: 'Wymagane: todoId',
      noFieldsToUpdate: 'Brak pól do aktualizacji',
      requiredChatIdTitle: 'Wymagane: chatId, title',
      requiredChatId: 'Wymagane: chatId',
      requiredSummaryOrTitle: 'Wymagane: summary lub title',
    },
    chat: {
      notFound: 'Czat nie znaleziony',
      sdkOnly: 'Tylko czaty z transportem SDK',
      noSdkAgentId: 'Brak sdkAgentId — wyślij pierwszą wiadomość…',
      noApiKey: 'Brak klucza API (CURSOR_API_KEY lub Ustawienia).',
      noCursorSessionId: 'Czat nie ma cursorSessionId',
      forAgentRunRequires: 'forAgentRun wymaga agentName',
      createFailed: 'Nie udało się utworzyć sesji (agent create-chat). {detail}',
      tooLittleContent: 'Za mało treści w czacie (min. {n} znaków). Napisz coś z agentem i spróbuj ponownie.',
      missingTextField: 'Brak pola text',
      missingChatId: 'Brak pola chatId',
      forkRequiresMessage: 'Fork wymaga wiadomości lub załącznika.',
      forkCopyHistoryFailed: 'Nie udało się skopiować historii czatu.',
      forkRequiresApiKey: 'Fork czatu SDK wymaga skonfigurowanego klucza API.',
      tempAgentRequiresApiKey:
        'Tymczasowy agent wymaga klucza API: ustaw CURSOR_API_KEY lub zapisz klucz w Ustawieniach (Cursor → Integrations).',
    },
    upload: {
      missingBase64: 'Brak pola base64',
      invalidBase64: 'Nieprawidłowy base64',
      tooLarge: 'Obraz za duży (max 5 MB)',
      tooSmall: 'Plik za mały',
      unsupportedFormat: 'Nieobsługiwany format obrazu',
      processFailed: 'Nie udało się przetworzyć obrazu',
      missingFileName: 'Brak nazwy pliku',
      invalidFileName: 'Nieprawidłowa nazwa pliku',
      invalidFilePath: 'Nieprawidłowa ścieżka pliku',
    },
    files: {
      noWorkspace: 'Brak katalogu workspace',
      outsideWorkspace: 'Ścieżka poza workspace',
      notDirOrMissing: 'Nie katalog lub nie istnieje',
      missingPath: 'Brak parametru path',
      fileNotFound: 'Plik nie istnieje',
      tooLargeForPreview: 'Plik za duży do podglądu',
    },
    git: {
      noCommand: 'Brak polecenia git.',
      runError: 'Błąd uruchomienia git.',
      noRepo: 'Brak repozytorium git w katalogu workspace.',
      statusError: 'Błąd git status.',
      diffError: 'Błąd git diff.',
      unknownAction: 'Nieznana akcja git.',
      missingValue: 'Brak wymaganej wartości (np. nazwa gałęzi).',
      executeError: 'Błąd wykonania git.',
    },
    todo: {
      saveError: 'Błąd zapisu Todo',
      notFound: 'Nie znaleziono pozycji',
      titleRequired: 'Tytuł jest wymagany',
      titleEmpty: 'Tytuł nie może być pusty',
      missingId: 'Brak id',
      limitReached: 'Limit {n} pozycji',
    },
    tasks: {
      noRunId: 'Brak runId',
      runNotFound: 'Run nie znaleziony',
      schedulesRequired: 'schedules (array) wymagane',
      workspaceNotFound: 'Workspace nie znaleziony',
      noTasksFile: 'Brak .vscode/tasks.json w workspace.',
      taskNotFound: 'Brak zadania „{name}” w .vscode/tasks.json',
      runFailed: 'Błąd uruchomienia: {detail}',
    },
    pty: {
      sessionEnded: '[Sesja zakończona.]',
      taskFinished: '[Zadanie zakończone.]',
      agentFinished: '[Agent zakończony.]',
      buildFinished: '[Budowanie zakończone.]',
      noAgents: 'Brak agentów w .cursor/agents',
    },
    sdk: {
      noApiKey: 'Brak klucza API: ustaw CURSOR_API_KEY lub zapisz klucz w Ustawieniach…',
      chatNotFound: 'Nie znaleziono czatu SDK dla tej sesji.',
      noWorkspaceDir: 'Brak katalogu roboczego (workspace / workspaceFolder).',
      activeRunDetected: 'Wykryto aktywny run. Próbuję odblokować sesję i ponowić.',
      planBlocked: 'Tryb Plan zablokował wykonanie. Zamiast implementacji agent ma przygotować plan. Przełącz na Agent, aby wdrażać zmiany.',
    },
    generic: {
      invalidAction: 'Nieprawidłowa akcja',
      forbidden: 'Brak lub nieprawidłowy token',
    },
    widget: {
      endpointUnavailable: 'Endpoint niedostępny w sesji widgetu',
      invalidChatId: 'Nieprawidłowy identyfikator czatu',
      chatOutOfScope: 'Czat jest poza zakresem widgetu',
      invalidOrExpiredSession: 'Nieprawidłowa lub wygasła sesja widgetu',
      invalidSession: 'Nieprawidłowa sesja widgetu',
      pageBridgeAuthMissing: 'Brak autoryzacji bridge strony',
      pageBridgeAuthInvalid: 'Nieprawidłowa autoryzacja bridge strony',
      pageBridgeAccessDenied: 'Brak dostępu do bridge strony',
    },
    dev: {
      restartInProgress: 'Restart serwera jest już w toku.',
      restartDisabled: 'Restart w procesie jest wyłączony w produkcji. Zrestartuj proces lub kontener Cretli.',
    },
    settings: {
      sdkTimeoutInvalid: 'Timeout SDK musi być pełną liczbą sekund od 15 do 86400.',
    },
  },
};

/** @param {import('http').IncomingMessage} req */
export function pickLang(req) {
  try {
    const header = String(req?.headers?.['accept-language'] || '').toLowerCase();
    if (!header) return DEFAULT_LANG;
    for (const part of header.split(',')) {
      const tag = part.split(';')[0].trim();
      const base = tag.split('-')[0];
      if (SUPPORTED.includes(base)) return base;
    }
  } catch {}
  return DEFAULT_LANG;
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {string} key e.g. 'auth.invalidPassword'
 * @param {Record<string, string|number>} [vars]
 * @returns {string}
 */
export function msg(req, key, vars = null) {
  const lang = pickLang(req);
  const dict = messages[lang] || messages[DEFAULT_LANG];
  let str = lookup(dict, key);
  if (str === undefined) str = lookup(messages[DEFAULT_LANG], key);
  if (str === undefined) return key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      str = str.split(`{${k}}`).join(String(v));
    }
  }
  return str;
}

function lookup(dict, key) {
  const parts = key.split('.');
  let cur = dict;
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in cur) cur = cur[p];
    else return undefined;
  }
  return typeof cur === 'string' ? cur : undefined;
}
