'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { levenshteinDistance, similarity, findBestFuzzyMatch } = require('../src/fuzzy');
const { findDuplicateIds, findDuplicateGeneratorNotes, findMaxWidthViolations } = require('../src/validate');
const { parseXliff, detectSourceChanges, flagSourceChangedUnits } = require('../src/xliff');
const { mergeTranslationUnits } = require('../src/merge');

test('levenshteinDistance and similarity match known values', () => {
    assert.equal(levenshteinDistance('kitten', 'sitting'), 3);
    assert.equal(similarity('Hello', 'Hello'), 100);
    assert.equal(similarity('', 'x'), 0);
    assert.ok(similarity('Encoding time', 'Encodign time') > 80);
});

test('findBestFuzzyMatch returns closest match above threshold and ignores exact source', () => {
    const entries = [
        { source: 'Encoding time', translation: 'Kodierungszeit' },
        { source: 'Completely different', translation: 'Ganz anders' }
    ];
    const match = findBestFuzzyMatch('Encodign time', entries, 80);
    assert.equal(match.translation, 'Kodierungszeit');

    const noMatch = findBestFuzzyMatch('Encodign time', entries, 99);
    assert.equal(noMatch, undefined);
});

test('findDuplicateIds detects repeated trans-unit ids', () => {
    const xlf = `<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A"><source>Hello</source><target>Hallo</target></trans-unit>
<trans-unit id="A"><source>World</source><target>Welt</target></trans-unit>
</group></body></file></xliff>`;
    assert.deepEqual(findDuplicateIds(parseXliff(xlf)), ['A']);
});

test('findDuplicateGeneratorNotes detects repeated Xliff Generator notes', () => {
    const xlf = `<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A"><source>Hello</source><target>Hallo</target><note from="Xliff Generator">Table 1 - Field 2 - Caption</note></trans-unit>
<trans-unit id="B"><source>World</source><target>Welt</target><note from="Xliff Generator">Table 1 - Field 2 - Caption</note></trans-unit>
</group></body></file></xliff>`;
    assert.deepEqual(findDuplicateGeneratorNotes(parseXliff(xlf)), ['Table 1 - Field 2 - Caption']);
});

test('findMaxWidthViolations flags targets longer than maxwidth', () => {
    const xlf = `<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A" maxwidth="5"><source>Hi</source><target>Hallo Welt</target></trans-unit>
<trans-unit id="B" maxwidth="20"><source>Hi</source><target>Hallo</target></trans-unit>
</group></body></file></xliff>`;
    const violations = findMaxWidthViolations(parseXliff(xlf));
    assert.equal(violations.length, 1);
    assert.equal(violations[0].id, 'A');
});

test('detectSourceChanges finds ids whose source drifted from the g.xlf file', () => {
    const target = parseXliff(`<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A"><source>Old text</source><target>Alter Text</target></trans-unit>
</group></body></file></xliff>`);
    const source = parseXliff(`<xliff><file source-language="en-US"><body><group>
<trans-unit id="A"><source>New text</source></trans-unit>
</group></body></file></xliff>`);
    const changed = detectSourceChanges(target, source);
    assert.equal(changed.size, 1);
    assert.ok(changed.has('A'));
});

test('flagSourceChangedUnits sets needs-l10n and appends a review note once', () => {
    const xlf = `<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A"><source>Old text</source><target>Alter Text</target></trans-unit>
</group></body></file></xliff>`;
    const first = flagSourceChangedUnits(xlf, new Set(['A']));
    assert.equal(first.flaggedCount, 1);
    assert.match(first.text, /state="needs-l10n"/);
    assert.match(first.text, /AL\.XliffStudio/);

    const second = flagSourceChangedUnits(first.text, new Set(['A']));
    assert.equal(second.flaggedCount, 0);
});

