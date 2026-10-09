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
    assert.match(html, /data-action="openXliffSource"/);
    assert.match(html, /data-action="ai"/);
    assert.match(html, /data-action="accept"/);
    assert.match(html, /data-action="acceptTranslation"/);
    assert.match(html, /⇄ Sync/);
    assert.match(html, /\? Try Translation/);
    assert.match(html, /← Proposals to Drafts/);
    assert.match(html, /✓ Apply Drafts/);
    assert.match(html, /data-action="try"/);
    assert.match(html, /type:'tryFile'/);
    assert.match(html, /type:'synchronizeFile'/);
    assert.match(html, /id="dashboard"/);
    assert.match(html, /type:'openDashboard'/);
    assert.match(html, /> Missing</);
    assert.match(html, /> Review</);
    assert.match(html, /> Proposals</);
    assert.match(html, /> Placeholder errors</);
});


test('XLIFF editor exposes a blue file Save action that is enabled only for dirty documents', () => {
    const { XliffEditorProvider } = loadEditorWithVscodeStub();
    const provider = new XliffEditorProvider({});
    const html = provider.getHtml({ cspSource: 'vscode-webview://test' });
    assert.match(html, /id="saveFile" class="primary-action"/);
    assert.match(html, /saveFileButton\.disabled = model\.readOnly \|\| !model\.dirty/);
    assert.match(html, /type:'saveDocument'/);
    assert.match(html, /message\.type === 'saveState'/);

    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'xlfEditor.js'), 'utf8');
    assert.match(source, /if \(message\.type === 'saveDocument'\)/);
    assert.match(source, /await document\.save\(\)/);
    assert.match(source, /type: 'saveState'[\s\S]*dirty: Boolean\(document\.isDirty\)[\s\S]*documentVersion: Number\(document\.version\)/);
});

test('XLIFF editor dashboard button uses an inline SVG instead of a font-dependent glyph', () => {
    const { XliffEditorProvider } = loadEditorWithVscodeStub();
    const provider = new XliffEditorProvider({});
    const html = provider.getHtml({ cspSource: 'vscode-webview://test' });
    assert.match(html, /id="dashboard"[\s\S]*?<svg class="toolbar-icon"/);
    assert.match(html, /<rect x="2" y="2" width="5" height="5"/);
    assert.doesNotMatch(html, /id="dashboard"[^>]*>▦<\/button>/);
});


test('XLIFF editor toolbar is grouped in workflow order with Save last', () => {
    const { XliffEditorProvider } = loadEditorWithVscodeStub();
    const provider = new XliffEditorProvider({});
    const html = provider.getHtml({ cspSource: 'vscode-webview://test' });
    const toolbar = html.match(/<div class="workflow">([\s\S]*?)<\/div>\n  <\/div>\n<div class="quality-panel/);
    assert.ok(toolbar, 'workflow toolbar not found');
    const content = toolbar[1];
    const ids = ['sync', 'tryGet', 'acceptVisible', 'saveDrafts', 'discardDrafts', 'acceptAllNoState', 'qualityCheck', 'showInvisibles', 'dashboard', 'glossary', 'refresh', 'openText', 'saveFile'];
    let previous = -1;
    for (const id of ids) {
        const current = content.indexOf(`id="${id}"`);
        assert.ok(current > previous, `${id} must follow the previous workflow action`);
        previous = current;
    }
    assert.equal((content.match(/class="workflow-separator"/g) || []).length, 4);
    assert.equal((content.match(/class="workflow-group"/g) || []).length, 5);
});

test('XLIFF editor can toggle Word-like non-printing characters without changing stored text', () => {
    const { XliffEditorProvider } = loadEditorWithVscodeStub();
    const provider = new XliffEditorProvider({});
    const html = provider.getHtml({ cspSource: 'vscode-webview://test' });
    assert.match(html, /id="showInvisibles"[\s\S]*?aria-pressed="false"[^>]*>¶<\/button>/);
    assert.match(html, /id="qualityCheck"[\s\S]*?workflow-separator[\s\S]*?id="showInvisibles"/);
    assert.match(html, /showInvisiblesButton\.addEventListener\('click'/);
    assert.match(html, /document\.body\.classList\.toggle\('show-invisibles', showInvisibles\)/);
    assert.match(html, /\.ws-space::after \{ content:'·'/);
    assert.match(html, /\.ws-tab::after \{ content:'→'/);
    assert.match(html, /\.ws-newline::after, \.ws-cr::after \{ content:'¶'/);
    assert.match(html, /\.ws-nbsp::after \{ content:'⍽'/);
    assert.match(html, /function whitespaceEditorHtml\(action, ordinal, value, disabled\)/);
    assert.match(html, /whitespaceEditorHtml\('translation', row\.ordinal, row\.translation, disabled\)/);
    assert.match(html, /whitespaceEditorHtml\('proposal', row\.ordinal, row\.proposal, disabled\)/);
    assert.match(html, /note\.from === 'Developer' \? whitespaceStaticHtml\(note\.text\) : esc\(note\.text\)/);
    assert.match(html, /class=\"generator-note\" title=\"Xliff Generator\"/);
    assert.match(html, /content\.innerHTML = whitespaceDecoratedHtml\(editor\.value\)/);
    assert.match(html, /showInvisibles:showInvisibles/);
});

test('row source actions resolve exact XLIFF origin first and use project search only as fallback', () => {
    const { XliffEditorProvider, isGeneratorXliff } = loadEditorWithVscodeStub();
    const provider = new XliffEditorProvider({});
    const html = provider.getHtml({ cspSource: 'vscode-webview://test' });
    assert.match(html, /type:'goToSourceDefinition', ordinal:ordinal/);
    assert.match(html, /type:'openXliffUnitSource', ordinal:ordinal/);
    const rowActions = html.match(/data-action="search"[\s\S]*?data-action="addGlossary"[\s\S]*?data-action="openXliffSource"/);
    assert.ok(rowActions, 'source jump must be placed beside T+ after the AL source action');

    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'xlfEditor.js'), 'utf8');
    assert.match(source, /findExactAlOriginCandidates/);
    assert.match(source, /withGeneratorOriginFromCompanion/);
    assert.match(source, /findSiblingGxlf\(xlfUri, targetLanguage\)/);
    assert.match(source, /openProjectSourceSearch/);
    assert.match(source, /workbench\.action\.findInFiles/);
    assert.doesNotMatch(source, /Select AL source definition/);
    assert.doesNotMatch(source, /showQuickPick\(picks/);
    assert.match(source, /if \(message\.type === 'goToSourceDefinition'\)/);
    assert.match(source, /if \(message\.type === 'openXliffUnitSource'\)/);
    assert.equal(isGeneratorXliff({ fsPath: '/p/MyApp.g.xlf' }, { targetLanguage: undefined }), true);
    assert.equal(isGeneratorXliff({ fsPath: '/p/MyApp.de-DE.xlf' }, { targetLanguage: 'de-DE' }), false);
});

test('package contributes the visual XLIFF editor as default for xlf files', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const editor = pkg.contributes.customEditors.find(item => item.viewType === 'alXliffStudio.xlfEditor');
    assert.ok(editor);
    assert.equal(require('../package.nls.json')[editor.displayName.slice(1,-1)], 'AL Xliff Studio — XLIFF Editor');
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

test('XLIFF editor renders red placeholder errors and a persisted translation acceptance action', () => {
    const { XliffEditorProvider } = loadEditorWithVscodeStub();
    const provider = new XliffEditorProvider({});
    const html = provider.getHtml({ cspSource: 'vscode-webview://test' });
    assert.match(html, /\.placeholder-error/);
    assert.match(html, /Placeholder mismatch/);
    assert.match(html, /data-action="acceptTranslation"/);
    assert.match(html, /Accept the current saved translation and set state to translated/);
    assert.match(html, /%\\d\+/);
});


test('manual translation editing never changes workflow state implicitly', () => {
    const { determineManualTranslationState } = loadEditorWithVscodeStub();
    assert.equal(determineManualTranslationState({ targetState: 'needs-translation' }, 'Kunde %1', true), 'needs-translation');
    assert.equal(determineManualTranslationState({ targetState: 'translated' }, 'Kunde %2', false), 'translated');
    assert.equal(determineManualTranslationState({ targetState: 'needs-l10n' }, 'Kunde %1', true), 'needs-l10n');
    assert.equal(determineManualTranslationState({ targetState: '' }, '', true), '');
});

test('persisted translations can be explicitly accepted from sensible non-final states', () => {
    const { canAcceptPersistedTranslation } = loadEditorWithVscodeStub();
    for (const state of ['needs-l10n', 'needs-adaptation', 'needs-review-translation', 'needs-review-adaptation', 'needs-review-l10n', 'needs-translation', 'new', '']) {
        assert.equal(canAcceptPersistedTranslation({ target: 'Kunde', targetState: state, translate: 'yes' }), true, state);
    }
    for (const state of ['translated', 'signed-off', 'final']) {
        assert.equal(canAcceptPersistedTranslation({ target: 'Kunde', targetState: state, translate: 'yes' }), false, state);
    }
    assert.equal(canAcceptPersistedTranslation({ target: '', targetState: 'needs-l10n', translate: 'yes' }), false);
    assert.equal(canAcceptPersistedTranslation({ target: 'Kunde', targetState: 'needs-l10n', translate: 'no' }), false);
    assert.equal(canAcceptPersistedTranslation({ target: 'Kunde', targetState: 'needs-l10n', translate: 'yes' }, true), false);
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
    const focusoutHandler = html.match(/rowsElement\.addEventListener\('focusout',[\s\S]*?\n\}\);/);
    assert.ok(focusoutHandler);
    assert.doesNotMatch(focusoutHandler[0], /saveManyDrafts/);
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
    assert.match(html, /Developer comment \/ exact \.lng \/ exact glossary → Translation draft; fuzzy \/ AI → Proposal draft/);
    assert.match(html, /const isDraft = Boolean\(row\.translationDirty \|\| row\.hasTranslationDraft\)/);
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


test('row Try waits for status mutations and resolves from the current unsaved XLIFF snapshot', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'xlfEditor.js'), 'utf8');
    const start = source.indexOf("if (message.type === 'tryUnit') {");
    const end = source.indexOf("if (message.type === 'addGlossaryTerm') {", start);
    assert.ok(start >= 0 && end > start, 'tryUnit handler not found');
    const handler = source.slice(start, end);
    assert.match(handler, /await waitForDocumentMutations\(\)/);
    assert.match(handler, /const currentText = document\.getText\(\)/);
    assert.match(handler, /const currentParsed = await parseWithDocumentSessionAsync\(document\.uri, currentText, Number\(document\.version\)\)/);
    assert.match(handler, /requestedId/);
    assert.match(handler, /requestedSource/);
    assert.match(handler, /excludeTranslation: existingTranslation/);
    assert.match(handler, /suggestion === latestTranslation/);
});



test('row Try reconciles a single local result without a full document reload', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'xlfEditor.js'), 'utf8');
    const start = source.indexOf("if (message.type === 'tryUnit') {");
    const aiStart = source.indexOf("if (config.get('ai.enabled', true) === false)", start);
    assert.ok(start >= 0 && aiStart > start, 'local tryUnit resolver block not found');
    const handler = source.slice(start, aiStart);
    const resolvedStart = handler.indexOf('if (resolved.translation) {');
    assert.ok(resolvedStart >= 0, 'resolved local-result branch not found');
    const localResolver = handler.slice(resolvedStart);
    assert.match(localResolver, /type: 'stageTranslationDrafts'/);
    assert.match(localResolver, /type: 'proposalUpdated'/);
    assert.doesNotMatch(localResolver, /await postDocument\(\)/);
});

test('a newer render closes an overlay owned by a superseded chunked render', () => {
    const { XliffEditorProvider } = loadEditorWithVscodeStub();
    const provider = new XliffEditorProvider({});
    const html = provider.getHtml({ cspSource: 'vscode-webview://test' });
    assert.match(html, /let renderOverlayGeneration = 0;/);
    assert.match(html, /renderOverlayGeneration = generation;[\s\S]*setLoading\(stage, 0, 0, true, 'entries'\)/);
    assert.match(html, /renderOverlayGeneration && renderOverlayGeneration <= generation && !applyDraftsOverlayVisible/);
    assert.match(html, /hideLoading\(\);[\s\S]*renderOverlayGeneration = 0;/);
});

test('row Try stays disabled while a status change is being committed and statusUpdated carries the document version', () => {
    const { XliffEditorProvider } = loadEditorWithVscodeStub();
    const provider = new XliffEditorProvider({});
    const html = provider.getHtml({ cspSource: 'vscode-webview://test' });
    assert.match(html, /const busyStatusRows = new Set\(\)/);
    assert.match(html, /busyStatusRows\.add\(ordinal\)/);
    assert.match(html, /busyStatusRows\.delete\(ordinal\)/);
    assert.match(html, /type:'tryUnit', ordinal:ordinal, id:row\.id \|\| '', source:row\.source \|\| ''/);
    assert.match(html, /tryButton\.disabled[\s\S]*busyStatusRows\.has\(row\.ordinal\)/);

    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'xlfEditor.js'), 'utf8');
    const statusStart = source.indexOf("if (message.type === 'updateStatus') {");
    const tryStart = source.indexOf("if (message.type === 'tryUnit') {");
    assert.ok(statusStart > tryStart);
    const statusHandler = source.slice(statusStart, source.indexOf("if (message.type === 'openGlossary')", statusStart) > statusStart ? source.indexOf("if (message.type === 'openGlossary')", statusStart) : statusStart + 5000);
    assert.match(source, /type: 'statusUpdated'[\s\S]*documentVersion: Number\(document\.version\)/);
});

