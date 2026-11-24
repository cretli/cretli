---
title: Pierwsze kroki
description: Zainstaluj Cretli, skonfiguruj pierwszą sesję i zaktualizuj istniejącą instalację.
---

# Pierwsze kroki

## Wymagania i instalacja

Użyj Linuksa, macOS lub WSL2 w Windows. Natywny terminal Windows nie jest obsługiwany. Zainstaluj Git i Node.js w wersji co najmniej 22.18. Pamięć aplikacji wymaga również dołączonego SQLite 3.51.0 lub nowszego; udokumentowane przykłady to Node 22.23.2 i 24.14. Natywne zależności terminala mogą wymagać kompilatora, a macOS narzędzi Xcode Command Line Tools.

```sh
git clone https://github.com/cretli/cretli.git
cd cretli
npm install
npm run build:front:prod
npm start
```

Otwórz `https://localhost:3011`. Domyślnie serwer jest dostępny tylko na tym komputerze. Zaakceptuj samopodpisany certyfikat wyłącznie dla własnego serwera. Jeśli brakuje certyfikatów, uruchom `npm run gen-cert` i ponownie włącz aplikację.

## Pierwsza sesja

Na stronie logowania utwórz hasło dostępu. Po zalogowaniu obecne okno pierwszego uruchomienia proponuje wybór backendu czatu i, gdy potrzeba, folderu obszaru roboczego. Wskaż projekt, na przykład `my-app`. W **Ustawienia → Harness** skonfiguruj backend, kończąc logowanie lub podając klucz API. Następnie utwórz czat i wybierz model. Terminal i pliki działają bez danych dostawcy modeli.

Rozbudowany kreator wdrożenia jest **planowany**, jeszcze niewydany. Instrukcja opisuje obecne okno konfiguracji oraz Ustawienia.

![Lista czatów](img/chat-list-mobile.png)

## Aktualizacja

Zrób kopię danych aplikacji i zachowaj lokalne zmiany przed aktualizacją. Postępuj według instrukcji Git dla wydania: publiczna historia master może być przepisywana, więc zwykły pull może nie zadziałać. Po pobraniu nowego kodu wykonaj `npm install`, zbuduj interfejs przez `npm run build:front:prod` i uruchom Cretli ponownie. Zachowaj dotychczasowe dane aplikacji. Dla kontenerów zobacz [instalację Docker](install-docker.md), a przy problemach [rozwiązywanie problemów](troubleshooting.md).

<!-- sources note: Current first-run dialog; expanded onboarding wizard (todo 25115b9e) remains planned. -->
<!-- sources: docs/INSTALL.md, app_front/features/setup/firstRunSetup.js, docs/harnesses.md, package.json -->
