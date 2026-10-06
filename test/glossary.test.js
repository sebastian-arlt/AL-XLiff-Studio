'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    parseGlossary,
    serializeGlossary,
    findExactGlossaryTranslation,
    findRelevantGlossaryTerms,
    findTerminologyViolations,
    glossaryHintsForSource
} = require('../src/glossary');
const { resolveKnownTranslationForUnit } = require('../src/resolver');
const { parseXliff } = require('../src/xliff');

test('glossary roundtrip supports languages, match modes and notes', () => {
    const text = serializeGlossary([{ source: 'Customer', targetLanguage: 'de-de', translation: 'Debitor', match: 'word', caseSensitive: false, note: 'BC term' }]);
    const parsed = parseGlossary(text);
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.entries[0].targetLanguage, 'de-DE');
    assert.equal(parsed.entries[0].translation, 'Debitor');
    assert.equal(parsed.entries[0].note, 'BC term');
});

test('exact glossary lookup is used after lng miss and before fuzzy', () => {
    const unit = parseXliff('<xliff><file source-language="en-US" target-language="de-DE"><body><trans-unit id="A"><source>Customer</source></trans-unit></body></file></xliff>').units[0];
    const glossary = [{ source: 'Customer', targetLanguage: 'de-DE', translation: 'Debitor', match: 'word', caseSensitive: false }];
    const result = resolveKnownTranslationForUnit(unit, [unit], 'de-DE', new Map(), { enabled: true, minimumQuality: 0 }, glossary);
    assert.equal(result.translation, 'Debitor');
    assert.equal(result.source, 'glossary');
});

test('companion lng still has priority over glossary', () => {
    const unit = parseXliff('<xliff><file source-language="en-US" target-language="de-DE"><body><trans-unit id="A"><source>Customer</source></trans-unit></body></file></xliff>').units[0];
    const glossary = [{ source: 'Customer', targetLanguage: 'de-DE', translation: 'Debitor', match: 'word', caseSensitive: false }];
    const result = resolveKnownTranslationForUnit(unit, [unit], 'de-DE', new Map([['Customer', 'Kunde']]), { enabled: true, minimumQuality: 0 }, glossary);
    assert.equal(result.translation, 'Kunde');
    assert.equal(result.source, 'map');
});

test('terminology validation finds required term missing in translation', () => {
    const glossary = [{ source: 'Customer', targetLanguage: 'de-DE', translation: 'Debitor', match: 'word', caseSensitive: false }];
    assert.equal(findRelevantGlossaryTerms('Customer No.', 'de-DE', glossary).length, 1);
    const violations = findTerminologyViolations('Customer No.', 'Kundennummer', 'de-DE', glossary);
    assert.equal(violations.length, 1);
    assert.match(violations[0].message, /Debitor/);
    assert.equal(findTerminologyViolations('Customer No.', 'Debitornummer', 'de-DE', glossary).length, 0);
});

test('glossary hints expose relevant terminology to AI', () => {
    const glossary = [
        { source: 'Customer', targetLanguage: 'de-DE', translation: 'Debitor', match: 'word', caseSensitive: false, note: 'BC standard' },
        { source: 'Vendor', targetLanguage: 'de-DE', translation: 'Kreditor', match: 'word', caseSensitive: false }
    ];
    const hints = glossaryHintsForSource('Open Customer Card', 'de-DE', glossary);
    assert.deepEqual(hints, [{ source: 'Customer', translation: 'Debitor', note: 'BC standard' }]);
});

const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

test('package contributes glossary command and custom editor', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    assert.ok(pkg.contributes.commands.some(command => command.command === 'alXliffStudio.openGlossary'));
    assert.ok(pkg.activationEvents.includes('onCommand:alXliffStudio.openGlossary'));
    assert.ok(pkg.contributes.customEditors.some(editor => editor.viewType === 'alXliffStudio.glossaryEditor'));
});

