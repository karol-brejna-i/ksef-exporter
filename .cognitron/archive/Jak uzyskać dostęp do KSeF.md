**Ministerstwo Finansów udostępnia dedykowane środowiska testowe**, które pozwalają programistom i integratorom bezpiecznie testować komunikację z systemem KSeF bez wywoływania skutków prawnych. \[1, 2\]

Obecnie komunikacja z API opiera się na **wersji KSeF API 2.0**. Do dyspozycji masz następujące środowiska: \[1, 3\]

| Środowisko \[1, 4, 5\]         | Bazowy adres URL API                     | Przeznaczenie / Cechy                                                                                      |
| :----------------------------- | :--------------------------------------- | :--------------------------------------------------------------------------------------------------------- |
| **Testowe (TE)**               | `https://api-test.ksef.mf.gov.pl/api/v2` | Służy do pierwszych testów. Obsługuje fikcyjne certyfikaty (*self-signed*).                                |
| **Przedprodukcyjne (Demo/TR)** | `https://api-demo.ksef.mf.gov.pl/api/v2` | Dokładne odwzorowanie produkcji. Wymaga rzeczywistych metod uwierzytelnienia (np. prawdziwy podpis/token). |
| **Produkcyjne (PRD)**          | `https://api.ksef.mf.gov.pl/api/v2`      | Środowisko docelowe. Wystawione tu faktury mają moc prawną.                                                |

---

## Procedura: Jak krok po kroku skorzystać z API KSeF?

Komunikacja z API nie odbywa się za pomocą standardowego loginu i hasła. Musisz wywołać tzw. **sesję interaktywną**. Poniżej znajduje się pełna procedura przygotowania i nawiązania połączenia: \[6\]

## **Krok 1: Wygenerowanie tokena autoryzacyjnego**

Najwygodniejszą metodą uwierzytelniania w zewnętrznym kodzie jest **token KSeF**. \[1, 6\]

1. Zaloguj się ręcznie do [Testowej Aplikacji Podatnika KSeF](https://ksef.podatki.gov.pl/aplikacja-podatnika-ksef-20/aplikacja-podatnika-ksef-20-wersja-testowa/) (używając np. Profilu Zaufanego).  
2. Przejdź do zakładki generowania tokenów.  
3. Wygeneruj token i przypisz mu odpowiednie uprawnienia (np. zapis i odczyt faktur).  
4. Skopiuj token (będzie potrzebny w Twojej aplikacji jako `encryptedToken` lub element autoryzacji). \[2, 7\]

## **Krok 2: Pobranie specyfikacji OpenAPI oraz Klucza Publicznego**

Do prawidłowego szyfrowania danych i budowania zapytań potrzebujesz oficjalnych zasobów:

1. Wejdź na portal KSeF API Dokumentacja.  
2. Pobierz aktualny **plik specyfikacji OpenAPI (Swagger)**, aby wygenerować model zapytań w swoim języku programowania (Java, C\#, Python itp.).  
3. Pobierz **klucz publiczny Ministerstwa Finansów** dedykowany dla środowiska testowego (służy do szyfrowania klucza sesyjnego). \[1, 8\]

## **Krok 3: Inicjalizacja sesji w API (Proces Uwierzytelniania)**

Aby system KSeF przyjął Twoje dokumenty, musisz otworzyć sesję za pomocą dwuetapowego mechanizmu: \[7, 9\]

1. **Wywołanie `InitSessionTokenChallenge` (POST)**: Wysyłasz zapytanie zawierające Twój identyfikator podatkowy (NIP) na endpoint inicjujący. W odpowiedzi system zwraca unikalny ciąg znaków tzw. **challenge** oraz aktualny timestamp. \[7\]  
2. **Szyfrowanie tokena**: Twój wygenerowany w Kroku 1 token łączysz z otrzymanym timestampem (w formacie `token|timestamp`). Całość szyfrujesz algorytmem `RSA-OAEP` (z użyciem SHA-256) przy pomocy klucza publicznego MF. \[7\]  
3. **Wywołanie `InitSessionToken` (POST)**: Przesyłasz zaszyfrowany token z powrotem do KSeF. Jeśli dane są poprawne, system zwraca **SessionID** oraz token dostępowy **JWT (accessToken)**. \[7, 9\]

## **Krok 4: Operacje na fakturach (Wysyłka i Odbiór)**

Po uzyskaniu aktywnej sesji możesz wykonywać właściwe zapytania: \[6\]

* **Wysyłanie**: Dokument faktury przygotowany w formacie XML (zgodny z najnowszą strukturą logiczną ministerstwa, np. FA(3)) wysyłasz metodą POST na odpowiedni endpoint. API KSeF 2.0 wymaga, aby przesyłane faktury były dodatkowo szyfrowane. \[1, 2, 10\]  
* **Sprawdzanie statusu**: Po wysłaniu faktury odpytujesz system o status przetwarzania. Gdy system przetworzy dokument poprawnie, zwraca jego stały, unikalny **Numer KSeF** oraz pozwala na pobranie **UPO** (Urzędowego Poświadczenia Odbioru). \[6, 11\]

## **Krok 5: Zamknięcie sesji**

Po zakończeniu operacji dobrą praktyką programistyczną jest poprawne zamknięcie otwartej sesji za pomocą dedykowanego endpointu typu POST (`TerminateSession`), co zwalnia zasoby systemowe. \[11\]

Jeśli planujesz rozpocząć integrację od razu, daj mi znać:

* W jakim **języku programowania** (np. C\#, Java, Python, PHP) budujesz swoją aplikację?  
* Czy chcesz zobaczyć **przykładowy kod** dla pierwszego kroku autoryzacji (pobieranie *challenge*)?

Wskaż interesujący Cię obszar, a przygotuję konkretne techniczne wskazówki.

\[1\] [https://ksbot.pl](https://ksbot.pl/api/ksef-api-testowe/)  
\[2\] [https://ksef.podatki.gov.pl](https://ksef.podatki.gov.pl/aplikacja-podatnika-ksef-20/aplikacja-podatnika-ksef-20-wersja-testowa/)  
\[3\] [https://ksbot.pl](https://ksbot.pl/api/ksef-api-testowe/)  
\[4\] [https://ksbot.pl](https://ksbot.pl/api/ksef-api-jak-zaczac/)  
\[5\] [https://comstar.net.pl](https://comstar.net.pl/ksef-demo-testy-api/)  
\[6\] [https://mizzox.com](https://mizzox.com/baza-wiedzy/ksef-api-jak-dziala/)  
\[7\] [https://api-test.ksef.mf.gov.pl](https://api-test.ksef.mf.gov.pl/)  
\[8\] [https://api-test.ksef.mf.gov.pl](https://api-test.ksef.mf.gov.pl/)  
\[9\] [https://api-test.ksef.mf.gov.pl](https://api-test.ksef.mf.gov.pl/)  
\[10\] [https://pl.andersen.com](https://pl.andersen.com/blog/dokumentacja-api-ksef-2-0-co-warto-wiedziec/)  
\[11\] [https://ksef24.com](https://ksef24.com/)  
