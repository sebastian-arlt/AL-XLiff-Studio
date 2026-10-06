# Skalierungsbudgets und Lookup-Inventar ab 1.11.64

Ausführen: `node tools/scaling-matrix.cjs --output=artifacts/scaling-1.11.64`.
Optional `--baseline=artifacts/scaling-PREVIOUS/matrix-report.json` zum Vergleich mit einer freigegebenen Vorgängerversion. Jedes Szenario wird zweimal sequenziell in einem frischen Node-Prozess ausgeführt. Ohne Baseline wird der zweite Lauf gegen den ersten geprüft. Fixture-Hashes, Rechnerdaten, Übertragungsmengen, Worker-Ereignisse und alle Einzelmessungen stehen im Ergebnisbericht. Absolute Grenzen gelten unabhängig vom Vergleich.

| Dateigröße | Einträge | RSS je Phase | Laufzeit je Phase |
|---|---:|---:|---:|
| 5 MiB | 10.000 | 1.024 MiB | 7.000 ms |
| 15 MiB | 30.000 | 1.536 MiB | 12.000 ms |
| 30 MiB | 60.000 | 2.560 MiB | 20.000 ms |

Allgemeiner Host-Stall maximal 1.000 ms. Engere bestehende Grenzen: Übersetzungs-Paging und Quality-Filter/Paging 100 ms; Apply inklusive Hintergrundarbeit 200 ms; Sync 500 ms. Übersetzungsseiten höchstens 2 MiB, Quality-Seiten höchstens 512 KiB Übertragung. Sichtbare Eingabe-/Paint-Latenz wird vom Adapter nicht gemessen. Phasen über 100 ms bleiben im Bericht als Optimierungskandidaten sichtbar; insbesondere bei 30 MiB ist das 100-ms-Ziel nicht für alle Phasen erreicht.

Vergleichsgrenzen: Laufzeit höchstens Vorgänger × 1,4 + 100 ms; Stall × 1,5 + 50 ms; RSS × 1,35 + 128 MiB. Die additive Toleranz verhindert, dass Rauschen bei sehr kurzen Aktionen als Regression gilt. Änderung der Grenzen erfordert neue Messungen und eine dokumentierte Begründung. Zwei Läufe sind eine reproduzierbare Abnahmebasis, keine statistische Garantie.

## Lookup-Inventar

- Problems→Editor, Go, Editor-Ordinalzugriff, Source-Retry, KI-Same-Source-Kontext und Generator-Companion-ID: Snapshot-Indizes mit Maps nach ID, Source und Ordinal. Doppelte IDs/Sources bleiben Listen und werden nicht stillschweigend überschrieben. Ordinalzugriff verwendet zunächst direkt den vorhandenen Arrayplatz.
- Neue Parse-Snapshots nach Apply, Save, Sync und Reload bekommen eigene Indizes. WeakMap-Schlüssel sind die Parse-Snapshots; keine zusätzlichen globalen Eigentümer halten alte Dokumente am Leben.
- Vollständige fehlende-Einträge-Ermittlung für Try All, Quality-Prüfung und neuer Filteraufbau: notwendige Gesamtdurchläufe, bleiben bestehen.
- `find()` in Notes, AL-Pfadsegmenten, Duplicate-ID-Gruppen, geöffneten Dokumenten und auf der maximal 200 Einträge großen Quality-Seite: kleine oder seltene Suchen, ohne gemessenen Indexnutzen; unverändert.
- KI-Nachbarschaft und Translation-Memory-Ähnlichkeit brauchen weiterhin inhaltliche Auswahl über ihre Kandidaten. Weitere Optimierung bleibt messungsabhängig; kein pauschaler Umbau aller Suchfunktionen.

## State- und Cache-Grenzen

Webview hält nur aktuelle Vollzeilen (höchstens 200) und eine Quality-Seite (höchstens 200); weitere Einträge haben kompakte Draft-/Proposal-/Undo-Marker. Benutzeränderungen über Seitenwechsel müssen bis Apply/Discard/Save erhalten bleiben und werden deshalb nicht durch ein willkürliches Limit verworfen. Draft-Overrides enthalten den Translation-Text einmal; der Host leitet daraus den Draft ab. Keine globalen Kopien aller Source-/Notes-/Quality-Details.

Übersetzungs-Abfragecache: acht Ordinalindizes pro Editor, abhängig von Dokumentversion, Abfrage und Overrides, geleert bei Reload und neuen QA-Daten. DocumentSession: vorhandenes LRU mit acht Sessions und 384-MiB-Schätzung; aktive Dokumente sind bewusst gehalten. Lookup-Indizes enthalten Referenzen auf vorhandene Units statt neuer Vollkopien. Speicherwerte umfassen echte Worker, kurzzeitige Peaks können zwischen den 5-ms-Abtastungen fehlen.

Sichtbare Abnahme in echtem VS Code bleibt gemäß `docs/large-xlf-stress.md` erforderlich.
