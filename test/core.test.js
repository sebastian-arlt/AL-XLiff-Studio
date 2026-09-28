'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseLng, serializeLng, mergeEntries } = require('../src/lng');
const { parseXliff, translatedPairs, updateMissingTranslations, placeholdersMatch, parseCommentTranslations, getDeveloperCommentTranslation, getDeveloperCommentTranslationForUnits } = require('../src/xliff');
const { resolveKnownTranslation } = require('../src/resolver');

test('lng roundtrip keeps escaped content and unique keys', () => {
    const text = serializeLng([
        { source: 'Hello', translation: 'Hallo' },
        { source: 'Line\nBreak', translation: 'Zeile\nUmbruch' },
        { source: 'Hello', translation: 'Ignored duplicate' }
    ], 'de-DE');
    const parsed = parseLng(text);
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.entries.length, 2);
    assert.equal(parsed.entries.find(x => x.source === 'Hello').translation, 'Hallo');
    assert.equal(parsed.entries.find(x => x.source === 'Line\nBreak').translation, 'Zeile\nUmbruch');
});

test('merge detects conflicting translation and overwrites when requested', () => {
    const merged = mergeEntries([{ source: 'A', translation: 'Alt' }], [{ source: 'A', translation: 'Neu' }]);
    assert.equal(merged.conflicts.length, 1);
    assert.equal(merged.entries[0].translation, 'Neu');
});

test('parses Business Central XLIFF and extracts translated pairs', () => {
    const xlf = `<?xml version="1.0" encoding="utf-8"?>
<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2">
<file source-language="en-US" target-language="de-DE" datatype="xml"><body><group id="body">
<trans-unit id="A"><source>Encoding time</source><target>Kodierungszeit</target><note from="Developer">Shown in factbox</note></trans-unit>
<trans-unit id="B"><source>Invalid %1</source></trans-unit>
</group></body></file></xliff>`;
    const parsed = parseXliff(xlf);
    assert.equal(parsed.targetLanguage, 'de-DE');
    assert.equal(parsed.units.length, 2);
    assert.equal(parsed.units[0].notes[0], 'Shown in factbox');
    const pairs = translatedPairs(parsed);
    assert.deepEqual(pairs.entries, [{ source: 'Encoding time', translation: 'Kodierungszeit' }]);
});

test('fills absent target and marks it translated', () => {
    const xlf = `<xliff><file source-language="en-US" target-language="de-DE"><body><group><trans-unit id="B">
  <source>Invalid %1</source>
  <note>Context</note>
</trans-unit></group></body></file></xliff>`;
    const translations = new Map([['Invalid %1', 'Ungültig %1']]);
    const result = updateMissingTranslations(xlf, translations, {});
    assert.equal(result.updatedCount, 1);
    assert.match(result.text, /<target state="translated">Ungültig %1<\/target>/);
});

test('replaces stale target but leaves valid target alone', () => {
    const xlf = `<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A"><source>Hello</source><target state="needs-translation">Old</target></trans-unit>
<trans-unit id="B"><source>World</source><target>Welt</target></trans-unit>
</group></body></file></xliff>`;
    const result = updateMissingTranslations(xlf, new Map([['Hello', 'Hallo'], ['World', 'Erde']]), {});
    assert.equal(result.updatedCount, 1);
    assert.match(result.text, /<source>Hello<\/source><target state="translated">Hallo<\/target>/);
    assert.match(result.text, /<source>World<\/source><target>Welt<\/target>/);
});

test('placeholder validator rejects changed placeholders', () => {
    assert.equal(placeholdersMatch('Customer %1 has %2.', 'Kunde %1 hat %2.'), true);
    assert.equal(placeholdersMatch('Customer %1 has %2.', 'Kunde %1 hat %3.'), false);
});

