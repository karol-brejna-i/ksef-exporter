W# **Specyfikacja Systemu: Automatyzacja Rozliczeń (Parkowa) - V5**

## **1. Koncepcja, Możliwości i Ograniczenia**

**Koncepcja:** Przejście z manualnego zarządzania danymi rozliczeniowymi w arkuszach Excel na zautomatyzowaną aplikację webową. System ma działać jako agregator kosztów dla punktu „Parkowa”, pobierając dane wprost z Krajowego Systemu e-Faktur (KSeF) i wykorzystując algorytmy AI do precyzyjnego kategoryzowania wydatków.  
**Możliwości systemu:**

* Drastyczna redukcja czasu potrzebnego na zamknięcie miesiąca rozliczeniowego.  
* Eliminacja błędów ludzkich (np. literówek, pominięcia faktury) dzięki bezpośredniemu połączeniu ze źródłem danych (KSeF).  
* Skalowalność: możliwość łatwego dodania kolejnych punktów/lokalizacji do rozliczeń w przyszłości bez proporcjonalnego wzrostu nakładu pracy.

**Ograniczenia i Ryzyka:**

* **Faktury poza KSeF:** System centralny nie rejestruje faktur od kontrahentów zagranicznych (np. Meta, Google) ani drobnych paragonów z NIP (do 450 zł), które mogą nie zostać od razu zaraportowane. Aplikacja musi uwzględniać ścieżkę awaryjną dla takich dokumentów.  
* **Koszty AI:** Przepuszczanie każdej pojedynczej pozycji przez modele językowe (LLM) generuje niepotrzebne koszty. Wymagane jest inteligentne zarządzanie ruchem (np. stosowanie sztywnych reguł tam, gdzie to możliwe).

## **2. Warstwa I: Wymagania Biznesowe i Użytkowe**

Wymagania definiują, w jaki sposób użytkownik (osoba rozliczająca) wchodzi w interakcję z systemem i jakie cele musi osiągnąć.

* **HU-01: Automatyczne pobieranie:** Jako osoba odpowiedzialna za rozliczenia, chcę jednym kliknięciem zainicjować pobieranie wszystkich faktur zakupowych z danego miesiąca, aby nie musieć logować się do zewnętrznych systemów księgowych ani szukać załączników w poczcie e-mail.  
* **HU-02: Ręczne wprowadzanie wyjątków:** Jako użytkownik chcę mieć możliwość ręcznego dodania faktury (np. od podmiotu zagranicznego lub paragonu), aby moje rozliczenie miesiąca było w 100% kompletne, nawet dla dokumentów, które obiektywnie nie mogły znaleźć się w KSeF.  
* **HU-03: Weryfikacja wizualna i kategoryzacja:** Jako użytkownik chcę widzieć przejrzysty interfejs tabelaryczny podzielony na kategorie (Media, Zakup towarów, Inne), z wyraźnym oznaczeniem, które wydatki system przypisał z całkowitą pewnością, a które wymagają mojego potwierdzenia.  
* **HU-04: Korekta reguł:** Jako użytkownik chcę mieć możliwość zmiany kategorii dla konkretnego wydatku z poziomu interfejsu (np. z listy rozwijanej), a system powinien tę zmianę zapamiętać na przyszłość.

## **3. Warstwa II: Wymagania Brzegowe (Warunki Sukcesu Automatyzacji)**

