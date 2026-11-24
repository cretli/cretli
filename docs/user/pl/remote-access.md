---
title: Dostęp zdalny, PWA i powiadomienia
description: Otwórz Cretli z telefonu lub innego komputera bezpiecznie i poznaj ustawienia domyślne.
---

# Dostęp zdalny, PWA i powiadomienia

Cretli domyślnie nasłuchuje na `127.0.0.1`, więc dostęp ma tylko komputer, na którym działa. Wszystko poniżej wymaga świadomego włączenia.

## Włącz dostęp w sieci LAN

Aby użyć telefonu lub innego komputera w zaufanej sieci, ustaw token konfiguracji i uruchom skrypt LAN:

```bash
export CRETLI_SETUP_TOKEN="$(openssl rand -hex 16)"
npm run start:lan
```

Ustaw `CRETLI_LAN_HOST` na adres, którego użyją inne urządzenia, i otwórz `https://<ten adres>:3011`. `CRETLI_BIND` przyjmuje jeden adres lub listę oddzieloną przecinkami, np. `127.0.0.1,192.0.2.10`. Gdy tylko zostanie użyty adres nielokalny, Cretli wymaga hasła lub tokenu konfiguracji. Gdy system zapyta, zezwól programowi Node w zaporze. W WSL dostęp LAN wymaga adresu LAN Windows i przekierowania z Windows; zobacz [rozwiązywanie problemów](troubleshooting.md).

## HTTPS i PWA

Cretli domyślnie używa HTTPS z certyfikatem samopodpisanym, więc przeglądarka pokaże ostrzeżenie raz na urządzenie. Zaufany certyfikat w swojej sieci skonfigurujesz według przewodnika o zaufanym HTTPS w repozytorium. Przeglądarki instalują progresywną aplikację internetową i dostarczają powiadomienia push tylko z zaufanego źródła HTTPS. Po instalacji aplikacja otwiera się we własnym oknie i pokazuje baner aktualizacji, gdy nowe zasoby są gotowe.

## Powiadomienia

Cretli może wysyłać powiadomienia web push, np. gdy Watcher znajdzie oczekującą pracę albo zadanie jest zablokowane. Wymagają zaufanego źródła HTTPS i Twojej zgody w przeglądarce. Są dostarczane w miarę możliwości i nie zastępują sprawdzenia zadania.

## Udostępnianie portu

Agent może poprosić Cretli o otwarcie portu deweloperskiego w sieci LAN przez `port_expose`. Przy domyślnej polityce (`agentMode` ustawione na `ask`) każdą prośbę zatwierdzasz na karcie zgody w czacie. Przy `allow_in_range` port jest udostępniany bez karty, a przy `never` każda prośba jest odrzucana. Cretli odmawia też dla portów debugowania i podobnych, portów spoza zakresu oraz aplikacji nasłuchujących tylko lokalnie. Przed udostępnieniem linku sprawdź `port_status`.

## Uwagi o bezpieczeństwie

Cretli udostępnia pełny terminal. Nie przekierowuj go do internetu. Zanim włączysz dostęp zdalny, przeczytaj [podstawy bezpieczeństwa](security-basics.md).

<!-- sources: docs/INSTALL.md, docs/apps-and-ports.md, docs/trusted-https.md, SECURITY.md -->