test('glossary editor webview script is valid and exposes terminology columns', () => {
    const originalLoad = Module._load;
    Module._load = function(request, parent, isMain) {
        if (request === 'vscode') return { window: {}, workspace: {}, commands: {}, Uri: {} };
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        delete require.cache[require.resolve('../src/glossaryEditor')];
        const { GlossaryEditorProvider } = require('../src/glossaryEditor');
        const provider = new GlossaryEditorProvider({});
        const html = provider.getHtml({ cspSource: 'vscode-webview://test' });
        const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/);
        assert.ok(script);
        assert.doesNotThrow(() => new Function(script[1]));
        for (const label of ['Source term', 'Language', 'Required translation', 'Match', 'Case', 'Note']) assert.match(html, new RegExp(label));
    } finally {
        Module._load = originalLoad;
    }
});

test('AI prompt payload includes terminology hints', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'ai.js'), 'utf8');
    assert.match(source, /terminology: Array\.isArray\(item\.terminology\)/);
    assert.match(source, /use those required source-to-target terms consistently/i);
});

test('package contributes configurable glossary path', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const setting = pkg.contributes.configuration.properties['alXliffStudio.glossary.path'];
    assert.ok(setting);
    assert.equal(setting.type, 'string');
    assert.equal(setting.default, '');
    assert.equal(setting.scope, 'resource');
});

test('legacy glossary is migrated into the project .alxliffstudio directory', async () => {
    const originalLoad = Module._load;
    const makeUri = value => ({
        scheme: 'file',
        fsPath: value,
        path: value.replace(/\\/g, '/'),
        toString() { return 'file://' + this.path; }
    });
    const folder = { name: 'Project', uri: makeUri('/workspace') };
    const legacy = makeUri('/workspace/Translations/.al-xliff-glossary.json');
    const targetPath = '/workspace/.alxliffstudio/glossary.json';
    const files = new Map([
        ['/workspace/app.json', Buffer.from('{}')],
        [legacy.fsPath, Buffer.from('{"version":1,"entries":[]}')]
    ]);
    const vscodeMock = {
        window: { activeTextEditor: undefined },
        workspace: {
            workspaceFolders: [folder],
            getWorkspaceFolder: () => folder,
            getConfiguration: () => ({ get: () => '' }),
            findFiles: async pattern => String(pattern.pattern || pattern).includes('.al-xliff-glossary.json') && files.has(legacy.fsPath) ? [legacy] : [],
            fs: {
                stat: async uri => { if (!files.has(uri.fsPath)) throw Object.assign(new Error('missing'), { code: 'FileNotFound' }); return {}; },
                readFile: async uri => files.get(uri.fsPath),
                writeFile: async (uri, value) => { files.set(uri.fsPath, Buffer.from(value)); },
                delete: async uri => { files.delete(uri.fsPath); },
                createDirectory: async () => {}
            }
        },
        Uri: {
            joinPath(base, ...parts) { return makeUri(path.posix.normalize([base.path, ...parts].join('/'))); },
            file(value) { return makeUri(value); }
        },
        RelativePattern: class RelativePattern { constructor(base, pattern) { this.base = base; this.pattern = pattern; } }
    };
    Module._load = function(request, parent, isMain) {
        if (request === 'vscode') return vscodeMock;
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        for (const mod of ['../src/glossaryEditor', '../src/studioPaths']) {
            try { delete require.cache[require.resolve(mod)]; } catch (_) {}
        }
        const { resolveProjectGlossary } = require('../src/glossaryEditor');
        const resolved = await resolveProjectGlossary(makeUri('/workspace/Translations/App.de-DE.xlf'), false);
        assert.equal(resolved.ambiguous, false);
        assert.equal(resolved.uri.fsPath, targetPath);
        assert.equal(files.has(targetPath), true);
        assert.equal(files.has(legacy.fsPath), false);
    } finally {
        Module._load = originalLoad;
        for (const mod of ['../src/glossaryEditor', '../src/studioPaths']) {
            try { delete require.cache[require.resolve(mod)]; } catch (_) {}
        }
    }
});

