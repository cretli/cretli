/**
 * Polish UI strings specific to the CodeBuddy harness. Merged into the dictionary by
 * app_front/i18n/pl.js, so a harness ships its own translations
 * (docs/ts-migration-and-core-harnesses-plan.md, B2).
 */

export const codebuddyPl = {
  settings: {
    harnessCodeBuddy: 'CodeBuddy',
    harnessStatusCodeBuddyMissing: 'Brak opcjonalnego pakietu @tencent-ai/agent-sdk albo CLI codebuddy',
    harnessCodeBuddyApiTitle: 'CodeBuddy API',
    harnessCodeBuddyHintPrefix: 'Klucz z',
    harnessCodeBuddyHintSuffix: 'Wymagany dla czatów z harnessu CodeBuddy. Zmienna CODEBUDDY_API_KEY ma pierwszeństwo. Potrzebny jest też CLI codebuddy.',
    harnessCodeBuddyApiKeyLabel: 'Nowy klucz API',
    harnessCodeBuddyApiKeyPlaceholder: 'Wklej klucz CodeBuddy i kliknij Zapisz',
    harnessCodeBuddyApiKeySave: 'Zapisz klucz',
    harnessCodeBuddyApiKeyClear: 'Usuń z ustawień',
    harnessCodeBuddyNotReadyNoKey: 'Brak klucza CodeBuddy — wklej klucz powyżej lub ustaw CODEBUDDY_API_KEY na serwerze.',
    harnessCodeBuddyNotReady: 'CodeBuddy nie jest gotowy. Zainstaluj CLI i opcjonalny @tencent-ai/agent-sdk, potem dodaj klucz API.',
    harnessCodeBuddyReady: 'CodeBuddy gotowy — modele pochodzą z Twojego konta Tencent.',
    harnessCodeBuddyModelsTitle: 'CodeBuddy — modele czatu',
    harnessCodeBuddyModelsHint: 'Modele z konta Tencent CodeBuddy (katalog CLI). Zaznacz wpisy widoczne w pickerze dla harnessu CodeBuddy.',
    harnessCodeBuddyModelsEmpty: 'Brak modeli CodeBuddy. Dodaj klucz w Harness → CodeBuddy i zainstaluj CLI.',
  },
  firstRun: {
    hintCodeBuddy: 'Klucz z codebuddy.ai/profile/keys. Potrzebne też CLI codebuddy.',
  },
  chat: {
    contextDetailsTransportCodeBuddy: 'CodeBuddy',
    harnessErrorCodeBuddy: 'CodeBuddy nie jest gotowy — dodaj klucz w Ustawienia → Harness → CodeBuddy, zainstaluj CLI codebuddy i opcjonalny @tencent-ai/agent-sdk.',
    codebuddyDisabled: 'CodeBuddy jest niedostępny. Dodaj CODEBUDDY_API_KEY w Ustawienia → Harness → CodeBuddy, zainstaluj CLI i odśwież.',
    codebuddySdkMissing: 'Opcjonalny pakiet @tencent-ai/agent-sdk nie jest zainstalowany.',
    codebuddyCliMissing: 'Nie znaleziono CLI CodeBuddy. Zainstaluj `codebuddy` albo ustaw CODEBUDDY_CODE_PATH.',
    codebuddyStatusFailed: 'Nie udało się sprawdzić statusu CodeBuddy.',
  },
  lanSettings: {
    codebuddyKeyFromEnv: 'Aktywny klucz: zmienna środowiskowa CODEBUDDY_API_KEY (ma pierwszeństwo nad plikiem ustawień).',
    codebuddyKeyStored: 'Aktywny klucz: zapisany w ustawieniach serwera (wartość nie jest pokazywana).',
    codebuddyKeyMissing: 'Brak aktywnego klucza — wklej poniżej klucz CodeBuddy lub ustaw CODEBUDDY_API_KEY przy starcie procesu Node.',
  },
  usage: {
    harnessCodebuddy: 'CodeBuddy',
  },
};
