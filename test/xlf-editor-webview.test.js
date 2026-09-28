'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

function loadEditorWithVscodeStub() {
    const originalLoad = Module._load;
    const vscodeStub = {
        Uri: { file(fsPath) { return { fsPath, path: fsPath, toString() { return fsPath; } }; } },
        workspace: { textDocuments: [] },
        window: {}
    };
    Module._load = function(request, parent, isMain) {
        if (request === 'vscode') return vscodeStub;
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        for (const mod of ['../src/xlfEditor', '../src/ai']) {
            try { delete require.cache[require.resolve(mod)]; } catch (_) {}
        }
        return require('../src/xlfEditor');
    } finally {
        Module._load = originalLoad;
    }
}

test('generated XLIFF editor webview script is valid JavaScript', () => {
    const { XliffEditorProvider } = loadEditorWithVscodeStub();
    const provider = new XliffEditorProvider({});
    const html = provider.getHtml({ cspSource: 'vscode-webview://test' });
    const match = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/);
    assert.ok(match, 'webview script block not found');
    assert.doesNotThrow(() => new Function(match[1]));
});

test('XLIFF editor exposes all requested columns, per-column filters and row actions', () => {
    const { XliffEditorProvider } = loadEditorWithVscodeStub();
    const provider = new XliffEditorProvider({});
    const html = provider.getHtml({ cspSource: 'vscode-webview://test' });
    for (const label of ['Source', 'Translation', 'Proposed translation', 'Status', 'Notes']) {
        assert.match(html, new RegExp(label));
    }
    for (const id of ['filter-source', 'filter-translation', 'filter-proposal', 'filter-status', 'filter-notes']) {
        assert.match(html, new RegExp(`id="${id}"`));
    }
    assert.match(html, /data-action="search"/);
    assert.match(html, /data-action="ai"/);
    assert.match(html, /data-action="accept"/);
    assert.match(html, /data-action="confirmReview"/);
    assert.match(html, /⇄ Sync/);
    assert.match(html, /\? Try Translation/);
    assert.match(html, /← Proposals to Drafts/);
    assert.match(html, /✓ Apply Drafts/);
    assert.match(html, /data-action="try"/);
    assert.match(html, /type:'tryFile'/);
    assert.match(html, /type:'synchronizeFile'/);
    assert.match(html, /> Missing</);
    assert.match(html, /> Review</);
    assert.match(html, /> Proposals</);
    assert.match(html, /> Placeholder errors</);
});

test('XLIFF project search uses exact plain text and generator XLIFF is read-only', () => {
    const { createFindInFilesArgs, isGeneratorXliff } = loadEditorWithVscodeStub();
    assert.deepEqual(createFindInFilesArgs('Customer No.'), {
        query: 'Customer No.', triggerSearch: true, isRegex: false, matchWholeWord: false
    });
    assert.equal(isGeneratorXliff({ fsPath: '/p/MyApp.g.xlf' }, { targetLanguage: undefined }), true);
    assert.equal(isGeneratorXliff({ fsPath: '/p/MyApp.de-DE.xlf' }, { targetLanguage: 'de-DE' }), false);
});

test('package contributes the visual XLIFF editor as default for xlf files', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const editor = pkg.contributes.customEditors.find(item => item.viewType === 'alXliffStudio.xlfEditor');
    assert.ok(editor);
    assert.equal(editor.displayName, 'AL Xliff Studio — XLIFF Editor');
    assert.equal(editor.priority, 'default');
    assert.equal(editor.selector[0].filenamePattern, '*.xlf');
});


test('XLIFF editor reports placeholder mismatches per row with details', () => {
    const { getPlaceholderValidation } = loadEditorWithVscodeStub();
    assert.deepEqual(getPlaceholderValidation('Customer %1 has %2.', 'Kunde %1 hat %2.'), {
        error: '', expected: ['%1', '%2'], actual: ['%1', '%2']
    });
    const mismatch = getPlaceholderValidation('Customer %1 has %2.', 'Kunde %1 hat %3.');
    assert.match(mismatch.error, /Placeholder mismatch/);
    assert.match(mismatch.error, /%1, %2/);
    assert.match(mismatch.error, /%1, %3/);
    assert.equal(getPlaceholderValidation('Customer %1', '').error, '', 'missing target is not a placeholder error');
});

test('XLIFF editor renders red placeholder errors and a review confirmation action', () => {
    const { XliffEditorProvider } = loadEditorWithVscodeStub();
    const provider = new XliffEditorProvider({});
    const html = provider.getHtml({ cspSource: 'vscode-webview://test' });
    assert.match(html, /\.placeholder-error/);
    assert.match(html, /Placeholder mismatch/);
    assert.match(html, /✓ Review/);
    assert.match(html, /set state to translated/);
    assert.match(html, /%\\d\+/);
});


