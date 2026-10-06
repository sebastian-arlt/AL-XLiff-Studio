'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    parseXliff,
    isMissingTranslation,
    isReviewTranslation,
    translatedPairs,
    updateMissingTranslations,
    updateTranslationUnit,
    detectSourceChanges,
    flagSourceChangedUnits
} = require('../src/xliff');
const { calculateXliffMetrics } = require('../src/dashboardMetrics');
const { analyzeXliffQuality } = require('../src/quality');
const { mergeTranslationUnits } = require('../src/merge');

function wrap(units) {
    return `<xliff><file source-language="en-US" target-language="de-DE"><body><group>${units}</group></body></file></xliff>`;
}

test('NAB text markers are parsed as workflow metadata, not translation text', () => {
    const parsed = parseXliff(wrap(`
<trans-unit id="A"><source>Customer</source><target>[NAB: REVIEW]Debitor</target></trans-unit>
<trans-unit id="B"><source>Vendor</source><target>[NAB: SUGGESTION]Kreditor</target></trans-unit>
<trans-unit id="C"><source>Order</source><target>[NAB: NOT TRANSLATED]</target></trans-unit>`));

    assert.equal(parsed.units[0].target, 'Debitor');
    assert.equal(parsed.units[0].targetState, 'needs-review-translation');
    assert.equal(parsed.units[0].nabMarker, '[NAB: REVIEW]');
    assert.equal(parsed.units[1].target, 'Kreditor');
    assert.equal(parsed.units[1].targetState, 'needs-review-translation');
    assert.equal(parsed.units[2].target, '');
    assert.equal(parsed.units[2].targetState, 'new');
});

test('NAB REVIEW and SUGGESTION remain review while NOT TRANSLATED remains missing', () => {
    const parsed = parseXliff(wrap(`
<trans-unit id="A"><source>Customer</source><target>[NAB: REVIEW]Debitor</target></trans-unit>
<trans-unit id="B"><source>Vendor</source><target>[NAB: SUGGESTION]Kreditor</target></trans-unit>
<trans-unit id="C"><source>Order</source><target>[NAB: NOT TRANSLATED]</target></trans-unit>`));

    assert.equal(isReviewTranslation(parsed.units[0]), true);
    assert.equal(isReviewTranslation(parsed.units[1]), true);
    assert.equal(isMissingTranslation(parsed.units[0], true), false);
    assert.equal(isMissingTranslation(parsed.units[1], true), false);
    assert.equal(isMissingTranslation(parsed.units[2], true), true);

    const metrics = calculateXliffMetrics(parsed);
    assert.equal(metrics.review, 2);
    assert.equal(metrics.missing, 1);
    assert.equal(metrics.translated, 0);
});

test('NAB markers can never be exported to companion translation memory', () => {
    const parsed = parseXliff(wrap(`
<trans-unit id="A"><source>Customer</source><target>[NAB: REVIEW]Debitor</target></trans-unit>
<trans-unit id="B"><source>Vendor</source><target>[NAB: SUGGESTION]Kreditor</target></trans-unit>
<trans-unit id="C"><source>Order</source><target>[NAB: NOT TRANSLATED]</target></trans-unit>
<trans-unit id="D"><source>Posting Date</source><target state="translated">Buchungsdatum</target></trans-unit>`));

    assert.deepEqual(translatedPairs(parsed).entries, [
        { source: 'Posting Date', translation: 'Buchungsdatum' }
    ]);
});

test('filling NAB NOT TRANSLATED removes marker and NAB note and writes normal translated state', () => {
    const xlf = wrap(`
<trans-unit id="A"><source>Customer</source><target>[NAB: NOT TRANSLATED]</target><note from="NAB AL Tools">Target has not been translated.</note><note from="Developer">DEU=Debitor</note></trans-unit>`);
    const result = updateMissingTranslations(xlf, new Map([['Customer', 'Debitor']]));

    assert.equal(result.updatedCount, 1);
    assert.match(result.text, /<target state="translated">Debitor<\/target>/);
    assert.doesNotMatch(result.text, /\[NAB:/);
    assert.doesNotMatch(result.text, /from="NAB AL Tools"/);
    assert.match(result.text, /from="Developer"/);
    assert.deepEqual(translatedPairs(parseXliff(result.text)).entries, [{ source: 'Customer', translation: 'Debitor' }]);
});

test('accepting a NAB REVIEW target strips the marker and stale NAB note before adding it to translation memory', () => {
    const xlf = wrap(`
<trans-unit id="A"><source>Customer</source><target>[NAB: REVIEW]Debitor</target><note from="NAB AL Tools">Source changed.</note></trans-unit>`);
    const result = updateTranslationUnit(xlf, 0, { state: 'translated' });

    assert.equal(result.updatedCount, 1);
    assert.match(result.text, /<target state="translated">Debitor<\/target>/);
    assert.doesNotMatch(result.text, /\[NAB:/);
    assert.doesNotMatch(result.text, /NAB AL Tools/);
    assert.deepEqual(translatedPairs(parseXliff(result.text)).entries, [{ source: 'Customer', translation: 'Debitor' }]);
});

test('NAB marker compatibility avoids false no-state and marker-related quality issues', () => {
    const parsed = parseXliff(wrap(`
<trans-unit id="A"><source>Customer</source><target>[NAB: REVIEW]Debitor</target><note from="NAB AL Tools">Review this translation.</note></trans-unit>
<trans-unit id="B"><source>Order</source><target>[NAB: NOT TRANSLATED]</target></trans-unit>`));
    const report = analyzeXliffQuality(parsed);
    const codes = report.issues.map(issue => issue.code);

    assert.equal(codes.includes('target-without-state'), false);
    assert.equal(codes.includes('unknown-state'), false);
    assert.equal(codes.includes('source-equals-target'), false);
});

test('source synchronization migrates a NAB review marker to needs-l10n and removes NAB note', () => {
    const targetText = wrap(`
<trans-unit id="A"><source>Old caption</source><target>[NAB: REVIEW]Alte Beschriftung</target><note from="NAB AL Tools">Source changed.</note></trans-unit>`);
    const source = parseXliff(`<xliff><file source-language="en-US"><body><group>
<trans-unit id="A"><source>New caption</source></trans-unit>
</group></body></file></xliff>`);
    const changes = detectSourceChanges(parseXliff(targetText), source);
    const result = flagSourceChangedUnits(targetText, changes);

    assert.equal(result.flaggedCount, 1);
    assert.match(result.text, /<source>New caption<\/source>/);
    assert.match(result.text, /<target state="needs-l10n">Alte Beschriftung<\/target>/);
    assert.doesNotMatch(result.text, /\[NAB:/);
    assert.doesNotMatch(result.text, /NAB AL Tools/);
});

test('merge into a NAB untranslated target removes NAB metadata and uses Studio review state', () => {
    const targetText = wrap(`
<trans-unit id="A"><source>Customer</source><target>[NAB: NOT TRANSLATED]</target><note from="NAB AL Tools">Not translated.</note></trans-unit>`);
    const sourceText = wrap(`
<trans-unit id="A"><source>Customer</source><target state="translated">Debitor</target></trans-unit>`);
    const result = mergeTranslationUnits(targetText, parseXliff(targetText), parseXliff(sourceText), 'untranslated', { provenanceEnabled: false });

    assert.equal(result.updatedCount, 1);
    assert.match(result.text, /<target state="needs-adaptation">Debitor<\/target>/);
    assert.doesNotMatch(result.text, /\[NAB:/);
    assert.doesNotMatch(result.text, /NAB AL Tools/);
    assert.match(result.text, /AL\.XliffStudio/);
});
