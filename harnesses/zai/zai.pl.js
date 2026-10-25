/**
 * Polish UI strings specific to the Z.AI SDK harness. Merged into the dictionary by
 * app_front/i18n/pl.js, so a harness ships its own translations
 * (docs/ts-migration-and-core-harnesses-plan.md, B2).
 */

export const zaiPl = {
  settings: {
    harnessZai: 'Z.AI SDK',
    harnessZaiApiTitle: 'Oficjalne SDK Z.AI',
    harnessZaiIndependentHint: 'Ten klucz i dostawca są niezależne od ustawień OpenCode.',
    harnessZaiProvider: 'Dostawca / plan',
    harnessZaiApiKey: 'Klucz API Z.AI',
    harnessZaiProviderSaving: 'Zapisywanie dostawcy…',
    harnessZaiInstallSdk: 'Zainstaluj oficjalne SDK Python',
    harnessZaiSdkRestartHint: 'Po instalacji uruchom ponownie serwer, jeśli status SDK się nie zaktualizuje.',
    harnessZaiModelsTitle: 'Z.AI — modele czatu',
    harnessZaiModelsHint: 'Wybierz modele Z.AI widoczne na liście modeli czatu.',
    harnessZaiModelsEmpty: 'Brak modeli Z.AI. Sprawdź klucz API i instalację SDK.',
    harnessZaiNotReadyNoKey: 'Brak klucza API Z.AI SDK. Skonfiguruj go w Harness → Z.AI.',
    harnessZaiNotReady: 'SDK Z.AI nie jest gotowe. Sprawdź instalację SDK i klucz API.',
    harnessZaiReady: 'SDK Z.AI jest gotowe.',
    harnessZaiInstallingSdk: 'Instalowanie oficjalnego SDK…',
    harnessZaiSdkInstalled: 'SDK zainstalowane i dostępne.',
    harnessZaiInstallFailed: 'Nie udało się zainstalować SDK Z.AI.',
    harnessStatusZaiMissing: 'Brak oficjalnego pakietu Python zai-sdk',
  },
  firstRun: {
    hintZai: 'Klucz API z platformy Z.AI. Zainstaluj oficjalne SDK Python poleceniem npm run setup:zai-sdk.',
  },
  chat: {
    harnessErrorZai: 'Harness Z.AI SDK nie jest gotowy — skonfiguruj jego klucz API w Ustawienia → Harness → Z.AI i zainstaluj SDK poleceniem npm run setup:zai-sdk.',
    zaiSdkMissing: 'Brak oficjalnego SDK Python dla Z.AI. Uruchom npm run setup:zai-sdk na serwerze.',
    zaiDisabled: 'Z.AI jest niedostępne. Sprawdź klucz API i instalację oficjalnego SDK w ustawieniach.',
    zaiStatusFailed: 'Nie udało się sprawdzić statusu Z.AI SDK.',
  },
  usage: {
    harnessZai: 'Z.AI SDK',
  },
};