test('manual translation editing never changes workflow state implicitly', () => {
    const { determineManualTranslationState } = loadEditorWithVscodeStub();
    assert.equal(determineManualTranslationState({ targetState: 'needs-translation' }, 'Kunde %1', true), 'needs-translation');
    assert.equal(determineManualTranslationState({ targetState: 'translated' }, 'Kunde %2', false), 'translated');
    assert.equal(determineManualTranslationState({ targetState: 'needs-l10n' }, 'Kunde %1', true), 'needs-l10n');
    assert.equal(determineManualTranslationState({ targetState: '' }, '', true), '');
});

test('translation textarea stays a local draft until the top Apply Drafts action', () => {
    const { XliffEditorProvider } = loadEditorWithVscodeStub();
    const provider = new XliffEditorProvider({});
    const html = provider.getHtml({ cspSource: 'vscode-webview://test' });
    assert.match(html, /rowsElement\.addEventListener\('input'/);
    assert.match(html, /row\.translationDirty = row\.translation !== row\.savedTranslation/);
    assert.match(html, /type:'saveManyDrafts'/);
    assert.match(html, /✓ Apply Drafts/);
    assert.doesNotMatch(html, /type:'saveTranslationDraft'/);
    assert.doesNotMatch(html, /data-action="saveTranslation"/);
    assert.doesNotMatch(html, /addEventListener\('blur'[\s\S]*saveManyDrafts/);
    assert.doesNotMatch(html, /addEventListener\('focusout'[\s\S]*saveManyDrafts/);
    const changeHandler = html.match(/rowsElement\.addEventListener\('change',[\s\S]*?\n\}\);/);
    assert.ok(changeHandler);
    assert.doesNotMatch(changeHandler[0], /saveManyDrafts/);
});


test('XLIFF editor exposes the explicit sync -> try/AI -> staged drafts -> apply workflow', () => {
    const { XliffEditorProvider } = loadEditorWithVscodeStub();
    const provider = new XliffEditorProvider({});
    const html = provider.getHtml({ cspSource: 'vscode-webview://test' });
    assert.match(html, /id="sync"/);
    assert.match(html, /type:'synchronizeFile'/);
    assert.match(html, /id="tryGet"/);
    assert.match(html, /type:'tryFile'/);
    assert.match(html, /data-action="try"/);
    assert.match(html, /type:'tryUnit'/);
    assert.match(html, /data-action="accept"/);
    assert.match(html, /stageTranslationDrafts/);
    assert.match(html, /Developer comment \/ exact \.lng → Translation draft; fuzzy \/ AI → Proposal draft/);
    assert.match(html, /translationDirty \? row\.translation : row\.proposal/);
    assert.match(html, /class="chrome"/);
    assert.match(html, /row-missing/);
    assert.match(html, /row-review/);
    assert.match(html, /row-error/);
});


test('XLIFF editor does not auto-resolve proposals during document refresh', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'xlfEditor.js'), 'utf8');
    const postDocument = source.match(/const postDocument = async \(\) => \{([\s\S]*?)\n        \};\n\n        const applyText/);
    assert.ok(postDocument, 'postDocument block not found');
    assert.doesNotMatch(postDocument[1], /resolveKnownTranslationForUnit/);
    assert.doesNotMatch(postDocument[1], /loadCompanionMap/);
});

test('Try Translation stages exact local hits and keeps fuzzy or AI as proposal drafts', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'xlfEditor.js'), 'utf8');
    const start = source.indexOf("if (message.type === 'tryUnit') {");
    const end = source.indexOf("if (message.type === 'updateStatus') {", start);
    assert.ok(start >= 0 && end > start, 'tryUnit handler not found');
    const handler = source.slice(start, end);
    assert.match(handler, /resolveKnownTranslationForUnit/);
    assert.match(handler, /resolved\.source === 'fuzzy'/);
    assert.match(handler, /proposalCache\.set/);
    assert.match(handler, /type: 'stageTranslationDrafts'/);
    assert.match(handler, /translateItems/);
    assert.doesNotMatch(handler, /updateTranslationUnit/);
});

test('Apply Drafts is the commit point and sets staged translations to translated', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'xlfEditor.js'), 'utf8');
    const handler = source.match(/if \(message\.type === 'saveManyDrafts'\) \{([\s\S]*?)\n                \}\n\n                if \(message\.type === 'acceptMany'\)/);
    assert.ok(handler, 'saveManyDrafts handler not found');
    assert.match(handler[1], /state: 'translated'/);
    assert.match(handler[1], /writeAcceptedToMap/);
    assert.match(handler[1], /proposalCache\.delete/);
});

test('proposal acceptance only moves the proposal into a Translation draft', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'xlfEditor.js'), 'utf8');
    const handler = source.match(/if \(message\.type === 'acceptProposal'\) \{([\s\S]*?)\n                \}\n\n                if \(message\.type === 'aiTranslate'\)|if \(message\.type === 'acceptProposal'\) \{([\s\S]*?)\n                \}\n/);
    assert.ok(handler, 'acceptProposal handler not found');
    const body = handler[1] || handler[2] || '';
    assert.match(body, /proposalAcceptedAsDraft/);
    assert.doesNotMatch(body, /updateTranslationUnit/);
});


