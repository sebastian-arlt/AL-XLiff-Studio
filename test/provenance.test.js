'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseXliff, updateTranslationUnit } = require('../src/xliff');
const {
    createProvenance,
    provenanceFromResolved,
    serializeProvenanceNote,
    parseProvenanceNote,
    getProvenanceHistory,
    formatProvenanceLabel,
    formatProvenanceHistory
} = require('../src/provenance');
const { mergeTranslationUnits } = require('../src/merge');

test('provenance note roundtrips through XLIFF and keeps AI model metadata', () => {
    const xlf = `<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A"><source>Open</source><target state="needs-translation"/></trans-unit>
</group></body></file></xliff>`;
    const provenance = createProvenance('ai', {
        at: '2026-09-30T10:00:00.000Z',
        action: 'applied',
        model: { id: 'gpt-test', name: 'GPT Test', vendor: 'copilot', family: 'gpt' }
    });
    const result = updateTranslationUnit(xlf, 0, {
        translation: 'Öffnen',
        state: 'translated',
        provenance
    });
    assert.equal(result.updatedCount, 1);
    assert.match(result.text, /Provenance:/);
    const unit = parseXliff(result.text).units[0];
    const history = getProvenanceHistory(unit.noteDetails);
    assert.equal(history.length, 1);
    assert.equal(history[0].origin, 'ai');
    assert.equal(history[0].model.id, 'gpt-test');
    assert.equal(formatProvenanceLabel(history[0]), 'AI · GPT Test');
    assert.match(formatProvenanceHistory(history[0]), /applied/);
});

test('provenance history is append-only across later acceptance events', () => {
    const xlf = `<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A"><source>Open</source><target state="needs-translation"/></trans-unit>
</group></body></file></xliff>`;
    const first = updateTranslationUnit(xlf, 0, {
        translation: 'Öffnen',
        state: 'needs-review-translation',
        provenance: createProvenance('fuzzy', {
            at: '2026-09-30T10:00:00.000Z',
            action: 'staged-for-review',
            quality: 91,
            matchedSource: 'Open Card'
        })
    });
    const second = updateTranslationUnit(first.text, 0, {
        state: 'translated',
        provenance: createProvenance('human-accepted', {
            at: '2026-09-30T10:05:00.000Z',
            action: 'accepted',
            previousState: 'needs-review-translation'
        })
    });
    const history = getProvenanceHistory(parseXliff(second.text).units[0].noteDetails);
    assert.equal(history.length, 2);
    assert.equal(history[0].origin, 'fuzzy');
    assert.equal(history[0].quality, 91);
    assert.equal(history[1].origin, 'human-accepted');
    assert.equal(history[1].previousState, 'needs-review-translation');
});

test('resolved-source provenance distinguishes direct comment, lng, glossary and fuzzy', () => {
    assert.equal(provenanceFromResolved({ source: 'comment', commentScope: 'unit' }).origin, 'developer-comment');
    assert.equal(provenanceFromResolved({ source: 'map' }).origin, 'lng');
    assert.equal(provenanceFromResolved({ source: 'glossary', glossaryEntry: { source: 'Customer' } }).term, 'Customer');
    const fuzzy = provenanceFromResolved({ source: 'fuzzy', quality: 87, matchedSource: 'Posting Date' });
    assert.equal(fuzzy.origin, 'fuzzy');
    assert.equal(fuzzy.quality, 87);
    assert.equal(fuzzy.matchedSource, 'Posting Date');
});

test('provenance JSON note parser ignores unrelated AL Xliff Studio notes', () => {
    const event = createProvenance('lng', { at: '2026-09-30T10:00:00.000Z', action: 'applied' });
    const note = serializeProvenanceNote(event);
    assert.equal(parseProvenanceNote(note).origin, 'lng');
    assert.equal(parseProvenanceNote('Fuzzy match (90%) from "Hello". Please review.'), undefined);
});

test('XLIFF merge writes merge provenance together with review note', () => {
    const source = `<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A"><source>Hello</source><target state="translated">Hallo</target></trans-unit>
</group></body></file></xliff>`;
    const target = `<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A"><source>Hello</source><target state="needs-translation"/></trans-unit>
</group></body></file></xliff>`;
    const result = mergeTranslationUnits(target, parseXliff(target), parseXliff(source), 'untranslated');
    const history = getProvenanceHistory(parseXliff(result.text).units[0].noteDetails);
    assert.equal(history.length, 1);
    assert.equal(history[0].origin, 'merge');
    assert.equal(history[0].action, 'merged-for-review');
});

test('visual XLIFF editor carries provenance through proposal and draft staging', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'xlfEditor.js'), 'utf8');
    assert.match(source, /translationDraftProvenance/);
    assert.match(source, /proposalProvenance/);
    assert.match(source, /provenanceHistoryLabels/);
    assert.match(source, /History /);
    assert.match(source, /provenance:row\.translationDraftProvenance/);
});

test('provenance can be disabled for merge output and is exposed as a setting', () => {
    const source = `<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A"><source>Hello</source><target state="translated">Hallo</target></trans-unit>
</group></body></file></xliff>`;
    const target = `<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A"><source>Hello</source><target state="needs-translation"/></trans-unit>
</group></body></file></xliff>`;
    const result = mergeTranslationUnits(target, parseXliff(target), parseXliff(source), 'untranslated', { provenanceEnabled: false });
    assert.doesNotMatch(result.text, /Provenance:/);
    assert.match(result.text, /Copied from another xliff file/);

    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const setting = pkg.contributes.configuration.properties['alXliffStudio.provenance.enabled'];
    assert.ok(setting);
    assert.equal(setting.type, 'boolean');
    assert.equal(setting.default, true);
});
