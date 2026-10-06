'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const { recordAiUsage, getAiUsage, resetAiUsage } = require('../src/aiUsage');

test('AI usage aggregates requests, input/output tokens and model metadata for the current session', () => {
    resetAiUsage();
    recordAiUsage({ model: { id: 'model-a', name: 'Model A', vendor: 'test' }, inputTokens: 120, outputTokens: 30 });
    recordAiUsage({ model: { id: 'model-a', name: 'Model A', vendor: 'test' }, inputTokens: 80, outputTokens: 20 });
    recordAiUsage({ model: { id: 'model-b', name: 'Model B' }, inputTokens: undefined, outputTokens: undefined });

    const usage = getAiUsage();
    assert.equal(usage.requests, 3);
    assert.equal(usage.measuredRequests, 2);
    assert.equal(usage.unmeasuredRequests, 1);
    assert.equal(usage.inputTokens, 200);
    assert.equal(usage.outputTokens, 50);
    assert.equal(usage.totalTokens, 250);
    assert.equal(usage.models.length, 2);
    assert.equal(usage.models.find(model => model.id === 'model-a').requests, 2);
});

function loadAiWithTokenModel(showUsage) {
    const originalLoad = Module._load;
    const model = {
        id: 'token-model',
        name: 'Token Model',
        vendor: 'test',
        countCalls: [],
        async countTokens(text) {
            this.countCalls.push(String(text));
            return Math.max(1, Math.ceil(String(text).length / 4));
        },
        async sendRequest() {
            return { text: (async function* () { yield '[{"id":"t0","translation":"Kunde"}]'; })() };
        }
    };
    const vscodeStub = {
        workspace: {
            getConfiguration(section) {
                return { get(key, fallback) {
                    if (section === 'alXliffStudio' && key === 'ai.enabled') return true;
                    if (section === 'alXliffStudio' && key === 'ai.batchSize') return 20;
                    if (section === 'alXliffStudio' && key === 'ai.usage.enabled') return showUsage;
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
    return { ai, model };
}

test('AI translation records model tokenizer counts only when AI usage tracking is enabled', async () => {
    resetAiUsage();
    const enabled = loadAiWithTokenModel(true);
    const item = { key: 'customer#0', source: 'Customer', context: {}, terminology: [] };
    await enabled.ai.translateItemsByKeyDetailed([item], 'en-US', 'de-DE');
    const usage = getAiUsage();
    assert.equal(usage.requests, 1);
    assert.equal(usage.measuredRequests, 1);
    assert.ok(usage.inputTokens > 0);
    assert.ok(usage.outputTokens > 0);
    assert.equal(usage.totalTokens, usage.inputTokens + usage.outputTokens);
    assert.equal(usage.models[0].name, 'Token Model');
    assert.equal(enabled.model.countCalls.length, 2);

    resetAiUsage();
    const disabled = loadAiWithTokenModel(false);
    await disabled.ai.translateItemsByKeyDetailed([item], 'en-US', 'de-DE');
    assert.equal(getAiUsage().requests, 0);
    assert.equal(disabled.model.countCalls.length, 0);
});

test('AI usage has a dedicated persistent overview page and is removed from the Translation Dashboard', () => {
    const dashboard = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8');
    const usagePage = fs.readFileSync(path.join(__dirname, '..', 'src', 'aiUsagePage.js'), 'utf8');
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

    assert.doesNotMatch(dashboard, /AI usage · current VS Code session|Input tokens|Output tokens/);
    assert.match(dashboard, /openAiUsage/);
    assert.match(dashboard, /AI Usage/);
    assert.match(usagePage, /Persistent token statistics/);
    assert.match(usagePage, /Input tokens/);
    assert.match(usagePage, /Output tokens/);
    assert.match(usagePage, /Recent AI requests/);
    assert.equal(pkg.contributes.configuration.properties['alXliffStudio.ai.usage.enabled'].default, true);
    assert.ok(Object.keys(pkg.contributes.configuration.properties).every(key => !key.includes('showAiTokenUsage')));
    assert.ok(pkg.contributes.commands.some(command => command.command === 'alXliffStudio.openAiUsage'));

    const editor = fs.readFileSync(path.join(__dirname, '..', 'src', 'xlfEditor.js'), 'utf8');
    assert.doesNotMatch(editor, /Persistent token statistics|Recent AI requests/);
});

test('persistent AI usage aggregates models, language pairs, days and recent requests', () => {
    const originalLoad = Module._load;
    const vscodeStub = { workspace: {}, window: {}, Uri: {} };
    Module._load = function(request, parent, isMain) {
        if (request === 'vscode') return vscodeStub;
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        for (const mod of ['../src/aiUsageStore', '../src/studioPaths']) {
            try { delete require.cache[require.resolve(mod)]; } catch (_) {}
        }
        const { createEmptyUsageDocument, updateUsageDocument, aggregateUsageDocuments } = require('../src/aiUsageStore');
        let doc = createEmptyUsageDocument();
        doc = updateUsageDocument(doc, {
            timestamp: '2026-10-01T08:00:00.000Z',
            model: { id: 'luna', name: 'Luna' },
            sourceLanguage: 'en-US', targetLanguage: 'de-DE', itemCount: 20,
            inputTokens: 1000, outputTokens: 200
        });
        doc = updateUsageDocument(doc, {
            timestamp: '2026-10-01T09:00:00.000Z',
            model: { id: 'luna', name: 'Luna' },
            sourceLanguage: 'en-US', targetLanguage: 'de-DE', itemCount: 10,
            inputTokens: 500, outputTokens: 100
        });
        assert.equal(doc.totals.requests, 2);
        assert.equal(doc.totals.translationItems, 30);
        assert.equal(doc.totals.totalTokens, 1800);
        assert.equal(doc.models[0].requests, 2);
        assert.equal(doc.languagePairs[0].translationItems, 30);
        assert.equal(doc.days[0].date, '2026-10-01');
        assert.equal(doc.recentRequests.length, 2);

        const aggregate = aggregateUsageDocuments([{ project: 'App', uri: { toString: () => 'file:///usage' }, document: doc }]);
        assert.equal(aggregate.totals.totalTokens, 1800);
        assert.equal(aggregate.projects[0].project, 'App');
        assert.equal(aggregate.models[0].name, 'Luna');
    } finally {
        Module._load = originalLoad;
        for (const mod of ['../src/aiUsageStore', '../src/studioPaths']) {
            try { delete require.cache[require.resolve(mod)]; } catch (_) {}
        }
    }
});

test('dedicated AI Usage webview script is valid and exposes detailed persistent statistics', () => {
    const originalLoad = Module._load;
    const vscodeStub = { workspace: {}, window: {}, ViewColumn: { One: 1 }, Uri: {} };
    Module._load = function(request, parent, isMain) {
        if (request === 'vscode') return vscodeStub;
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        for (const mod of ['../src/aiUsagePage', '../src/aiUsageStore', '../src/studioPaths']) {
            try { delete require.cache[require.resolve(mod)]; } catch (_) {}
        }
        const { AiUsagePage } = require('../src/aiUsagePage');
        const page = Object.create(AiUsagePage.prototype);
        const html = page.getHtml({ cspSource: 'vscode-webview://test' });
        const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/);
        assert.ok(script);
        assert.doesNotThrow(() => new Function(script[1]));
        for (const label of ['AI Usage', 'Models', 'Language pairs', 'Daily usage', 'Projects', 'Recent AI requests']) {
            assert.match(html, new RegExp(label));
        }
        assert.match(html, /\.alxliffstudio\/ai-usage\.json/);
    } finally {
        Module._load = originalLoad;
        for (const mod of ['../src/aiUsagePage', '../src/aiUsageStore', '../src/studioPaths']) {
            try { delete require.cache[require.resolve(mod)]; } catch (_) {}
        }
    }
});
