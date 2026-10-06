# AL Xliff Studio 1.11.72 – Leere Notes unverändert erhalten

Sync erkennt leere `<note .../>`, `<note ... />` und `<note ...></note>` als gleichwertig. Eine reine Abweichung dieser Schreibweise erzeugt keine Note-Änderung und keinen falschen out-of-sync-Status. Im bestehenden Translation-XLIFF bleibt die vorhandene Form erhalten – einschließlich unverändertem Raw-XML, wenn die Note ansonsten gleich ist.

Wenn andere Notes oder Attribute tatsächlich angepasst werden, behalten bestehende leere Notes ihre selbstschließende beziehungsweise ausgeschriebene Form. Inhaltliche Änderungen, Hinzufügen und Entfernen von Notes folgen weiterhin dem Generator. Bei neuen Notes ohne bestehendes Gegenstück gilt die Generator-Schreibweise. Beide Sync-Aufrufer (Editor/Dashboard) und Worker nutzen dieselbe korrigierte Funktion.

Der bisherige Note-RegEx konnte eine selbstschließende Note bis zum schließenden Tag einer nachfolgenden Note erfassen. Erkennung, Entfernen und XLIFF-Parser behandeln selbstschließende Notes jetzt getrennt. Unrelated Notes bleiben erhalten und werden korrekt ihrem from-Attribut zugeordnet.

Dateien: `src/synchronize.js`, `src/xliff.js`, `test/empty-note-sync.test.js`, Versionsdateien und Changelog.

367 Tests, Syntaxprüfung und regulärer VSIX-Build erfolgreich. Gezielte Regressionen prüfen beide Schreibweisen, Leerzeichen vor />, tatsächliche Attribut-/Note-Änderungen, benachbarte unrelated Notes, Idempotenz sowie die Gleichheit des realen Sync-Workers. 15-MB/30.000-Einheiten-Stresstest erfolgreich. Native sichtbare VS-Code-Abnahme bleibt offen.

Lieferung: `al-xliff-studio-1.11.72.vsix`, `al-xliff-studio-source-1.11.72.zip`.