test('Apply Drafts is the commit point, applies translation drafts in one batch, and leaves proposals staged', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'xlfEditor.js'), 'utf8');
    const start = source.indexOf("if (message.type === 'saveManyDrafts') {");
    const end = source.indexOf("if (message.type === 'acceptMany') {", start);
    assert.ok(start >= 0 && end > start, 'saveManyDrafts handler not found');
    const handler = source.slice(start, end);
    assert.match(handler, /state: 'translated'/);
    assert.match(handler, /await updateTranslationUnitsAdaptive\(latestText, batchChanges,/);
    assert.match(handler, /clearStaged: true/);
    assert.match(handler, /writeAcceptedToMap\(commit\.accepted\)/);
    assert.match(handler, /enqueueDocumentMutation/);
    assert.doesNotMatch(handler, /await postDocument\(\)/);

    const { XliffEditorProvider } = loadEditorWithVscodeStub();
    const provider = new XliffEditorProvider({});
    const html = provider.getHtml({ cspSource: 'vscode-webview://test' });
    const applyStart = html.indexOf("saveDraftsButton.addEventListener('click'");
    const applyEnd = html.indexOf("acceptAllNoStateButton.addEventListener", applyStart);
    const clientApply = html.slice(applyStart, applyEnd);
    assert.match(clientApply, /dirtyRows\(\)\.map/);
    assert.doesNotMatch(clientApply, /stagedRows\(\)\.map/);
    assert.match(html, /Proposal drafts stay proposals until moved with Proposals to Drafts/);
});

test('proposal acceptance only moves the proposal into a Translation draft', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'xlfEditor.js'), 'utf8');
    const handler = source.match(/if \(message\.type === 'acceptProposal'\) \{([\s\S]*?)\n                \}\n\n                if \(message\.type === 'aiTranslate'\)|if \(message\.type === 'acceptProposal'\) \{([\s\S]*?)\n                \}\n/);
    assert.ok(handler, 'acceptProposal handler not found');
    const body = handler[1] || handler[2] || '';
    assert.match(body, /proposalAcceptedAsDraft/);
    assert.doesNotMatch(body, /updateTranslationUnit/);
});


test('XLIFF quick state filters are OR-combined in the extension host', () => {
    const { queryViewRows } = loadEditorWithVscodeStub();
    const rows = new Map([
        [0, { ordinal:0, source:'Missing source', translation:'', status:'missing', missing:true, review:false, proposal:'', notes:[], qualityIssues:[], glossaryTerms:[] }],
        [1, { ordinal:1, source:'Review source', translation:'Prüfung', status:'needs-review-translation', missing:false, review:true, proposal:'', notes:[], qualityIssues:[], glossaryTerms:[] }],
        [2, { ordinal:2, source:'Proposal source', translation:'', status:'missing', missing:true, review:false, proposal:'Vorschlag', notes:[], qualityIssues:[], glossaryTerms:[] }],
        [3, { ordinal:3, source:'Other', translation:'Fertig', status:'translated', missing:false, review:false, proposal:'', notes:[], qualityIssues:[], glossaryTerms:[] }]
    ]);
    const result = queryViewRows(rows, { view:{ page:1, pageSize:100, sortField:'source', quick:{ missing:true, review:true, proposal:true } } });
    assert.deepEqual(result.rows.map(row => row.ordinal).sort((a,b)=>a-b), [0,1,2]);
    assert.equal(result.filteredCount, 3);
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

test('sync keeps a removed unit translation in companion translation memory', () => {
    const { synchronizeTranslationUnits } = require('../src/synchronize');
    const { mergeTranslationMemoryFromXliffTexts } = loadEditorWithVscodeStub();
    const before = `<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="KEEP"><source>Keep</source><target state="translated">Behalten</target></trans-unit>
<trans-unit id="LOCKED"><source>Locked caption</source><target state="translated">Gesperrte Beschriftung</target></trans-unit>
</group></body></file></xliff>`;
    const generator = `<xliff><file source-language="en-US"><body><group>
<trans-unit id="KEEP"><source>Keep</source></trans-unit>
</group></body></file></xliff>`;

    const synchronized = synchronizeTranslationUnits(before, generator);
    assert.doesNotMatch(synchronized.text, /id="LOCKED"/);

    const memory = mergeTranslationMemoryFromXliffTexts([], [before, synchronized.text]);
    const map = new Map(memory.entries.map(entry => [entry.source, entry.translation]));
    assert.equal(map.get('Locked caption'), 'Gesperrte Beschriftung');
    assert.equal(map.get('Keep'), 'Behalten');
});

test('visual Sync updates companion lng from pre-sync and synchronized XLIFF', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'xlfEditor.js'), 'utf8');
    const handler = source.match(/if \(message\.type === 'synchronizeFile'\) \{([\s\S]*?)\n                \}\n\n                if \(message\.type === 'tryFile'\)/);
    assert.ok(handler, 'synchronizeFile handler not found');
    assert.match(handler[1], /updateCompanionMapFromXliffTexts\(\[beforeSyncText, result\.text\], result\.memorySnapshots\)/);
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
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'xlfEditor.js'), 'utf8');
    assert.match(source, /const pageOrdinals = visibleOrdinals\.slice\(start, end\)/);
    assert.match(html, /type:'requestViewPage'/);
    assert.equal(countTransUnitsFast('<body><trans-unit id="1"/><trans-unit id="2"></trans-unit></body>'), 2);
});

test('pagination, filtering and sorting show delayed background progress before rerendering', () => {
    const { XliffEditorProvider } = loadEditorWithVscodeStub();
    const provider = new XliffEditorProvider({});
    const html = provider.getHtml({ cspSource: 'vscode-webview://test' });
    assert.match(html, /render\(\{ loading:true, stage:'Loading next page', preserveScroll:false \}\)/);
    assert.match(html, /render\(\{ loading:true, stage:'Filtering entries', preserveScroll:false \}\)/);
    assert.match(html, /render\(\{ loading:true, stage:'Sorting entries', preserveScroll:false \}\)/);
    assert.match(html, /setLoading\(stage, 0, 0, true, 'entries'\)/);
    assert.match(html, /vscode\.setState\(\{ pageSize:pageSize, currentPage:currentPage, scrollTop:lastKnownScrollTop, showInvisibles:showInvisibles, qualitySortColumn:qualitySortColumn, qualitySortDirection:qualitySortDirection \}\)/);
});

test('background loading progress is a non-blocking top strip instead of a modal overlay', () => {
    const { XliffEditorProvider } = loadEditorWithVscodeStub();
    const provider = new XliffEditorProvider({});
    const html = provider.getHtml({ cspSource: 'vscode-webview://test' });
    assert.match(html, /\.loading-overlay \{[^}]*top:0;[^}]*left:0;[^}]*right:0;[^}]*pointer-events:none;/);
    assert.doesNotMatch(html, /\.loading-overlay \{[^}]*inset:0;/);
    assert.doesNotMatch(html, /\.loading-overlay \{[^}]*backdrop-filter:/);
    assert.match(html, /\.loading-overlay\.indeterminate \.loading-bar/);
    assert.match(html, /@keyframes xliff-progress-indeterminate/);
    assert.match(html, /loadingOverlay\.classList\.toggle\('indeterminate', safeTotal <= 0\)/);
    assert.match(html, /aria-label="Background activity"/);
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

test('XLIFF editor exposes terminology workflow and OR-combined terminology filter', () => {
    const { XliffEditorProvider } = loadEditorWithVscodeStub();
    const provider = new XliffEditorProvider({});
    const html = provider.getHtml({ cspSource: 'vscode-webview://test' });
    assert.match(html, /id="glossary"/);
    assert.match(html, /id="terminologyErrorsOnly"/);
    assert.match(html, /data-action="addGlossary"/);
    assert.match(html, /function terminologyError\(row, translation\)/);
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'xlfEditor.js'), 'utf8');
    assert.match(source, /view\.quick\.terminologyErrors[\s\S]*keys\.translationTerminologyError/);
    assert.match(html, /exact glossary/);
});

test('XLIFF editor exposes the integrated Quality Check workflow and OR-combined Quality filter', () => {
    const { XliffEditorProvider } = loadEditorWithVscodeStub();
    const provider = new XliffEditorProvider({});
    const html = provider.getHtml({ cspSource: 'vscode-webview://test' });
    assert.match(html, /id="qualityCheck"/);
    assert.match(html, /! Quality Check/);
    assert.match(html, /id="qualityPanel"/);
    assert.match(html, /id="qualityOnly"/);
    assert.match(html, /type:'validateQuality'/);
    assert.match(html, /message\.type === 'qualityReport'/);
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'xlfEditor.js'), 'utf8');
    assert.match(source, /view\.quick\.quality[\s\S]*keys\.qualityIssueCount/);
    assert.match(html, /data-quality-ordinal/);
});


