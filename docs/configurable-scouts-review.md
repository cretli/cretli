# Weryfikacja planu konfigurowalnych Scoutów

Data: 2026-10-06. TODO: `7acf66ec-d231-4c94-9492-aef8ac00f600`.
Recenzent: DeepSeek V4.1 Flash, delegacja `2dd5a932-0c59-48d9-a522-fd9f14503b6b`.

DeepSeek ocenił pierwotny plan jako FAIL: wymagał doprecyzowania modelu wielu skanów i łączenia źródeł. Rodzic przeczytał cały raport, sprawdził wskazany kod i odtworzył istotne zachowania przez read-only probe Node. Potwierdzone uwagi zapisano w specyfikacji i podzadaniach. Nie implementowano funkcji i nie wykonywano ponownej recenzji DeepSeek po zmianach projektu.

## Potwierdzone uwagi i korekty

| Priorytet | Luka w projekcie | Dowód obecnego zachowania | Decyzja |
| --- | --- | --- | --- |
| P1 | Zbyt ogólny opis stanu równoległych skanów i migracji | `workspace-watcher-scout.js`: reserve 1111, set 1471, submit 1654; `workspace-watcher.js`: parent IDs 297; `mcp-inprocess-client.js`: autofill 643 | Kolekcja activeScoutScans, selekcja po scanId/chatId, migracja tokenów, przepięcie wszystkich konsumentów, atomowa zajętość i rozliczanie rezerwacji. |
| P1 | Brak kontraktu atomowego merge źródeł | dedupe 912 odrzuca already_pending; record 1236 dopisuje nowe; normalizator w `workspace-watchers-persist.js`:261–315 nie zachowuje nowych pól w submit | sources[] z atrybucją serwera, dedupe i zapis pod jednym lockiem, idempotentne źródła i zachowanie decyzji użytkownika. |
| P2 | Brak polityki pełnej skrzynki | persist:72,335 i scout:1241 ograniczają kolekcję do ostatnich 200 | Nie usuwać pending; nowe unikalne wyniki ponad limit jawnie odrzucać, merge dopuścić, zapisać capacity_exceeded. |
| P2 | Historia i retencja bez ustalonego kontraktu | persist:342 przechowuje tylko day/count; runner:1956 zwraca dane executora, nie pełną trwałą historię | Zdefiniować rekord skanu w kroku 1, oddzielić szczegóły historii od źródeł/decyzji, powiązać usage z ledgerem, brak pomiaru oznaczać null. |
| P2 | Niejasna precedencja wyboru modelu i semantyka pustych ustawień | persist:464 fallback kategorii; scout:1722 zastępuje allowedHarnesses; orchestrator:150 explicit override | Legacy adapter, walidacja nowych profili, jawny executor profilu ma pierwszeństwo, auto nowego profilu niezależne od executora TODO, zachować istniejący fallback allowed harnessów. |
| P2 | Sprzeczność „wyłączony” i „uruchom ręcznie”; brak granicy etapu pośredniego | Dwa różne znaczenia enabled w pierwotnym opisie; równoległość planowana przed zakończeniem etapu API/submit | enabled profilu dotyczy automatyki, globalny scoutEnabled wszystkich startów. Nowa równoległość w produkcji dopiero po kompletnym kroku 4. |

Nie są to dowody, że nowa funkcja jest już błędnie zaimplementowana. Singleton, odrzucanie duplikatów i brak historii per profil opisują dzisiejszego Scouta. Oryginalny plan przewidywał ich rozbudowę; korekty uszczegóławiają sposób i odbiór tej rozbudowy.

## Uwagi przyjęte częściowo

- Lista tylko jednego parent chatu nie oznacza automatycznie zaniżenia każdego snapshotu: istnieje także rozpoznawanie po tytule i lineage. Trzeba obsłużyć wszystkie profile, szczególnie zmienione tytuły i rezerwacje jeszcze bez chatu; nie potwierdzono uniwersalnego scenariusza przekroczenia limitu w obecnym systemie.
- `forcePending` celowo odrzuca źródło podane przez model. Nowa atrybucja musi zostać dodana przez serwer, a nie przez zaufanie polom submit.
- Puste legacy kategorie są obecnie świadomym fallbackiem; nowa walidacja nie może zepsuć migracji historycznych danych.
- Historia/model danych były już wymagane przez kroki 1/4; brakowało schematu, retencji i zachowania przy braku pomiaru. Runner nie zwraca w pokazanym fragmencie usage, wbrew jednemu sformułowaniu raportu DeepSeek.
- Nowy workspace nie wymaga materializacji wiersza przy odczycie. Wybrano wirtualny profil i zapis przy konfiguracji, zachowując brak skutków ubocznych GET.
- Mirror pojedynczego skanu nie daje bezpiecznego downgrade ani wsparcia dla starych writerów. Wybrano backup i zatrzymanie writera przed migracją; kompatybilność dotyczy klientów API/MCP.
- Podział UI na trzy podzadania jest korektą organizacji pracy, nie blockerem architektury. Zachowano sześć faz i dodano kroki 5.1–5.3.

## Weryfikacja

Read-only probe rodzica potwierdził: singleton scan, brak niezaufanych source/scanId w serwerowym finding, fallback pustych kategorii, odrzucenie duplicate już pending oraz usunięcie pierwszego rekordu po przekroczeniu 200 w starym normalizatorze. Probe nie zapisywał store.

Host-owned `delegation_verify` dla `workspace-watcher-scout` zakończył się `passed`, exit 0; dane testowe w izolowanym katalogu `/tmp`. Obejmuje istniejące reguły promptu, autoryzacji submit, harmonogramu, rollbacku, archiwizacji, REST i TODO. Wynik został zapisany przy delegacji niezależnie od jej VERDICT: FAIL.

Testy potwierdzają zastane zachowanie Scouta. Nowe profile, ich współbieżność i migracja v2 są na etapie projektu — będą wymagać testów wymienionych w specyfikacji podczas implementacji. Pełnego zestawu repozytorium nie uruchamiano.

Plan po korektach jest konkretniejszy i zachowuje zakres MVP. Nadal jest projektem w statusie idea, bez zatwierdzenia planu i bez deklaracji PASS od drugiej recenzji.

Późniejsza recenzja Grok 4.7 i bieżące testy: [raport](configurable-scouts-grok-review.md). Grok wskazał dodatkowe luki (FAIL), a nowe uruchomienie testu Scouta zakończyło się failed w przypadku autoCreate. Powyższy passed jest zapisem historycznego uruchomienia przy audycie DeepSeek.