test('mergeTranslationUnits untranslated mode only fills empty targets', () => {
    const sourceXlf = parseXliff(`<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A"><source>Hello</source><target>Hallo Quelle</target></trans-unit>
<trans-unit id="B"><source>World</source><target>Welt Quelle</target></trans-unit>
</group></body></file></xliff>`);
    const targetText = `<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A"><source>Hello</source></trans-unit>
<trans-unit id="B"><source>World</source><target>Welt</target></trans-unit>
</group></body></file></xliff>`;
    const targetParsed = parseXliff(targetText);

    const result = mergeTranslationUnits(targetText, targetParsed, sourceXlf, 'untranslated');
    assert.equal(result.updatedCount, 1);
    assert.match(result.text, /<trans-unit id="A"><source>Hello<\/source>\s*<target state="needs-adaptation">Hallo Quelle<\/target>/);
    assert.match(result.text, />Welt</);
});

test('mergeTranslationUnits overwrite mode replaces existing targets', () => {
    const sourceXlf = parseXliff(`<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A"><source>Hello</source><target>Hallo Quelle</target></trans-unit>
</group></body></file></xliff>`);
    const targetText = `<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A"><source>Hello</source><target>Hallo</target></trans-unit>
</group></body></file></xliff>`;
    const targetParsed = parseXliff(targetText);

    const result = mergeTranslationUnits(targetText, targetParsed, sourceXlf, 'overwrite');
    assert.equal(result.updatedCount, 1);
    assert.match(result.text, />Hallo Quelle</);
});

test('mergeTranslationUnits add mode inserts whole trans-units missing from target', () => {
    const sourceText = `<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A"><source>Hello</source><target>Hallo Quelle</target></trans-unit>
<trans-unit id="B"><source>World</source><target>Welt Quelle</target></trans-unit>
</group></body></file></xliff>`;
    const sourceXlf = parseXliff(sourceText);
    const targetText = `<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A"><source>Hello</source><target>Hallo</target></trans-unit>
</group></body></file></xliff>`;
    const targetParsed = parseXliff(targetText);

    const result = mergeTranslationUnits(targetText, targetParsed, sourceXlf, 'add', { sourceText });
    assert.equal(result.addedCount, 1);
    assert.match(result.text, /id="B"/);
    assert.match(result.text, />Welt Quelle</);
});


test('review states are preserved and are not considered missing for AI/fill', () => {
    const { isMissingTranslation, translatedPairs } = require('../src/xliff');
    const parsed = parseXliff(`<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A"><source>Encoding time</source><target state="needs-review-translation">Kodierungszeit</target></trans-unit>
<trans-unit id="B"><source>Changed</source><target state="needs-l10n">Alt</target></trans-unit>
<trans-unit id="C"><source>New</source><target state="needs-translation">Old</target></trans-unit>
</group></body></file></xliff>`);
    assert.equal(isMissingTranslation(parsed.units[0], true), false);
    assert.equal(isMissingTranslation(parsed.units[1], true), false);
    assert.equal(isMissingTranslation(parsed.units[2], true), true);
    // Review candidates are intentionally not promoted into translation memory.
    assert.deepEqual(translatedPairs(parsed).entries, []);
});

test('source synchronization updates source and is not blocked by unrelated AL.XliffStudio notes', () => {
    const targetText = `<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A"><source>Old text</source><target state="needs-review-translation">Alter Text</target><note from="AL.XliffStudio">Fuzzy match (90%) from &quot;Older text&quot;. Please review.</note></trans-unit>
</group></body></file></xliff>`;
    const target = parseXliff(targetText);
    const source = parseXliff(`<xliff><file source-language="en-US"><body><group>
<trans-unit id="A"><source>New text</source></trans-unit>
</group></body></file></xliff>`);
    const changes = detectSourceChanges(target, source);
    const result = flagSourceChangedUnits(targetText, changes);
    assert.equal(result.synchronizedCount, 1);
    assert.equal(result.flaggedCount, 1);
    assert.match(result.text, /<source>New text<\/source>/);
    assert.match(result.text, /state="needs-l10n"/);
    assert.match(result.text, /Fuzzy match/);
    assert.match(result.text, /Source changed from/);
});