test('fills an existing empty target without producing malformed XML', () => {
    const xlf = `<xliff><file source-language="en-US" target-language="de-DE"><body><group><trans-unit id="C"><source>Hello</source><target></target></trans-unit></group></body></file></xliff>`;
    const result = updateMissingTranslations(xlf, new Map([['Hello', 'Hallo']]), {});
    assert.equal(result.updatedCount, 1);
    assert.match(result.text, /<target state="translated">Hallo<\/target>/);
    assert.doesNotMatch(result.text, /<targetstate=/);
});

test('treats non-final XLIFF states as stale translations', () => {
    const xlf = `<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A"><source>A</source><target state="needs-adaptation">Alt</target></trans-unit>
<trans-unit id="B"><source>B</source><target state="final">Fertig</target></trans-unit>
</group></body></file></xliff>`;
    const parsed = parseXliff(xlf);
    const pairs = translatedPairs(parsed);
    assert.deepEqual(pairs.entries, [{ source: 'B', translation: 'Fertig' }]);
});


test('replaces self-closing needs-translation target instead of leaving it behind', () => {
    const xlf = `<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A"><source>Hello</source><target state="needs-translation"/></trans-unit>
</group></body></file></xliff>`;
    const result = updateMissingTranslations(xlf, new Map([['Hello', 'Hallo']]), {});
    assert.equal(result.updatedCount, 1);
    assert.match(result.text, /<source>Hello<\/source><target state="translated">Hallo<\/target>/);
    assert.doesNotMatch(result.text, /<target state="needs-translation"\s*\/>/);
    assert.equal((result.text.match(/<target\b/g) || []).length, 1);
});


test('reads DEU developer-comment translation for de-DE', () => {
    const xlf = `<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A"><source>Evaluation Month</source><target state="needs-translation"/><note from="Developer" annotates="general" priority="2">DEU=Auswertungsmonat</note></trans-unit>
</group></body></file></xliff>`;
    const unit = parseXliff(xlf).units[0];
    const match = getDeveloperCommentTranslation(unit, 'de-DE');
    assert.equal(match.conflict, false);
    assert.equal(match.translation, 'Auswertungsmonat');
});

test('reads target translation from multi-language DEU/ENU developer comment', () => {
    const xlf = `<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A"><source>Evaluation Month</source><note from="Developer" annotates="general" priority="2">DEU=Auswertungsmonat; ENU=Evaluation Month</note></trans-unit>
</group></body></file></xliff>`;
    const unit = parseXliff(xlf).units[0];
    assert.equal(getDeveloperCommentTranslation(unit, 'de-DE').translation, 'Auswertungsmonat');
    assert.equal(getDeveloperCommentTranslation(unit, 'en-US').translation, 'Evaluation Month');
});

test('reads BCP-47 developer-comment translation for de-DE', () => {
    const xlf = `<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A"><source>Evaluation Month</source><note from="Developer">de-DE=Auswertungsmonat; en-US=Evaluation Month</note></trans-unit>
</group></body></file></xliff>`;
    const unit = parseXliff(xlf).units[0];
    assert.equal(getDeveloperCommentTranslation(unit, 'de-DE').translation, 'Auswertungsmonat');
});

test('does not treat placeholder documentation as a translation comment', () => {
    const xlf = `<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A"><source>Customer %1 on %2</source><note from="Developer">%1 = Customer No.; %2 = Posting Date</note></trans-unit>
</group></body></file></xliff>`;
    const unit = parseXliff(xlf).units[0];
    const match = getDeveloperCommentTranslation(unit, 'de-DE');
    assert.equal(match.conflict, false);
    assert.equal(match.translation, undefined);
});

test('comment parser permits semicolons inside a translated value', () => {
    const parsed = parseCommentTranslations('DEU=Erste Zeile; zweiter Teil; ENU=First line; second part');
    assert.equal(parsed.get('DEU'), 'Erste Zeile; zweiter Teil');
    assert.equal(parsed.get('ENU'), 'First line; second part');
});

