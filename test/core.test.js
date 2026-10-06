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
<trans-unit id="A"><source>Encoding time</source><target state="translated">Kodierungszeit</target><note from="Developer">Shown in factbox</note></trans-unit>
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


test('row retry can skip the existing translation and continue to a changed known suggestion', () => {
    const xlf = `<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A"><source>Status</source><target state="needs-translation">Alt</target><note from="Developer">DEU=Alt</note></trans-unit>
</group></body></file></xliff>`;
    const unit = parseXliff(xlf).units[0];
    const { resolveKnownTranslationForUnit } = require('../src/resolver');

    const changedDeveloper = { ...unit, noteDetails: [{ from: 'Developer', text: 'DEU=Neu' }] };
    const developerResult = resolveKnownTranslationForUnit(changedDeveloper, [changedDeveloper], 'de-DE', new Map([['Status', 'Aus Speicher']]), undefined, [], { excludeTranslation: 'Alt' });
    assert.equal(developerResult.source, 'comment');
    assert.equal(developerResult.translation, 'Neu');

    const fallbackResult = resolveKnownTranslationForUnit(unit, [unit], 'de-DE', new Map([['Status', 'Aus Speicher']]), undefined, [], { excludeTranslation: 'Alt' });
    assert.equal(fallbackResult.source, 'map');
    assert.equal(fallbackResult.translation, 'Aus Speicher');
});

test('row retry treats an unchanged known translation as unresolved instead of staging a no-op', () => {
    const xlf = `<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A"><source>Status</source><target state="needs-translation">Alt</target><note from="Developer">DEU=Alt</note></trans-unit>
</group></body></file></xliff>`;
    const unit = parseXliff(xlf).units[0];
    const { resolveKnownTranslationForUnit } = require('../src/resolver');
    const result = resolveKnownTranslationForUnit(unit, [unit], 'de-DE', new Map([['Status', 'Alt']]), undefined, [], { excludeTranslation: 'Alt' });
    assert.equal(result.translation, undefined);
    assert.equal(result.source, undefined);
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

test('target text without state is review, not missing, and is excluded from translation memory', () => {
    const { isMissingTranslation, isReviewTranslation } = require('../src/xliff');
    const parsed = parseXliff(`<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A"><source>Customer No.</source><target>Debitornummer</target></trans-unit>
<trans-unit id="B"><source>Posting Date</source><target></target></trans-unit>
</group></body></file></xliff>`);
    const noState = parsed.units[0];
    const empty = parsed.units[1];
    assert.equal(isMissingTranslation(noState, true), false);
    assert.equal(isReviewTranslation(noState), true);
    assert.equal(isMissingTranslation(empty, true), true);
    assert.equal(isReviewTranslation(empty), false);
    assert.deepEqual(translatedPairs(parsed).entries, []);
});


test('bulk no-state acceptance sets only valid non-empty targets to translated', () => {
    const { setNoStateTargetsTranslated, parseXliff } = require('../src/xliff');
    const xlf = `<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A"><source>Customer %1</source><target>Kunde %1</target></trans-unit>
<trans-unit id="B"><source>Vendor</source><target>Lieferant</target></trans-unit>
<trans-unit id="C"><source>Already</source><target state="translated">Bereits</target></trans-unit>
<trans-unit id="D"><source>Missing</source><target/></trans-unit>
<trans-unit id="E" translate="no"><source>Locked</source><target>Gesperrt</target></trans-unit>
<trans-unit id="F"><source>Bad %1</source><target>Falsch %2</target></trans-unit>
</group></body></file></xliff>`;
    const result = setNoStateTargetsTranslated(xlf, { provenance: false });
    assert.equal(result.updatedCount, 2);
    assert.deepEqual(result.accepted.map(item => item.source), ['Customer %1', 'Vendor']);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].source, 'Bad %1');
    const parsed = parseXliff(result.text);
    assert.equal(parsed.units[0].targetState, 'translated');
    assert.equal(parsed.units[1].targetState, 'translated');
    assert.equal(parsed.units[2].targetState, 'translated');
    assert.equal(parsed.units[3].targetState, undefined);
    assert.equal(parsed.units[4].targetState, undefined);
    assert.equal(parsed.units[5].targetState, undefined);
});

