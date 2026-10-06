'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

function loadAiWithVscodeStub(batchSize = 2, requests = [], token, invalidSource) {
    const originalLoad = Module._load;
    const model = {
        id: 'test-model', vendor: 'test', family: 'test-model', name: 'Test Model',
        async sendRequest(messages) {
            const prompt = messages[0].value || messages[0].content || String(messages[0]);
            const marker = 'INPUT=';
            const input = JSON.parse(prompt.slice(prompt.indexOf(marker) + marker.length));
            requests.push(input);
            if (token) token.isCancellationRequested = true;
            const output = input.map(row => ({ id: row.id, translation: row.source === invalidSource ? 'invalid' : `T:${row.source}` }));
            return {
                text: (async function* () { yield JSON.stringify(output); })()
            };
        }
    };
    const vscodeStub = {
        workspace: {
            getConfiguration(section) {
                return {
                    get(key, fallback) {
                        if (section === 'alXliffStudio' && key === 'ai.enabled') return true;
                        if (section === 'alXliffStudio' && key === 'ai.batchSize') return batchSize;
                        if (section === 'alXliffStudio.ai') return '';
                        return fallback;
                    }
                };
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

test('AI translation reports batch progress using completed translation count', async () => {
    const { translateItems } = loadAiWithVscodeStub(2);
    const reports = [];
    const result = await translateItems([
        { key: 'a', source: 'A' },
        { key: 'b', source: 'B' },
        { key: 'c', source: 'C' }
    ], 'en-US', 'de-DE', { isCancellationRequested: false }, (completed, total) => {
        reports.push([completed, total]);
    });

    assert.deepEqual(reports, [[2, 3], [3, 3]]);
    assert.equal(result.get('A'), 'T:A');
    assert.equal(result.get('C'), 'T:C');
});

test('AI deduplicates exact source texts before batching and fans results out to every key', async () => {
    const requests = [], reports = [];
    const {translateItemsByKeyDetailed} = loadAiWithVscodeStub(2, requests);
    const items = ['A','B','C','A','B',' A','a'].map((source,i) => ({key:String(i),source}));
    const detailed = await translateItemsByKeyDetailed(items,'en-US','de-DE',undefined,(done,total) => reports.push([done,total]));
    assert.deepEqual(requests.flat().map(item => item.source), ['A','B','C',' A','a']);
    assert.equal(detailed.translations.size,7);
    assert.equal(detailed.translations.get('0'),detailed.translations.get('3'));
    assert.equal(detailed.translations.get('1'),detailed.translations.get('4'));
    assert.deepEqual(reports,[[4,7],[6,7],[7,7]]);
});

test('AI cancellation stops remaining unique batches and placeholder rejection applies to all duplicates', async () => {
    const requests = [], token = {isCancellationRequested:false};
    const {translateItemsByKey} = loadAiWithVscodeStub(1,requests,token);
    const result = await translateItemsByKey([{key:'a',source:'A'},{key:'b',source:'B'},{key:'c',source:'A'}],'en-US','de-DE',token);
    assert.equal(requests.length,1);
    assert.deepEqual([...result.keys()],['a','c']);
    const invalid = loadAiWithVscodeStub(2,[],undefined,'Hello %1');
    const rejected = await invalid.translateItemsByKey([{key:'a',source:'Hello %1'},{key:'b',source:'Hello %1'}],'en-US','de-DE');
    assert.equal(rejected.size,0);
});

test('permission dialog contains only the number of open AI translations and translation uses notification progress', () => {
    const extensionSource = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
    assert.match(extensionSource, /`\$\{aiPendingCount\} open translation/);
    assert.doesNotMatch(extensionSource, /could not be resolved from Developer comments/);
    assert.match(extensionSource, /location:\s*vscode\.ProgressLocation\.Notification/);
    assert.match(extensionSource, /message:\s*`\$\{Math\.min\(aiCompleted, aiPendingCount\)\} \/ \$\{aiPendingCount\}`/);
});


test('XLIFF editor AI progress reports only the newly completed delta', () => {
    const editorSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'xlfEditor.js'), 'utf8');
    assert.match(editorSource, /let lastAiProgressCompleted = 0/);
    assert.match(editorSource, /const delta = Math\.max\(0, completed - lastAiProgressCompleted\)/);
    assert.match(editorSource, /increment: total \? \(100 \* delta \/ total\) : 0/);
    assert.doesNotMatch(editorSource, /increment: total \? \(100 \* completed \/ total\) : 0/);
});

test('AI confirmation is evaluated only after deterministic translations were applied and reparsed', () => {
    const extensionSource = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
    const deterministicUpdate = extensionSource.indexOf('const deterministicUpdate = updateMissingTranslations');
    const writeDeterministic = extensionSource.indexOf('await writeText(uri, deterministicText)', deterministicUpdate);
    const reparse = extensionSource.indexOf('const afterDeterministic = parseXliff(deterministicText)', writeDeterministic);
    const pendingCount = extensionSource.indexOf('const aiPendingCount =', reparse);
    const aiPrompt = extensionSource.indexOf('await vscode.window.showWarningMessage(', pendingCount);

    assert.ok(deterministicUpdate >= 0);
    assert.ok(writeDeterministic > deterministicUpdate);
    assert.ok(reparse > writeDeterministic);
    assert.ok(pendingCount > reparse);
    assert.ok(aiPrompt > pendingCount);
    assert.match(extensionSource, /const remainingUnits = afterDeterministic\.units\.filter/);
    assert.match(extensionSource, /const companionMap = entriesToMap\(seeded\.entries\)/);
});

test('source synchronization runs before translation-memory and AI remainder calculation', () => {
    const extensionSource = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
    const sourceSync = extensionSource.indexOf('const changedUnits = detectSourceChanges(parsed, sourceParsed)');
    const currentPairs = extensionSource.indexOf('const currentPairs = translatedPairs(parsed', sourceSync);
    const missingUnits = extensionSource.indexOf('const missingUnits = parsed.units.filter', currentPairs);
    const pendingCount = extensionSource.indexOf('const aiPendingCount =', missingUnits);
    assert.ok(sourceSync >= 0);
    assert.ok(currentPairs > sourceSync);
    assert.ok(missingUnits > currentPairs);
    assert.ok(pendingCount > missingUnits);
});