test('conflicting developer translations for identical source are reported instead of guessed', () => {
    const xlf = `<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A"><source>Order</source><note from="Developer">DEU=Auftrag</note></trans-unit>
<trans-unit id="B"><source>Order</source><note from="Developer">de-DE=Bestellung</note></trans-unit>
</group></body></file></xliff>`;
    const units = parseXliff(xlf).units;
    const match = getDeveloperCommentTranslationForUnits(units, 'de-DE');
    assert.equal(match.conflict, true);
    assert.equal(match.translation, undefined);
});


test('resolver prefers Developer comment over companion lng', () => {
    const xlf = `<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A"><source>Order</source><note from="Developer">DEU=Auftrag</note></trans-unit>
</group></body></file></xliff>`;
    const units = parseXliff(xlf).units;
    const result = resolveKnownTranslation(units, 'de-DE', new Map([['Order', 'Bestellung']]));
    assert.equal(result.translation, 'Auftrag');
    assert.equal(result.source, 'comment');
});

test('resolver uses companion lng when no Developer translation exists', () => {
    const xlf = `<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A"><source>Order</source><note from="Developer">%1 = ignored placeholder note</note></trans-unit>
</group></body></file></xliff>`;
    const units = parseXliff(xlf).units;
    const result = resolveKnownTranslation(units, 'de-DE', new Map([['Order', 'Bestellung']]));
    assert.equal(result.translation, 'Bestellung');
    assert.equal(result.source, 'map');
});

test('resolver leaves source unresolved for AI after comment and lng miss', () => {
    const xlf = `<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A"><source>Order</source></trans-unit>
</group></body></file></xliff>`;
    const units = parseXliff(xlf).units;
    const result = resolveKnownTranslation(units, 'de-DE', new Map());
    assert.equal(result.translation, undefined);
    assert.equal(result.source, undefined);
});

test('resolver falls back to companion lng when Developer comments conflict', () => {
    const xlf = `<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A"><source>Order</source><note from="Developer">DEU=Auftrag</note></trans-unit>
<trans-unit id="B"><source>Order</source><note from="Developer">DEU=Bestellung</note></trans-unit>
</group></body></file></xliff>`;
    const units = parseXliff(xlf).units;
    const result = resolveKnownTranslation(units, 'de-DE', new Map([['Order', 'Bestellung']]));
    assert.equal(result.commentConflict, true);
    assert.equal(result.translation, 'Bestellung');
    assert.equal(result.source, 'map');
});

test('exact Business Central Developer note DEU translation is resolved before Xliff Generator note', () => {
    const xlf = `<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2"><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="Table 1072466045 - Field 4190130733 - Property 2879900210" size-unit="char" translate="yes" xml:space="preserve">
  <source>Customer No.</source>
  <target state="needs-translation"/>
  <note from="Developer" annotates="general" priority="2">DEU=Debitornummer</note>
  <note from="Xliff Generator" annotates="general" priority="3">Table DBH Account Entry - Field Customer No. - Property Caption</note>
</trans-unit>
</group></body></file></xliff>`;
    const unit = parseXliff(xlf).units[0];
    const { resolveKnownTranslationForUnit } = require('../src/resolver');
    const resolved = resolveKnownTranslationForUnit(unit, [unit], 'de-DE', new Map());
    assert.equal(resolved.source, 'comment');
    assert.equal(resolved.translation, 'Debitornummer');
});

test('exact trans-unit Developer comment wins even when identical source has conflicting comment elsewhere', () => {
    const xlf = `<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A"><source>Customer No.</source><target state="needs-translation"/><note from="Developer">DEU=Debitornummer</note></trans-unit>
<trans-unit id="B"><source>Customer No.</source><target state="needs-translation"/><note from="Developer">DEU=Kundennummer</note></trans-unit>
</group></body></file></xliff>`;
    const units = parseXliff(xlf).units;
    const { resolveKnownTranslationForUnit } = require('../src/resolver');
    const first = resolveKnownTranslationForUnit(units[0], units, 'de-DE', new Map());
    const second = resolveKnownTranslationForUnit(units[1], units, 'de-DE', new Map());
    assert.equal(first.translation, 'Debitornummer');
    assert.equal(second.translation, 'Kundennummer');
});

