'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

function createVscodeStub(initialFiles = {}) {
    const makeUri = value => ({
        scheme: 'file',
        fsPath: path.resolve(value),
        path: path.resolve(value).replace(/\\/g, '/'),
        toString() { return 'file://' + this.path; }
    });
    const folder = { name: 'Workspace', uri: makeUri('/workspace') };
    const files = new Map(Object.entries(initialFiles).map(([key, value]) => [path.resolve(key), Buffer.from(value)]));
    const vscode = {
        window: { activeTextEditor: undefined },
        workspace: {
            workspaceFolders: [folder],
            getWorkspaceFolder: () => folder,
            fs: {
                async stat(uri) {
                    if (!files.has(path.resolve(uri.fsPath))) throw Object.assign(new Error('missing'), { code: 'FileNotFound' });
                    return {};
                },
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
    return { vscode, makeUri, files };
}

function loadProjectQualityIgnore(vscodeStub) {
    const originalLoad = Module._load;
    Module._load = function(request, parent, isMain) {
        if (request === 'vscode') return vscodeStub;
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        for (const name of ['../src/projectQualityIgnore', '../src/studioPaths']) delete require.cache[require.resolve(name)];
        return require('../src/projectQualityIgnore');
    } finally {
        Module._load = originalLoad;
    }
}

test('project Quality Ignore JSON stores rule codes only, deduplicates them and migrates old exact entries', () => {
    const { vscode } = createVscodeStub();
    const ignores = loadProjectQualityIgnore(vscode);
    const legacy = {
        code: 'placeholder-mismatch', severity: 'error', message: 'Placeholders differ',
        source: 'Customer %1', target: 'Kunde %2', targetLanguage: 'de-DE'
    };
    const text = ignores.serializeProjectQualityIgnores([legacy, legacy, { code: 'punctuation' }]);
    const parsed = ignores.parseProjectQualityIgnores(text);
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.version, 2);
    assert.deepEqual(parsed.ignores, [
        { code: 'placeholder-mismatch' },
        { code: 'punctuation' }
    ]);

    const migrated = ignores.parseProjectQualityIgnores(JSON.stringify({ version:1, ignores:[legacy, { ...legacy, source:'Other' }] }));
    assert.deepEqual(migrated.ignores, [{ code:'placeholder-mismatch' }]);
});

test('project Quality Ignore persists one project-wide rule and restore removes the rule', async () => {
    const { vscode, makeUri, files } = createVscodeStub({ '/workspace/MyApp/app.json': '{}' });
    const ignores = loadProjectQualityIgnore(vscode);
    const xlf = makeUri('/workspace/MyApp/Translations/App.de-DE.xlf');
    const issue = {
        code: 'formatting-sequence-mismatch', severity: 'error', message: 'Formatting differs',
        source: 'A\\B', target: 'A B'
    };

    const added = await ignores.setProjectQualityIssueIgnored(xlf, issue, 'de-DE', true);
    assert.equal(added.updated, true);
    const storedPath = path.resolve('/workspace/MyApp/.alxliffstudio/quality-ignores.json');
    assert.equal(files.has(storedPath), true);
    const stored = files.get(storedPath).toString('utf8');
    assert.match(stored, /formatting-sequence-mismatch/);
    assert.doesNotMatch(stored, /Formatting differs|de-DE|A B/);

    const loaded = await ignores.readProjectQualityIgnores(xlf);
    assert.deepEqual(loaded.ignores, [{ code:'formatting-sequence-mismatch' }]);

    // Same rule from another language/finding is already covered globally.
    const duplicateRule = await ignores.setProjectQualityIssueIgnored(xlf, {
        code:'formatting-sequence-mismatch', severity:'warning', message:'Different message', source:'X', target:'Y'
    }, 'fr-FR', true);
    assert.equal(duplicateRule.updated, false);

    const removed = await ignores.setProjectQualityIssueIgnored(xlf, { code:'formatting-sequence-mismatch' }, 'fr-FR', false);
    assert.equal(removed.updated, true);
    const final = await ignores.readProjectQualityIgnores(xlf);
    assert.equal(final.ignores.length, 0);
});