test('Quality Go navigation preserves active filters and temporarily reveals the target row', () => {
    const { XliffEditorProvider } = loadEditorWithVscodeStub();
    const provider = new XliffEditorProvider({});
    const html = provider.getHtml({ cspSource: 'vscode-webview://test' });

    assert.doesNotMatch(html, /function clearQuickFilters\(\) \{\s*clearQuickFilters\(\)/);
    assert.match(html, /function clearQuickFilters\(\) \{[\s\S]*translatedOnly\.checked = false;[\s\S]*qualityOnly\.checked = false;/);
    assert.match(html, /let navigationOrdinal = null;/);
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'xlfEditor.js'), 'utf8');
    assert.match(source, /Number\.isInteger\(view\.navigationOrdinal\)[\s\S]*row\.ordinal[\s\S]*view\.navigationOrdinal/);
    assert.match(html, /function jumpToOrdinal\(ordinal, severity\) \{[\s\S]*navigationOrdinal = ordinal;[\s\S]*render\(\{ loading:false, stage:'Opening translation unit'/);
    assert.match(html, /navigationOrdinal:Number\.isInteger\(navigationOrdinal\) \? navigationOrdinal : null/);
    assert.match(html, /type:'requestViewPage'/);
    assert.doesNotMatch(html, /function jumpToOrdinal\(ordinal, severity\) \{[\s\S]{0,700}globalFilter\.value = '';/);
    assert.match(html, /let pendingNavigationOrdinal = null;/);
    assert.match(html, /function revealOrdinalNow\(ordinal, flash, severity\)/);
    assert.match(html, /render\(\{ loading:false, stage:'Opening translation unit', preserveScroll:false, jumpOrdinal:ordinal, jumpSeverity:normalizedSeverity \}\)/);
    assert.match(html, /if \(revealOrdinalNow\(ordinal, true, normalizedSeverity\)\) return true;/);
    assert.match(html, /tr\.saved-flash > td \{ background:color-mix\(in srgb, var\(--xliff-navigation-highlight\) 14%, var\(--vscode-editor-background\)\); \}/);
    assert.match(html, /saved-flash-warning[^}]*--xliff-navigation-highlight:var\(--vscode-editorWarning-foreground\)/);
    assert.match(html, /saved-flash-error[^}]*--xliff-navigation-highlight:var\(--vscode-editorError-foreground\)/);
    assert.match(html, /saved-flash-info[^}]*--xliff-navigation-highlight:var\(--vscode-charts-blue\)/);
    assert.match(html, /data-quality-severity/);
    assert.match(html, /const navigationHighlightMs = 5200;/);
    assert.match(html, /if \(element\._xliffHighlightTimer\) clearTimeout\(element\._xliffHighlightTimer\);/);
});


test('Quality results use an independent accordion scroll area and Go scrolls only the translation viewport', () => {
    const { XliffEditorProvider } = loadEditorWithVscodeStub();
    const provider = new XliffEditorProvider({});
    const html = provider.getHtml({ cspSource: 'vscode-webview://test' });

    assert.match(html, /class="editor-workspace" id="editorWorkspace"/);
    assert.match(html, /class="quality-body" id="qualityBody"/);
    assert.match(html, /id="qualityToggle"/);
    assert.match(html, /class="translation-scroll" id="translationScroll"/);
    assert.match(html, /\.translation-scroll \{[^}]*overflow:auto;/);
    assert.match(html, /\.quality-list \{[^}]*overflow:auto;/);
    assert.match(html, /\.quality-panel\.collapsed \.quality-body \{ display:none; \}/);
    assert.match(html, /function setQualityExpanded\(expanded\)/);
    assert.match(html, /setQualityExpanded\(true\)/);
    assert.match(html, /translationScroll\.getBoundingClientRect\(\)/);
    assert.match(html, /translationScroll\.scrollTop \+= delta;/);
    assert.doesNotMatch(html, /element\.scrollIntoView\(\{ block:'center' \}\)/);
});


test('top Quality Check button hides and restores the complete Quality area while refresh remains explicit', () => {
    const { XliffEditorProvider } = loadEditorWithVscodeStub();
    const provider = new XliffEditorProvider({});
    const html = provider.getHtml({ cspSource: 'vscode-webview://test' });

    assert.match(html, /id="qualityRefresh"/);
    assert.match(html, /let qualityReportAvailable = false;/);
    assert.match(html, /function setQualityVisible\(visible\)[\s\S]*qualityPanel\.classList\.toggle\('hidden', !isVisible\)[\s\S]*if \(isVisible\) setQualityExpanded\(true\)/);
    assert.match(html, /function renderQualityReport\([\s\S]*qualityReportAvailable = true;[\s\S]*setQualityVisible\(true\)/);
    assert.match(html, /function showCurrentQualityReport\(\) \{[\s\S]*paintQualityReport\(currentQualityReport, currentQualityIncludesDrafts\);[\s\S]*setQualityVisible\(true\);/);
    assert.match(html, /qualityCheckButton\.addEventListener\('click',[\s\S]*!qualityPanel\.classList\.contains\('hidden'\)[\s\S]*setQualityVisible\(false\)[\s\S]*showCurrentQualityReport\(\)[\s\S]*showQualityPendingPanel\([\s\S]*runQualityCheck\(\)/);
    assert.match(html, /qualityRefresh\.addEventListener\('click', function\(\) \{ runQualityCheck\(\); \}\)/);
});

test('Quality Check restores its summary and requests a host page without retaining a report transfer', () => {
    const { XliffEditorProvider } = loadEditorWithVscodeStub();
    const html = new XliffEditorProvider({}).getHtml({ cspSource: 'vscode-webview://test' });
    assert.match(html, /function showCurrentQualityReport/);
    assert.match(html, /function requestQualityPage/);
    assert.match(html, /if \(model\.qualityPending\)/);
    assert.doesNotMatch(html, /pendingQualityTransfer/);
});

test('row AI proposal updates in place without resetting the translation scroll position', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'xlfEditor.js'), 'utf8');
    const handlerStart = source.indexOf("if (message.type === 'aiTranslate') {");
    const handlerEnd = source.indexOf("if (message.type === 'acceptProposal') {", handlerStart);
    assert.ok(handlerStart >= 0 && handlerEnd > handlerStart, 'aiTranslate handler not found');
    const handler = source.slice(handlerStart, handlerEnd);
    assert.match(handler, /type: 'proposalUpdated'/);
    assert.doesNotMatch(handler, /await postDocument\(\)/);

    const { XliffEditorProvider } = loadEditorWithVscodeStub();
    const provider = new XliffEditorProvider({});
    const html = provider.getHtml({ cspSource: 'vscode-webview://test' });
    assert.match(html, /message\.type === 'proposalUpdated'/);
    assert.match(html, /proposalEditor\.value = row\.proposal/);
    assert.match(html, /updateInlineValidation\(row, 'proposal', row\.proposal\)/);
    assert.match(html, /if \(row\) updateRowControls\(row\)/);
    const aiBusy = html.match(/else if \(message\.type === 'aiBusy'\) \{([\s\S]*?)\n  \} else if \(message\.type === 'tryBusy'\)/);
    assert.ok(aiBusy, 'aiBusy webview handler not found');
    assert.doesNotMatch(aiBusy[1], /render\(/);
});


test('persisted translation acceptance is serialized, updates only the affected row, and does not wait for translation-memory maintenance', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'xlfEditor.js'), 'utf8');
    const handlerStart = source.indexOf("if (message.type === 'acceptTranslation') {");
    const handlerEnd = source.indexOf("if (message.type === 'revertAppliedTranslation') {", handlerStart);
    assert.ok(handlerStart >= 0 && handlerEnd > handlerStart, 'acceptTranslation handler not found');
    const handler = source.slice(handlerStart, handlerEnd);
    assert.match(handler, /enqueueDocumentMutation/);
    assert.match(handler, /type: 'translationAccepted'/);
    assert.match(handler, /void writeAcceptedToMap/);
    assert.match(handler, /type: 'translationApplyBusy'/);
    assert.doesNotMatch(handler, /postDocument\(/);

    assert.match(source, /const changedRange = new vscode\.Range\(document\.positionAt\(prefixLength\), document\.positionAt\(oldSuffix\)\)/);

    const { XliffEditorProvider } = loadEditorWithVscodeStub();
    const provider = new XliffEditorProvider({});
    const html = provider.getHtml({ cspSource: 'vscode-webview://test' });
    const acceptedStart = html.indexOf("else if (message.type === 'translationAccepted') {");
    const acceptedEnd = html.indexOf("else if (message.type === 'aiBusy') {", acceptedStart);
    assert.ok(acceptedStart >= 0 && acceptedEnd > acceptedStart, 'translationAccepted webview handler not found');
    const accepted = html.slice(acceptedStart, acceptedEnd);
    assert.match(accepted, /row\.rawState = message\.state \|\| 'translated'/);
    assert.match(accepted, /row\.review = false/);
    assert.match(accepted, /updateRowControls\(row\)/);
    assert.match(accepted, /updateSummary\(\)/);
    assert.doesNotMatch(accepted, /render\(/);
});

test('accepting a persisted translation refreshes inline Quality warnings without full rerender', () => {
    const { XliffEditorProvider } = loadEditorWithVscodeStub();
    const provider = new XliffEditorProvider({});
    const html = provider.getHtml({ cspSource: 'vscode-webview://test' });
    assert.match(html, /function qualityInlineHtml\(row\)/);
    assert.match(html, /function updateQualityInline\(row\)/);
    const acceptedStart = html.indexOf("else if (message.type === 'translationAccepted') {");
    const acceptedEnd = html.indexOf("else if (message.type === 'aiBusy') {", acceptedStart);
    assert.ok(acceptedStart >= 0 && acceptedEnd > acceptedStart, 'translationAccepted webview handler not found');
    const accepted = html.slice(acceptedStart, acceptedEnd);
    assert.match(accepted, /updateQualityInline\(row\)/);
    assert.match(accepted, /removeResolvedAcceptQualityIssues\(ordinal\)/);
    assert.doesNotMatch(accepted, /render\(/);
});

test('row accept applies an individual Translation draft even when saved state is already translated', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'xlfEditor.js'), 'utf8');
    assert.match(source, /row\.canAcceptTranslation \|\| row\.translationDirty/);
    assert.match(source, /translationDirty:row\.translationDirty/);
    assert.match(source, /if \(!translationDirty && \['translated', 'signed-off', 'final'\]\.includes\(currentState\)\)/);
    assert.match(source, /translationDirty\s*\? \{ translation, state: 'translated', provenance, clearStaged: true \}/);
});

