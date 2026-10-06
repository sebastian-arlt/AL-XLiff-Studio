'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function loadAiParser() {
    const originalLoad = Module._load;
    const vscodeStub = {
        workspace: { getConfiguration() { return { get(_key, fallback) { return fallback; } }; } },
        lm: { async selectChatModels() { return []; } },
        LanguageModelChatMessage: { User(value) { return { value }; } },
        CancellationTokenSource: class { constructor() { this.token = {}; } },
        window: {}
    };
    Module._load = function(request, parent, isMain) {
        if (request === 'vscode') return vscodeStub;
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        delete require.cache[require.resolve('../src/ai')];
        return require('../src/ai').parseJsonArray;
    } finally {
        Module._load = originalLoad;
    }
}

test('AI parser accepts strict arrays and a single translation object returned by compact models', () => {
    const parse = loadAiParser();
    assert.deepEqual(parse('[{"id":"t0","translation":"Kunde"}]'), [{ id: 't0', translation: 'Kunde' }]);
    assert.deepEqual(parse('{"id":"t0","translation":"Kunde"}'), [{ id: 't0', translation: 'Kunde' }]);
});

test('AI parser accepts common wrapper, keyed, JSON-lines, and prose response shapes', () => {
    const parse = loadAiParser();
    assert.deepEqual(parse('{"translations":[{"id":"t0","translation":"Kunde"},{"id":"t1","translation":"Artikel"}]}'), [
        { id: 't0', translation: 'Kunde' },
        { id: 't1', translation: 'Artikel' }
    ]);
    assert.deepEqual(parse('{"t0":"Kunde","t1":"Artikel"}'), [
        { id: 't0', translation: 'Kunde' },
        { id: 't1', translation: 'Artikel' }
    ]);
    assert.deepEqual(parse('{"id":"t0","translation":"Kunde"}\n{"id":"t1","translation":"Artikel"}'), [
        { id: 't0', translation: 'Kunde' },
        { id: 't1', translation: 'Artikel' }
    ]);
    assert.deepEqual(parse('Here is the result:\n```json\n[{"id":"t0","translation":"Kunde"}]\n```'), [
        { id: 't0', translation: 'Kunde' }
    ]);
});

test('AI parser accepts alternate compact-model field names, trailing commas, tables and numbered lists', () => {
    const parse = loadAiParser();
    assert.deepEqual(parse('[{"id":"t0","target":"Kunde",},{"key":"t1","translatedText":"Artikel",}]', 2), [
        { id: 't0', translation: 'Kunde' },
        { id: 't1', translation: 'Artikel' }
    ]);
    assert.deepEqual(parse('| id | translation |\n| --- | --- |\n| t0 | Kunde |\n| t1 | Artikel |', 2), [
        { id: 't0', translation: 'Kunde' },
        { id: 't1', translation: 'Artikel' }
    ]);
    assert.deepEqual(parse('Here are the translations:\n1. Kunde\n2. Artikel', 2), [
        { id: 't0', translation: 'Kunde' },
        { id: 't1', translation: 'Artikel' }
    ]);
    assert.deepEqual(parse('Kunde', 1), [{ id: 't0', translation: 'Kunde' }]);
    assert.deepEqual(parse("[{'id':'t0','translation':'Kunde'},{'id':'t1','translation':'Artikel'}]", 2), [
        { id: 't0', translation: 'Kunde' },
        { id: 't1', translation: 'Artikel' }
    ]);
    assert.deepEqual(parse('- id: t0\n  translation: Kunde\n- id: t1\n  translation: Artikel', 2), [
        { id: 't0', translation: 'Kunde' },
        { id: 't1', translation: 'Artikel' }
    ]);
});

function loadAiWithResponseFactory(responseFactory) {
    const originalLoad = Module._load;
    const model = {
        id: 'compact-model', name: 'Compact Model', vendor: 'test',
        async sendRequest(messages) {
            const output = responseFactory(messages[0].value);
            return { text: (async function* () { yield output; })() };
        }
    };
    const vscodeStub = {
        workspace: {
            getConfiguration(section) {
                return { get(key, fallback) {
                    if (section === 'alXliffStudio' && key === 'ai.enabled') return true;
                    if (section === 'alXliffStudio' && key === 'ai.batchSize') return 20;
                    if (section === 'alXliffStudio' && key === 'ai.usage.enabled') return false;
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
    try {
        delete require.cache[require.resolve('../src/ai')];
        return require('../src/ai');
    } finally {
        Module._load = originalLoad;
    }
}

test('AI translation maps one-based ids returned by compact models back to the requested units', async () => {
    const ai = loadAiWithResponseFactory(() => '[{"id":"t1","translation":"Kunde"},{"id":"t2","translation":"Artikel"}]');
    const items = [
        { key: 'customer', source: 'Customer', context: {}, terminology: [] },
        { key: 'item', source: 'Item', context: {}, terminology: [] }
    ];
    const result = await ai.translateItemsByKeyDetailed(items, 'en-US', 'de-DE');
    assert.equal(result.translations.get('customer'), 'Kunde');
    assert.equal(result.translations.get('item'), 'Artikel');
});

test('AI translation splits an unsupported batch and accepts bare single-item responses', async () => {
    let calls = 0;
    const ai = loadAiWithResponseFactory(prompt => {
        calls++;
        const payload = JSON.parse(prompt.slice(prompt.lastIndexOf('INPUT=') + 6));
        if (payload.length > 1) return 'I translated the requested texts.';
        return payload[0].source === 'Customer' ? 'Kunde' : 'Artikel';
    });
    const items = [
        { key: 'customer', source: 'Customer', context: {}, terminology: [] },
        { key: 'item', source: 'Item', context: {}, terminology: [] }
    ];
    const result = await ai.translateItemsByKeyDetailed(items, 'en-US', 'de-DE');
    assert.equal(result.translations.get('customer'), 'Kunde');
    assert.equal(result.translations.get('item'), 'Artikel');
    assert.equal(calls, 3);
});
