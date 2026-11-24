---
title: OpenCode
description: Skonfiguruj dostęp do OpenCode, wybierz modele i poznaj ograniczenia.
---

# OpenCode

OpenCode łączy czat Cretli z lokalnym programem OpenCode CLI i modelami jego dostawców. Zainstaluj CLI albo użyj opcjonalnego pakietu instalowanego z Cretli. W **Ustawienia → Harness → OpenCode** sprawdź gotowość, wybierz dane dostępu, a następnie utwórz czat OpenCode.

## Logowanie i modele

Użyj klucza API OpenCode Zen (`OPENCODE_API_KEY`) albo logowania dostawcy przez CLI. OpenCode obsługuje też klucze Z.AI i Xiaomi MiMo. Dla Z.AI wybierz odpowiedni wariant zwykłego API lub Coding Plan. Klucze MiMo rozliczane za użycie i Token Plan wymagają pasującego adresu usługi; klucza abonamentu nie można łączyć z adresem rozliczenia za użycie.

Lista modeli pochodzi z katalogu dostawców OpenCode. Zależnie od danych dostępu zawiera modele Zen, GLM i MiMo, na przykład `cretli-mimo/mimo-v2.6-pro`. Włącz wybrane pozycje w ustawieniach, zamiast zakładać dostępność każdego modelu dostawcy.

## Znane ograniczenia

Pierwsza wiadomość może czekać minutę lub dwie na uruchomienie lokalnego serwera. Każdy czat ma osobną instancję zużywającą pamięć komputera. Opcjonalny limit instancji odrzuca nowy czat, gdy wszystkie dopuszczone instancje pracują. Tryb Plan blokuje narzędzia zmieniające pliki regułami uprawnień; nie jest to izolacja systemowa. Pytania i prośby o uprawnienia pojawiają się w czacie i wstrzymują pracę do odpowiedzi.

<!-- sources: harnesses/opencode/SETUP.md -->
