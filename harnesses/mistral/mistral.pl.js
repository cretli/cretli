/**
 * Polish UI strings specific to the Mistral harness. Merged into the dictionary by
 * app_front/i18n/pl.js, so a harness ships its own translations
 * (docs/ts-migration-and-core-harnesses-plan.md, B2).
 */

export const mistralPl = {
  settings: {
    harnessMistral: 'Mistral',
    harnessStatusMistralMissing: 'Brak pakietu @mistralai/mistralai',
    harnessMistralApiTitle: 'Mistral Vibe Code',
    harnessMistralHintPrefix: 'Utwórz klucz Vibe w',
    harnessMistralHintSuffix: 'Zapisz oba klucze i wybierz, którego mają używać nowe czaty. Klucz planowy Vibe CLI zużywa limit Vibe Code, a klucz Studio — limit API. Wymagany jest też pakiet @mistralai/mistralai.',
    harnessMistralApiKeyLabel: 'Klucz Studio API',
    harnessMistralApiKeyPlaceholder: 'Wklej klucz Studio API i kliknij Zapisz',
    harnessMistralVibeKeyLabel: 'Klucz Vibe Code',
    harnessMistralVibeKeyPlaceholder: 'Wklej klucz Vibe Code i kliknij Zapisz',
    harnessMistralBillingModeLabel: 'Klucz używany w nowych czatach',
    harnessMistralBillingAuto: 'Vibe Code, jeśli skonfigurowano',
    harnessMistralBillingVibe: 'Limit Vibe Code',
    harnessMistralBillingApi: 'Limit Studio API',
    harnessMistralApiKeySave: 'Zapisz klucz',
    harnessMistralApiKeyClear: 'Usuń z ustawień',
    harnessMistralNotReadyNoKey: 'Brak klucza Mistral — wklej klucz Vibe Code powyżej lub ustaw MISTRAL_VIBE_API_KEY na serwerze.',
    harnessMistralNotReady: 'Mistral nie jest gotowy. Zainstaluj @mistralai/mistralai, a następnie dodaj klucz API.',
    harnessMistralReady: 'Mistral gotowy — aktualny katalog modeli.',
    harnessMistralModelsTitle: 'Mistral — modele czatu',
    harnessMistralModelsHint: 'Modele z API Mistral, gdy ustawiono klucz (zapasowo: lista wbudowana). Zaznacz pozycje dla wyboru w czacie.',
    harnessMistralModelsEmpty: 'Brak modeli Mistral. Dodaj klucz w Harness → Mistral i zainstaluj @mistralai/mistralai.',
  },
  firstRun: {
    hintMistral: 'Klucz z console.mistral.ai/api-keys. Zainstaluj pakiet @mistralai/mistralai.',
  },
  chat: {
    contextDetailsTransportMistral: 'Mistral',
    harnessErrorMistral: 'Mistral nie jest gotowy — dodaj klucz w Ustawienia → Harness → Mistral i zainstaluj @mistralai/mistralai.',
    mistralDisabled: 'Mistral jest niedostępny. Dodaj MISTRAL_API_KEY w Ustawienia → Harness → Mistral, zainstaluj @mistralai/mistralai i odśwież.',
    mistralSdkMissing: 'Pakiet @mistralai/mistralai nie jest zainstalowany.',
    mistralStatusFailed: 'Nie udało się sprawdzić statusu Mistral.',
    mistralAuthError: 'Mistral odrzucił klucz API. Sprawdź go w Ustawienia → Harness → Mistral.',
    mistralRateLimitError: 'Osiągnięto limit zapytań Mistral. Odczekaj chwilę i spróbuj ponownie.',
  },
  lanSettings: {
    mistralKeyFromEnv: 'Aktywny klucz: zmienna środowiskowa MISTRAL_API_KEY (nadpisuje plik ustawień).',
    mistralKeyStored: 'Aktywny klucz: zapisany w ustawieniach serwera (wartość nie jest pokazywana).',
    mistralKeyMissing: 'Brak aktywnego klucza — wklej poniżej klucz Mistral lub ustaw MISTRAL_API_KEY przy starcie procesu Node.',
    mistralVibeKeyFromEnv: 'Aktywny klucz: MISTRAL_VIBE_API_KEY (limit Vibe Code).',
    mistralVibeKeyStored: 'Aktywny klucz: klucz Vibe Code zapisany w ustawieniach serwera (wartość nie jest pokazywana).',
  },
  usage: {
    harnessMistral: 'Mistral',
  },
  harnessVersion: {
    installMistral: 'Zainstaluj Mistral',
  },
};
