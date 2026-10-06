'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
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
    const createdDirectories = [];
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
                async delete(uri) { files.delete(path.resolve(uri.fsPath)); },
                async createDirectory(uri) { createdDirectories.push(path.resolve(uri.fsPath)); }
            }
        },
        Uri: {
            file(value) { return makeUri(value); },
            joinPath(base, ...parts) { return makeUri(path.join(base.fsPath, ...parts)); }
        }
    };
    return { vscode, makeUri, files, createdDirectories };
}

function loadStudioPaths(vscodeStub) {
    const originalLoad = Module._load;
    Module._load = function(request, parent, isMain) {
        if (request === 'vscode') return vscodeStub;
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        delete require.cache[require.resolve('../src/studioPaths')];
        return require('../src/studioPaths');
    } finally {
        Module._load = originalLoad;
    }
}

test('AL Xliff Studio project data lives beside app.json, not under .vscode', async () => {
    const { vscode, makeUri } = createVscodeStub({ '/workspace/MyApp/app.json': '{}' });
    const paths = loadStudioPaths(vscode);
    const xlf = makeUri('/workspace/MyApp/Translations/App.de-DE.xlf');

    const map = await paths.getLanguageMapUri(xlf, 'de-DE');
    const glossary = await paths.getDefaultGlossaryUri(xlf);
    const usage = await paths.getAiUsageUri(xlf);
    const debugLog = await paths.getAiDebugLogUri(xlf);
    const qualityIgnores = await paths.getProjectQualityIgnoreUri(xlf);

    assert.equal(map.fsPath, path.resolve('/workspace/MyApp/.alxliffstudio/lng/App.de-DE.lng'));
    assert.equal(glossary.fsPath, path.resolve('/workspace/MyApp/.alxliffstudio/glossary.json'));
    assert.equal(usage.fsPath, path.resolve('/workspace/MyApp/.alxliffstudio/ai-usage.json'));
    assert.equal(debugLog.fsPath, path.resolve('/workspace/MyApp/.alxliffstudio/debug/ai-debug.log'));
    assert.equal(qualityIgnores.fsPath, path.resolve('/workspace/MyApp/.alxliffstudio/quality-ignores.json'));
    assert.doesNotMatch(map.fsPath, /[\\/]\.vscode[\\/]/);
});

test('legacy companion lng is migrated out of Translations into .alxliffstudio/lng', async () => {
    const legacy = '/workspace/MyApp/Translations/App.de-DE.lng';
    const { vscode, makeUri, files } = createVscodeStub({
        '/workspace/MyApp/app.json': '{}',
        [legacy]: '# AL Xliff Studio Language Map v1\n'
    });
    const paths = loadStudioPaths(vscode);
    const xlf = makeUri('/workspace/MyApp/Translations/App.de-DE.xlf');
    const migrated = await paths.migrateLegacyLanguageMapIfNeeded(xlf, 'de-DE');
    const target = path.resolve('/workspace/MyApp/.alxliffstudio/lng/App.de-DE.lng');

    assert.equal(migrated.fsPath, target);
    assert.equal(files.has(path.resolve(legacy)), false);
    assert.equal(files.has(target), true);
    assert.equal(files.get(path.resolve('/workspace/MyApp/.alxliffstudio/.gitignore')).toString('utf8'), 'ai-usage.json\ndebug/\n');
});


test('package exposes a bounded DocumentSession cache memory budget setting', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const setting = pkg.contributes.configuration.properties['alXliffStudio.performance.documentSessionCacheMB'];
    assert.ok(setting);
    assert.equal(setting.default, 384);
    assert.equal(setting.minimum, 64);
    assert.equal(setting.maximum, 2048);
});
