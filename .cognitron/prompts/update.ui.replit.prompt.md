I would like you to update your prototype using the following information.


## Domain model

An *Invoice* has: issue date, seller name, seller NIP (tax id), buyer name, buyer NIP (buyer fields are often empty), invoice number, KSeF number (present only for invoices imported from KSeF; absent for manually-entered invoices, which instead show a "Manual" badge), gross total + currency, a category (e.g. "Media", "Zakup towarów", "Inne"), and a category confidence state: `matched` (auto-assigned with high confidence) or `needs review` (should stand out visually and invite the user to confirm/correct it). Each invoice has zero or more *line items*; it also tracks whether item extraction has run yet, so an invoice can be in one of three item-states: "not yet extracted", "extracted, 0 items", or "extracted, N items" — these three should look different, not collapse into a blank table.

A *line item* has: ordinal/position, description, quantity, unit (raw string, e.g. "szt.", "kg" — don't normalize/validate it), unit price (net or gross — net is sometimes missing, fall back to gross), net value, gross value, VAT rate (this is a label, not a plain percentage — values like `23`, `8`, `0 WDT`, `zw` (exempt), `oo` (reverse charge) all occur and should render as-is, not as "23%"), and VAT amount. A line item can be flagged as a "correction — state before" row (from a correcting invoice); style these as visually distinct/muted, not deleted.

Some example data are in attached csv files. 

## Invoice list

Invoice list should be dense, scannable table/list. Revisit attributes to show in the list.
Think about issue date, seller name, total, category (inline-editable, e.g. a dropdown), a small confidence indicator next to category. Do NOT show technical details like KSeF number, or any line-item financial breakdown in this list — keep it uncluttered enough to scan 20+ rows at once. Include a small summary bar above the list (total count, count needing review, total gross per currency).

## Invoice detail

Invoice details windows allows to see the items of the invoice, and edit the category.

The goal is for the user to be able to see the product/service description and decide if the category is correct. 

## Example data

The 10 invoices deliberately vary every dimension the UI needs to handle:

- Source: 8 KSeF, 2 manual (#3, #9 — no KSeF number, no items)
- Confidence: mix of matched / needs_review
- Category: Media, Zakup towarów, Inne all represented
- Item state: not-yet-extracted (#5), extracted-but-zero (#6), normal N-items (rest)
- Edge cases: a correction "state before" line item (#4), unusual VAT labels 0 WDT/oo/np I (#8), a rare populated buyer NIP/name (#7), a non-PLN currency (#8, EUR)


### Invoices 

```
invoiceId,source,ksefNumber,invoiceNumber,sellerNip,sellerName,buyerNip,buyerName,issueDate,grossTotal,currency,category,categorizationConfidence,itemsExtracted,itemCount
1,ksef,5260250995-20260605-A1B2C3D4E5F6-77,FV/06/2026/1188,5260250995,Orange Polska S.A.,,,2026-06-05,1230.50,PLN,Media,matched,yes,3
2,ksef,6272738458-20260601-B2C3D4E5F6A1-12,FA/2026/06/00457,6272738458,Hurtownia Elektryczna ABC Sp. z o.o.,,,2026-06-01,1156.50,PLN,Zakup towarów,needs_review,yes,4
3,manual,,FV/07/2026/014,7791234567,Jan Kowalski - Usługi Transportowe,,,2026-07-14,450.00,PLN,Inne,matched,no,0
4,ksef,5213456789-20260520-C3D4E5F6A1B2-34,FV-KOR-2026/05/0033,5213456789,Papiernicze Biuro Plus Sp. z o.o.,,,2026-05-20,746.61,PLN,Zakup towarów,matched,yes,5
5,ksef,5261027099-20260701-D4E5F6A1B2C3-56,FV/2026/07/09912,5261027099,PGE Obrót S.A.,,,2026-07-01,892.34,PLN,Media,needs_review,no,0
6,ksef,5250007313-20260628-E5F6A1B2C3D4-78,PP/2026/06/2201,5250007313,Poczta Polska S.A.,,,2026-06-28,32.00,PLN,Inne,matched,yes,0
7,ksef,5510005827-20260710-F6A1B2C3D4E5-90,SH/2026/07/0761,5510005827,Stalprodukt Handel Sp. z o.o.,1234567890,Firma XYZ Sp. z o.o. - Oddział Kraków,2026-07-10,2177.10,PLN,Zakup towarów,needs_review,yes,3
8,ksef,8981234567-20260615-A2B3C4D5E6F7-11,TI/2026/06/0089,8981234567,TechImport Sp. z o.o.,,,2026-06-15,3873.00,EUR,Zakup towarów,matched,yes,4
9,manual,,FV-2026-08-002,6511234567,Anna Nowak - Doradztwo Podatkowe,,,2026-08-02,150.00,PLN,Inne,matched,no,0
10,ksef,6272430195-20260722-B3C4D5E6F7A8-23,TS/2026/07/33417,6272430195,Tauron Sprzedaż Sp. z o.o.,,,2026-07-22,553.51,PLN,Media,needs_review,yes,2
```


### Items

```
itemId,invoiceId,ordinal,lineNumber,name,unit,quantity,unitPriceNet,unitPriceGross,netValue,grossValue,vatRate,vatAmount,correctionStateBefore
1,1,1,1,Abonament telefoniczny - pakiet Business,szt.,1,500.00,615.00,500.00,615.00,23,115.00,false
2,1,2,2,Usługa internetowa światłowodowa 300Mb/s,szt.,1,300.00,369.00,300.00,369.00,23,69.00,false
3,1,3,3,Opłata za nadwyżkę transferu danych,szt.,1,200.41,246.50,200.41,246.50,23,46.09,false
4,2,1,1,Kabel YDYp 3x2.5mm 100m,szt.,2,250.00,307.50,500.00,615.00,23,115.00,false
5,2,2,2,Wyłącznik nadmiarowo-prądowy B16,szt.,10,15.00,18.45,150.00,184.50,23,34.50,false
6,2,3,3,Rozdzielnica elektryczna 12-modułowa,szt.,1,220.00,270.60,220.00,270.60,23,50.60,false
7,2,4,4,Transport i rozładunek,usł.,1,80.00,86.40,80.00,86.40,8,6.40,false
8,4,1,1,Papier A4 80g/m2 (przed korektą),op.,10,18.00,22.14,180.00,221.40,23,41.40,true
9,4,2,1,Papier A4 80g/m2,op.,8,18.00,22.14,144.00,177.12,23,33.12,false
10,4,3,2,Toner do drukarki HP CF283A,szt.,3,95.00,116.85,285.00,350.55,23,65.55,false
11,4,4,3,Zszywki biurowe 24/6,op.,20,3.50,4.31,70.00,86.10,23,16.10,false
12,4,5,4,Segregator A4 75mm,szt.,15,7.20,8.86,108.00,132.84,23,24.84,false
13,7,1,1,Blacha stalowa czarna 2mm 1000x2000mm,szt.,5,240.00,295.20,1200.00,1476.00,23,276.00,false
14,7,2,2,Kątownik stalowy 40x40x4mm 6m,szt.,12,35.00,43.05,420.00,516.60,23,96.60,false
15,7,3,3,Usługa cięcia laserowego,usł.,1,150.00,184.50,150.00,184.50,23,34.50,false
16,8,1,1,Import - dostawa komponentów elektronicznych (WDT),szt.,100,12.50,12.50,1250.00,1250.00,0 WDT,0.00,false
17,8,2,2,Usługa konsultingowa IT - reverse charge,usł.,1,2000.00,2000.00,2000.00,2000.00,oo,0.00,false
18,8,3,3,Licencja oprogramowania - eksport poza UE,szt.,1,500.00,500.00,500.00,500.00,np I,0.00,false
19,8,4,4,Materiały biurowe uzupełniające,op.,5,20.00,24.60,100.00,123.00,23,23.00,false
20,10,1,1,Energia elektryczna - zużycie czynne,kWh,450,0.65,0.80,292.50,359.78,23,67.28,false
21,10,2,2,Opłata dystrybucyjna zmienna,kWh,450,0.35,0.43,157.50,193.73,23,36.23,false
```