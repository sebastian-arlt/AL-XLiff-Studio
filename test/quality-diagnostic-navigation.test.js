'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const root = path.join(__dirname, '..');

function createVscodeStub() {
    let enabled = true;
    let codeActionProvider;
    let commandHandler;
    let configHandler;
    class CodeAction {
        constructor(title, kind) {
            this.title = title;
            this.kind = kind;
        }
    }
    const vscode = {
        CodeAction,
        CodeActionKind: { QuickFix: { value: 'quickfix' } },
        workspace: {
            getConfiguration() {
                return {
                    get(key, fallback) {
                        return key === 'quality.problemsNavigation.enabled' ? enabled : fallback;
                    }
                };
            },
            onDidChangeConfiguration(handler) {
                configHandler = handler;
                return { dispose() {} };
            }
        },
        languages: {
            registerCodeActionsProvider(_selector, provider) {
                codeActionProvider = provider;
                return { dispose() {} };
            }
        },
        commands: {
            registerCommand(_id, handler) {
                commandHandler = handler;
                return { dispose() {} };
            }
        },
        Uri: {
            parse(value) {
                return { scheme: 'file', fsPath: String(value).replace(/^file:\/\//, ''), toString() { return String(value); } };
            }
        },
        window: { showWarningMessage() {} }
    };
    return {
        vscode,
        setEnabled(value) { enabled = Boolean(value); },
        getProvider() { return codeActionProvider; },
        getCommandHandler() { return commandHandler; },
        getConfigHandler() { return configHandler; }
    };
}

function loadNavigation(stub) {
    const originalLoad = Module._load;
    Module._load = function(request, parent, isMain) {
        if (request === 'vscode') return stub.vscode;
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        delete require.cache[require.resolve('../src/qualityDiagnosticNavigation')];
        return require('../src/qualityDiagnosticNavigation');
    } finally {
        Module._load = originalLoad;
    }
}

function makeDiagnostic() {
    return {
        source: 'AL Xliff Studio',
        code: 'placeholder-mismatch',
        message: 'Placeholder mismatch',
        range: {
            start: { line: 41, character: 2 },
            end: { line: 41, character: 3 }
        }
    };
}

test('Problems Quick Fix navigation is configurable and enabled by default', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const setting = pkg.contributes.configuration.properties['alXliffStudio.quality.problemsNavigation.enabled'];
    assert.ok(setting);
    assert.equal(setting.type, 'boolean');
    assert.equal(setting.default, true);
    assert.match(setting.description, /Show translation unit/);
});

test('diagnostic creation stores a stable translation-unit mapping used by the Quick Fix', async () => {
    const stub = createVscodeStub();
    const navigation = loadNavigation(stub);
    const opened = [];
    const context = { subscriptions: [] };
    navigation.registerQualityDiagnosticNavigation(context, async (uri, target) => {
        opened.push({ uri, target });
        return true;
    });

    const uri = { scheme: 'file', fsPath: '/workspace/Translations/App.de-DE.xlf', toString() { return 'file:///workspace/Translations/App.de-DE.xlf'; } };
    const diagnostic = makeDiagnostic();
    navigation.beginQualityDiagnosticMappings(uri);
    navigation.registerQualityDiagnosticMapping(uri, diagnostic, {
        ordinal: 73,
        id: 'Page 42 - Control 7 - Property Caption',
        source: 'Customer %1',
        code: 'placeholder-mismatch',
        severity: 'error',
        message: 'Placeholder mismatch'
    });

    // Use a clone to prove lookup does not depend on Diagnostic object identity.
    const clonedDiagnostic = makeDiagnostic();
    const actions = stub.getProvider().provideCodeActions({ uri }, undefined, { diagnostics: [clonedDiagnostic] });
    assert.equal(actions.length, 1);
    assert.equal(actions[0].title, 'AL Xliff Studio: Show translation unit');
    assert.equal(actions[0].isPreferred, true);
    assert.deepEqual(actions[0].command.arguments[0].target, {
        ordinal: 73,
        unitId: 'Page 42 - Control 7 - Property Caption',
        source: 'Customer %1',
        code: 'placeholder-mismatch',
        severity: 'error',
        message: 'Placeholder mismatch'
    });

    await stub.getCommandHandler()(actions[0].command.arguments[0]);
    assert.equal(opened.length, 1);
    assert.equal(opened[0].target.ordinal, 73);
    assert.equal(opened[0].target.unitId, 'Page 42 - Control 7 - Property Caption');
});

test('disabling Problems navigation removes Quick Fixes and prevents command navigation', async () => {
    const stub = createVscodeStub();
    const navigation = loadNavigation(stub);
    let opened = 0;
    const context = { subscriptions: [] };
    navigation.registerQualityDiagnosticNavigation(context, async () => { opened++; return true; });
    const uri = { scheme: 'file', fsPath: '/workspace/Translations/App.de-DE.xlf', toString() { return 'file:///workspace/Translations/App.de-DE.xlf'; } };
    const diagnostic = makeDiagnostic();
    navigation.beginQualityDiagnosticMappings(uri);
    navigation.registerQualityDiagnosticMapping(uri, diagnostic, { ordinal: 3, id: 'A', source: 'Hello' });

    stub.setEnabled(false);
    stub.getConfigHandler()({ affectsConfiguration: key => key === 'alXliffStudio.quality.problemsNavigation.enabled' });
    assert.deepEqual(stub.getProvider().provideCodeActions({ uri }, undefined, { diagnostics: [diagnostic] }), []);
    assert.equal(await stub.getCommandHandler()({ uri, target: { ordinal: 3, unitId: 'A', source: 'Hello' } }), false);
    assert.equal(opened, 0);
});

test('XLIFF diagnostics register navigation metadata at creation time without restoring the old click bridge', () => {
    const editorSource = fs.readFileSync(path.join(root, 'src', 'xlfEditor.js'), 'utf8');
    const extensionSource = fs.readFileSync(path.join(root, 'extension.js'), 'utf8');
    assert.match(editorSource, /beginQualityDiagnosticMappings\(uri\)/);
    assert.match(editorSource, /registerQualityDiagnosticMapping\(uri, diagnostic, issue\)/);
    assert.match(editorSource, /static async openAtDiagnosticTarget\(uri, target\)/);
    assert.match(extensionSource, /registerQualityDiagnosticNavigation/);
    assert.doesNotMatch(editorSource, /registerTextDocumentContentProvider/);
    assert.doesNotMatch(editorSource, /onDidChangeTextEditorSelection/);
});
