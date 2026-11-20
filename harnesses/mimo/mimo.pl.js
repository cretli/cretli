/**
 * Polish UI strings specific to the MiMo harness. Merged into the dictionary by
 * app_front/i18n/pl.js, so a harness ships its own translations
 * (docs/ts-migration-and-core-harnesses-plan.md, B2).
 */

export const mimoPl = {
  settings: {
    harnessMimo: 'MiMo',
    harnessMimoApiTitle: 'API Xiaomi MiMo',
    harnessMimoIndependentHint: 'Te dane logowania są niezależne od własnego dostawcy w OpenCode.',
    harnessMimoApiKey: 'Klucz API MiMo',
    harnessMimoBaseUrl: 'Bazowy URL API MiMo',
    harnessMimoBaseUrlHint: 'Domyślnie https://api.xiaomimimo.com/v1 — zmieniaj tylko dla proxy lub własnej bramy.',
    harnessMimoModelsTitle: 'MiMo — modele czatu',
    harnessMimoModelsHint: 'Wybierz, które modele MiMo pojawią się w selektorze modeli czatu.',
    harnessMimoModelsEmpty: 'Brak dostępnych modeli MiMo. Sprawdź klucz API.',
    harnessMimoNotReadyNoKey: 'Brak klucza API MiMo. Skonfiguruj go w Harness → MiMo.',
    harnessMimoReady: 'API MiMo jest gotowe.',
    harnessStatusMimoMissing: 'Klucz API MiMo nie jest skonfigurowany',
  },
  firstRun: {
    hintMimo: 'Klucz API MiMo z platform.xiaomimimo.com (REST zgodny z OpenAI, bez dodatkowego SDK).',
  },
  chat: {
    mimoDisabled: 'MiMo jest niedostępne. Sprawdź klucz API w Ustawienia → Harness → MiMo.',
    harnessErrorMimo: 'MiMo nie jest gotowe — skonfiguruj klucz API w Ustawienia → Harness → MiMo.',
    mimoStatusFailed: 'Nie udało się sprawdzić statusu MiMo.',
  },
  usage: {
    harnessMimo: 'MiMo',
  },
};
