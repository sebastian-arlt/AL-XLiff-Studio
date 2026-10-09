'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const root = path.join(__dirname, '..');
const german = require('../l10n/bundle.l10n.de.json');

function loadLocale(language) {
    const original = Module._load;
    const vscode = { env: { language }, workspace: { textDocuments: [] }, window: {}, Uri: {} };
    Module._load = function(request, parent, isMain) {
        return request === 'vscode' ? vscode : original.call(this, request, parent, isMain);
    };
    try {
        for (const key of Object.keys(require.cache)) if (key.startsWith(path.join(root, 'src') + path.sep)) delete require.cache[key];
        return {
            ui: require('../src/localization'),
            guided: require('../src/guidedTranslationHtml'),
            workflows: require('../src/guidedTranslation').workflowsFor,
            editor: require('../src/xlfEditor').XliffEditorProvider,
            dashboard: require('../src/dashboard').TranslationDashboard,
            memory: require('../src/editor').LanguageMapEditorProvider,
            glossary: require('../src/glossaryEditor').GlossaryEditorProvider,
            usage: require('../src/aiUsagePage').AiUsagePage
        };
    } finally { Module._load = original; }
}

for (const language of ['en', 'de', 'de-DE', 'fr']) {
    test(`all six webviews use ${language} locale safely and keep valid scripts`, () => {
        const loaded = loadLocale(language);
        const expected = language.startsWith('de') ? 'de' : 'en';
        assert.equal(loaded.ui.uiLanguage(), expected);
        const webview = { cspSource: 'vscode-webview://test' };
        const htmls = [loaded.guided.guidedTranslationHtml(webview), ...['editor', 'dashboard', 'memory', 'glossary', 'usage'].map(key => loaded[key].prototype.getHtml.call({ context: {} }, webview))];
        for (const html of htmls) {
            assert.ok(html.includes(`<html lang="${expected}">`));
            for (const block of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new vm.Script(block[1]));
        }
        assert.ok(htmls[0].includes(expected === 'de' ? 'Übersetzung bearbeiten' : 'Edit translation'));
        assert.ok(htmls[1].includes(expected === 'de' ? 'Entwürfe übernehmen' : 'Apply Drafts'));
        assert.ok(htmls[2].includes(expected === 'de' ? 'Übersetzungsübersicht' : 'Translation Dashboard'));
        assert.ok(htmls[5].includes('&lt;/&gt; ' + (expected === 'de' ? 'Daten' : 'Data') + '</button>'));
        assert.ok(!htmls[5].includes('&amp;lt;'));
        const workflows = loaded.workflows({ targetLanguage: 'fr-FR', metrics: { missing: 3, review: 0, qualityIssues: 1 }, syncStatus: 'synced' });
        assert.equal(workflows[1].description, expected === 'de' ? '3 fehlende Übersetzungen' : '3 missing translations');
        assert.equal(workflows[2].enabled, false);
        assert.equal(workflows[1].id, 'translate-missing');
    });
}

test('catalogs preserve all numbered placeholders and manifest keys exist in both languages', () => {
    const slots = value => [...value.matchAll(/\{\d+\}/g)].map(match => match[0]).sort();
    for (const [en, de] of Object.entries(german)) assert.deepEqual(slots(de), slots(en), en);
    const manifest = JSON.stringify(require('../package.json'));
    const english = require('../package.nls.json'), de = require('../package.nls.de.json');
    for (const match of manifest.matchAll(/"%([^%]+)%"/g)) {
        assert.ok(english[match[1]], match[1]);
        assert.ok(de[match[1]], match[1]);
    }
    assert.equal(require('../package.json').l10n, './l10n');
});

test('escaping and translated quality messages preserve embedded project text', () => {
    const { ui } = loadLocale('de');
    const source = "Save ' </script> \\ \n {1}";
    const literal = ui.scriptString('{0} missing translations', source);
    assert.ok(!literal.includes('</script>'));
    assert.equal(vm.runInNewContext(literal), source + ' fehlende Übersetzungen');
    assert.equal(ui.htmlText('{0} missing translations', '<img>'), '&lt;img&gt; fehlende Übersetzungen');
    const issue = { code: 'developer-comment-mismatch', severity: 'warning', source: 'Save', target: 'Übersetzung', ordinal: 9, message: 'Translation differs from the Developer Note suggestion for fr-FR: “Save”.' };
    const report = { issues: [issue], ignoredIssues: [], byOrdinal: new Map([[9, [issue]]]) };
    ui.localizeQualityReport(report);
    assert.equal(issue.message, 'Übersetzung weicht vom Entwicklerhinweis für fr-FR ab: „Save“.');
    assert.equal(issue.source, 'Save');
    assert.equal(issue.target, 'Übersetzung');
    assert.equal(issue.severity, 'warning');
    assert.equal(report.byOrdinal.get(9)[0], issue);
});

test('host messages delegate to the native VS Code localization API', () => {
    const calls = [];
    const module = { exports: {} };
    new Function('require', 'module', 'exports', fs.readFileSync(path.join(root, 'src/localization.js'), 'utf8'))(request => request === 'vscode' ? {
        env: { language: 'de' }, l10n: { t(message, ...args) { calls.push([message, ...args]); return 'native result'; } }
    } : german, module, module.exports);
    assert.equal(module.exports.t('{0} missing translations', 3), 'native result');
    assert.deepEqual(calls, [['{0} missing translations', 3]]);
});

test('all static localization keys in extension sources have English and German entries', () => {
    const acorn = require('acorn');
    const english = require('../l10n/bundle.l10n.json');
    const files = ['extension.js', ...fs.readdirSync(path.join(root, 'src')).filter(file => file.endsWith('.js')).map(file => 'src/' + file)];
    let checked = 0;
    function walk(node) {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'CallExpression' && ['t', 'htmlText', 'scriptString'].includes(node.callee.name) && node.arguments[0] && typeof node.arguments[0].value === 'string') {
            const key = node.arguments[0].value;
            assert.ok(Object.hasOwn(english, key), key);
            assert.ok(Object.hasOwn(german, key), key);
            checked++;
        }
        for (const value of Object.values(node)) {
            if (Array.isArray(value)) value.forEach(walk);
            else if (value && typeof value === 'object') walk(value);
        }
    }
    for (const file of files) walk(acorn.parse(fs.readFileSync(path.join(root, file), 'utf8'), { ecmaVersion: 'latest' }));
    assert.ok(checked > 400);
});