1. **Kwestie formalne i uwierzytelnienie:** Skrypt nie może łączyć się z systemami państwowymi w sposób niezabezpieczony. Wymagane jest operowanie na wygenerowanych w Urzędzie Skarbowym tokenach sesyjnych z restrykcyjnym nadaniem uprawnień (wyłącznie do odczytu faktur zakupowych), aby wykluczyć ryzyko niepowołanego wystawienia dokumentów.  
2. **Mechanizm pobierania i przetwarzania danych:** Moduł backendowy musi realizować pobieranie danych asynchronicznie, omijać limity zapytań API (rate-limiting) oraz potrafić skutecznie parsować skomplikowane drzewa XML na płaskie dane zrozumiałe dla bazy danych.  
3. **Inteligentny Silnik Kategoryzacji:** Logika musi być trójstopniowa. Najpierw aplikuje proste, stałe reguły (np. NIP dostawcy X \= Media). Złożone lub nowe pozycje trafiają do algorytmu AI, który na podstawie analizy kontekstu podejmuje ostateczną decyzję.  
4. **Interfejs i Bezpieczeństwo Danych:** Ze względu na przetwarzanie wrażliwych danych finansowych firmy, aplikacja internetowa musi być zamknięta, zabezpieczona mechanizmem logowania (np. JWT) i niewidoczna dla osób trzecich, mimo że jest hostowana w chmurze.

## **4. Warstwa III: Architektura i Komponenty Systemu**

| Komponent                             | Realizowana funkcja (odniesienie do wymagań)                                                                                                          |
| :------------------------------------ | :---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Moduł Integracji KSeF (Konektor)**  | Odpowiada za bezpieczne uwierzytelnienie i pobieranie dokumentów XML (HU-01). Realizuje założenia bezpiecznej komunikacji read-only.                  |
| **Moduł Obsługi Wyjątków (Uploader)** | Zapewnia interfejs do ręcznego dodawania dokumentów pozasystemowych, wpisując się w wymaganie obsługi dokumentów z zewnątrz (HU-02).                  |
| **Hybrydowy Silnik Kategoryzacji**    | Serce systemu analizujące dane wejściowe. Łączy sztywne reguły (Słownik Dostawców) z modelem językowym (LLM) do interpretacji nieznanych wydatków.    |
| **Frontend (Panel Użytkownika)**      | Lekka aplikacja przeglądarkowa agregująca powyższe komponenty. Prezentuje zagregowane koszty, pozwala na weryfikację i ręczne korekty (HU-03, HU-04). |

## **Załącznik 1: Pozyskiwanie dostępu do API KSeF (Instrukcja Złota)**

1. **Logowanie podmiotu:** Użytkownik uprawniony (np. właściciel firmy) loguje się do oficjalnej Aplikacji Podatnika KSeF lub e-Urzędu Skarbowego za pomocą Profilu Zaufanego, e-Dowodu lub bankowości elektronicznej.  
2. **Generowanie Tokena Zewnętrznego:** W zakładce „Uprawnienia” lub „Tokeny” należy wygenerować nowy stały token autoryzacyjny. Jest to unikalny ciąg znaków, który aplikacja wykorzysta jako klucz początkowy do inicjalizacji sesji.  
3. **Nadanie uprawnień (Krytyczne):** Podczas generowania tokena, system zapyta o role. Zgodnie z założeniami warstwy II, tokenowi należy przypisać WYŁĄCZNIE rolę odczytu dokumentów (Dostęp do faktur zakupowych). Nie należy nadawać uprawnień do wystawiania dokumentów.  
4. **Przechowywanie:** Wygenerowany token jest traktowany jak hasło. Należy go bezpiecznie przekazać do konfiguracji środowiskowej (env) backendu projektowanej aplikacji.

## **Załącznik 2: Pełne Historyczne Dane Kosztowe (Zbiór Referencyjny)**

Zestawienie pełnych danych z arkusza "ROZLICZENIE PARKOWA 2025.xlsx", stanowiące bazę do nauki dla silnika kategoryzacji (zestaw regułowy).

### **A.1. Dane Rozliczeniowe (Styczeń 2025)**

