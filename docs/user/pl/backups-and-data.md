---
title: Kopie zapasowe i dane
description: Gdzie Cretli trzyma dane, jakie są narzędzia kopii i jak bezpiecznie przywracać.
---

# Kopie zapasowe i dane

Cretli zapisuje wszystko, co tworzy, w folderze `data/` w katalogu instalacji: czaty, zadania, ustawienia, certyfikaty i poświadczenia. To prywatny stan działania. **Nigdy go nie commituj**, nie kopiuj do repozytorium i nie wklejaj jego plików do czatów. Reguły ignorowania w git już go wykluczają.

## Wybierz narzędzie

| Potrzeba | Narzędzie | Serwer |
| --- | --- | --- |
| Przeniesienie ustawień bez sekretów | Ustawienia → Dane i kopie, eksport ustawień przenośnych | działa |
| Kopia lub archiwum czatów | Eksport rozmów; import tworzy **nowe** czaty | działa |
| Co godzinę lokalne migawki | Kopie automatyczne w `data/backups/auto/` | działa |
| Odtwarzanie po awarii wszystkich danych | `node scripts/cretli-offline-data.mjs` | **zatrzymany** |

## Automatyczne kopie lokalne

Serwer zapisuje migawkę przy starcie i co godzinę. Przechowuje ostatnie kopie godzinowe, dzienne i tygodniowe, każdą z manifestem rozmiarów i sum kontrolnych. Leżą na tym samym dysku, więc nie chronią przed utratą komputera. Wypisz je poleceniem `node scripts/backup-restore.mjs --list`. Przywracanie jest próbą bez zmian, dopóki nie dodasz `--apply`; wcześniej zatrzymaj Cretli i wstrzymaj Watchery.

## Pełna kopia offline

Przy zatrzymanym serwerze `backup --dest DIR` zapisuje zweryfikowaną kopię wszystkich zarządzanych plików. Dodaj `--encrypt`, aby dostać jeden zaszyfrowany plik `.cretlibak`. Sekrety są pomijane, chyba że podasz też `--include-secrets`, więc chroń ten plik i jego hasło. Przed poleganiem na kopii sprawdź ją poleceniem `verify`, a przywracaj przez `restore --backup ŚCIEŻKA --yes`. Po przywróceniu zbiór danych pozostaje wstrzymany: sprawdź wynik, a potem uruchom `node scripts/cretli-offline-data.mjs finalize` i `node scripts/cretli-offline-data.mjs resume`. Dopóki nie wznowisz, praca automatyczna, np. Watchery, pozostaje wyłączona.

## Dobre nawyki

- Regularnie kopiuj kopie na inny komputer lub dysk.
- Zrób kopię przed aktualizacją lub zmianą konfiguracji.
- Od czasu do czasu przetestuj przywracanie na zapasowej kopii.
- Nie udostępniaj publicznie eksportowanych archiwów; czaty mogą zawierać prywatny kod i tokeny.

<!-- sources: docs/backup/recovery-guide.md, docs/backup/local-backups.md, docs/backup/offline-data-recovery.md, docs/backup/conversations-export-import.md -->