test('fast accept asks the extension host to recompute filtered membership without a full XLIFF reload', () => {
    const { XliffEditorProvider } = loadEditorWithVscodeStub();
    const provider = new XliffEditorProvider({});
    const html = provider.getHtml({ cspSource: 'vscode-webview://test' });
    assert.match(html, /function refreshFilteredMembershipAfterAccept\(row\)/);
    assert.match(html, /syncIndexFromFullRow\(row\)/);
    assert.match(html, /render\(\{ loading:false, preserveScroll:true \}\)/);
    assert.doesNotMatch(html, /if \(matches\(row\)\)/);
    assert.match(html, /refreshFilteredMembershipAfterAccept\(row\)/);
});

test('provenance setting suppresses editor provenance display and persistence hooks', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'xlfEditor.js'), 'utf8');
    assert.match(source, /get\('provenance\.enabled', false\) !== false/);
    assert.match(source, /provenanceEnabled: provenanceIsEnabled/);
    assert.match(source, /if \(!model\.provenanceEnabled\) return ''/);
    assert.match(source, /provenanceEnabled\(\) \? sanitizeProvenance/);
});


test('XLIFF editor exposes confirmed bulk no-state acceptance in the top workflow', () => {
    const { XliffEditorProvider } = loadEditorWithVscodeStub();
    const provider = new XliffEditorProvider({});
    const html = provider.getHtml({ cspSource: 'vscode-webview://test' });
    assert.match(html, /id="acceptAllNoState"/);
    assert.match(html, /✓ No State/);
    assert.match(html, /type:'acceptAllNoState'/);
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'xlfEditor.js'), 'utf8');
    assert.match(source, /message\.type === 'acceptAllNoState'/);
    assert.match(source, /showWarningMessage\([\s\S]*modal: true/);
    assert.match(source, /setNoStateTargetsTranslated/);
});

test('Quality Check exposes persistent ignore and restore workflow without allowing staged-draft suppression', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'xlfEditor.js'), 'utf8');
    assert.match(source, /qualityIgnored/);
    assert.match(source, /data-quality-action="ignore"/);
    assert.match(source, /data-quality-action="restore"/);
    assert.match(source, /setQualityIgnored/);
    assert.match(source, /ignored by/);
});


test('single-row Apply clears the checkmark immediately but keeps Undo until the document is actually saved', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'xlfEditor.js'), 'utf8');
    assert.match(source, /const pendingAppliedUndo = new Map\(\)/);
    assert.match(source, /pendingAppliedUndo\.set\(ordinal, undoSnapshot\)/);
    assert.match(source, /message\.type === 'revertAppliedTranslation'/);
    assert.match(source, /replaceTranslationUnitRaw\(document\.getText\(\), ordinal, undo\.rawUnit\)/);
    assert.match(source, /pendingAppliedUndo\.clear\(\)/);

    const { XliffEditorProvider } = loadEditorWithVscodeStub();
    const provider = new XliffEditorProvider({});
    const html = provider.getHtml({ cspSource: 'vscode-webview://test' });
    const acceptedStart = html.indexOf("else if (message.type === 'translationAccepted') {");
    const acceptedEnd = html.indexOf("else if (message.type === 'aiBusy') {", acceptedStart);
    assert.ok(acceptedStart >= 0 && acceptedEnd > acceptedStart, 'translationAccepted webview handler not found');
    const accepted = html.slice(acceptedStart, acceptedEnd);
    assert.match(accepted, /row\.translationDirty = false/);
    assert.match(accepted, /row\.canAcceptTranslation = false/);
    assert.match(accepted, /row\.appliedUndo = Boolean\(message\.canUndoApply\)/);
    assert.match(accepted, /updateRowControls\(row\)/);

    assert.match(html, /revertButton\.classList\.toggle\('hidden', !dirty && !appliedUndo\)/);
    assert.match(html, /Undo this applied translation before the XLIFF is saved/);
    assert.match(html, /applied · unsaved/);
    assert.match(html, /if \(!model\.dirty\) \{[\s\S]*row\.appliedUndo = false/);
});

test('undoing an unsaved applied draft restores the previous XLIFF unit and re-stages the draft', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'xlfEditor.js'), 'utf8');
    const start = source.indexOf("if (message.type === 'revertAppliedTranslation') {");
    const end = source.indexOf("if (message.type === 'synchronizeFile') {", start);
    assert.ok(start >= 0 && end > start, 'revertAppliedTranslation handler not found');
    const handler = source.slice(start, end);
    assert.match(handler, /replaceTranslationUnitRaw/);
    assert.match(handler, /setStagedTranslations/);
    assert.match(handler, /kind: 'draft'/);
    assert.match(handler, /pendingAppliedUndo\.delete\(ordinal\)/);
    assert.match(handler, /type: 'translationApplyReverted'/);
});

test('Quality Check supports rule-wide project ignore and uses a plain globe for restore', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'xlfEditor.js'), 'utf8');
    assert.match(source, /message\.type === 'setProjectQualityIgnored'/);
    assert.match(source, /setProjectQualityIssueIgnored/);
    assert.match(source, /data-quality-action="projectIgnore"/);
    assert.match(source, /data-quality-action="projectRestore"/);
    assert.match(source, /Ignore this Quality Check rule for the whole AL project/);
    assert.match(source, /Restore this globally ignored Quality Check rule/);
    assert.match(source, /issue\.ignoredBy === 'project'/);
    assert.match(source, /function projectQualityIgnoreIcon\(\) \{ return projectQualityGlobeSvg\(true\); \}/);
    assert.match(source, /function projectQualityRestoreIcon\(\) \{ return projectQualityGlobeSvg\(false\); \}/);
    assert.match(source, /const slash = withSlash \?/);
    assert.match(source, /fill="none" stroke="currentColor"/);
    assert.match(source, /localIgnore \+ projectIgnore/);
    assert.match(source, /type:'setProjectQualityIgnored', ignored:action==='projectIgnore'/);
});


test('XLIFF editor error banner can be dismissed without reloading the editor', () => {
    const { XliffEditorProvider } = loadEditorWithVscodeStub();
    const provider = new XliffEditorProvider({});
    const html = provider.getHtml({ cspSource: 'vscode-webview://test' });
    assert.match(html, /id="errorMessage"/);
    assert.match(html, /id="errorClose"/);
    assert.match(html, /aria-label="Close error message"/);
    assert.match(html, /errorCloseButton\.addEventListener\('click', function\(\) \{ showError\(''\); \}\)/);
    assert.match(html, /errorElement\.style\.display = message \? 'flex' : 'none'/);
});


test('XLIFF editor persists staged drafts and proposals as hidden XLIFF notes and restores them after reload', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'xlfEditor.js'), 'utf8');
    assert.match(source, /getStagedTranslation\(unit\)/);
    assert.match(source, /isStagedTranslationNoteDetail\(note\)/);
    assert.match(source, /setStagedTranslations\(document\.getText\(\), persistenceItems\)/);
    assert.match(source, /message\.type === 'translationDraftChanged'/);
    assert.match(source, /message\.type === 'proposalChanged'/);
    assert.match(source, /kind: 'draft'/);
    assert.match(source, /kind: 'proposal'/);
    assert.match(source, /hasTranslationDraft/);
    assert.match(source, /rowStateIndex/);
    assert.match(source, /getStagedTranslation\(unit\)/);
});

test('manual Translation and Proposal changes stay volatile until explicit Save or Apply', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'xlfEditor.js'), 'utf8');
    assert.match(source, /const volatileStageCache = new Map\(\)/);
    const draftStart = source.indexOf("if (message.type === 'translationDraftChanged') {");
    const draftEnd = source.indexOf("if (message.type === 'saveManyDrafts') {", draftStart);
    const draftHandler = source.slice(draftStart, draftEnd);
    assert.match(draftHandler, /volatileStageCache\.set\(ordinal, \{ kind: 'draft'/);
    assert.doesNotMatch(draftHandler, /persistStagedItem\(ordinal/);
    const proposalStart = source.indexOf("if (message.type === 'proposalChanged') {");
    const proposalEnd = source.indexOf("if (message.type === 'translationDraftChanged') {", proposalStart);
    const proposalHandler = source.slice(proposalStart, proposalEnd);
    assert.match(proposalHandler, /volatileStageCache\.set\(ordinal, \{ kind: 'proposal'/);
    assert.doesNotMatch(proposalHandler, /persistStagedItem\(ordinal/);
});

test('staged metadata never auto-saves the backing XLIFF from background staging', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'xlfEditor.js'), 'utf8');
    const block = source.match(/const persistStagedItemsNow = async items => \{([\s\S]*?)\n        \};/);
    assert.ok(block, 'persistStagedItemsNow helper not found');
    assert.match(block[1], /setStagedTranslations\(document\.getText\(\), persistenceItems\)/);
    assert.doesNotMatch(block[1], /document\.save\(\)/);
});

test('Apply removes staging notes and Discard converts drafts back to proposals', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'xlfEditor.js'), 'utf8');
    const start = source.indexOf("if (message.type === 'saveManyDrafts') {");
    const end = source.indexOf("if (message.type === 'acceptMany') {", start);
    assert.ok(start >= 0 && end > start, 'saveManyDrafts handler not found');
    const apply = source.slice(start, end);
    assert.match(apply, /clearStaged: true/);
    assert.match(apply, /updateTranslationUnits/);
    assert.match(source, /message\.type === 'clearProposals' \|\| message\.type === 'clearStaged'/);
    const { XliffEditorProvider } = loadEditorWithVscodeStub();
    const provider = new XliffEditorProvider({});
    const html = provider.getHtml({ cspSource: 'vscode-webview://test' });
    assert.match(html, /type:'draftsToProposals'/);
    assert.match(html, /cancelAllStagePersistence\(\)/);
    assert.match(html, /const items = dirtyRows\(\)\.map/);
});