test('multiple legacy glossaries remain ambiguous until one is selected and migrated', async () => {
    const originalLoad = Module._load;
    const makeUri = value => ({ scheme: 'file', fsPath: value, path: value, toString() { return 'file://' + value; } });
    const folder = { name: 'Project', uri: makeUri('/workspace') };
    const first = makeUri('/workspace/A/.al-xliff-glossary.json');
    const second = makeUri('/workspace/B/.al-xliff-glossary.json');
    const targetPath = '/workspace/.alxliffstudio/glossary.json';
    const files = new Map([
        ['/workspace/app.json', Buffer.from('{}')],
        [first.fsPath, Buffer.from('{"version":1,"entries":[{"source":"A","targetLanguage":"de-DE","translation":"A"}]}')],
        [second.fsPath, Buffer.from('{"version":1,"entries":[{"source":"B","targetLanguage":"de-DE","translation":"B"}]}')]
    ]);
    const config = { get: () => '' };
    const vscodeMock = {
        window: {
            activeTextEditor: undefined,
            showQuickPick: async items => items.find(item => item.label === 'B/.al-xliff-glossary.json')
        },
        workspace: {
            workspaceFolders: [folder],
            getWorkspaceFolder: () => folder,
            getConfiguration: () => config,
            findFiles: async pattern => String(pattern.pattern || pattern).includes('.al-xliff-glossary.json') ? [second, first] : [],
            fs: {
                stat: async uri => { if (!files.has(uri.fsPath)) throw Object.assign(new Error('missing'), { code: 'FileNotFound' }); return {}; },
                readFile: async uri => files.get(uri.fsPath),
                writeFile: async (uri, value) => { files.set(uri.fsPath, Buffer.from(value)); },
                delete: async uri => { files.delete(uri.fsPath); },
                createDirectory: async () => {}
            }
        },
        Uri: {
            joinPath(base, ...parts) { return makeUri(path.posix.normalize([base.path, ...parts].join('/'))); },
            file(value) { return makeUri(value); }
        },
        RelativePattern: class RelativePattern { constructor(base, pattern) { this.base = base; this.pattern = pattern; } }
    };
    Module._load = function(request, parent, isMain) {
        if (request === 'vscode') return vscodeMock;
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        for (const mod of ['../src/glossaryEditor', '../src/studioPaths']) {
            try { delete require.cache[require.resolve(mod)]; } catch (_) {}
        }
        const { resolveProjectGlossary } = require('../src/glossaryEditor');
        const ambiguous = await resolveProjectGlossary(makeUri('/workspace/App.de-DE.xlf'), false);
        assert.equal(ambiguous.ambiguous, true);
        assert.equal(ambiguous.uri, undefined);
        const selected = await resolveProjectGlossary(makeUri('/workspace/App.de-DE.xlf'), true);
        assert.equal(selected.uri.fsPath, targetPath);
        assert.equal(files.has(targetPath), true);
        assert.equal(files.has(second.fsPath), false);
        assert.equal(files.has(first.fsPath), true);
    } finally {
        Module._load = originalLoad;
        for (const mod of ['../src/glossaryEditor', '../src/studioPaths']) {
            try { delete require.cache[require.resolve(mod)]; } catch (_) {}
        }
    }
});

test('glossary persists quality ignore rules', () => {
    const { parseGlossary, serializeGlossary } = require('../src/glossary');
    const text = serializeGlossary([{ source: 'Save.', targetLanguage: 'de-DE', translation: 'Speichern', match: 'exact', caseSensitive: false, note: '', qualityIgnore: ['punctuation', 'whitespace'] }]);
    assert.match(text, /"quality"/);
    assert.match(text, /"punctuation"/);
    const parsed = parseGlossary(text);
    assert.deepEqual(parsed.entries[0].qualityIgnore, ['punctuation', 'whitespace']);
});

test('visual glossary editor exposes Quality exceptions for glossary-based QA suppression', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'glossaryEditor.js'), 'utf8');
    assert.match(source, /Quality exceptions/);
    assert.match(source, /data-field="qualityIgnore"/);
});

test('repeated glossary matching reuses normalized entries for large-editor workloads', () => {
    const glossary = Array.from({ length: 100 }, (_, index) => ({
        source: `Term ${index}`,
        targetLanguage: 'de-DE',
        translation: `Begriff ${index}`,
        match: 'word',
        caseSensitive: false
    }));
    const first = findRelevantGlossaryTerms('Use Term 42 here', 'de-DE', glossary);
    const second = findRelevantGlossaryTerms('Use Term 42 here', 'de-DE', glossary);
    assert.equal(first.length, 1);
    assert.equal(second.length, 1);
    assert.strictEqual(first[0], second[0], 'normalized glossary entries should be cached and reused');
});