test('source synchronization updates an untranslated source without adding review state', () => {
    const targetText = `<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A"><source>Old text</source><target state="needs-translation"/></trans-unit>
</group></body></file></xliff>`;
    const source = parseXliff(`<xliff><file source-language="en-US"><body><group>
<trans-unit id="A"><source>New text</source></trans-unit>
</group></body></file></xliff>`);
    const changes = detectSourceChanges(parseXliff(targetText), source);
    const result = flagSourceChangedUnits(targetText, changes);
    assert.equal(result.synchronizedCount, 1);
    assert.equal(result.flaggedCount, 0);
    assert.match(result.text, /<source>New text<\/source>/);
    assert.match(result.text, /state="needs-translation"/);
    assert.doesNotMatch(result.text, /Source changed from/);
});

test('merge blocks different target languages', () => {
    const source = parseXliff(`<xliff><file source-language="en-US" target-language="fr-FR"><body><group>
<trans-unit id="A"><source>Hello</source><target>Bonjour</target></trans-unit>
</group></body></file></xliff>`);
    const targetText = `<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A"><source>Hello</source></trans-unit>
</group></body></file></xliff>`;
    assert.throws(
        () => mergeTranslationUnits(targetText, parseXliff(targetText), source, 'untranslated'),
        /Target languages differ/
    );
});

test('merge untranslated fills needs-translation but preserves review/adaptation targets', () => {
    const source = parseXliff(`<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A"><source>A</source><target>Neu A</target></trans-unit>
<trans-unit id="B"><source>B</source><target>Neu B</target></trans-unit>
</group></body></file></xliff>`);
    const targetText = `<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A"><source>A</source><target state="needs-translation">Alt A</target></trans-unit>
<trans-unit id="B"><source>B</source><target state="needs-adaptation">Alt B</target></trans-unit>
</group></body></file></xliff>`;
    const result = mergeTranslationUnits(targetText, parseXliff(targetText), source, 'untranslated');
    assert.equal(result.updatedCount, 1);
    assert.match(result.text, /<source>A<\/source><target state="needs-adaptation">Neu A<\/target>/);
    assert.match(result.text, /<source>B<\/source><target state="needs-adaptation">Alt B<\/target>/);
});

test('merge note is idempotent when overwrite is run repeatedly', () => {
    const source = parseXliff(`<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A"><source>Hello</source><target>Hallo Quelle</target></trans-unit>
</group></body></file></xliff>`);
    const targetText = `<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A"><source>Hello</source><target>Hallo</target></trans-unit>
</group></body></file></xliff>`;
    const first = mergeTranslationUnits(targetText, parseXliff(targetText), source, 'overwrite');
    const second = mergeTranslationUnits(first.text, parseXliff(first.text), source, 'overwrite');
    assert.equal((second.text.match(/Copied from another xliff file/g) || []).length, 1);
});

test('source synchronization keeps needs-translation targets eligible for later filling', () => {
    const { isMissingTranslation } = require('../src/xliff');
    const targetText = `<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A"><source>Old text</source><target state="needs-translation">Old draft</target></trans-unit>
</group></body></file></xliff>`;
    const source = parseXliff(`<xliff><file source-language="en-US"><body><group>
<trans-unit id="A"><source>New text</source></trans-unit>
</group></body></file></xliff>`);
    const changes = detectSourceChanges(parseXliff(targetText), source);
    const result = flagSourceChangedUnits(targetText, changes);
    const unit = parseXliff(result.text).units[0];
    assert.equal(unit.source, 'New text');
    assert.equal(unit.targetState, 'needs-translation');
    assert.equal(isMissingTranslation(unit, true), true);
    assert.equal(result.flaggedCount, 0);
});

test('generator companion filename is matched to the translation XLIFF basename', () => {
    const { getGeneratorCompanionFilename } = require('../src/paths');
    assert.equal(getGeneratorCompanionFilename('/project/Translations/My.App.de-DE.xlf', 'de-DE'), 'My.App.g.xlf');
    assert.equal(getGeneratorCompanionFilename('/project/Translations/My.App.fr-FR.xlf', 'de-DE'), undefined);
});