test('Save completes before Quality refresh and keeps a hidden quality panel closed', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'xlfEditor.js'), 'utf8');
    const handler = source.match(/if \(message\.type === 'saveDocument'\) \{([\s\S]*?)\n                \}\n                if \(message\.type === 'openDashboard'\)/);
    assert.ok(handler, 'saveDocument handler not found');
    assert.match(handler[1], /const qualityGeneration = \+\+saveQualityRunGeneration/);
    assert.match(handler[1], /void webviewPanel\.webview\.postMessage\(\{ type: 'qualityPending', pending: true \}\)/);
    assert.doesNotMatch(handler[1], /parse before save/);
    assert.match(handler[1], /void \(async \(\) => \{/);
    assert.match(handler[1], /await yieldToEventLoop\(\)/);
    assert.match(handler[1], /postQualityReportToWebview\(report, \{[\s\S]*preserveVisibility: true/);
    assert.match(handler[1], /unitOverrides: qualityDraftItems\.map/);

    const { XliffEditorProvider } = loadEditorWithVscodeStub();
    const provider = new XliffEditorProvider({});
    const html = provider.getHtml({ cspSource: 'vscode-webview://test' });
    assert.match(html, /type:'saveDocument', items:items/);
    assert.match(html, /message\.preserveVisibility \? wasVisible : true/);
});

test('Apply Drafts shows delayed non-blocking progress only for a large commit and clears it on completion', () => {
    const { XliffEditorProvider } = loadEditorWithVscodeStub();
    const provider = new XliffEditorProvider({});
    const html = provider.getHtml({ cspSource: 'vscode-webview://test' });
    assert.match(html, /applyDraftsBusy = true/);
    assert.match(html, /applyDraftsOverlayVisible = items\.length >= APPLY_DRAFTS_OVERLAY_THRESHOLD/);
    assert.match(html, /setLoading\('Applying drafts', 0, items\.length, true, 'drafts'\)/);
    assert.match(html, /message\.type === 'applyDraftsProgress'/);
    assert.match(html, /message\.type === 'applyDraftsProgressDone'/);

    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'xlfEditor.js'), 'utf8');
    assert.match(source, /type: 'applyDraftsProgress'/);
    assert.match(source, /type: 'applyDraftsProgressDone'/);
    assert.match(source, /await updateTranslationUnitsAdaptive\(latestText, batchChanges,/);
});

test('Quality Go navigation cancels stale scroll restoration and persists the jump target', () => {
    const { XliffEditorProvider } = loadEditorWithVscodeStub();
    const provider = new XliffEditorProvider({});
    const html = provider.getHtml({ cspSource: 'vscode-webview://test' });

    assert.match(html, /let scrollRestoreGeneration = 0;/);
    assert.match(html, /const restoreGeneration = \+\+scrollRestoreGeneration;/);
    assert.match(html, /if \(restoreGeneration !== scrollRestoreGeneration\) return;/);
    assert.match(html, /function revealOrdinalNow\(ordinal, flash, severity\) \{[\s\S]*scrollRestoreGeneration\+\+;[\s\S]*lastKnownScrollTop = Math\.max\(0, Number\(translationScroll\.scrollTop\) \|\| 0\);[\s\S]*persistPageState\(\);/);
    assert.match(html, /const requestedJump = Number\.isInteger\(context\.jumpOrdinal\) \? context\.jumpOrdinal : pendingNavigationOrdinal;/);
    assert.match(html, /const requestedSeverity = Number\.isInteger\(context\.jumpOrdinal\) \? context\.jumpSeverity : pendingNavigationSeverity;/);
    assert.match(html, /if \(Number\.isInteger\(requestedJump\) && revealOrdinalNow\(requestedJump, true, requestedSeverity\)\) return;/);
});

test('XLIFF row actions preserve the current translation scroll position', () => {
    const { XliffEditorProvider } = loadEditorWithVscodeStub();
    const provider = new XliffEditorProvider({});
    const html = provider.getHtml({ cspSource: 'vscode-webview://test' });
    assert.match(html, /let lastKnownScrollTop = Math\.max\(0, Number\(persistedState\.scrollTop\) \|\| 0\)/);
    assert.match(html, /function captureScrollPosition\(\)/);
    assert.match(html, /function restoreScrollPosition\(scrollTop\)/);
    assert.match(html, /scrollTop:lastKnownScrollTop/);
    const rowClick = html.match(/rowsElement\.addEventListener\('click',[\s\S]*?\n\}\);/);
    assert.ok(rowClick, 'row click handler not found');
    assert.match(rowClick[0], /captureScrollPosition\(\);/);
    assert.match(html, /const preserveScroll = !options \|\| options\.preserveScroll !== false/);
    assert.match(html, /render\(\{ loading:true, stage:'Sorting entries', preserveScroll:false \}\)/);
    assert.match(html, /render\(\{ loading:false, stage:'Opening translation unit', preserveScroll:false, jumpOrdinal:ordinal, jumpSeverity:normalizedSeverity \}\)/);
});

test('XLIFF editor uses adaptive delayed background progress and atomic rendering for smaller views', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'xlfEditor.js'), 'utf8');
    assert.match(source, /DOCUMENT_LOADING_OVERLAY_THRESHOLD = 500/);
    assert.match(source, /estimatedUnits >= DOCUMENT_LOADING_OVERLAY_THRESHOLD/);

    const { XliffEditorProvider } = loadEditorWithVscodeStub();
    const provider = new XliffEditorProvider({});
    const html = provider.getHtml({ cspSource: 'vscode-webview://test' });
    assert.match(html, /RENDER_OVERLAY_UNIT_THRESHOLD = 500/);
    assert.match(html, /LOADING_OVERLAY_DELAY_MS = 300/);
    assert.match(html, /const showOverlay = loadingAllowed && totalRows >= RENDER_OVERLAY_UNIT_THRESHOLD/);
    assert.match(html, /rowsElement\.innerHTML = state\.pageRows\.map\(rowHtml\)\.join\(''\)/);
    assert.match(html, /loadingShowTimer = setTimeout/);
});

test('XLIFF editor debounces text filters and updates Try busy state without rebuilding the table', () => {
    const { XliffEditorProvider } = loadEditorWithVscodeStub();
    const provider = new XliffEditorProvider({});
    const html = provider.getHtml({ cspSource: 'vscode-webview://test' });
    assert.match(html, /FILTER_RENDER_DEBOUNCE_MS = 120/);
    assert.match(html, /filterRenderTimer = setTimeout\(applyFilterRender, FILTER_RENDER_DEBOUNCE_MS\)/);
    const tryBusy = html.match(/else if \(message\.type === 'tryBusy'\) \{([\s\S]*?)\n  \} else if \(message\.type === 'syncBusy'\)/);
    assert.ok(tryBusy, 'tryBusy handler not found');
    assert.match(tryBusy[1], /updateVisibleRowControls\(\)/);
    assert.doesNotMatch(tryBusy[1], /render\(/);
});

test('Apply Drafts uses delayed background progress only for larger batches and commits the batch in one XLIFF pass', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'xlfEditor.js'), 'utf8');
    assert.match(source, /APPLY_DRAFTS_PROGRESS_THRESHOLD = 20/);
    assert.match(source, /showApplyDraftsProgress = requested\.length >= APPLY_DRAFTS_PROGRESS_THRESHOLD/);
    assert.match(source, /await updateTranslationUnitsAdaptive\(latestText, batchChanges,/);
    assert.doesNotMatch(source, /processedDrafts\+\+/);

    const { XliffEditorProvider } = loadEditorWithVscodeStub();
    const provider = new XliffEditorProvider({});
    const html = provider.getHtml({ cspSource: 'vscode-webview://test' });
    assert.match(html, /APPLY_DRAFTS_OVERLAY_THRESHOLD = 20/);
    assert.match(html, /applyDraftsOverlayVisible = items\.length >= APPLY_DRAFTS_OVERLAY_THRESHOLD/);
    assert.match(html, /LOADING_OVERLAY_DELAY_MS = 300/);
});

test('manual Translation and Proposal editing defers persistence and rerendering until text focus leaves the row editors', () => {
    const { XliffEditorProvider } = loadEditorWithVscodeStub();
    const provider = new XliffEditorProvider({});
    const html = provider.getHtml({ cspSource: 'vscode-webview://test' });
    assert.match(html, /function isRowTextEditingActive\(\)/);
    assert.match(html, /pendingStagePersistence\.set\(key, \{ ordinal:row\.ordinal, kind:kind \}\)/);
    assert.match(html, /if \(isRowTextEditingActive\(\)\) return;/);
    assert.match(html, /rowsElement\.addEventListener\('focusout',[\s\S]*?settleTextEditing\(\)/);
    assert.match(html, /function flushPendingStagePersistence\(\)/);
    assert.match(html, /function render\(options\) \{\s*if \(isRowTextEditingActive\(\)\) \{\s*pendingRenderOptions = options \|\| \{\};\s*return;/);
    assert.match(html, /function flushDeferredRender\(\)/);
    const changeHandler = html.match(/rowsElement\.addEventListener\('change',[\s\S]*?\n\}\);/);
    assert.ok(changeHandler, 'change handler not found');
    assert.doesNotMatch(changeHandler[0], /persistStageNow\(row, 'draft'\)/);
    assert.doesNotMatch(changeHandler[0], /persistStageNow\(row, 'proposal'\)/);
});

test('Quality Check list supports OR-combined severity filters', () => {
    const { XliffEditorProvider } = loadEditorWithVscodeStub();
    const provider = new XliffEditorProvider({});
    const html = provider.getHtml({ cspSource: 'vscode-webview://test' });
    assert.match(html, /id="qualityFilterInfo"/);
    assert.match(html, /id="qualityFilterWarning"/);
    assert.match(html, /id="qualityFilterError"/);
    assert.match(html, /Severity filters are OR-combined/);
    assert.match(html, /function selectedQualitySeverities\(\)/);
    assert.match(html, /severities:selectedQualitySeverities\(\)/);
    assert.match(html, /qualitySeverityFilters\.forEach/);
});



test('VS Code Problems jump bridge is fully removed and diagnostics stay on the real XLIFF resource', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'xlfEditor.js'), 'utf8');
    assert.doesNotMatch(source, /PROBLEM_NAVIGATION_SCHEME/);
    assert.doesNotMatch(source, /registerTextDocumentContentProvider/);
    assert.doesNotMatch(source, /handleProblemSelection/);
    assert.doesNotMatch(source, /jumpToProblemTarget/);
    assert.doesNotMatch(source, /problemNavigation/);
    assert.doesNotMatch(source, /qualityDiagnosticTargets/);
    assert.match(source, /collection\.set\(uri, diagnostics\)/);
});

test('row </> and toolbar raw-XLIFF actions use the normal text editor without selection bridge hooks', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'xlfEditor.js'), 'utf8');
    assert.match(source, /if \(message\.type === 'openXliffUnitSource'\)/);
    assert.match(source, /await openXliffUnitSource\(document, Number\(message\.ordinal\)\)/);
    assert.match(source, /async function openXliffUnitSource\(document, ordinal\)/);
    assert.match(source, /vscode\.window\.showTextDocument\(document, \{ preview: false, preserveFocus: false \}\)/);
    assert.match(source, /editor\.selection = new vscode\.Selection\(range\.start, range\.end\)/);
    assert.match(source, /editor\.revealRange\(range, vscode\.TextEditorRevealType\.InCenterIfOutsideViewport\)/);
    assert.match(source, /if \(message\.type === 'openText'\)[\s\S]*showTextDocument\(document/);
});


test('Apply Drafts never rebuilds the full XLIFF row model and refreshes quality asynchronously', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'xlfEditor.js'), 'utf8');
    const start = source.indexOf("if (message.type === 'saveManyDrafts') {");
    const end = source.indexOf("if (message.type === 'acceptMany') {", start);
    assert.ok(start >= 0 && end > start, 'saveManyDrafts handler not found');
    const handler = source.slice(start, end);
    assert.match(handler, /await updateTranslationUnitsAdaptive\(latestText, batchChanges,/);
    assert.doesNotMatch(handler, /await postDocument\(\)/);
    assert.match(handler, /type: 'draftsSaved'/);
    assert.match(handler, /runQualityCheckForUri\(document\.uri, document\.getText\(\)\)/);
    assert.match(handler, /preserveVisibility: true/);

    const { XliffEditorProvider } = loadEditorWithVscodeStub();
    const provider = new XliffEditorProvider({});
    const html = provider.getHtml({ cspSource: 'vscode-webview://test' });
    assert.match(html, /message\.type === 'draftsSaved'[\s\S]*?pageRowCache\.get\(ordinal\)[\s\S]*?mergePartialRowOverride\(ordinal/);
    assert.doesNotMatch(html, /message\.type === 'draftsSaved'[\s\S]{0,2500}?resolvedMissing/);
    assert.match(html, /message\.type === 'qualityReport'/);
});

