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
      invalidCsrf: 'Invalid or missing CSRF token — refresh the page and try again',
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
      branchesError: 'Failed to list branches.',
      workspaceBusy: 'Work is still running in this workspace ({chats} chat run(s), {delegations} delegation(s), {watcher} watcher cycle(s)). Stop it before switching branches.',
    },
    todo: {
      saveError: 'Todo save error',
      blockedByTree: 'Complete earlier subtasks and approve the parent plan before starting this task.',
      notFound: 'Item not found',
      titleRequired: 'Title is required',
      titleEmpty: 'Title cannot be empty',
      missingId: 'Missing id',
      limitReached: 'Limit of {n} items reached',
      worktreeDirty: 'The main tree has uncommitted changes. Choose to commit manually, start from HEAD, or start from a snapshot.',
      worktreeBranchCollision: 'The worktree branch already exists. Delete or rename it (or clean up the previous worktree) and start again.',
      worktreePathExists: 'The worktree directory already exists but is not registered to this task. Remove it or choose another name.',
      worktreeMissing: 'The previous worktree is missing. Recreate the execution or clean up the record.',
      worktreeForeign: 'The worktree is not owned by this task (foreign or orphaned). Inspect it by hand before retrying.',
      worktreeOwnerMismatch: 'The worktree ownership marker does not match. Refusing to adopt it.',
      worktreeExternalChange: 'The worktree changed since it was frozen. Inspect it and start a new execution.',
      worktreeMixing: 'This tree already has a live worktree under a different key (a manual root or a Watcher leaf). Mixing is not supported; finish or clean up the existing worktree first.',
      worktreeBusy: 'The worktree is busy (preparing or active). Try again once the execution closes.',
      worktreeUnaccepted: 'The worktree result is not integrated and needs an explicit discard confirmation.',
      worktreeNotGit: 'The workspace is not a Git repository, so worktree mode is unavailable.',
      worktreeConfigInvalid: 'The watcher policy has no valid worktree layout. Configure the worktree settings first.',
      worktreeModeInvalid: 'Invalid execution mode for the tree root.',
      worktreePrepareFailed: 'The worktree prepare step failed. Check the prepare command and try again.',
      worktreeReuseMismatch: 'The linked chat already runs in a different execution folder; start a fresh chat instead.',
      worktreeReuseBusy: 'The linked chat has a live run; stop it before its execution folder can be re-pointed.',
      worktreeFrozen: 'This task tree already owns a worktree, so project mode was not applied. Start with release_worktree=true to move it back to the project folder.',
      worktreeDeleteBlocked: 'This task tree still owns a live worktree. Finish or clean it up before deleting, or pass force to discard it.',
      worktreeReparentBlocked: 'This task tree still owns a live worktree; moving it would orphan that worktree. Finish or clean it up first.',
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
    fs: {
      notFound: 'That path does not exist on the server.',
      notDir: 'That path is not a folder.',
      readError: 'Could not read that folder.',
      invalidName: 'Invalid folder name.',
      exists: 'A folder with that name already exists.',
      permission: 'No permission to create a folder here.',
      mkdirError: 'Could not create that folder.',
    },
    settings: {
      sdkTimeoutInvalid: 'SDK timeout must be a whole number of seconds from 15 to 86400.',
      workspacePathInvalid: 'That path is not a folder or a .code-workspace file.',
      workspaceFileNotInRegistry: 'That workspace file is not in the Cretli workspace list.',
    },
    update: {
      noRepo: 'This install is not a git clone. Update from Settings is unavailable.',
      busy: 'An update is already running.',
      activeRuns: 'A run is still in progress. Wait for it to finish before updating.',
      activeRunsUnknown: 'Could not verify active runs. Try again before updating or installing.',
      restartInProgress: 'A server restart is already scheduled. Try the update after the restart.',
      notAcceptingRuns: 'An update or install is in progress. New runs are not accepted until it finishes.',
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
      invalidCsrf: 'Brak lub nieprawidłowy token CSRF — odśwież stronę i spróbuj ponownie',
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
      branchesError: 'Nie udało się pobrać listy gałęzi.',
      workspaceBusy: 'W tym workspace nadal trwa praca ({chats} uruchomienie(nia) czatu, {delegations} delegacje, {watcher} cykl(e) watchera). Zatrzymaj ją przed przełączeniem gałęzi.',
    },
    todo: {
      saveError: 'Błąd zapisu Todo',
      blockedByTree: 'Najpierw ukończ wcześniejsze podzadania i zatwierdź plan rodzica.',
      notFound: 'Nie znaleziono pozycji',
      titleRequired: 'Tytuł jest wymagany',
      titleEmpty: 'Tytuł nie może być pusty',
      missingId: 'Brak id',
      limitReached: 'Limit {n} pozycji',
      worktreeDirty: 'Główne drzewo ma niezacommitowane zmiany. Zacommituj je ręcznie, rozpocznij z HEAD albo utwórz migawkę.',
      worktreeBranchCollision: 'Gałąź worktree już istnieje. Usuń ją lub zmień nazwę (albo posprzątaj poprzedni worktree) i spróbuj ponownie.',
      worktreePathExists: 'Katalog worktree już istnieje, ale nie jest zarejestrowany dla tego zadania. Usuń go lub wybierz inną nazwę.',
      worktreeMissing: 'Poprzedni worktree zniknął. Utwórz nowe wykonanie albo posprzątaj rekord.',
      worktreeForeign: 'Worktree nie należy do tego zadania (obcy lub osierocony). Sprawdź go ręcznie przed ponowną próbą.',
      worktreeOwnerMismatch: 'Znacznik właściciela worktree się nie zgadza. Odmowa przejęcia.',
      worktreeExternalChange: 'Worktree zmienił się od zamrożenia. Sprawdź go i rozpocznij nowe wykonanie.',
      worktreeMixing: 'To drzewo ma już żywy worktree pod innym kluczem (ręczny root albo liść Watchera). Mieszanie jest nieobsługiwane; najpierw ukończ lub posprzątaj istniejący worktree.',
      worktreeBusy: 'Worktree jest zajęty (przygotowanie lub aktywne wykonanie). Spróbuj, gdy wykonanie się zamknie.',
      worktreeUnaccepted: 'Wynik worktree nie jest zintegrowany i wymaga wyraźnego potwierdzenia odrzucenia.',
      worktreeNotGit: 'Workspace nie jest repozytorium Git, więc tryb worktree jest niedostępny.',
      worktreeConfigInvalid: 'Polityka watchera nie ma poprawnego układu worktree. Najpierw skonfiguruj ustawienia worktree.',
      worktreeModeInvalid: 'Nieprawidłowy tryb wykonania dla korzenia drzewa.',
      worktreePrepareFailed: 'Krok przygotowania worktree nie powiódł się. Sprawdź komendę przygotowania i spróbuj ponownie.',
      worktreeReuseMismatch: 'Powiązany czat działa w innym folderze wykonania; uruchom nowy czat.',
      worktreeReuseBusy: 'Powiązany czat ma żywy run; zatrzymaj go, zanim folder wykonania zostanie przepięty.',
      worktreeFrozen: 'To drzewo zadań ma już worktree, więc tryb project nie został zastosowany. Uruchom z release_worktree=true, aby przenieść je z powrotem do katalogu projektu.',
      worktreeDeleteBlocked: 'To drzewo zadań ma żywy worktree. Ukończ go lub posprzątaj przed usunięciem albo wymuś usunięcie.',
      worktreeReparentBlocked: 'To drzewo zadań ma żywy worktree; przeniesienie go osierociłoby worktree. Ukończ go lub posprzątaj najpierw.',
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
    fs: {
      notFound: 'Ta ścieżka nie istnieje na serwerze.',
      notDir: 'Ta ścieżka nie jest katalogiem.',
      readError: 'Nie udało się odczytać tego katalogu.',
      invalidName: 'Nieprawidłowa nazwa folderu.',
      exists: 'Folder o tej nazwie już istnieje.',
      permission: 'Brak uprawnień, żeby utworzyć tu folder.',
      mkdirError: 'Nie udało się utworzyć folderu.',
    },
    settings: {
      sdkTimeoutInvalid: 'Timeout SDK musi być pełną liczbą sekund od 15 do 86400.',
      workspacePathInvalid: 'Ta ścieżka nie jest katalogiem ani plikiem .code-workspace.',
      workspaceFileNotInRegistry: 'Ten plik workspace nie jest na liście Cretli.',
    },
    update: {
      noRepo: 'Ta instalacja nie jest klonem gita. Aktualizacja z Ustawień jest niedostępna.',
      busy: 'Aktualizacja już trwa.',
      activeRuns: 'Uruchomienie nadal trwa. Poczekaj na jego zakończenie przed aktualizacją.',
      activeRunsUnknown: 'Nie udało się sprawdzić aktywnych uruchomień. Spróbuj ponownie przed aktualizacją.',
      restartInProgress: 'Restart serwera jest już zaplanowany. Zaktualizuj po restarcie.',
      notAcceptingRuns: 'Trwa aktualizacja lub instalacja. Nowe uruchomienia nie są przyjmowane do jej zakończenia.',
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