| Kategoria kosztu     | Kontrahent / Opis wpisu | Wartość brutto (PLN)  |
| :------------------- | :---------------------- | :-------------------- |
| RAPORTY MSC BRUTTO   | BAR                     | 21 404.70             |
| RAPORTY MSC BRUTTO   | GOFRY                   | 6 182.20              |
| WYPŁATY / KOSZTY     | Henryka Kostecka        | 360.00                |
| WYPŁATY / KOSZTY     | Paulina Michałek        | 850.00                |
| WYPŁATY / KOSZTY     | Diana Kuzmenko          | 1 555.50              |
| WYPŁATY / KOSZTY     | Julia Khomiakowa        | 850.00                |
| WYPŁATY / KOSZTY     | Ewelina Trocka          | 5 500.00              |
| MEDIA BRUTTO         | Odpady Komunalne        | 219.37                |
| MEDIA BRUTTO         | Energa Odsetki          | 20.91                 |
| MEDIA BRUTTO         | Energa Operator         | 1 438.15              |
| MEDIA BRUTTO         | Gaz                     | 168.00                |
| MEDIA BRUTTO         | T-Mobile                | 166.05                |
| MEDIA BRUTTO         | Energa - Dystrybucja   | 2 832.21              |
| MEDIA BRUTTO         | Enea                    | 2 360.76              |
| MEDIA BRUTTO         | PGNiG                   | 153.97                |
| ZAKUP TOWARÓW BRUTTO | Triada                  | 469.68                |
| ZAKUP TOWARÓW BRUTTO | Eurocash                | 822.88                |
| ZAKUP TOWARÓW BRUTTO | Firma Handlowa          | 52.94                 |
| INNE BRUTTO          | Poczta                  | 13.30 / 17.30 / 24.20 |
| INNE BRUTTO          | Ochrona                 | 1 000.00              |
| INNE BRUTTO          | DJ                      | 1 800.00              |
| INNE BRUTTO          | OBI                     | 51.96                 |
| INNE BRUTTO          | Leasing Skoda           | 1 428.71              |

### **A.2. Luty i Marzec 2025 (Wybór Kluczowych Pozycji)**

* **Luty - Wynagrodzenia (Wypłaty):** Ewelina Trocka (5500.00), Diana Kuzmenko (1509.75), Paulina - Bar (700.00), Teresa Szmitowska (1068.00).  
* **Luty - Media:** Energa Operator (142.50), Enea (393.45 \+ 1917.53 \+ 34.30), Gdańskie Wodociągi (518.96), PGNiG (300.50).  
* **Luty - Zakupy i Inne:** Piwowar (408.72 \+ 1720.24 \+ 38.94), Eurocash (1333.57), Pepsi (848.66), Ochrona (1000.00), Leasing Skoda (1428.71).  
* **Marzec - Wynagrodzenia (Wypłaty):** Ewelina (5500.00), Julia Reszczyńska (3065.25), Diana Kuzmenko (259.25), Teresa (1080.00).  
* **Marzec - Media:** Energa-Dystrybucja (2974.69), T-Mobile (178.35), Enea (1791.57 \+ 1113.25), Wodociągi (518.96).  
* **Marzec - Zakupy i Inne:** Eurocash (1264.51 \+ 1182.52), Piwowar (2602.07 \+ 1296.96), Pepsi (1256.17), DJ (2250.00), Ochrona (1250.00), Leasing Skoda (1428.71).

### **A.3. Podsumowanie Agregatów Finansowych (Q1 2025)**

| Miesiąc rozliczeniowy | Koszty razem (PLN) | Obrót (PLN) | Zysk (PLN) |
| :-------------------- | :----------------- | :---------- | :--------- |
| **Styczeń 2025**      | 26 267.73          | 39 327.47   | 13 059.74  |
| **Luty 2025**         | 36 887.95          | 40 594.20   | 3 706.25   |
| **Marzec 2025**       | 49 066.82          | 63 628.35   | 14 561.53  |

### **A.4. Zdefiniowane Reguły Mapowania dla Agenta AI**

* **Warunek:** Jeśli pole tekstowe sprzedawcy zawiera Energa, Enea, PGNiG, T-Mobile, Wodociągi lub Odpady → **Kategoria:** MEDIA  
* **Warunek:** Jeśli pole tekstowe sprzedawcy zawiera Eurocash, Piwowar, Pepsi lub Triada → **Kategoria:** ZAKUP TOWARÓW  
* **Warunek:** Jeśli pole tekstowe sprzedawcy zawiera Ochrona, Securitas, Leasing, Skoda, OBI lub Castorama → **Kategoria:** INNE / STAŁE