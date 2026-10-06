# AL Xliff Studio – Roadmap ab 1.11.58

Stand: 05.10.2026. Reihenfolge: erst Verhalten und Datenintegrität sichern, dann gemessene Engpässe beseitigen und Budgets festlegen; anschließend Architektur bereinigen und Komfortfunktionen ergänzen. Jeder Abschnitt endet mit gezielten Regressionen, vollständiger Testsuite, Syntaxprüfung, VSIX-Build und einem aktualisierten Änderungsbericht. Keine neuen blockierenden Dialoge und keine unnötigen Vollscans.

## 1. Abnahmebasis und responsive Synchronisierung

Technische Aufgaben in 1.11.59 umgesetzt:

- Bestehende automatisierte Abnahme für Dashboard, No State, Quality-Seiten, Developer-Drafts, Apply/Discard und KI-Deduplizierung vollständig ausführen.
- Große Sync-Berechnungen für Editor und Dashboard in den vorhandenen Worker verlagern. Für die Dashboard-Sync-Statusprüfung denselben Pfad ohne unnötige Translation-Memory-Auswertung verwenden.
- Vor-/Nach-Sync-Translation-Memory-Paare im Worker ermitteln; nur Ergebnistext, Zähler und kompakte Paare übertragen, keine vollständigen Parse-Objekte für diese Arbeit.
- Worker-Cancellation bei Änderungen, Ersatzlauf oder Schließen erhalten. Veraltete Ergebnisse vor Dateiedits abweisen; kein großer synchroner Fallback bei Sync-Worker-Fehlern.
- Gleichheit der Sync-Ergebnisse, Entfernen/Hinzufügen, Review-Flags, Translation-Memory-Erhalt sowie Editor-/Dashboard-Cancellation testen.
- Den 15-MB/30.000-Einheiten-Stresstest mit expliziter Prüfung eines abgeschlossenen Sync-Workers ausführen.
- Erste Regressionbudgets festsetzen: Sync-Host-Stall höchstens 500 ms; Quality-Filter und Quality-Paging höchstens 100 ms; allgemeine Grenzen weiterhin 5.000 ms Stall und 2.048 MiB RSS. Phasen über 100 ms bleiben separat sichtbar. Diese Grenzen sind für den Adaptertest, keine garantierte UI-Latenz für jeden Rechner.

**Offener Abnahmeschritt:** sichtbare Prüfung in echtem VS Code nach `docs/large-xlf-stress.md`. Die verfügbaren Computer-Werkzeuge dieses Chats erlauben keine Bedienung nativer Anwendungen; automatisierte Host-/Webview-Script-Tests ersetzen diese Prüfung nicht. Installation und Oberflächenprüfung sind deshalb nicht als erledigt markiert.

## 2. Apply und Übersetzungs-Paging optimieren

Technische Aufgaben in 1.11.60 umgesetzt; native UI-Abnahme weiterhin offen.

- Apply zerlegen und messen: XML-Batchänderung, Undo-Erfassung, Companion-Memory und Hintergrund-QA; schwere Arbeit aus dem Host verlagern bzw. in begrenzten Schritten ausführen.
- Übersetzungsseitenwechsel ohne erneute Filter-/Sortier-Vollberechnung bei identischer Abfrage. Indizes abhängig von Dokumentversion, Filter, Sortierung und Draft-Revision wiederverwenden.
- Seitendetails und Transport nur für die benötigten Einträge; keine globalen Detailkopien.
- Regressionen für schnelle Wechsel, Stale-Antworten, Draft-Erhalt, Apply/Undo und Save.
- Abschluss: nachgewiesene Reduzierung der heute gemessenen Blockaden; kein falsches Versprechen, dass bereits alle Aktionen unter 100 ms liegen.

## 3. Indizes und feste Skalierungsbudgets

Technische Aufgaben in 1.11.64 umgesetzt; sichtbare native Abnahme weiterhin offen:

- Verbleibende wiederholte lineare Suchen inventarisieren. Indizes nach ID/Ordinal/Source nur dort einführen, wo Messungen den Nutzen zeigen; Aktualisierung bei Sync/Apply/Reload mitprüfen.
- Globalen Webview-State weiter reduzieren und Cache-Limits dokumentieren.
- 5-/15-/30-MB-Szenarien mit passenden Unit-Zahlen, wiederholten Läufen, Laufzeit, Host-Stall, Transfermenge und Speicher vergleichen. Ein frischer Prozess pro Größe verhindert vermischte Speicherwerte.
- Hardwarebezogene Ausgangswerte sowie absolute Grenzen und zulässige Regressionen festlegen. Ziel: kurze UI-Aktionen ohne Host-Blockierung über 100 ms; Langläufe bleiben asynchron und abbrechbar.

## 4. Schnellnavigation

Offen: Next Missing, Next Review, Next Error – mit korrekter Filter-/Paging-Navigation, klarer Wrap-around-Anzeige und Draft-Erhalt. Baut auf den stabilen Indizes aus Abschnitt 3 auf.

## 5. Globale Ignore-Regeln verwalten

Offen: Übersicht vorhandener Regeln, Suche, Entfernen/Wiederherstellen und Herkunft anzeigen; vorhandene Quality-Ignore-Logik nutzen, keine neue parallele Regelsammlung. Fehler weiterhin nicht pauschal ignorierbar machen.

## 6. Mehrfachauswahl und Bulk-Aktionen

Offen: Auswahl auf Seite und über gefilterte Ergebnismengen, klarer Geltungsbereich, Apply/Discard/Status-Aktionen, Fortschritt und sichere Teilresultate bei Abbruch. Große Aktionen verwenden die in Abschnitt 2/3 geprüften Wege.

## 7. Projektweite Inkonsistenzsuche

Offen: gleiche Source-Texte und Zielsprache über Dateien hinweg vergleichen; lokale Developer-Vorgaben und bewusste Ausnahmen sichtbar halten. Ergebnisse hostseitig paginieren und gezielt öffnen; keine automatischen globalen Überschreibungen.

Bereits vorhanden und nicht erneut einzuplanen: Parser-/Quality-Cancellation, hostseitiges Quality-Paging, Large-XLIFF-Grundtest, No-State→Translated-Aktion samt Filter, KI-Deduplizierung, Developer-Draft-Fixes und korrigierte Punktprüfung.

## Abschlussmessung Abschnitt 1

342 Tests, Syntaxprüfung, VSIX-Build und 30.000-Einheiten-Stresstest erfolgreich. Sync: max. Host-Stall 915.7 → 103.1 ms; Laufzeit 3537.7 → 3486.8 ms. Gleicher Rechner/Fixture, jeweils ein Lauf; native UI-Abnahme weiterhin offen. Vollständige Daten in `artifacts/verification-1.11.59/stress-report.json` und `CHANGE_REPORT.md`.

## Abschlussmessung Abschnitt 2

Übersetzungs-Paging: 420.2 → 4.9 ms Laufzeit, 432.1 → 10.6 ms Host-Stall. Apply einschließlich Hintergrundarbeit: 1166.3 → 1227.5 ms Laufzeit, 322.2 → 95.1 ms Host-Stall. Begrenzter Cache für acht Abfragen mit Dokumentversion und Draft-Inhalt; neue QA-Ergebnisse und Reload leeren ihn. Einzel-Apply bearbeitet bereits nur den betroffenen XML-Block. Große Apply-Batches verwenden einen abbrechbaren Worker und verwerfen Ergebnisse bei Dokumentänderung.

## Abschluss Abschnitt 3

Snapshot-Lookup-Indizes und reduzierter Draft-Override-State; minimaler XML-Edit in kurzen Schritten. Sechs erfolgreiche Skalierungsläufe für 5/15/30 MiB mit festen absoluten und relativen Budgets. Grenzwerte, Lookup-Inventar und Cache-Limits in `docs/scaling-budgets.md`; Werte und verbleibende 100-ms-Kandidaten in `CHANGE_REPORT.md`. Developer-Note-QA berücksichtigt zusätzlich Vorgabe-Leerzeichen.