test('merge blocks structurally ambiguous XLIFF files', () => {
    const source = parseXliff(`<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A"><source>Hello</source><target>Hallo 1</target></trans-unit>
<trans-unit id="A"><source>Hello 2</source><target>Hallo 2</target></trans-unit>
</group></body></file></xliff>`);
    const targetText = `<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A"><source>Hello</source></trans-unit>
</group></body></file></xliff>`;
    assert.throws(
        () => mergeTranslationUnits(targetText, parseXliff(targetText), source, 'untranslated'),
        /duplicate trans-unit id/
    );
});

test('duplicate id and generator-note validation can be configured independently', () => {
    const pkg = require('../package.json');
    const props = pkg.contributes.configuration.properties;
    assert.equal(props['alXliffStudio.validation.checkDuplicateIds'].default, true);
    assert.equal(props['alXliffStudio.validation.checkDuplicateGeneratorNotes'].default, true);
});

test('synchronizeTranslationUnits updates sources, adds new units and removes obsolete units', () => {
    const { synchronizeTranslationUnits } = require('../src/synchronize');
    const targetText = `<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A"><source>Old text</source><target state="translated">Alter Text</target></trans-unit>
<trans-unit id="OLD"><source>Obsolete</source><target state="translated">Alt</target></trans-unit>
</group></body></file></xliff>`;
    const sourceText = `<xliff><file source-language="en-US"><body><group>
<trans-unit id="A"><source>New text</source><note from="Xliff Generator">A context</note></trans-unit>
<trans-unit id="B"><source>Brand new</source><note from="Developer">DEU=Ganz neu</note></trans-unit>
</group></body></file></xliff>`;
    const result = synchronizeTranslationUnits(targetText, sourceText);
    assert.equal(result.synchronizedSources, 1);
    assert.equal(result.flaggedTargets, 1);
    assert.equal(result.addedUnits, 1);
    assert.equal(result.removedUnits.length, 1);
    assert.equal(result.removedUnits[0].id, 'OLD');
    assert.equal(result.removedUnits[0].source, 'Obsolete');
    assert.equal(result.removedUnits[0].target, 'Alt');
    assert.match(result.text, /<source>New text<\/source>/);
    assert.match(result.text, /state="needs-l10n">Alter Text<\/target>/);
    assert.match(result.text, /id="B"/);
    assert.match(result.text, /<target state="needs-translation"\/>/);
    assert.match(result.text, /DEU=Ganz neu/);
    assert.doesNotMatch(result.text, /id="OLD"/);
});

test('synchronizeTranslationUnits follows generator trans-unit order instead of appending new units', () => {
    const { synchronizeTranslationUnits } = require('../src/synchronize');
    const targetText = `<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="C"><source>C</source><target state="translated">C-DE</target></trans-unit>
<trans-unit id="A"><source>A</source><target state="translated">A-DE</target></trans-unit>
<trans-unit id="OLD"><source>Old</source><target state="translated">Alt</target></trans-unit>
</group></body></file></xliff>`;
    const sourceText = `<xliff><file source-language="en-US"><body><group>
<trans-unit id="A"><source>A</source></trans-unit>
<trans-unit id="B"><source>B</source></trans-unit>
<trans-unit id="C"><source>C</source></trans-unit>
</group></body></file></xliff>`;

    const result = synchronizeTranslationUnits(targetText, sourceText);
    const positions = ['id="A"', 'id="B"', 'id="C"'].map(token => result.text.indexOf(token));

    assert.ok(positions.every(position => position >= 0));
    assert.ok(positions[0] < positions[1]);
    assert.ok(positions[1] < positions[2]);
    assert.doesNotMatch(result.text, /id="OLD"/);
    assert.equal(result.removedUnits.length, 1);
    assert.match(result.text, /id="A"[\s\S]*?<target state="translated">A-DE<\/target>/);
    assert.match(result.text, /id="B"[\s\S]*?<target state="needs-translation"\/>/);
    assert.match(result.text, /id="C"[\s\S]*?<target state="translated">C-DE<\/target>/);
});