test('XLIFF quick state filters are OR-combined', () => {
    const { XliffEditorProvider } = loadEditorWithVscodeStub();
    const provider = new XliffEditorProvider({});
    const html = provider.getHtml({ cspSource: 'vscode-webview://test' });
    assert.match(html, /const quickFilters = \[\]/);
    assert.match(html, /quickFilters\.push\(Boolean\(row\.missing\)\)/);
    assert.match(html, /quickFilters\.push\(Boolean\(row\.review\)\)/);
    assert.match(html, /quickFilters\.push\(Boolean\(row\.proposal\)\)/);
    assert.match(html, /quickFilters\.push\(Boolean\(row\.translationDirty \|\| row\.proposal\)\)/);
    assert.match(html, /quickFilters\.length && !quickFilters\.some\(Boolean\)/);
    assert.match(html, />Any:<\/span>/);
});

test('sync translation-memory merge preserves pre-sync sources for fuzzy lookup', () => {
    const { mergeTranslationMemoryFromXliffTexts } = loadEditorWithVscodeStub();
    const before = `<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A"><source>Old caption</source><target state="translated">Alte Beschriftung</target></trans-unit>
<trans-unit id="B"><source>Stable</source><target state="translated">Stabil</target></trans-unit>
</group></body></file></xliff>`;
    const after = `<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A"><source>New caption</source><target state="needs-l10n">Alte Beschriftung</target></trans-unit>
<trans-unit id="B"><source>Stable</source><target state="translated">Stabil</target></trans-unit>
</group></body></file></xliff>`;
    const result = mergeTranslationMemoryFromXliffTexts([], [before, after]);
    const map = new Map(result.entries.map(entry => [entry.source, entry.translation]));
    assert.equal(map.get('Old caption'), 'Alte Beschriftung');
    assert.equal(map.get('Stable'), 'Stabil');
    assert.equal(map.has('New caption'), false, 'needs-l10n target must not pollute translation memory');
});

test('visual Sync updates companion lng from pre-sync and synchronized XLIFF', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'xlfEditor.js'), 'utf8');
    const handler = source.match(/if \(message\.type === 'synchronizeFile'\) \{([\s\S]*?)\n                \}\n\n                if \(message\.type === 'tryFile'\)/);
    assert.ok(handler, 'synchronizeFile handler not found');
    assert.match(handler[1], /updateCompanionMapFromXliffTexts\(\[beforeSyncText, result\.text\]\)/);
    assert.match(handler[1], /Companion \.lng updated/);
});


test('XLIFF editor shows staged loading progress and paginates rendering', () => {
    const { XliffEditorProvider, countTransUnitsFast } = loadEditorWithVscodeStub();
    const provider = new XliffEditorProvider({});
    const html = provider.getHtml({ cspSource: 'vscode-webview://test' });
    assert.match(html, /id="loadingOverlay"/);
    assert.match(html, /id="loadingBar"/);
    assert.match(html, /message\.type === 'loadStart'/);
    assert.match(html, /message\.type === 'loadProgress'/);
    assert.match(html, /Rendering page/);
    assert.match(html, /requestAnimationFrame\(appendChunk\)/);
    assert.match(html, /RENDER_CHUNK_SIZE = 50/);
    assert.match(html, /id="pageSize"/);
    assert.match(html, /<option value="50">50<\/option>/);
    assert.match(html, /<option value="100" selected>100<\/option>/);
    assert.match(html, /<option value="200">200<\/option>/);
    assert.match(html, /visible\.slice\(start, end\)/);
    assert.equal(countTransUnitsFast('<body><trans-unit id="1"/><trans-unit id="2"></trans-unit></body>'), 2);
});

test('pagination, filtering and sorting show the loading overlay before rerendering', () => {
    const { XliffEditorProvider } = loadEditorWithVscodeStub();
    const provider = new XliffEditorProvider({});
    const html = provider.getHtml({ cspSource: 'vscode-webview://test' });
    assert.match(html, /render\(\{ loading:true, stage:'Loading next page' \}\)/);
    assert.match(html, /render\(\{ loading:true, stage:'Filtering entries' \}\)/);
    assert.match(html, /render\(\{ loading:true, stage:'Sorting entries' \}\)/);
    assert.match(html, /setLoading\(stage, 0, 0, true, 'entries'\)/);
    assert.match(html, /vscode\.setState\(\{ pageSize:pageSize, currentPage:currentPage \}\)/);
});

test('backend large-XLIFF preparation reports processed trans-unit counts before the document is posted', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'xlfEditor.js'), 'utf8');
    const postDocument = source.match(/const postDocument = async \(\) => \{([\s\S]*?)\n        \};\n\n        const applyText/);
    assert.ok(postDocument, 'postDocument block not found');
    assert.match(postDocument[1], /type: 'loadStart'/);
    assert.match(postDocument[1], /type: 'loadProgress'/);
    assert.match(postDocument[1], /current: unitIndex \+ 1/);
    assert.match(postDocument[1], /total: parsed\.units\.length/);
    assert.match(postDocument[1], /await yieldToEventLoop\(\)/);
});