test('quality ignore note can be added and restored on one translation unit', () => {
    const { setQualityIssueIgnored, parseXliff } = require('../src/xliff');
    const original = `<xliff><file source-language="en-US" target-language="de-DE"><body><trans-unit id="A"><source>Save.</source><target state="translated">Speichern</target></trans-unit></body></file></xliff>`;
    const issue = { code: 'punctuation', source: 'Save.', target: 'Speichern' };
    const ignored = setQualityIssueIgnored(original, 0, issue, true);
    assert.equal(ignored.updatedCount, 1);
    assert.match(ignored.text, /QualityIgnore:/);
    const parsed = parseXliff(ignored.text);
    assert.ok(parsed.units[0].notes.some(note => note.startsWith('QualityIgnore:')));
    const restored = setQualityIssueIgnored(ignored.text, 0, issue, false);
    assert.equal(restored.updatedCount, 1);
    assert.doesNotMatch(restored.text, /QualityIgnore:/);
});

test('staged proposal is persisted as Studio XLIFF note without becoming a target translation', () => {
    const { setStagedTranslation, getStagedTranslation, isStagedTranslationNoteDetail } = require('../src/xliff');
    const xlf = `<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A"><source>Hello %1</source><target state="needs-translation"/></trans-unit>
</group></body></file></xliff>`;
    const provenance = { v: 1, at: '2026-10-01T08:00:00.000Z', origin: 'ai', action: 'proposal', model: { id: 'gpt-test' } };
    const staged = setStagedTranslation(xlf, 0, {
        kind: 'proposal',
        text: 'Hallo %1',
        provenance,
        origin: 'AI · gpt-test'
    });
    assert.equal(staged.updatedCount, 1);
    assert.match(staged.text, /Staged translation:/);
    assert.match(staged.text, /\"kind\":\"proposal\"/);
    const parsed = parseXliff(staged.text);
    assert.equal(parsed.units[0].target, '');
    assert.equal(parsed.units[0].targetState, 'needs-translation');
    assert.deepEqual(translatedPairs(parsed).entries, []);
    const restored = getStagedTranslation(parsed.units[0]);
    assert.equal(restored.kind, 'proposal');
    assert.equal(restored.text, 'Hallo %1');
    assert.equal(restored.origin, 'AI · gpt-test');
    assert.ok(parsed.units[0].noteDetails.some(isStagedTranslationNoteDetail));
});

test('applying a staged draft clears the staging note and writes a translated target', () => {
    const { setStagedTranslation, getStagedTranslation, updateTranslationUnit } = require('../src/xliff');
    const xlf = `<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A"><source>Hello</source><target state="needs-translation"/></trans-unit>
</group></body></file></xliff>`;
    const staged = setStagedTranslation(xlf, 0, { kind: 'draft', text: 'Hallo', origin: '.lng' });
    assert.equal(getStagedTranslation(parseXliff(staged.text).units[0]).text, 'Hallo');
    const applied = updateTranslationUnit(staged.text, 0, { translation: 'Hallo', state: 'translated', clearStaged: true });
    assert.equal(applied.updatedCount, 1);
    assert.match(applied.text, /<target state="translated">Hallo<\/target>/);
    assert.equal(getStagedTranslation(parseXliff(applied.text).units[0]), undefined);
    assert.doesNotMatch(applied.text, /Staged translation:/);
});

test('batch draft commit applies multiple translations in one pass and clears only their staging notes', () => {
    const { setStagedTranslations, updateTranslationUnits, getStagedTranslation } = require('../src/xliff');
    const xlf = `<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A"><source>Hello</source><target state="needs-translation"/></trans-unit>
<trans-unit id="B"><source>World</source><target state="needs-translation"/></trans-unit>
<trans-unit id="C"><source>Keep proposal</source><target state="needs-translation"/></trans-unit>
</group></body></file></xliff>`;
    const staged = setStagedTranslations(xlf, [
        { ordinal: 0, staged: { kind: 'draft', text: 'Hallo' } },
        { ordinal: 1, staged: { kind: 'draft', text: 'Welt' } },
        { ordinal: 2, staged: { kind: 'proposal', text: 'Vorschlag' } }
    ]);
    const applied = updateTranslationUnits(staged.text, [
        { ordinal: 0, changes: { translation: 'Hallo', state: 'translated', clearStaged: true } },
        { ordinal: 1, changes: { translation: 'Welt', state: 'translated', clearStaged: true } }
    ]);
    assert.equal(applied.updatedCount, 2);
    assert.deepEqual(applied.updatedOrdinals, [0, 1]);
    const parsed = parseXliff(applied.text);
    assert.equal(parsed.units[0].target, 'Hallo');
    assert.equal(parsed.units[0].targetState, 'translated');
    assert.equal(parsed.units[1].target, 'Welt');
    assert.equal(parsed.units[1].targetState, 'translated');
    assert.equal(getStagedTranslation(parsed.units[0]), undefined);
    assert.equal(getStagedTranslation(parsed.units[1]), undefined);
    assert.equal(getStagedTranslation(parsed.units[2]).kind, 'proposal');
});

test('source synchronization discards staged metadata created for the previous source text', () => {
    const { setStagedTranslation, detectSourceChanges, flagSourceChangedUnits, getStagedTranslation } = require('../src/xliff');
    const target = `<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A"><source>Old caption</source><target state="needs-translation"/></trans-unit>
</group></body></file></xliff>`;
    const generator = `<xliff><file source-language="en-US"><body><group>
<trans-unit id="A"><source>New caption</source></trans-unit>
</group></body></file></xliff>`;
    const staged = setStagedTranslation(target, 0, { kind: 'proposal', text: 'Alter Vorschlag' });
    const changes = detectSourceChanges(parseXliff(staged.text), parseXliff(generator));
    const synced = flagSourceChangedUnits(staged.text, changes);
    const unit = parseXliff(synced.text).units[0];
    assert.equal(unit.source, 'New caption');
    assert.equal(getStagedTranslation(unit), undefined);
    assert.doesNotMatch(synced.text, /Staged translation:/);
});

test('replaceTranslationUnitRaw restores the exact pre-Apply trans-unit snapshot', () => {
    const { parseXliff, getUnitRaw, updateTranslationUnit, replaceTranslationUnitRaw } = require('../src/xliff');
    const original = '<xliff><file source-language="en-US" target-language="de-DE"><body><group><trans-unit id="A"><source>Hello</source><target state="needs-review-translation">Alt</target><note from="Developer">Keep me</note></trans-unit></group></body></file></xliff>';
    const originalParsed = parseXliff(original);
    const originalRaw = getUnitRaw(original, originalParsed.units[0]);
    const applied = updateTranslationUnit(original, 0, { translation: 'Hallo', state: 'translated', clearStaged: true });
    assert.equal(parseXliff(applied.text).units[0].target, 'Hallo');

    const restored = replaceTranslationUnitRaw(applied.text, 0, originalRaw);
    assert.equal(restored.updatedCount, 1);
    const unit = parseXliff(restored.text).units[0];
    assert.equal(getUnitRaw(restored.text, unit), originalRaw);
    assert.equal(unit.target, 'Alt');
    assert.equal(unit.targetState, 'needs-review-translation');
    assert.ok(unit.notes.some(note => String(note).includes('Keep me')));
});

test('Point 6 stores trans-unit XML offsets instead of retaining unit.raw', () => {
    const { parseXliff, getUnitRaw } = require('../src/xliff');
    const text = `<xliff><file source-language="en-US" target-language="de-DE"><body><group>\n  <trans-unit id="A" xml:space="preserve"><source>Hello <b>world</b></source><target state="translated">Hallo Welt</target><note from="Developer">Keep</note></trans-unit>\n  <trans-unit id="B"><source>Next</source><target/></trans-unit>\n</group></body></file></xliff>`;
    const parsed = parseXliff(text);
    assert.equal(parsed.units.length, 2);
    for (const unit of parsed.units) {
        assert.equal(Object.prototype.hasOwnProperty.call(unit, 'raw'), false, 'parsed unit must not retain a full raw XML copy');
        assert.ok(Number.isInteger(unit.startOffset));
        assert.ok(Number.isInteger(unit.endOffset));
        assert.ok(unit.endOffset > unit.startOffset);
        const raw = getUnitRaw(text, unit);
        assert.match(raw, /^<trans-unit\b/);
        assert.match(raw, /<\/trans-unit>$/);
        assert.equal(text.slice(unit.startOffset, unit.endOffset), raw);
    }
    assert.match(getUnitRaw(text, parsed.units[0]), /<note from="Developer">Keep<\/note>/);
    assert.match(getUnitRaw(text, parsed.units[1]), /<target\/>/);
});

test('Point 6 records source and target content offsets for later zero-copy diagnostics work', () => {
    const { parseXliff } = require('../src/xliff');
    const text = `<xliff><file source-language="en-US" target-language="de-DE"><body><trans-unit id="A"><source>A &amp; B</source><target state="translated">C &lt; D</target></trans-unit></body></file></xliff>`;
    const unit = parseXliff(text).units[0];
    assert.equal(text.slice(unit.sourceStartOffset, unit.sourceEndOffset), 'A &amp; B');
    assert.equal(text.slice(unit.targetStartOffset, unit.targetEndOffset), 'C &lt; D');
    assert.equal(unit.source, 'A & B');
    assert.equal(unit.target, 'C < D');
});
