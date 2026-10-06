'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const { parseXliff } = require('../src/xliff');
const {
    createAiTranslationItem,
    parseGeneratorNote,
    buildTranslationMemoryExamples
} = require('../src/aiContext');

const SAMPLE = `<?xml version="1.0" encoding="utf-8"?>
<xliff version="1.2"><file source-language="en-US" target-language="de-DE"><body>
  <trans-unit id="a"><source>Open</source><target state="needs-translation"/><note from="Developer">Opens the customer card.</note><note from="Xliff Generator">Page Customer List - Action Open - Property Caption</note></trans-unit>
  <trans-unit id="b"><source>Customer</source><target state="translated">Debitor</target><note from="Xliff Generator">Page Customer List - Field Customer - Property Caption</note></trans-unit>
  <trans-unit id="c"><source>Open</source><target state="translated">Offen</target><note from="Xliff Generator">Table Sales Header - Field Open - Property Caption</note></trans-unit>
  <trans-unit id="d" maxwidth="12"><source>Open customer</source><target state="needs-translation"/><note from="Xliff Generator">Page Customer List - Action OpenCustomer - Property Caption</note></trans-unit>
</body></file></xliff>`;

test('generator note is parsed into Business Central object/element/property context', () => {
    const context = parseGeneratorNote('Page Customer List - Action Open - Property Caption');
    assert.equal(context.objectType, 'Page');
    assert.equal(context.objectName, 'Customer List');
    assert.equal(context.element, 'Action Open');
    assert.equal(context.property, 'Caption');
    assert.deepEqual(context.path, ['Page Customer List', 'Action Open', 'Property Caption']);
});

test('AI context combines generator notes, developer guidance, placeholders, nearby units, same-source contexts, TM and terminology', () => {
    const parsed = parseXliff(SAMPLE);
    const map = new Map([
        ['Open order', 'Auftrag öffnen'],
        ['Close customer', 'Debitor schließen'],
        ['Posting Date', 'Buchungsdatum']
    ]);
    const glossary = [{ source: 'Customer', targetLanguage: 'de-DE', translation: 'Debitor', match: 'word', caseSensitive: false, note: 'BC terminology' }];
    const unit = parsed.units[3];
    const item = createAiTranslationItem(unit, parsed, map, glossary, {
        nearbyUnits: 3,
        translationMemoryExamples: 2,
        minimumMemorySimilarity: 20,
        sameSourceContexts: 3,
        maxCharactersPerItem: 6000
    });

    assert.equal(item.ordinal, 3);
    assert.match(item.key, /d#3$/);
    assert.equal(item.context.generator.objectType, 'Page');
    assert.equal(item.context.generator.objectName, 'Customer List');
    assert.equal(item.context.maxWidth, 12);
    assert.ok(item.context.nearbyUnits.some(row => row.source === 'Customer' && row.confirmedTranslation === 'Debitor'));
    assert.ok(item.context.translationMemoryExamples.some(row => row.source === 'Open order'));
    assert.deepEqual(item.terminology.map(row => row.translation), ['Debitor']);
});

test('same English source gets a distinct AI key and its own AL context per trans-unit', () => {
    const parsed = parseXliff(SAMPLE);
    const first = createAiTranslationItem(parsed.units[0], parsed, new Map(), [], {});
    const second = createAiTranslationItem(parsed.units[2], parsed, new Map(), [], {});
    assert.notEqual(first.key, second.key);
    assert.equal(first.source, second.source);
    assert.equal(first.context.generator.objectName, 'Customer List');
    assert.equal(second.context.generator.objectName, 'Sales Header');
    assert.ok(first.context.developerNotes.some(note => /customer card/i.test(note)));
});

test('translation-memory context returns the strongest confirmed examples first', () => {
    const examples = buildTranslationMemoryExamples('Open customer', new Map([
        ['Open customer card', 'Debitorenkarte öffnen'],
        ['Open order', 'Auftrag öffnen'],
        ['Completely different', 'Völlig anders']
    ]), 2, 10);
    assert.equal(examples.length, 2);
    assert.ok(examples[0].similarity >= examples[1].similarity);
    assert.equal(examples[0].source, 'Open customer card');
});

function loadAiWithContextAwareModel() {
    const originalLoad = Module._load;
    const model = {
        id: 'test-model', vendor: 'test', family: 'test-model', name: 'Test Model',
        async sendRequest(messages) {
            const prompt = messages[0].value || String(messages[0]);
            const marker = 'INPUT=';
            const input = JSON.parse(prompt.slice(prompt.indexOf(marker) + marker.length));
            const output = input.map(row => ({
                id: row.id,
                translation: row.context && row.context.generator && row.context.generator.objectName === 'Customer List' ? 'Öffnen' : 'Offen'
            }));
            return { text: (async function* () { yield JSON.stringify(output); })() };
        }
    };
    const vscodeStub = {
        workspace: {
            getConfiguration(section) {
                return { get(key, fallback) {
                    if (section === 'alXliffStudio' && key === 'ai.enabled') return true;
                    if (section === 'alXliffStudio' && key === 'ai.batchSize') return 20;
                    if (section === 'alXliffStudio.ai') return '';
                    return fallback;
                } };
            }
        },
        lm: { async selectChatModels() { return [model]; } },
        LanguageModelChatMessage: { User(value) { return { value }; } },
        CancellationTokenSource: class { constructor() { this.token = { isCancellationRequested: false }; } },
        window: {}
    };
    Module._load = function(request, parent, isMain) {
        if (request === 'vscode') return vscodeStub;
        return originalLoad.call(this, request, parent, isMain);
    };
    delete require.cache[require.resolve('../src/ai')];
    const ai = require('../src/ai');
    Module._load = originalLoad;
    return ai;
}

test('AI API shares one translation across identical source texts with different contexts', async () => {
    const parsed = parseXliff(SAMPLE);
    const a = createAiTranslationItem(parsed.units[0], parsed, new Map(), [], {});
    const c = createAiTranslationItem(parsed.units[2], parsed, new Map(), [], {});
    const { translateItemsByKey } = loadAiWithContextAwareModel();
    const result = await translateItemsByKey([a, c], 'en-US', 'de-DE');
    assert.equal(result.get(a.key), 'Öffnen');
    assert.equal(result.get(c.key), 'Öffnen');
});

test('AI prompt explicitly documents the structured AL context contract', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'ai.js'), 'utf8');
    assert.match(source, /context\.generator/);
    assert.match(source, /context\.developerNotes/);
    assert.match(source, /context\.nearbyUnits/);
    assert.match(source, /context\.translationMemoryExamples/);
    assert.match(source, /same source text/i);
});

test('package exposes bounded context-aware AI settings', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const props = pkg.contributes.configuration.properties;
    assert.equal(props['alXliffStudio.ai.context.enabled'].default, true);
    assert.equal(props['alXliffStudio.ai.context.nearbyUnits'].default, 4);
    assert.equal(props['alXliffStudio.ai.context.translationMemoryExamples'].default, 3);
    assert.equal(props['alXliffStudio.ai.context.minimumMemorySimilarity'].default, 35);
    assert.equal(props['alXliffStudio.ai.context.sameSourceContexts'].default, 3);
    assert.equal(props['alXliffStudio.ai.context.maxCharactersPerItem'].default, 6000);
});