test('large XLIFF loads cancel stale preparation and distinguish editor transfer from row preparation', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'xlfEditor.js'), 'utf8');
    assert.match(source, /const snapshotVersion = Number\(document\.version\)/);
    assert.match(source, /const abandonStaleSnapshot = async phase =>/);
    assert.match(source, /currentVersion !== snapshotVersion/);
    assert.match(source, /type: 'loadCancelled'/);
    assert.match(source, /stage: t\("Updating editor"\)/);
    assert.match(source, /current: parsed\.units\.length/);
});



test('single-row Apply cannot be overwritten by a stale document payload or late draft persistence message', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'xlfEditor.js'), 'utf8');
    assert.match(source, /const rowApplyInProgress = new Set\(\)/);
    assert.match(source, /const lastAppliedDraftRevision = new Map\(\)/);
    assert.match(source, /rowApplyInProgress\.add\(ordinal\)/);
    assert.match(source, /lastAppliedDraftRevision\.set\(ordinal, draftRevision\)/);
    assert.match(source, /rowApplyInProgress\.has\(ordinal\)[\s\S]*incomingRevision <= appliedRevision/);
    assert.match(source, /documentVersion: Number\(document\.version\)/);

    const { XliffEditorProvider } = loadEditorWithVscodeStub();
    const provider = new XliffEditorProvider({});
    const html = provider.getHtml({ cspSource: 'vscode-webview://test' });
    assert.match(html, /let latestDocumentVersion = 0/);
    assert.match(html, /incomingDocumentVersion < latestDocumentVersion/);
    assert.match(html, /const previousOverrides = new Map\(\)/);
    assert.match(html, /Preserve unsent\/local webview edits across an asynchronous document refresh/);
    assert.match(html, /row\.translationDirty = false/);
    assert.match(html, /row\.canAcceptTranslation = false/);
    assert.match(html, /revision:Number\(row\.translationEditRevision\) \|\| 0/);
});

test('webview global row state is compact and full Source/Translation stay page-scoped', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'xlfEditor.js'), 'utf8');
    const compact = source.match(/function createWebviewRowIndexEntry\(row\) \{([\s\S]*?)\n\}/);
    assert.ok(compact, 'compact row-state builder not found');
    assert.doesNotMatch(compact[1], /source:\s*row\.source/);
    assert.doesNotMatch(compact[1], /translation:\s*row\.translation/);
    assert.doesNotMatch(compact[1], /id:\s*row\.id/);
    assert.match(source, /const rowStateIndex = rows\.map\(createWebviewRowIndexEntry\)\.filter\(Boolean\)/);
    assert.match(source, /full row data is materialized by requestViewPage for the visible page/);

    const { XliffEditorProvider } = loadEditorWithVscodeStub();
    const html = new XliffEditorProvider({}).getHtml({ cspSource: 'vscode-webview://test' });
    assert.match(html, /const rowStateByOrdinal = new Map\(\)/);
    assert.match(html, /const pageRowCache = new Map\(\)/);
    assert.doesNotMatch(html, /let model = \{ rows:\[\]/);
});

test('webview ordinal lookup and view overrides use Map/Set instead of global row scans', () => {
    const { XliffEditorProvider } = loadEditorWithVscodeStub();
    const html = new XliffEditorProvider({}).getHtml({ cspSource: 'vscode-webview://test' });
    assert.match(html, /function indexRowByOrdinal\(ordinal\) \{ return rowStateByOrdinal\.get\(Number\(ordinal\)\); \}/);
    assert.match(html, /const dirtyOrdinals = new Set\(\)/);
    assert.match(html, /const proposalOrdinals = new Set\(\)/);
    assert.match(html, /const viewOverrideOrdinals = new Set\(\)/);
    assert.match(html, /viewOverrideOrdinals\.forEach\(function\(ordinal\)/);
    assert.doesNotMatch(html, /model\.rows\.find/);
    assert.doesNotMatch(html, /\(model\.rows \|\| \[\]\)\.forEach/);
    assert.match(html, /const overrides = collectViewOverrides\(\);[\s\S]*viewRequestKey\(overrides\)[\s\S]*overrides:overrides/);
});

test('internal XLIFF edits are suppressed by document version instead of a fragile one-shot boolean', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'xlfEditor.js'), 'utf8');
    assert.match(source, /const suppressedDocumentVersions = new Set\(\)/);
    assert.match(source, /const expectedDocumentVersion = Number\(document\.version\) \+ 1/);
    assert.match(source, /suppressedDocumentVersions\.add\(expectedDocumentVersion\)/);
    assert.match(source, /suppressedDocumentVersions\.delete\(Number\(event\.document\.version\)\)/);
    assert.doesNotMatch(source, /suppressNextDocumentChange/);
});

test('Save is a lightweight commit and suppresses full row preparation during save participants', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'xlfEditor.js'), 'utf8');
    const handler = source.match(/if \(message\.type === 'saveDocument'\) \{([\s\S]*?)\n                \}\n                if \(message\.type === 'openDashboard'\)/);
    assert.ok(handler, 'saveDocument handler not found');
    assert.match(handler[1], /explicitSaveInProgress = true/);
    assert.match(handler[1], /explicitSaveInProgress = false/);
    assert.match(handler[1], /scheduleDocumentReload\(0\)/);
    assert.doesNotMatch(handler[1], /type: 'saveReconcile'/);
    assert.doesNotMatch(handler[1], /hasStructuralUnitChange/);
    assert.doesNotMatch(handler[1], /parse before save/);
    assert.doesNotMatch(handler[1], /await postDocument\(\)/);

    const changeHandler = source.match(/const changeSubscription = vscode\.workspace\.onDidChangeTextDocument\(event => \{([\s\S]*?)\n        \}\);/);
    assert.ok(changeHandler, 'change subscription not found');
    assert.match(changeHandler[1], /if \(explicitSaveInProgress\)/);
    assert.match(changeHandler[1], /scheduleDocumentReload\(\)/);
});

test('Save owns staged-note persistence in one batch instead of racing blur persistence', () => {
    const { XliffEditorProvider } = loadEditorWithVscodeStub();
    const provider = new XliffEditorProvider({});
    const html = provider.getHtml({ cspSource: 'vscode-webview://test' });
    const saveClick = html.match(/saveFileButton\.addEventListener\('click', function\(\) \{([\s\S]*?)\n\}\);/);
    assert.ok(saveClick, 'Save click handler not found');
    assert.match(saveClick[1], /cancelAllStagePersistence\(\)/);
    assert.match(saveClick[1], /kind:isDraft \? 'draft' : 'proposal'/);
    assert.match(html, /message\.type === 'saveReconcile'/);
});

test('proposal transfer button is aligned to the top of the row', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'xlfEditor.js'), 'utf8');
    assert.match(source, /\.transfer-cell\s*\{[^}]*vertical-align:top;/);
});


test('XLIFF editor main toolbar gives every button the same height', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'xlfEditor.js'), 'utf8');
    assert.match(source, /\.workflow button \{ height:32px; min-height:32px; display:inline-flex; align-items:center; justify-content:center; padding-top:0; padding-bottom:0; line-height:1; \}/);
});

test('XLIFF editor keeps generator origin in Source only and top-aligns row headers', () => {
    const { XliffEditorProvider } = loadEditorWithVscodeStub();
    const provider = new XliffEditorProvider({});
    const html = provider.getHtml({ cspSource: 'vscode-webview://test' });
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'xlfEditor.js'), 'utf8');

    assert.match(html, /class="generator-note" title="Xliff Generator"/);
    assert.match(source, /String\(note && note\.from \|\| ''\)\.trim\(\)\.toLowerCase\(\) !== 'xliff generator'/);
    assert.match(html, /th \{ vertical-align:top;/);
    assert.match(html, /\.actions button\[data-action="search"\] \{ font-size:18px; line-height:1; \}/);
});


test('XLIFF editor filters and sorts in the extension host and transfers only the resolved page', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'xlfEditor.js'), 'utf8');
    const { XliffEditorProvider } = loadEditorWithVscodeStub();
    const provider = new XliffEditorProvider({});
    const html = provider.getHtml({ cspSource: 'vscode-webview://test' });

    assert.match(source, /message\.type === 'requestViewPage'/);
    assert.match(source, /const result = queryViewRows\(activeRowStore, .*activeViewKeyStore, viewPageCache\)/);
    assert.match(source, /const pageRows = result\.rows\.map\(materializeActiveRow\)/);
    assert.match(source, /rows: pageRows/);
    assert.match(source, /function rowMatchesView\(row, view, preparedKeys\)/);
    assert.match(source, /function compareViewRows\(a, b, view, aKeys, bKeys\)/);
    assert.match(html, /type:'requestViewPage'/);
    assert.match(html, /message\.type === 'viewPage'/);
    assert.match(html, /function currentViewDefinition\(\)/);
    assert.match(html, /renderViewPage\(message\)/);
    assert.doesNotMatch(html, /function filteredSortedRows\(/);
    assert.doesNotMatch(html, /model\.rows\.filter\(matches\)\.sort\(compareRows\)/);
    assert.doesNotMatch(html, /type:'requestPageRows'/);
});

test('extension-host view query applies filters, sorting, paging, navigation and live overrides', () => {
    const { queryViewRows } = loadEditorWithVscodeStub();
    const rows = new Map([
        [0, { ordinal:0, id:'0', source:'Zulu', translation:'Ziel', status:'translated', missing:false, review:false, proposal:'', notes:[{from:'Developer',text:'last'}], qualityIssues:[], glossaryTerms:[] }],
        [1, { ordinal:1, id:'1', source:'Alpha', translation:'Alt', status:'needs-review-translation', missing:false, review:true, proposal:'', notes:[{from:'Developer',text:'needle'}], qualityIssues:[], glossaryTerms:[] }],
        [2, { ordinal:2, id:'2', source:'Beta', translation:'', status:'missing', missing:true, review:false, proposal:'', notes:[], qualityIssues:[], glossaryTerms:[] }]
    ]);
    const filtered = queryViewRows(rows, { view:{ page:1, pageSize:50, sortField:'source', sortDirection:1, filters:{notes:'needle'} } });
    assert.equal(filtered.filteredCount, 1);
    assert.equal(filtered.rows[0].ordinal, 1);

    const sorted = queryViewRows(rows, { view:{ page:1, pageSize:50, sortField:'source', sortDirection:-1 } });
    assert.deepEqual(sorted.rows.map(row => row.source), ['Zulu','Beta','Alpha']);

    const overridden = queryViewRows(rows, {
        view:{ page:1, pageSize:50, sortField:'translation', sortDirection:1, quick:{draft:true} },
        overrides:[{ ordinal:2, translation:'Lokaler Draft', savedTranslation:'', translationDirty:true, hasTranslationDraft:true, translationDraft:'Lokaler Draft' }]
    });
    assert.deepEqual(overridden.rows.map(row => row.ordinal), [2]);
    assert.equal(overridden.rows[0].translation, 'Lokaler Draft');

    const navigated = queryViewRows(rows, { view:{ page:1, pageSize:50, sortField:'source', filters:{source:'does-not-match'}, navigationOrdinal:2 } });
    assert.equal(navigated.filteredCount, 1);
    assert.equal(navigated.rows[0].ordinal, 2);
});



