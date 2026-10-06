'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

function model(id, vendor, family = id, name = id) {
    return {
        id,
        vendor,
        family,
        name,
        async sendRequest() { return { text: (async function* () { yield '[]'; })() }; }
    };
}

function loadAi(vscodeStub) {
    const originalLoad = Module._load;
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

test('translation model compatibility excludes copilotcli and prefers standard copilot duplicates', () => {
    const vscodeStub = {
        workspace: { getConfiguration() { return { get() { return ''; } }; } },
        lm: { async selectChatModels() { return []; } },
        LanguageModelChatMessage: { User(value) { return { value }; } },
        CancellationTokenSource: class { constructor() { this.token = {}; } },
        window: {}
    };
    const ai = loadAi(vscodeStub);
    const models = ai.compatibleTranslationModels([
        model('gpt-5.6-luna', 'copilotcli', 'gpt-5.6-luna', 'GPT-5.6 Luna CLI'),
        model('gpt-5.6-luna', 'copilot', 'gpt-5.6-luna', 'GPT-5.6 Luna'),
        model('claude-sonnet', 'copilot', 'claude-sonnet', 'Claude Sonnet'),
        model('other', 'thirdparty', 'other', 'Other')
    ]);

    assert.equal(models.some(entry => entry.vendor === 'copilotcli'), false);
    assert.equal(models.filter(entry => entry.id === 'gpt-5.6-luna').length, 1);
    assert.equal(models.find(entry => entry.id === 'gpt-5.6-luna').vendor, 'copilot');
});

test('Select Translation AI Model only offers compatible models and stores vendor/family', async () => {
    const updates = [];
    let offered;
    const lunaCli = model('gpt-5.6-luna', 'copilotcli', 'gpt-5.6-luna', 'GPT-5.6 Luna CLI');
    const luna = model('gpt-5.6-luna', 'copilot', 'gpt-5.6-luna', 'GPT-5.6 Luna');
    const sonnet = model('claude-sonnet', 'copilot', 'claude-sonnet', 'Claude Sonnet');
    const vscodeStub = {
        workspace: {
            getConfiguration() {
                return {
                    get() { return ''; },
                    async update(key, value, target) { updates.push({ key, value, target }); }
                };
            }
        },
        lm: { async selectChatModels() { return [lunaCli, luna, sonnet]; } },
        LanguageModelChatMessage: { User(value) { return { value }; } },
        CancellationTokenSource: class { constructor() { this.token = {}; } },
        ConfigurationTarget: { Workspace: 2 },
        window: {
            async showQuickPick(items) {
                offered = items;
                return items.find(item => item.model.id === 'gpt-5.6-luna');
            },
            showInformationMessage() {},
            showWarningMessage() {}
        }
    };
    const ai = loadAi(vscodeStub);
    await ai.chooseAiModelCommand();

    assert.deepEqual(offered.map(item => [item.model.id, item.model.vendor]), [
        ['claude-sonnet', 'copilot'],
        ['gpt-5.6-luna', 'copilot']
    ]);
    assert.deepEqual(updates.map(({ key, value }) => [key, value]), [
        ['modelId', 'gpt-5.6-luna'],
        ['vendor', 'copilot'],
        ['family', 'gpt-5.6-luna']
    ]);
});

test('configured copilotcli model is resolved through a compatible provider instead', async () => {
    const lunaCli = model('gpt-5.6-luna', 'copilotcli', 'gpt-5.6-luna', 'GPT-5.6 Luna CLI');
    const luna = model('gpt-5.6-luna', 'copilot', 'gpt-5.6-luna', 'GPT-5.6 Luna');
    const selectors = [];
    const vscodeStub = {
        workspace: {
            getConfiguration() {
                return { get(key) {
                    if (key === 'modelId') return 'gpt-5.6-luna';
                    if (key === 'vendor') return 'copilotcli';
                    if (key === 'family') return 'gpt-5.6-luna';
                    return '';
                } };
            }
        },
        lm: {
            async selectChatModels(selector) {
                selectors.push(selector);
                if (selector.id === 'gpt-5.6-luna') return [lunaCli, luna];
                return [lunaCli, luna];
            }
        },
        LanguageModelChatMessage: { User(value) { return { value }; } },
        CancellationTokenSource: class { constructor() { this.token = {}; } },
        window: {}
    };
    const ai = loadAi(vscodeStub);
    const selected = await ai.selectModelFromConfiguration();
    assert.equal(selected.vendor, 'copilot');
    assert.equal(selectors[0].vendor, undefined);
});
