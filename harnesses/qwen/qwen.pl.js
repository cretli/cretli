/**
 * Polish UI strings specific to the Qwen harness. Merged into the dictionary by
 * app_front/i18n/pl.js, so a harness ships its own translations
 * (docs/ts-migration-and-core-harnesses-plan.md, B2).
 */

export const qwenPl = {
  settings: {
    harnessQwen: 'Qwen',
    harnessStatusQwenMissing: 'Brak opcjonalnego pakietu @qwen-code/sdk',
    harnessQwenApiTitle: 'Qwen Cloud API',
    harnessQwenHintPrefix: 'Klucz z',
    harnessQwenHintSuffix: ' (API Keys). QWEN_API_KEY ma pierwszeństwo. Potrzebny jest też opcjonalny pakiet @qwen-code/sdk.',
    harnessQwenEndpointLabel: 'Plan Qwen Cloud',
    harnessQwenEndpointPayg: 'Pay-as-you-go',
    harnessQwenEndpointTokenPlan: 'Token Plan',
    harnessQwenEndpointCodingPlan: 'Coding Plan',
    harnessQwenEndpointCustom: 'Własny URL',
    harnessQwenBaseUrlLabel: 'Własny base URL',
    harnessQwenBaseUrlPlaceholder: 'https://…',
    harnessQwenApiKeyLabel: 'Nowy klucz API',
    harnessQwenApiKeyPlaceholder: 'Wklej klucz Qwen Cloud i kliknij Zapisz',
    harnessQwenApiKeySave: 'Zapisz klucz',
    harnessQwenApiKeyClear: 'Usuń z ustawień',
    harnessQwenNotReadyNoKey: 'Brak klucza Qwen Cloud — wklej klucz powyżej lub ustaw QWEN_API_KEY na serwerze.',
    harnessQwenNotReadySdkMissing: 'Brak pakietu @qwen-code/sdk. Zainstaluj go i zrestartuj serwer. Klucz API jest już zapisany.',
    harnessQwenNotReady: 'Qwen Code nie jest gotowy. Zainstaluj @qwen-code/sdk, potem dodaj klucz API.',
    harnessQwenResolvedUrl: 'URL API dla tego planu:',
    harnessQwenReady: 'Qwen Code gotowy — API OpenAI-compatible z Qwen Cloud.',
    harnessQwenModelsTitle: 'Qwen — modele czatu',
    harnessQwenModelsHint: 'Live lista Qwen Cloud /models przy ustawionym kluczu; inaczej fallback planu (3.8 Max / Plus / Coder). Zaznacz wpisy widoczne w pickerze.',
    harnessQwenModelsEmpty: 'Brak modeli Qwen. Dodaj klucz w Harness → Qwen i zainstaluj @qwen-code/sdk.',
  },
  firstRun: {
    hintQwen: 'Klucz z home.qwencloud.com (API Keys). Zainstaluj opcjonalne @qwen-code/sdk.',
  },
  chat: {
    contextDetailsTransportQwen: 'Qwen',
    qwenQuotaError: 'Qwen Cloud: wyczerpany limit tokenów albo zbyt wiele zapytań. {detail}',
    qwenAuthError: 'Qwen Cloud: błąd autoryzacji. {detail} Sprawdź klucz API w Ustawienia → Harness → Qwen.',
    harnessErrorQwen: 'Qwen Code nie jest gotowy — dodaj klucz w Ustawienia → Harness → Qwen i zainstaluj @qwen-code/sdk.',
    qwenDisabled: 'Qwen Code jest niedostępny. Dodaj QWEN_API_KEY w Ustawienia → Harness → Qwen, zainstaluj @qwen-code/sdk i odśwież.',
    qwenSdkMissing: 'Opcjonalny pakiet @qwen-code/sdk nie jest zainstalowany.',
    qwenStatusFailed: 'Nie udało się sprawdzić statusu Qwen Code.',
  },
  lanSettings: {
    qwenKeyFromEnv: 'Aktywny klucz: zmienna środowiskowa QWEN_API_KEY (ma pierwszeństwo nad plikiem ustawień).',
    qwenKeyStored: 'Aktywny klucz: zapisany w ustawieniach serwera (wartość nie jest pokazywana).',
    qwenKeyMissing: 'Brak aktywnego klucza — wklej poniżej klucz Qwen Cloud lub ustaw QWEN_API_KEY przy starcie procesu Node.',
  },
  usage: {
    harnessQwen: 'Qwen',
  },
};
