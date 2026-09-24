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
    const sourceXlf = parseXliff(`<xliff><file source-language="en-US" target-language="fr-FR"><body><group>
<trans-unit id="A"><source>Hello</source><target>Bonjour</target></trans-unit>
<trans-unit id="B"><source>World</source><target>Monde</target></trans-unit>
</group></body></file></xliff>`);
    const targetText = `<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A"><source>Hello</source></trans-unit>
<trans-unit id="B"><source>World</source><target>Welt</target></trans-unit>
</group></body></file></xliff>`;
    const targetParsed = parseXliff(targetText);

    const result = mergeTranslationUnits(targetText, targetParsed, sourceXlf, 'untranslated');
    assert.equal(result.updatedCount, 1);
    assert.match(result.text, /<trans-unit id="A"><source>Hello<\/source>\s*<target state="needs-adaptation">Bonjour<\/target>/);
    assert.match(result.text, />Welt</);
});

test('mergeTranslationUnits overwrite mode replaces existing targets', () => {
    const sourceXlf = parseXliff(`<xliff><file source-language="en-US" target-language="fr-FR"><body><group>
<trans-unit id="A"><source>Hello</source><target>Bonjour</target></trans-unit>
</group></body></file></xliff>`);
    const targetText = `<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A"><source>Hello</source><target>Hallo</target></trans-unit>
</group></body></file></xliff>`;
    const targetParsed = parseXliff(targetText);

    const result = mergeTranslationUnits(targetText, targetParsed, sourceXlf, 'overwrite');
    assert.equal(result.updatedCount, 1);
    assert.match(result.text, />Bonjour</);
});

test('mergeTranslationUnits add mode inserts whole trans-units missing from target', () => {
    const sourceXlf = parseXliff(`<xliff><file source-language="en-US" target-language="fr-FR"><body><group>
<trans-unit id="A"><source>Hello</source><target>Bonjour</target></trans-unit>
<trans-unit id="B"><source>World</source><target>Monde</target></trans-unit>
</group></body></file></xliff>`);
    const targetText = `<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A"><source>Hello</source><target>Hallo</target></trans-unit>
</group></body></file></xliff>`;
    const targetParsed = parseXliff(targetText);

    const result = mergeTranslationUnits(targetText, targetParsed, sourceXlf, 'add');
    assert.equal(result.addedCount, 1);
    assert.match(result.text, /id="B"/);
    assert.match(result.text, />Monde</);
});
