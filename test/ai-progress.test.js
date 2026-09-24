'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

function loadAiWithVscodeStub(batchSize = 2) {
    const originalLoad = Module._load;
    const model = {
        async sendRequest(messages) {
            const prompt = messages[0].value || messages[0].content || String(messages[0]);
            const marker = 'INPUT=';
            const input = JSON.parse(prompt.slice(prompt.indexOf(marker) + marker.length));
            const output = input.map(row => ({ id: row.id, translation: `T:${row.source}` }));
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
                        if (section === 'bcXliffLanguageMap' && key === 'ai.enabled') return true;
                        if (section === 'bcXliffLanguageMap' && key === 'ai.batchSize') return batchSize;
                        if (section === 'bcXliffLanguageMap.ai') return '';
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

test('permission dialog contains only the number of open AI translations and translation uses notification progress', () => {
    const extensionSource = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
    assert.match(extensionSource, /`\$\{aiPendingCount\} open translation/);
    assert.doesNotMatch(extensionSource, /could not be resolved from Developer comments/);
    assert.match(extensionSource, /location:\s*vscode\.ProgressLocation\.Notification/);
    assert.match(extensionSource, /message:\s*`\$\{Math\.min\(aiCompleted, aiPendingCount\)\} \/ \$\{aiPendingCount\}`/);
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