test('replaceTranslationUnitSequence keeps generator-positioned missing units between existing translations', () => {
    const { synchronizeTranslationUnits } = require('../src/synchronize');
    const targetText = `<xliff><file source-language="en-US" target-language="de-DE"><body><group>
        <trans-unit id="A"><source>A</source><target>AA</target></trans-unit>
        <trans-unit id="D"><source>D</source><target>DD</target></trans-unit>
    </group></body></file></xliff>`;
    const sourceText = `<xliff><file source-language="en-US"><body><group>
        <trans-unit id="A"><source>A</source></trans-unit>
        <trans-unit id="B"><source>B</source></trans-unit>
        <trans-unit id="C"><source>C</source></trans-unit>
        <trans-unit id="D"><source>D</source></trans-unit>
    </group></body></file></xliff>`;

    const result = synchronizeTranslationUnits(targetText, sourceText);
    const ids = [...result.text.matchAll(/<trans-unit\b[^>]*id="([^"]+)"/g)].map(match => match[1]);
    assert.deepEqual(ids, ['A', 'B', 'C', 'D']);
});

test('synchronizeTranslationUnits blocks source-language mismatch', () => {
    const { synchronizeTranslationUnits } = require('../src/synchronize');
    const targetText = `<xliff><file source-language="en-US" target-language="de-DE"><body><group><trans-unit id="A"><source>A</source></trans-unit></group></body></file></xliff>`;
    const sourceText = `<xliff><file source-language="de-DE"><body><group><trans-unit id="A"><source>A</source></trans-unit></group></body></file></xliff>`;
    assert.throws(() => synchronizeTranslationUnits(targetText, sourceText), /Source languages differ/);
});

test('source change promotes a no-state target to needs-l10n instead of treating it as missing', () => {
    const { synchronizeTranslationUnits } = require('../src/synchronize');
    const targetText = `<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A"><source>Old caption</source><target>Alte Beschriftung</target></trans-unit>
</group></body></file></xliff>`;
    const sourceText = `<xliff><file source-language="en-US"><body><group>
<trans-unit id="A"><source>New caption</source></trans-unit>
</group></body></file></xliff>`;
    const result = synchronizeTranslationUnits(targetText, sourceText);
    assert.equal(result.flaggedTargets, 1);
    assert.match(result.text, /<source>New caption<\/source>/);
    assert.match(result.text, /<target state="needs-l10n">Alte Beschriftung<\/target>/);
});

test('synchronizeTranslationUnits is idempotent for an already synchronized translation XLIFF', () => {
    const { synchronizeTranslationUnits } = require('../src/synchronize');
    const targetText = `<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A"><source>A</source><target state="translated">A-DE</target></trans-unit>
<trans-unit id="B"><source>B</source><target state="needs-translation"/></trans-unit>
</group></body></file></xliff>`;
    const sourceText = `<xliff><file source-language="en-US"><body><group>
<trans-unit id="A"><source>A</source></trans-unit>
<trans-unit id="B"><source>B</source></trans-unit>
</group></body></file></xliff>`;
    const result = synchronizeTranslationUnits(targetText, sourceText);
    assert.equal(result.text, targetText);
    assert.equal(result.synchronizedSources, 0);
    assert.equal(result.addedUnits, 0);
});

