# Evaluation der Wissenssuche

Erzeugt mit `npm run eval:retrieval` am 2026-11-25.

- Wissensbasis: fiktiver Sanitär- und Heizungsbetrieb, 32 Abschnitte (`eval/retrieval/wissensbasis.md`)
- 45 Testfragen mit erwartetem Abschnitt (`eval/retrieval/fragen.json`)
- Embedding-Modell: Xenova/multilingual-e5-small (q8), Fusion: Reciprocal Rank Fusion mit k = 60

## Gesamt (Top 5)

| Methode | Hit@1 | Recall@3 | Recall@5 | MRR@5 | Ø Zeit |
|---|---|---|---|---|---|
| Volltext | 62 % | 67 % | 69 % | 0.64 | 1 ms |
| Semantisch | 91 % | 100 % | 100 % | 0.96 | 8 ms |
| Hybrid (RRF) | 91 % | 100 % | 100 % | 0.96 | 8 ms |

## Recall@3 nach Fragetyp

| Fragetyp | Anzahl | Volltext | Semantisch | Hybrid (RRF) |
|---|---|---|---|---|
| stichwort | 12 | 100 % | 100 % | 100 % |
| umschreibung | 14 | 36 % | 100 % | 100 % |
| exakt | 8 | 100 % | 100 % | 100 % |
| englisch | 6 | 0 % | 100 % | 100 % |
| code | 5 | 100 % | 100 % | 100 % |

## Einzelergebnisse (Platz des richtigen Abschnitts, – = nicht in den Top 5)

| Typ | Frage | Volltext | Semantisch | Hybrid (RRF) |
|---|---|---|---|---|
| stichwort | Was kostet die Wartung einer Gastherme? | 1 | 1 | 1 |
| stichwort | Wie lange dauert eine Badsanierung? | 1 | 1 | 1 |
| stichwort | Bietet ihr einen Wartungsvertrag an? | 1 | 1 | 1 |
| stichwort | Welche Zahlungsarten akzeptiert ihr? | 1 | 1 | 1 |
| stichwort | Macht ihr auch eine Legionellenprüfung? | 1 | 1 | 1 |
| stichwort | Wie hoch ist die Förderung für eine Wärmepumpe? | 1 | 1 | 1 |
| stichwort | Was kostet eine Kamerainspektion? | 1 | 1 | 1 |
| stichwort | Montiert ihr Klimaanlagen? | 1 | 1 | 1 |
| stichwort | Was kostet eine Leckageortung? | 1 | 1 | 1 |
| stichwort | Wie hoch ist der Notdienstzuschlag? | 1 | 1 | 1 |
| stichwort | Kann ich einen Termin kostenlos absagen? | 1 | 1 | 1 |
| stichwort | Bildet ihr Anlagenmechaniker aus? | 1 | 1 | 1 |
| umschreibung | Zu welchen Uhrzeiten ist bei euch jemand da? | – | 1 | 1 |
| umschreibung | Die Heizung im Wohnzimmer blubbert und wird nur unten warm. | – | 1 | 1 |
| umschreibung | Bei mir spritzt Wasser aus der Wand, was mache ich zuerst? | 3 | 1 | 1 |
| umschreibung | Das Spülbecken in der Küche läuft nicht mehr ab, alles bleibt stehen. | – | 1 | 1 |
| umschreibung | Meine Mutter sitzt im Rollstuhl und kommt nicht mehr in die Badewanne – was könnt ihr machen? | – | 1 | 1 |
| umschreibung | Gibt es Geld vom Staat, wenn ich meine alte Ölheizung ersetze? | 3 | 1 | 1 |
| umschreibung | Ist das Leitungswasser hier sehr kalkhaltig? | – | 1 | 1 |
| umschreibung | Fahrt ihr auch zu Kunden in Nachbarorten? | – | 1 | 1 |
| umschreibung | Wie viel verlangt ihr pro Stunde? | – | 1 | 1 |
| umschreibung | Was passiert, wenn nach eurer Arbeit nach einem Jahr etwas kaputtgeht? | 1 | 1 | 1 |
| umschreibung | Ich vermiete ein Haus mit sechs Parteien – welche Pflichten habe ich beim Wasser aus dem Hahn? | 5 | 2 | 2 |
| umschreibung | Es riecht im Keller nach Gas und es ist Sonntagnacht. Wen rufe ich an? | 1 | 1 | 1 |
| umschreibung | Ist mein altes Haus für eine Heizung mit Umweltwärme geeignet? | 1 | 1 | 1 |
| umschreibung | Was kostet es, wenn ihr erst vorbeikommt und euch alles anschaut, bevor ich mich entscheide? | – | 2 | 2 |
| exakt | Was ist eure Notdienstnummer? | 1 | 1 | 1 |
| exakt | Kommt ihr auch nach Griesheim? | 1 | 1 | 1 |
| exakt | Verbaut ihr Wärmepumpen von Vaillant? | 1 | 1 | 1 |
| exakt | Wie viel bar Druck sollte meine Heizung haben? | 1 | 1 | 1 |
| exakt | Habt ihr eine Zertifizierung nach F-Gase-Verordnung? | 1 | 1 | 1 |
| exakt | Ist euer Betrieb in der Pfungstädter Straße? | 1 | 1 | 1 |
| exakt | Wie viel zahlt die Pflegekasse dazu? | 1 | 1 | 1 |
| exakt | Was sagt das Gebäudeenergiegesetz zu neuen Gasheizungen? | 1 | 1 | 1 |
| englisch | When is your office open? | – | 1 | 1 |
| englisch | A pipe burst in my flat, what should I do first? | – | 1 | 1 |
| englisch | How much does servicing a heat pump cost? | – | 1 | 1 |
| englisch | Do you install air conditioning? | – | 2 | 2 |
| englisch | Are you hiring? | – | 1 | 1 |
| englisch | Can I pay by credit card? | – | 1 | 1 |
| code | Habt ihr Teile für die VC 206/5-5? | 1 | 1 | 1 |
| code | Ist ein Heizelement für den DHB-E 18 LCD da? | 1 | 1 | 1 |
| code | B2HF zeigt eine Störung – habt ihr Ersatzteile? | 1 | 1 | 1 |
| code | Wofür ist die Nummer 06151 594 299? | 1 | 2 | 2 |
| code | Ist 06151 594 200 eure normale Telefonnummer? | 1 | 1 | 1 |

**Hinweis:** Wissensbasis und Fragen sind selbst erstellt und klein (45 Fragen). Die Zahlen zeigen Tendenzen, keine allgemeingültigen Werte.