test('unit-specific translations can update identical source texts independently', () => {
    const xlf = `<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A"><source>Customer No.</source><target state="needs-translation"/></trans-unit>
<trans-unit id="B"><source>Customer No.</source><target state="needs-translation"/></trans-unit>
</group></body></file></xliff>`;
    const result = updateMissingTranslations(xlf, new Map(), {
        translationByOrdinal: new Map([[0, 'Debitornummer'], [1, 'Kundennummer']])
    });
    assert.equal(result.updatedCount, 2);
    assert.match(result.text, /<trans-unit id="A">[\s\S]*?<target state="translated">Debitornummer<\/target>/);
    assert.match(result.text, /<trans-unit id="B">[\s\S]*?<target state="translated">Kundennummer<\/target>/);
});

test('visual XLIFF editor can update an existing translation and status by ordinal', () => {
    const { updateTranslationUnit } = require('../src/xliff');
    const xlf = `<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A"><source>Hello</source><target state="needs-translation"/></trans-unit>
<trans-unit id="B"><source>World</source><target state="translated">Welt</target></trans-unit>
</group></body></file></xliff>`;
    const result = updateTranslationUnit(xlf, 0, { translation: 'Hallo', state: 'translated' });
    assert.equal(result.updatedCount, 1);
    assert.match(result.text, /<trans-unit id="A">[\s\S]*?<target state="translated">Hallo<\/target>/);
    assert.match(result.text, /<trans-unit id="B">[\s\S]*?<target state="translated">Welt<\/target>/);
});

test('visual XLIFF editor removes a target state when no-state is selected', () => {
    const { updateTranslationUnit } = require('../src/xliff');
    const xlf = `<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A"><source>Hello</source><target state="needs-review-translation">Hallo</target></trans-unit>
</group></body></file></xliff>`;
    const result = updateTranslationUnit(xlf, 0, { state: '' });
    assert.equal(result.updatedCount, 1);
    assert.match(result.text, /<target>Hallo<\/target>/);
    assert.doesNotMatch(result.text, /state=/);
});

test('translate=no units are not considered missing and are protected from visual edits', () => {
    const { updateTranslationUnit, isMissingTranslation } = require('../src/xliff');
    const xlf = `<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A" translate="no"><source>Do not translate</source><target state="needs-translation"/></trans-unit>
</group></body></file></xliff>`;
    const unit = parseXliff(xlf).units[0];
    assert.equal(unit.translate, 'no');
    assert.equal(isMissingTranslation(unit, true), false);
    const result = updateTranslationUnit(xlf, 0, { translation: 'Nicht übersetzen' });
    assert.equal(result.updatedCount, 0);
    assert.equal(result.text, xlf);
});


test('visual XLIFF editor can attach a fuzzy review note while filling one unit', () => {
    const { updateTranslationUnit, parseXliff } = require('../src/xliff');
    const input = `<?xml version="1.0" encoding="utf-8"?>\n<xliff version="1.2"><file source-language="en-US" target-language="de-DE"><body>\n<trans-unit id="A"><source>Customer No.</source><target state="needs-translation"/></trans-unit>\n</body></file></xliff>`;
    const result = updateTranslationUnit(input, 0, {
        translation: 'Debitornummer',
        state: 'needs-review-translation',
        note: 'Fuzzy match (91%) from "Customer Number". Please review.'
    });
    const parsed = parseXliff(result.text);
    assert.equal(parsed.units[0].target, 'Debitornummer');
    assert.equal(parsed.units[0].targetState, 'needs-review-translation');
    assert.match(result.text, /from="AL\.XliffStudio"/);
    assert.match(result.text, /Fuzzy match \(91%\)/);
});