test('null navigation ordinal does not force the first trans-unit through active filters', () => {
    const { queryViewRows } = loadEditorWithVscodeStub();
    const rows = new Map([
        [0, { ordinal:0, id:'0', source:'First Unit', translation:'Erste', status:'translated', missing:false, review:false, proposal:'', notes:[], qualityIssues:[], glossaryTerms:[] }],
        [1, { ordinal:1, id:'1', source:'Matching Unit', translation:'Zweite', status:'translated', missing:false, review:false, proposal:'', notes:[], qualityIssues:[], glossaryTerms:[] }]
    ]);

    const filtered = queryViewRows(rows, {
        view:{ page:1, pageSize:50, sortField:'source', filters:{source:'matching'}, navigationOrdinal:null }
    });
    assert.equal(filtered.filteredCount, 1);
    assert.deepEqual(filtered.rows.map(row => row.ordinal), [1]);

    const none = queryViewRows(rows, {
        view:{ page:1, pageSize:50, sortField:'source', filters:{source:'does-not-match'}, navigationOrdinal:null }
    });
    assert.equal(none.filteredCount, 0);
    assert.deepEqual(none.rows, []);

    const explicitFirst = queryViewRows(rows, {
        view:{ page:1, pageSize:50, sortField:'source', filters:{source:'does-not-match'}, navigationOrdinal:0 }
    });
    assert.equal(explicitFirst.filteredCount, 1);
    assert.deepEqual(explicitFirst.rows.map(row => row.ordinal), [0]);
});

test('extension-host view query reuses precomputed per-row search and sort keys', () => {
    const { queryViewRows, createViewSearchSortKeyStore } = loadEditorWithVscodeStub();
    let notesReads = 0;
    const row = {
        ordinal: 0,
        id: 'Table 1 - Field 2 - Property 3',
        source: 'Alpha',
        translation: 'Ziel',
        status: 'translated',
        missing: false,
        review: false,
        proposal: '',
        qualityIssues: [{ code:'Q1', message:'Quality needle' }],
        glossaryTerms: [{ source:'Customer', translation:'Kunde' }]
    };
    Object.defineProperty(row, 'notes', {
        configurable: true,
        get() {
            notesReads++;
            return [{ from:'Developer', text:'Precomputed needle' }];
        }
    });
    const rows = new Map([[0, row]]);
    const keys = createViewSearchSortKeyStore(rows);
    assert.equal(notesReads, 1, 'preparing the key store should read Notes once');

    Object.defineProperty(row, 'notes', {
        configurable: true,
        get() { throw new Error('Notes must not be recomputed for a prepared view query'); }
    });

    const byNotes = queryViewRows(rows, { view:{ page:1, pageSize:50, sortField:'notes', filters:{notes:'precomputed'} } }, keys);
    assert.equal(byNotes.filteredCount, 1);
    const byGlobal = queryViewRows(rows, { view:{ page:1, pageSize:50, sortField:'source', globalFilter:'quality needle' } }, keys);
    assert.equal(byGlobal.filteredCount, 1);
    const byGlossary = queryViewRows(rows, { view:{ page:1, pageSize:50, sortField:'source', globalFilter:'kunde' } }, keys);
    assert.equal(byGlossary.filteredCount, 1);
});

test('live row overrides recompute only the affected row keys', () => {
    const { queryViewRows, createViewSearchSortKeyStore } = loadEditorWithVscodeStub();
    const rows = new Map([
        [0, { ordinal:0, id:'0', source:'Alpha', translation:'Alt', status:'translated', missing:false, review:false, proposal:'', notes:[], qualityIssues:[], glossaryTerms:[] }],
        [1, { ordinal:1, id:'1', source:'Beta', translation:'Bestehend', status:'translated', missing:false, review:false, proposal:'', notes:[], qualityIssues:[], glossaryTerms:[] }]
    ]);
    const keys = createViewSearchSortKeyStore(rows);
    const result = queryViewRows(rows, {
        view:{ page:1, pageSize:50, sortField:'translation', sortDirection:1, globalFilter:'lokaler draft' },
        overrides:[{ ordinal:0, translation:'Lokaler Draft', translationDirty:true, hasTranslationDraft:true, translationDraft:'Lokaler Draft' }]
    }, keys);
    assert.deepEqual(result.rows.map(row => row.ordinal), [0]);
});


test('Point 5 precomputes complete editor summary counters from the extension-host row store', () => {
    const { createViewSearchSortKeyStore, createEditorSummaryStats } = loadEditorWithVscodeStub();
    const rows = new Map([
        [0, { ordinal:0, source:'A %1', translation:'A %1', rawState:'', missing:false, review:false, proposal:'', hasTranslationDraft:false, notTranslatable:false, qualityIssues:[{code:'Q1'}], glossaryTerms:[] }],
        [1, { ordinal:1, source:'B %1', translation:'', rawState:'needs-review-translation', missing:false, review:true, proposal:'B %2', hasTranslationDraft:false, notTranslatable:false, qualityIssues:[], glossaryTerms:[] }],
        [2, { ordinal:2, source:'Customer', translation:'Kunde', translationDraft:'Kundin', hasTranslationDraft:true, rawState:'translated', missing:false, review:false, proposal:'', notTranslatable:false, qualityIssues:[], glossaryTerms:[{source:'Customer',translation:'Kunde'}] }],
        [3, { ordinal:3, source:'Missing', translation:'', rawState:'', missing:true, review:false, proposal:'', hasTranslationDraft:false, notTranslatable:false, qualityIssues:[], glossaryTerms:[] }]
    ]);
    const keys = createViewSearchSortKeyStore(rows);
    const stats = createEditorSummaryStats(rows, keys, { total:1, errors:0, warnings:1, infos:0, categories:{} });
    assert.equal(stats.total, 4);
    assert.equal(stats.missing, 1);
    assert.equal(stats.review, 1);
    assert.equal(stats.proposals, 1);
    assert.equal(stats.translationDrafts, 1);
    assert.equal(stats.staged, 2);
    assert.equal(stats.placeholderErrors, 1);
    assert.equal(stats.terminologyErrors, 1);
    assert.equal(stats.qualityIssues, 1);
    assert.equal(stats.noState, 1);
    assert.equal(stats.quality.total, 1);
});

test('Point 5 updateSummary uses incremental counters instead of full model row scans', () => {
    const { XliffEditorProvider } = loadEditorWithVscodeStub();
    const provider = new XliffEditorProvider({});
    const html = provider.getHtml({ cspSource: 'vscode-webview://test' });
    const match = html.match(/function updateSummary\(pageState\) \{([\s\S]*?)\n\}/);
    assert.ok(match, 'updateSummary not found');
    const body = match[1];
    assert.doesNotMatch(body, /model\.rows\.filter/);
    assert.doesNotMatch(body, /model\.rows\.reduce/);
    assert.doesNotMatch(body, /model\.rows\.some/);
    assert.match(body, /draftCount\(\)/);
    assert.match(body, /stagedCount\(\)/);
    assert.match(body, /proposalOrdinals\.size/);
    assert.match(body, /stats\.placeholderErrors/);
    assert.match(body, /stats\.terminologyErrors/);
    assert.match(body, /stats\.qualityIssues/);
    assert.match(body, /stats\.noState/);
    assert.match(html, /function reconcileSummaryStatsForRow\(row\)/);
    assert.match(html, /summaryTouchedRows/);
});

test('Point 7 Quality diagnostics reuse parser startOffset values without rescanning trans-units', () => {
    const { diagnosticOffsetForOrdinal } = loadEditorWithVscodeStub();
    const units = [
        { ordinal:0, startOffset:17 },
        { ordinal:1, startOffset:101 },
        { ordinal:2, startOffset:250 }
    ];
    assert.equal(diagnosticOffsetForOrdinal(units, 0), 17);
    assert.equal(diagnosticOffsetForOrdinal(units, 1), 101);
    assert.equal(diagnosticOffsetForOrdinal(units, 2), 250);
    assert.equal(diagnosticOffsetForOrdinal(units, 99), 0);

    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'xlfEditor.js'), 'utf8');
    assert.doesNotMatch(source, /function findParsedTransUnitOffsets/);
    assert.doesNotMatch(source, /diagnostics find unit offsets/);
    assert.match(source, /diagnostics use parsed unit offsets/);
    assert.match(source, /publishQualityDiagnosticsForText\(uri, sourceText, analysis\.report, analysis\.parsed/);
    assert.match(source, /publishQualityDiagnostics\(document, qualityReport, parsed, perf\)/);
});

test('Point 7 diagnostic offset lookup tolerates non-indexed ordinals without XML scanning', () => {
    const { diagnosticOffsetForOrdinal } = loadEditorWithVscodeStub();
    const units = [
        { ordinal:5, startOffset:500 },
        { ordinal:7, startOffset:700 }
    ];
    assert.equal(diagnosticOffsetForOrdinal(units, 7), 700);
    assert.equal(diagnosticOffsetForOrdinal(units, -1), 0);
    assert.equal(diagnosticOffsetForOrdinal([{ ordinal:0, startOffset:-3 }], 0), 0);
});

