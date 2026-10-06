'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const extensionSource = fs.readFileSync(path.join(root, 'extension.js'), 'utf8');
const aiSource = fs.readFileSync(path.join(root, 'src', 'ai.js'), 'utf8');
const debugSource = fs.readFileSync(path.join(root, 'src', 'aiDebug.js'), 'utf8');
const pathsSource = fs.readFileSync(path.join(root, 'src', 'studioPaths.js'), 'utf8');


test('AI debug mode is opt-in and exposes an Open AI Debug Log command', () => {
    const setting = pkg.contributes.configuration.properties['alXliffStudio.debug.enabled'];
    assert.ok(setting);
    assert.equal(setting.type, 'boolean');
    assert.equal(setting.default, false);
    assert.ok(pkg.contributes.commands.some(command => command.command === 'alXliffStudio.openAiDebugLog'));
    assert.ok(pkg.activationEvents.includes('onCommand:alXliffStudio.openAiDebugLog'));
    assert.match(extensionSource, /openAiDebugLog/);
});


test('AI debug log captures exact prompt, raw response and parse failures only when debug is enabled', () => {
    assert.match(aiSource, /isAiDebugEnabled\(config\)/);
    assert.match(aiSource, /'parse-error'/);
    assert.match(aiSource, /prompt,/);
    assert.match(aiSource, /response: output/);
    assert.match(debugSource, /AI REQUEST \(exact prompt\)/);
    assert.match(debugSource, /AI RESPONSE \(raw text\)/);
    assert.match(pathsSource, /ai-debug\.log/);
});


test('AI debug writer persists a human-readable exact prompt and raw response under .alxliffstudio/debug', async () => {
    const Module = require('node:module');
    const originalLoad = Module._load;
    const files = new Map([[path.resolve('/workspace/MyApp/app.json'), Buffer.from('{}')]]);
    const makeUri = value => ({
        scheme: 'file',
        fsPath: path.resolve(value),
        path: path.resolve(value).replace(/\\/g, '/'),
        toString() { return 'file://' + this.path; }
    });
    const folder = { name: 'Workspace', uri: makeUri('/workspace') };
    const vscodeStub = {
        window: { activeTextEditor: undefined },
        workspace: {
            workspaceFolders: [folder],
            getWorkspaceFolder: () => folder,
            getConfiguration() { return { get(_key, fallback) { return fallback; } }; },
            fs: {
                async stat(uri) { if (!files.has(path.resolve(uri.fsPath))) throw new Error('missing'); return {}; },
                async readFile(uri) { return files.get(path.resolve(uri.fsPath)); },
                async writeFile(uri, content) { files.set(path.resolve(uri.fsPath), Buffer.from(content)); },
                async createDirectory() {}
            }
        },
        Uri: {
            file(value) { return makeUri(value); },
            joinPath(base, ...parts) { return makeUri(path.join(base.fsPath, ...parts)); }
        }
    };
    Module._load = function(request, parent, isMain) {
        if (request === 'vscode') return vscodeStub;
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        delete require.cache[require.resolve('../src/studioPaths')];
        delete require.cache[require.resolve('../src/aiDebug')];
        const { appendAiDebugEntry } = require('../src/aiDebug');
        const resource = makeUri('/workspace/MyApp/Translations/App.de-DE.xlf');
        await appendAiDebugEntry(resource, {
            timestamp: '2026-10-01T08:00:00.000Z',
            status: 'parse-error',
            model: { id: 'luna', name: 'GPT-5.6 Luna' },
            sourceLanguage: 'en-US', targetLanguage: 'de-DE', itemCount: 1,
            request: { prompt: 'Translate this exact request\nINPUT=[{"id":"t0"}]' },
            response: { rawText: 'Unexpected Luna response' },
            error: { name: 'Error', message: 'unsupported response format' }
        });
        const logPath = path.resolve('/workspace/MyApp/.alxliffstudio/debug/ai-debug.log');
        const log = files.get(logPath).toString('utf8');
        assert.match(log, /GPT-5\.6 Luna/);
        assert.match(log, /--- AI REQUEST \(exact prompt\) ---\nTranslate this exact request/);
        assert.match(log, /--- AI RESPONSE \(raw text\) ---\nUnexpected Luna response/);
        assert.match(log, /unsupported response format/);
        assert.equal(files.get(path.resolve('/workspace/MyApp/.alxliffstudio/.gitignore')).toString('utf8'), 'ai-usage.json\ndebug/\n');
    } finally {
        Module._load = originalLoad;
    }
});
