# AL Xliff Studio

**AL-Anwendungen übersetzen – übersichtlich, direkt in VS Code.**

AL Xliff Studio hilft dir, die Texte deiner Microsoft Dynamics 365 Business Central App zu übersetzen und zu prüfen. Du siehst, was noch fehlt, kannst vorhandene Übersetzungen nutzen und behältst die Kontrolle über jeden Vorschlag.

## Alle Sprachen im Blick

Das **Translation Dashboard** zeigt den Stand jeder Sprache: fertige Übersetzungen, fehlende Texte, Einträge zur Prüfung und Qualitätsprobleme. Öffne den Wizard oder den XLIFF Editor direkt neben einer Datei. Eine nicht synchronisierte Sprache kannst du einzeln aktualisieren.

![Translation Dashboard mit drei Sprachen, Fortschritt und direkten Aktionen](https://raw.githubusercontent.com/sebastian-arlt/AL-XLiff-Studio/HEAD/resources/overview/dashboard.png)

## Schritt für Schritt übersetzen

**Guided Translation** führt dich durch fehlende Texte, die Prüfung vorhandener Übersetzungen oder Qualitätsprobleme. Quelltext, Übersetzung und Vorschlag stehen zusammen mit den Entwicklerhinweisen bereit.

- **← / →** wechseln zum vorherigen oder nächsten Eintrag und erhalten deinen bearbeiteten Text als Entwurf.
- **Vorschlag einsetzen** übernimmt einen Vorschlag in das Eingabefeld. Erst **Übernehmen** bestätigt die Übersetzung.
- **AI-Vorschlag** liefert auf Wunsch einen zusätzlichen Vorschlag.
- **¶** macht versteckte Zeichen sichtbar, ohne den Text zu verändern.

Passt ein Entwicklerhinweis zur Zielsprache und weicht die Übersetzung davon ab, erscheint der Hinweis als Vorschlag. Am Ende siehst du die offenen Aufgaben und kannst direkt mit Review, übersprungenen Einträgen oder Qualitätskorrekturen weitermachen.

![Guided Translation zeigt Quelltext, aktuelle Übersetzung und den passenden Entwicklertext als Vorschlag](https://raw.githubusercontent.com/sebastian-arlt/AL-XLiff-Studio/HEAD/resources/overview/guided.png)

## Mehrere Texte gezielt bearbeiten

Im **XLIFF Editor** kannst du Übersetzungen nebeneinander bearbeiten und nach fehlenden Texten, Entwürfen, Vorschlägen oder Qualitätsproblemen filtern. Suche und Seitenaufteilung helfen auch bei großen Dateien.

Die **Lupe** öffnet die zugehörige AL-Definition, etwa ein Label, eine Caption oder einen ToolTip. Entwicklerhinweise und Herkunftsinformationen helfen dir, den Text im richtigen Zusammenhang zu übersetzen.

![XLIFF Editor mit Quelltexten, Übersetzungen, Status und Entwicklerhinweisen](https://raw.githubusercontent.com/sebastian-arlt/AL-XLiff-Studio/HEAD/resources/overview/editor.png)

## Vorhandene Arbeit wiederverwenden

| Funktion | Dein Nutzen |
| --- | --- |
| **Sync** | Gleicht eine Übersetzungsdatei mit den aktuellen Texten deiner App ab. |
| **Lokale Übersetzungen** | Nutzt Entwicklerkommentare, Sprachdateien und passende Glossareinträge als Ausgangspunkt. |
| **Glossar** | Hilft, Fachbegriffe einheitlich zu übersetzen. |
| **Quality Check** | Findet unter anderem fehlerhafte Platzhalter, abweichende Entwicklertexte und Terminologieprobleme. |
| **AL-Hover** | Zeigt vorhandene Übersetzungen direkt beim Arbeiten im AL-Code. |
| **AI Usage** | Zeigt die erfasste Nutzung der AI-Übersetzung. |

**Du entscheidest, was übernommen wird.** Ein Vorschlag ist noch keine bestätigte Übersetzung. Übernehmen ändert die geöffnete Datei; Speichern schreibt die Änderungen auf den Datenträger. Die AI-Funktionen verwenden ein verfügbares VS-Code-Sprachmodell.

## Einfach starten

1. Öffne dein AL-Projekt in VS Code.
2. Öffne **AL Xliff Studio** in der Seitenleiste. Klappe eine Sprache im **Project Overview** auf oder öffne das Dashboard.
3. Starte **Guided Translation** für eine schrittweise Bearbeitung oder den **XLIFF Editor** für die Tabellenansicht.

Für eine neue Sprache kannst du zuerst Sync prüfen und lokale Übersetzungen vorbereiten. Fehlt eine in deiner App vorgesehene XLIFF, bietet das Dashboard die Erstellung an, sobald eine passende generierte Datei vorhanden ist.

Die Bilder zeigen die tatsächlichen Erweiterungsansichten mit Beispieldaten. AL Xliff Studio benötigt VS Code 1.97 oder neuer. Eine lokale VSIX installierst du über **Extensions: Install from VSIX…**.

[Technische Referenz und weitere Einstellungen](https://github.com/sebastian-arlt/AL-XLiff-Studio/blob/HEAD/docs/technical-reference.md)