test('large XLIFFs defer initial quality until the first page has rendered', () => {
    const {
        XliffEditorProvider,
        shouldDeferInitialQuality,
        createEmptyQualityReport,
        DEFERRED_QUALITY_CHAR_THRESHOLD,
        DEFERRED_QUALITY_UNIT_THRESHOLD
    } = loadEditorWithVscodeStub();

    assert.equal(shouldDeferInitialQuality('small', { units: new Array(DEFERRED_QUALITY_UNIT_THRESHOLD - 1) }), false);
    assert.equal(shouldDeferInitialQuality('small', { units: new Array(DEFERRED_QUALITY_UNIT_THRESHOLD) }), true);
    assert.equal(shouldDeferInitialQuality('x'.repeat(DEFERRED_QUALITY_CHAR_THRESHOLD), { units: [] }), true);

    const empty = createEmptyQualityReport();
    assert.equal(empty.summary.total, 0);
    assert.equal(empty.byOrdinal.size, 0);
    assert.equal(empty.ignoredByOrdinal.size, 0);

    const provider = new XliffEditorProvider({});
    const html = provider.getHtml({ cspSource: 'vscode-webview://test' });
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'xlfEditor.js'), 'utf8');

    assert.match(source, /DEFERRED_QUALITY_CHAR_THRESHOLD = 3 \* 1024 \* 1024/);
    assert.match(source, /DEFERRED_QUALITY_UNIT_THRESHOLD = 5000/);
    assert.match(source, /defer quality check until first page/);
    assert.match(source, /qualityPending: deferInitialQuality/);
    assert.match(source, /message && message\.type === 'initialPageRendered'/);
    assert.match(source, /runDeferredQualityAfterFirstPage\(message\)/);
    assert.match(source, /type: 'qualityReport'[\s\S]*background: true/);

    assert.match(html, /function notifyInitialPageRenderedForDeferredQuality\(\)/);
    assert.match(html, /requestAnimationFrame\(function\(\) \{[\s\S]*requestAnimationFrame\(function\(\) \{/);
    assert.match(html, /type:'initialPageRendered'/);
    assert.match(html, /model\.qualityPending \? 'quality pending…'/);
    assert.match(html, /model\.qualityPending = false;/);
});

test('small XLIFFs keep the immediate quality path while deferred quality can be cancelled by manual validation', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'xlfEditor.js'), 'utf8');
    assert.match(source, /if \(deferInitialQuality\) \{[\s\S]*createEmptyQualityReport\(\)[\s\S]*\} else \{[\s\S]*await analyzeQualityForText/);
    assert.match(source, /if \(message\.type === 'validateQuality'\) \{[\s\S]*pendingDeferredQuality = undefined;[\s\S]*deferredQualityRunGeneration\+\+;/);
});

test('Point 9 paginates Quality Check results and renders only the current findings page', () => {
    const { XliffEditorProvider } = loadEditorWithVscodeStub();
    const provider = new XliffEditorProvider({});
    const html = provider.getHtml({ cspSource: 'vscode-webview://test' });

    for (const id of ['qualityPageSize', 'qualityFirstPage', 'qualityPrevPage', 'qualityPageInfo', 'qualityNextPage', 'qualityLastPage']) {
        assert.match(html, new RegExp(`id="${id}"`));
    }
    assert.match(html, /let qualityPageSize = 100;/);
    assert.match(html, /const pageStart = page\.start;/);
    assert.match(html, /const pageItems = page\.items \|\| \[\];/);
    assert.match(html, /type:'requestQualityPage'/);
    assert.match(html, /qualityList\.innerHTML = pageItems\.length \? pageItems\.map/);
    assert.match(html, /qualityPageSize = \[50,100,200\]\.includes\(requested\) \? requested : 100;/);
    assert.match(html, /showing ' \+ \(pageStart \+ 1\) \+ '–' \+ pageEnd \+ ' of ' \+ filteredCount/);
});

test('Point 9 caps VS Code Problems diagnostics while retaining the full Quality report', () => {
    const {
        selectQualityDiagnosticIssues,
        qualityDiagnosticsLimit,
        DEFAULT_QUALITY_DIAGNOSTIC_LIMIT
    } = loadEditorWithVscodeStub();
    const issues = Array.from({ length: 2505 }, (_, ordinal) => ({ ordinal, code: 'Q', message: `Issue ${ordinal}` }));
    const selected = selectQualityDiagnosticIssues({ issues }, 2000);

    assert.equal(DEFAULT_QUALITY_DIAGNOSTIC_LIMIT, 2000);
    assert.equal(qualityDiagnosticsLimit(), 2000);
    assert.equal(selected.total, 2505);
    assert.equal(selected.published, 2000);
    assert.equal(selected.issues.length, 2000);
    assert.equal(selected.issues[0], issues[0]);
    assert.equal(selected.issues[1999], issues[1999]);
    assert.equal(selected.truncated, true);

    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'xlfEditor.js'), 'utf8');
    assert.match(source, /selectQualityDiagnosticIssues\(report, qualityDiagnosticsLimit\(uri\)\)/);
    assert.match(source, /diagnosticSelection\.issues\.map/);
    assert.match(source, /totalIssues: diagnosticSelection\.total/);
    assert.match(source, /truncated: diagnosticSelection\.truncated/);

    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const setting = pkg.contributes.configuration.properties['alXliffStudio.quality.maxProblemsDiagnostics'];
    assert.equal(setting.type, 'integer');
    assert.equal(setting.default, 2000);
    assert.equal(setting.minimum, 100);
    assert.equal(setting.maximum, 50000);
});

test('large-file editor parsing uses async DocumentSession worker path without changing normal paging', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'xlfEditor.js'), 'utf8');
    assert.match(source, /getParsedDocumentSessionAsync/);
    assert.match(source, /parseXliffAdaptive/);
    assert.match(source, /analyzeXliffQualityAdaptive/);
    assert.match(source, /await abandonStaleSnapshot\('after parse XLIFF'\)/);
    assert.match(source, /requestViewPage/);
});


test('large Quality reports remain in the host and inline updates touch only materialized rows', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'xlfEditor.js'), 'utf8');
    const { XliffEditorProvider } = loadEditorWithVscodeStub();
    const provider = new XliffEditorProvider({});
    const html = provider.getHtml({ cspSource: 'vscode-webview://test' });
    assert.match(source, /report: qualityPageStore\.metadata/);
    assert.match(source, /await queryQualityPage/);
    assert.doesNotMatch(source, /qualityReportChunk|qualityReportStart|qualityReportEnd/);
    const syncBlock = html.match(/function syncRowQualityFromReport\(report\) \{([\s\S]*?)\n\}/);
    assert.ok(syncBlock, 'syncRowQualityFromReport not found');
    assert.doesNotMatch(syncBlock[1], /model\.rows\.forEach/);
    assert.match(syncBlock[1], /pageRowCache\.forEach/);
    assert.match(html, /message\.type === 'qualityPage'/);
    assert.match(html, /Number\(message\.revision\) !== currentQualityReport\.revision/);
});


test('host view query keeps transient results ordinal-only instead of allocating candidate row/key objects', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'xlfEditor.js'), 'utf8');
    const query = source.match(/function queryViewRows\(rowStore, request, preparedKeyStore, cache\) \{([\s\S]*?)\n\}/);
    assert.ok(query, 'queryViewRows not found');
    assert.match(query[1], /const visibleOrdinals = cached \? cached\.ordinals : \[\]/);
    assert.match(query[1], /visibleOrdinals\.push\(ordinal\)/);
    assert.doesNotMatch(query[1], /Array\.from\(rowStore/);
    assert.doesNotMatch(query[1], /const candidates/);
    assert.doesNotMatch(query[1], /\{ row, keys \}/);
});

test('editor row store drops heavy display details and rematerializes them only for a visible page', () => {
    const { compactEditorRow, materializeEditorRowDetails } = loadEditorWithVscodeStub();
    const row = {
        ordinal: 4, id: '4', source: 'Customer', translation: 'Kunde',
        notes: [{ from:'Developer', text:'Hinweis' }],
        generatorNote: 'Table 18 - Property 2879900210',
        translationProvenance: { source:'human' },
        translationProvenanceLabel: 'Human',
        provenanceHistory: [{ source:'human' }],
        provenanceHistoryLabels: ['Human'],
        glossaryTerms: [{ source:'Customer', translation:'Kunde' }],
        qualityIssues: [{ severity:'warning', code:'Q1', message:'Issue' }],
        ignoredQualityIssues: [{ severity:'info', code:'Q2', message:'Ignored' }]
    };
    const compact = compactEditorRow(row);
    for (const field of ['notes','generatorNote','translationProvenance','translationProvenanceLabel','provenanceHistory','provenanceHistoryLabels','glossaryTerms','qualityIssues','ignoredQualityIssues']) {
        assert.equal(Object.prototype.hasOwnProperty.call(compact, field), false, field + ' should stay page-scoped');
    }
    assert.equal(compact.qualityIssueCount, 1);

    const unit = {
        ordinal: 4,
        noteDetails: [
            { from:'Developer', text:'Hinweis' },
            { from:'Xliff Generator', text:'Table 18 - Property 2879900210' }
        ]
    };
    const materialized = materializeEditorRowDetails(compact, unit, {
        provenanceEnabled: true,
        glossaryTerms: [{ source:'Customer', translation:'Kunde' }],
        qualityIssues: [{ severity:'warning', code:'Q1', message:'Issue' }],
        ignoredQualityIssues: [{ severity:'info', code:'Q2', message:'Ignored' }]
    });
    assert.equal(materialized.notes.length, 1);
    assert.equal(materialized.notes[0].text, 'Hinweis');
    assert.equal(materialized.generatorNote, 'Table 18 - Property 2879900210');
    assert.equal(materialized.glossaryTerms[0].translation, 'Kunde');
    assert.equal(materialized.qualityIssues[0].code, 'Q1');
    assert.equal(materialized.ignoredQualityIssues[0].code, 'Q2');
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'xlfEditor.js'), 'utf8');
    assert.match(source, /const PAGE_DETAIL_GLOSSARY_CACHE_LIMIT = 1000/);
    assert.match(source, /glossaryTermsBySource\.size > PAGE_DETAIL_GLOSSARY_CACHE_LIMIT/);
});

test('prepared view override keys reuse flattened details instead of requiring page-only arrays', () => {
    const { compactEditorRow, createViewSearchSortKeys, createViewSearchSortKeysForOverride } = loadEditorWithVscodeStub();
    const full = {
        ordinal:0, id:'0', source:'Customer %1', translation:'Kunde %1', status:'translated',
        missing:false, review:false, proposal:'', notes:[{from:'Developer',text:'needle'}],
        qualityIssues:[{code:'Q1',message:'quality needle'}],
        glossaryTerms:[{source:'Customer',translation:'Kunde'}],
        translationTerminologyError:false, proposalTerminologyError:false
    };
    const baseKeys = createViewSearchSortKeys(full);
    const compact = compactEditorRow(full);
    const merged = { ...compact, translation:'Lokaler %1', translationDirty:true, hasTranslationDraft:true, translationDraft:'Lokaler %1' };
    const keys = createViewSearchSortKeysForOverride(compact, baseKeys, merged);
    assert.match(keys.notes, /needle/);
    assert.match(keys.quality, /quality needle/);
    assert.match(keys.glossary, /kunde/);
    assert.equal(keys.translation, 'lokaler %1');
    assert.equal(keys.hasDraft, true);
});

test('translation paging reuses bounded ordinal indexes and invalidates draft/version/filter queries', () => {
 const { queryViewRows, createViewSearchSortKeyStore } = loadEditorWithVscodeStub();
 const rows = new Map(Array.from({length:120}, (_,ordinal)=>[ordinal,{ordinal,source:'Item '+ordinal,translation:'',missing:true}]));
 const keys=createViewSearchSortKeyStore(rows), cache=new Map();
 let scans=0; const original=rows.entries.bind(rows); rows.entries=()=>{scans++;return original();};
 const request={documentVersion:1,view:{page:1,pageSize:50,sortField:'source'}};
 const first=queryViewRows(rows,request,keys,cache);
 const second=queryViewRows(rows,{...request,view:{...request.view,page:2}},keys,cache);
 assert.equal(scans,1); assert.equal(first.rows.length,50); assert.equal(second.rows[0].ordinal,50);
 queryViewRows(rows,{...request,documentVersion:2},keys,cache); assert.equal(scans,2);
 const changed=queryViewRows(rows,{...request,overrides:[{ordinal:0,translation:'Draft',translationDirty:true}],view:{...request.view,filters:{translation:'Draft'}}},keys,cache);
 assert.equal(changed.filteredCount,1); assert.equal(changed.rows[0].translation,'Draft');
 for(let i=0;i<12;i++) queryViewRows(rows,{...request,documentVersion:i+3},keys,cache);
 assert.ok(cache.size<=8);
});
