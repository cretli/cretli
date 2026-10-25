/**
 * Polish UI strings specific to the OpenRouter harness. Merged into the dictionary by
 * app_front/i18n/pl.js, so a harness ships its own translations
 * (docs/ts-migration-and-core-harnesses-plan.md, B2).
 */

export const openrouterPl = {
  settings: {
    harnessOpenRouter: 'OpenRouter',
    harnessOpenRouterTitle: 'OpenRouter API',
    harnessOpenRouterHintPrefix: 'Klucz z',
    harnessOpenRouterHintSuffix: 'Wymagany dla czatów z harnessu OpenRouter. Zmienna OPENROUTER_API_KEY ma pierwszeństwo.',
    harnessOpenRouterModelsTitle: 'OpenRouter — modele czatu',
    harnessOpenRouterModelsHint: 'Modele z klucza OpenRouter. Zaznacz pozycje widoczne w selektorze modelu dla czatów z harnessu OpenRouter.',
    harnessOpenRouterModelsEmpty: 'Brak modeli OpenRouter. Dodaj klucz API w Harness → OpenRouter.',
  },
  firstRun: {
    hintOpenRouter: 'Klucz z openrouter.ai/keys. Najprostsza ścieżka na telefonie.',
  },
  chat: {
    contextDetailsTransportOpenrouter: 'OpenRouter',
    harnessErrorOpenrouter: 'Czat OpenRouter wymaga poprawnego klucza API (Ustawienia → Harness → OpenRouter). Klucz musi zaczynać się od sk-or-v1-.',
    openrouterStatusFailed: 'Nie udało się pobrać statusu OpenRouter — tworzenie czatu niedostępne.',
    openrouterDisabled: 'OpenRouter jest niedostępny (brak klucza API na serwerze). Ustawienia → OpenRouter, albo OPENROUTER_API_KEY, potem odśwież stronę.',
  },
  lanSettings: {
    openrouterKeyFromEnv: 'Aktywny klucz: zmienna środowiskowa OPENROUTER_API_KEY (ma pierwszeństwo nad plikiem ustawień).',
    openrouterKeyInvalidFormat: 'Zapisany klucz ma nieprawidłowy format — klucze OpenRouter zaczynają się od sk-or-v1-. Utwórz klucz na openrouter.ai/keys.',
    openrouterKeyStored: 'Aktywny klucz: zapisany w ustawieniach serwera (wartość nie jest pokazywana).',
    openrouterKeyMissing: 'Brak aktywnego klucza — dodaj go poniżej lub ustaw OPENROUTER_API_KEY przy starcie procesu Node.',
  },
  usage: {
    openrouter: 'OpenRouter',
    harnessOpenrouter: 'OpenRouter',
  },
  harnessModelStats: {
    priceSource: {
      openrouter_pricing: 'katalog OpenRouter',
    },
  },
};
