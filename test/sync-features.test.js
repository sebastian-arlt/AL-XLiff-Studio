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
    assert.match(first.text, /BC\.XliffMap/);

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
    const sourceXlf = parseXliff(`<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A"><source>Hello</source><target>Hallo Quelle</target></trans-unit>
<trans-unit id="B"><source>World</source><target>Welt Quelle</target></trans-unit>
</group></body></file></xliff>`);
    const targetText = `<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A"><source>Hello</source><target>Hallo</target></trans-unit>
</group></body></file></xliff>`;
    const targetParsed = parseXliff(targetText);

    const result = mergeTranslationUnits(targetText, targetParsed, sourceXlf, 'add');
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

test('source synchronization updates source and is not blocked by unrelated BC.XliffMap notes', () => {
    const targetText = `<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A"><source>Old text</source><target state="needs-review-translation">Alter Text</target><note from="BC.XliffMap">Fuzzy match (90%) from &quot;Older text&quot;. Please review.</note></trans-unit>
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
    assert.equal(props['bcXliffLanguageMap.validation.checkDuplicateIds'].default, true);
    assert.equal(props['bcXliffLanguageMap.validation.checkDuplicateGeneratorNotes'].default, true);
});
