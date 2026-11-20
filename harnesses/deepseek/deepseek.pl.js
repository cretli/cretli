/**
 * Polish UI strings specific to the DeepSeek harness. Merged into the dictionary by
 * app_front/i18n/pl.js, so a harness ships its own translations
 * (docs/ts-migration-and-core-harnesses-plan.md, B2).
 */

export const deepseekPl = {
  settings: {
    harnessDeepSeek: 'DeepSeek',
    harnessStatusDeepSeekMissing: 'Brak opcjonalnych pakietów @deepseek-ai/dsh-sdk-client albo @deepseek-ai/dsh',
    harnessDeepSeekApiTitle: 'DeepSeek API',
    harnessDeepSeekHintPrefix: 'Klucz z',
    harnessDeepSeekHintSuffix: 'Wymagany dla czatów DeepSeek Harness. Zmienna DEEPSEEK_API_KEY ma pierwszeństwo. Potrzebne są też opcjonalne pakiety @deepseek-ai/dsh-sdk-client i @deepseek-ai/dsh.',
    harnessDeepSeekApiKeyLabel: 'Nowy klucz API',
    harnessDeepSeekApiKeyPlaceholder: 'Wklej klucz DeepSeek i kliknij Zapisz',
    harnessDeepSeekApiKeySave: 'Zapisz klucz',
    harnessDeepSeekApiKeyClear: 'Usuń z ustawień',
    harnessDeepSeekNotReadyNoKey: 'Brak klucza DeepSeek — wklej klucz powyżej lub ustaw DEEPSEEK_API_KEY na serwerze.',
    harnessDeepSeekNotReady: 'DeepSeek Harness nie jest gotowy. Zainstaluj @deepseek-ai/dsh-sdk-client i @deepseek-ai/dsh, potem dodaj klucz API.',
    harnessDeepSeekReady: 'DeepSeek Harness gotowy — live katalog oficjalny (V4.1 Flash / V4 Pro).',
    harnessDeepSeekModelsTitle: 'DeepSeek — modele czatu',
    harnessDeepSeekModelsHint: 'Modele z GET /models przy ustawionym kluczu (fallback: deepseek-flash / deepseek-v4-pro). Zaznacz wpisy widoczne w pickerze.',
    harnessDeepSeekModelsEmpty: 'Brak modeli DeepSeek. Dodaj klucz w Harness → DeepSeek i zainstaluj opcjonalne pakiety.',
  },
  firstRun: {
    hintDeepSeek: 'Klucz z platform.deepseek.com/api_keys. Zainstaluj opcjonalne @deepseek-ai/dsh-sdk-client i @deepseek-ai/dsh.',
  },
  chat: {
    contextDetailsTransportDeepSeek: 'DeepSeek',
    harnessErrorDeepSeek: 'DeepSeek Harness nie jest gotowy — dodaj klucz w Ustawienia → Harness → DeepSeek i zainstaluj @deepseek-ai/dsh-sdk-client oraz @deepseek-ai/dsh.',
    deepseekDisabled: 'DeepSeek Harness jest niedostępny. Dodaj DEEPSEEK_API_KEY w Ustawienia → Harness → DeepSeek, zainstaluj opcjonalne pakiety i odśwież.',
    deepseekSdkMissing: 'Opcjonalny pakiet @deepseek-ai/dsh-sdk-client nie jest zainstalowany.',
    deepseekCliMissing: 'Nie znaleziono CLI DeepSeek Harness. Zainstaluj @deepseek-ai/dsh albo ustaw DSH_BIN.',
    deepseekStatusFailed: 'Nie udało się sprawdzić statusu DeepSeek Harness.',
  },
  lanSettings: {
    deepseekKeyFromEnv: 'Aktywny klucz: zmienna środowiskowa DEEPSEEK_API_KEY (ma pierwszeństwo nad plikiem ustawień).',
    deepseekKeyStored: 'Aktywny klucz: zapisany w ustawieniach serwera (wartość nie jest pokazywana).',
    deepseekKeyMissing: 'Brak aktywnego klucza — wklej poniżej klucz DeepSeek lub ustaw DEEPSEEK_API_KEY przy starcie procesu Node.',
  },
  usage: {
    harnessDeepseek: 'DeepSeek',
  },
};
