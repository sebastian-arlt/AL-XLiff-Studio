# 1.11.101 – Note-Reihenfolge beim Sync

Geänderte Developer- und Xliff-Generator-Notes wurden beim Sync bisher entfernt und am Ende neu eingefügt. Sync ersetzt die Inhalte nun an den vorhandenen Positionen. Passende Notes bleiben auch bei anders sortierten Generator-Notes an ihrer Stelle. Zusätzliche Notes desselben Typs werden beim letzten bestehenden Eintrag ergänzt; nicht mehr vorhandene Notes werden weiterhin entfernt. Notes anderer Herkunft und Studio-Notes bleiben erhalten.

Fuzzy Match bleibt standardmäßig aktiv, Provenance standardmäßig deaktiviert. Studio-Notes bleiben weiterhin in der XLIFF; keine JSON-Auslagerung.

428 automatisierte Tests bestanden. Neue Prüffälle decken unterschiedliche Note-Reihenfolgen, mehrere Notes desselben Typs, neue und entfallene Notes, CRLF, wiederholten Sync und den Hintergrundprozess ab. Syntax- und VSIX-Prüfung über den etablierten Buildprozess; manuelle GUI-Prüfung steht aus.

Dateien: src/synchronize.js, test/empty-note-sync.test.js, docs/technical-reference.md, package.json, package-lock.json, CHANGELOG.md, CHANGE_REPORT.md.