test('synchronizeTranslationUnits mirrors Developer notes from the generated XLIFF while preserving unrelated notes', () => {
    const { synchronizeTranslationUnits } = require('../src/synchronize');
    const targetText = `<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A"><source>A</source><target state="translated">A-DE</target><note from="Developer" annotates="source" priority="2">DEU=Alt</note><note from="Xliff Generator">Table 1 - Field 2 - Caption</note><note from="AL.XliffStudio">Keep me</note></trans-unit>
</group></body></file></xliff>`;
    const sourceText = `<xliff><file source-language="en-US"><body><group>
<trans-unit id="A"><source>A</source><note from="Developer" annotates="source" priority="2">DEU=Neu; FRA=Nouveau</note><note from="Xliff Generator">Table 1 - Field 2 - Caption (new generator detail)</note></trans-unit>
</group></body></file></xliff>`;

    const result = synchronizeTranslationUnits(targetText, sourceText);
    assert.equal(result.synchronizedDeveloperNotes, 1);
    assert.equal(result.synchronizedGeneratorNotes, 1);
    assert.match(result.text, /<target state="translated">A-DE<\/target>/);
    assert.match(result.text, /<note from="Developer" annotates="source" priority="2">DEU=Neu; FRA=Nouveau<\/note>/);
    assert.doesNotMatch(result.text, /DEU=Alt/);
    assert.match(result.text, /<note from="Xliff Generator">Table 1 - Field 2 - Caption \(new generator detail\)<\/note>/);
    assert.match(result.text, /<note from="AL\.XliffStudio">Keep me<\/note>/);
});

test('synchronizeTranslationUnits removes stale Developer notes when the generated unit no longer contains them', () => {
    const { synchronizeTranslationUnits } = require('../src/synchronize');
    const targetText = `<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A"><source>A</source><target>A-DE</target><note from="Developer">DEU=Alt</note><note from="AL.XliffStudio">Keep me</note></trans-unit>
</group></body></file></xliff>`;
    const sourceText = `<xliff><file source-language="en-US"><body><group>
<trans-unit id="A"><source>A</source></trans-unit>
</group></body></file></xliff>`;

    const result = synchronizeTranslationUnits(targetText, sourceText);
    assert.equal(result.synchronizedDeveloperNotes, 1);
    assert.doesNotMatch(result.text, /from="Developer"/);
    assert.match(result.text, /<note from="AL\.XliffStudio">Keep me<\/note>/);
});

test('synchronizeTranslationUnits preserves multiple generated Developer notes and becomes idempotent', () => {
    const { synchronizeTranslationUnits } = require('../src/synchronize');
    const targetText = `<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A"><source>A</source><target>A-DE</target></trans-unit>
</group></body></file></xliff>`;
    const sourceText = `<xliff><file source-language="en-US"><body><group>
<trans-unit id="A"><source>A</source>
  <note from="Developer">DEU=Eins</note>
  <note from='Developer' annotates="source">Comment only</note>
</trans-unit>
</group></body></file></xliff>`;

    const first = synchronizeTranslationUnits(targetText, sourceText);
    assert.equal(first.synchronizedDeveloperNotes, 1);
    assert.equal((first.text.match(/from=["']Developer["']/g) || []).length, 2);
    const second = synchronizeTranslationUnits(first.text, sourceText);
    assert.equal(second.synchronizedDeveloperNotes, 0);
    assert.equal(second.text, first.text);
});


test('synchronizeTranslationUnits adds and removes Xliff Generator notes authoritatively', () => {
    const { synchronizeTranslationUnits } = require('../src/synchronize');
    const targetText = `<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A"><source>A</source><target>A-DE</target><note from="AL.XliffStudio">Keep me</note></trans-unit>
<trans-unit id="B"><source>B</source><target>B-DE</target><note from="Xliff Generator">Stale context</note></trans-unit>
</group></body></file></xliff>`;
    const sourceText = `<xliff><file source-language="en-US"><body><group>
<trans-unit id="A"><source>A</source><note from="Xliff Generator" annotates="general" priority="3">Table Demo - Field A - Property Caption</note></trans-unit>
<trans-unit id="B"><source>B</source></trans-unit>
</group></body></file></xliff>`;

    const first = synchronizeTranslationUnits(targetText, sourceText);
    assert.equal(first.synchronizedGeneratorNotes, 2);
    assert.match(first.text, /Table Demo - Field A - Property Caption/);
    assert.doesNotMatch(first.text, /Stale context/);
    assert.match(first.text, /<note from="AL\.XliffStudio">Keep me<\/note>/);

    const second = synchronizeTranslationUnits(first.text, sourceText);
    assert.equal(second.synchronizedGeneratorNotes, 0);
    assert.equal(second.text, first.text);
});
