'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createEditorHarness } = require('../tools/editor-harness.cjs');
const { GuidedWorkflowSession } = require('../src/guidedWorkflowSession');
const { parseXliff, getStagedTranslation, setStagedTranslations } = require('../src/xliff');

const xlf = units => `<xliff><file source-language="en-US" target-language="de-DE"><body>${units}</body></file></xliff>`;

test('previous and next preserve edits and materialize updated targets without duplicate counters', async () => {
    const t = await create(xlf('<trans-unit id="a"><source>Customer</source><target/></trans-unit><trans-unit id="b"><source>Order</source><target/></trans-unit>'));
    try {
        await t.session.start('translate-missing');
        assert.equal(t.session.state().canPrevious, false);
        await t.act('next', 'Debitor');
        assert.equal(t.session.current.id, 'b');
        assert.equal(getStagedTranslation(parseXliff(t.h.document.getText()).units[0]).text, 'Debitor');
        await t.act('previous', 'Auftrag');
        assert.equal(t.session.current.id, 'a');
        assert.equal(t.session.state().row.localDraft.translation, 'Debitor');
        await t.act('apply', 'Debitor');
        await t.act('previous');
        assert.equal(t.session.current.translation, 'Debitor');
        await t.act('apply', 'Kunde');
        assert.equal(t.session.accepted, 1);
        await t.act('skip', 'Auftrag');
        await t.act('finish');
        assert.equal(t.session.summary.missing, 1);
        assert.equal(t.session.summary.skipped, 1);
        assert.equal(t.session.summary.drafts, 1);
        assert.equal(t.session.summary.review, 1);
        assert.equal(t.session.summary.unvisited, 0);
        await t.session.start('skipped');
        assert.equal(t.session.queue.length, 1);
        assert.equal(t.session.current.id, 'b');
        t.h.externalChange(t.h.document.getText() + '\n<!-- external edit -->');
        await assert.rejects(t.session.start('skipped'), /außerhalb/);
    } finally { t.close(); }
});

test('checkpoint preserves an unsent entry in the open document without disk save or acceptance', async () => {
    const t = await create(xlf('<trans-unit id="a"><source>Customer</source><target/></trans-unit>'));
    try {
        await t.session.start('translate-missing');
        await t.act('checkpoint', 'Mein Entwurf');
        assert.equal(t.session.error, '');
        assert.equal(t.session.current.translationDraft, 'Mein Entwurf');
        assert.equal(t.session.drafts.size, 0);
        assert.equal(t.h.document.isDirty, true);
        assert.equal(getStagedTranslation(parseXliff(t.h.document.getText()).units[0]).text, 'Mein Entwurf');
        assert.equal(parseXliff(fs.readFileSync(t.h.uri.fsPath, 'utf8')).units[0].target, '');
        assert.equal(t.session.accepted, 0);
    } finally { t.close(); }
});

test('Expert Editor handoff checkpoints the visible input before opening the selected ordinal', async () => {
    const t=await create(xlf('<trans-unit id="a"><source>Customer</source><target/></trans-unit>'));
    const Module=require('node:module'), originalLoad=Module._load;
    let View;
    try {
        Module._load=function(id,parent,main){return id==='vscode'?t.h.vscode:originalLoad.call(this,id,parent,main);};
        delete require.cache[require.resolve('../src/guidedTranslation')];
        View=require('../src/guidedTranslation').GuidedTranslationView;
    } finally {Module._load=originalLoad;}
    const Provider=t.h.provider.constructor, original=Provider.openAtOrdinal, opened=[];
    Provider.openAtOrdinal=async (uri,ordinal)=>{opened.push(ordinal);assert.equal(getStagedTranslation(parseXliff(t.h.document.getText()).units[ordinal]).text,'Übergabe');};
    try {
        const view=new View({webview:{onDidReceiveMessage(){},postMessage:async()=>true},onDidDispose(){}},t.h.uri,{},{});
        view.session=t.session;
        await t.session.start('translate-missing');
        await view.handleMessage({type:'openEditor',text:'Übergabe',revision:t.session.revision});
        assert.deepEqual(opened,[0]);
        assert.equal(t.h.document.isDirty,true);
    } finally {Provider.openAtOrdinal=original;t.close();}
});

test('developer mismatch offers matching language as proposal and applies only after explicit selection', async () => {
    const initial = setStagedTranslations(xlf('<trans-unit id="a"><source>Customer</source><target state="translated">Kunde</target><note from="Developer">DEU=Debitor;ENU=Customer</note></trans-unit>'), [{ ordinal: 0, staged: { kind: 'draft', text: 'Mein Entwurf', origin: 'Manual' } }]).text;
    const t = await create(initial);
    try {
        await t.session.start('quality-fix');
        assert.ok(t.session.current.qualityIssues.some(issue => issue.code === 'developer-comment-mismatch'));
        assert.equal(t.session.current.proposal, 'Debitor');
        assert.equal(t.session.current.translation, 'Kunde');
        assert.equal(t.session.drafts.get(0).translation, 'Mein Entwurf');
        assert.equal(t.session.current.proposalProvenance.origin, 'developer-comment');
        assert.equal(t.h.document.isDirty, false);
        await t.act('useProposal');
        assert.equal(t.session.drafts.get(0).translation, 'Debitor');
        await t.act('apply', 'Debitor');
        await t.act('finish');
        const unit = parseXliff(t.h.document.getText()).units[0];
        assert.equal(unit.target, 'Debitor');
        assert.equal(t.session.quality.summary.warnings, 0);
    } finally { t.close(); }
});

test('foreign developer language does not become a guided proposal', async () => {
    const t = await create(xlf('<trans-unit id="a"><source>Customer %1</source><target state="translated">Kunde</target><note from="Developer">FRA=Client %1</note></trans-unit>'));
    try {
        await t.session.start('quality-fix');
        assert.equal(t.session.current.proposal || '', '');
        assert.ok(!t.session.current.qualityIssues.some(issue => issue.code === 'developer-comment-mismatch'));
    } finally { t.close(); }
});

test('new language local import preserves existing drafts, stages developer text and does not start AI', async () => {
    const initial = setStagedTranslations(xlf('<trans-unit id="a"><source>Customer</source><target/><note from="Developer">DEU=Debitor</note></trans-unit><trans-unit id="b"><source>Order</source><target/><note from="Developer">DEU=Auftrag</note></trans-unit><trans-unit id="c"><source>Unknown</source><target/></trans-unit>'), [{ ordinal: 1, staged: { kind: 'draft', text: 'Mein Entwurf', origin: 'Manual' } }]).text;
    const t = await create(initial);
    try {
        await t.session.importLocal();
        const units = parseXliff(t.h.document.getText()).units;
        assert.equal(getStagedTranslation(units[0]).text, 'Debitor');
        assert.equal(getStagedTranslation(units[1]).text, 'Mein Entwurf');
        assert.equal(getStagedTranslation(units[2]), undefined);
        assert.equal(units[0].target, '');
        assert.equal(t.h.popups.length, 0);
        await t.session.importLocal(); // Repeat is safe and preserves staged work.
        await t.session.start('new-language');
        assert.equal(t.session.current.translationDraft, 'Debitor');
        assert.equal(t.session.state().conflict, false);
    } finally { t.close(); }
});
async function create(text) {
    const h = await createEditorHarness({ root: fs.mkdtempSync(path.join(os.tmpdir(), 'xliff-guided-')), text });
    const states = [];
    const session = new GuidedWorkflowSession(h.document, h.provider, state => states.push(structuredClone(state)));
    await session.connect();
    return { h, session, states, act: (action, text) => session.act({ action, text, revision: session.revision }), close: () => { session.dispose(); h.close(); } };
}

test('missing workflow skips with a draft, rejects invalid placeholders, applies and saves with final quality', async () => {
    const testCase = await create(xlf('<trans-unit id="a"><source>Customer</source><target/><note from="Developer">DEU=Debitor</note></trans-unit><trans-unit id="b"><source>Order %1</source><target/></trans-unit>'));
    const { h, session, act } = testCase;
    try {
        await session.start('translate-missing');
        assert.equal(session.queue.length, 2);
        assert.equal(session.current.id, 'a');
        assert.equal(session.current.notes[0].from, 'Developer');
        await act('skip', 'Debitor');
        assert.equal(session.current.id, 'b');
        assert.equal(h.document.isDirty, true, 'skipped draft is preserved in the open document without saving to disk');
        assert.equal(getStagedTranslation(parseXliff(h.document.getText()).units[0]).text, 'Debitor');
        await act('apply', 'Auftrag');
        assert.match(session.error, /Placeholders/);
        assert.equal(session.position, 1);
        assert.equal(session.drafts.get(1).translation, 'Auftrag');
        await act('apply', 'Auftrag %1');
        assert.equal(session.phase, 'complete');
        assert.equal(h.document.isDirty, true);
        assert.equal(parseXliff(fs.readFileSync(h.uri.fsPath, 'utf8')).units[1].target, '');
        await act('finish');
        assert.equal(session.error, '');
        assert.equal(session.phase, 'summary');
        assert.equal(session.accepted, 1); assert.equal(session.skipped, 1);
        assert.equal(h.document.isDirty, false);
        const saved = parseXliff(fs.readFileSync(h.uri.fsPath, 'utf8'));
        assert.equal(saved.units[1].target, 'Auftrag %1');
        assert.equal(saved.units[1].targetState, 'translated');
        assert.equal(getStagedTranslation(saved.units[0]).text, 'Debitor');
        assert.ok(session.quality.summary);
    } finally { testCase.close(); }
});

test('review includes No State and proposals and explicitly applies selected proposal', async () => {
    const base = xlf('<trans-unit id="a"><source>Customer</source><target>Debitor</target></trans-unit><trans-unit id="b"><source>Order</source><target state="translated">Bestellung</target></trans-unit>');
    const staged = setStagedTranslations(base, [{ ordinal: 1, staged: { kind: 'proposal', text: 'Auftrag', origin: 'Test' } }]).text;
    const testCase = await create(staged);
    const { session, act, h } = testCase;
    try {
        await session.start('review');
        assert.equal(session.queue.length, 2);
        await act('apply', 'Debitor');
        assert.equal(session.current.proposal, 'Auftrag');
        assert.equal(session.current.translation, 'Bestellung');
        await act('useProposal');
        assert.equal(session.drafts.get(1).translation, 'Auftrag');
        await act('apply', 'Auftrag');
        assert.equal(session.phase, 'complete');
        await act('finish');
        const parsed = parseXliff(h.document.getText());
        assert.deepEqual(parsed.units.map(unit => unit.target), ['Debitor', 'Auftrag']);
        assert.ok(parsed.units.every(unit => unit.targetState === 'translated'));
    } finally { testCase.close(); }
});

test('quality workflow fixes an affected entry and final report reflects the new target', async () => {
    const testCase = await create(xlf('<trans-unit id="a"><source>Order %1</source><target state="translated">Auftrag %2</target></trans-unit>'));
    const { session, act } = testCase;
    try {
        await session.start('quality-fix');
        assert.equal(session.queue.length, 1);
        assert.ok(session.current.qualityIssues.some(issue => /placeholder/.test(issue.code)));
        await act('apply', 'Auftrag %1');
        await act('finish');
        assert.equal(session.phase, 'summary');
        assert.equal(session.quality.summary.errors, 0);
    } finally { testCase.close(); }
});

test('wizard rejects stale entry actions and external edits without overwriting them', async () => {
    const testCase = await create(xlf('<trans-unit id="a"><source>A</source><target/></trans-unit><trans-unit id="b"><source>B</source><target/></trans-unit>'));
    const { session, act, h } = testCase;
    try {
        await session.start('translate-missing');
        const oldRevision = session.revision;
        await act('skip');
        await session.act({ action: 'apply', text: 'Wrong row', revision: oldRevision });
        assert.match(session.error, /früheren Eintrag/);
        assert.equal(parseXliff(h.document.getText()).units[1].target, '');
        const external = h.document.getText() + '\n<!-- external -->';
        h.externalChange(external);
        await act('apply', 'Extern überschrieben');
        assert.match(session.error, /außerhalb/);
        assert.equal(h.document.getText(), external);
        assert.equal(session.state().conflict, true);
    } finally { testCase.close(); }
});

test('empty workflow finishes cleanly and headless adapter does not register an Expert panel', async () => {
    const testCase = await create(xlf('<trans-unit id="a"><source>A</source><target state="translated">Eintrag</target></trans-unit>'));
    const { session, act, h } = testCase;
    try {
        const records = h.editor.XliffEditorProvider.panelRecords.get(h.uri.toString());
        assert.equal(records.size, 1);
        await session.start('translate-missing');
        assert.equal(session.phase, 'complete');
        await act('finish');
        assert.equal(session.phase, 'summary');
        assert.equal(records.size, 1);
    } finally { testCase.close(); }
});

function mockAi(h, onRequest = () => {}) {
    h.vscode.CancellationTokenSource = class {
        token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
        cancel() { this.token.isCancellationRequested = true; }
        dispose() {}
    };
    h.vscode.lm = { async selectChatModels() { return [{ id: 'test-model', async sendRequest(messages) {
        const prompt = messages[0].value;
        const input = JSON.parse(prompt.slice(prompt.indexOf('INPUT=') + 6));
        onRequest();
        return { text: (async function* () { yield JSON.stringify(input.map(item => ({ id: item.id, translation: 'Auftrag %1' }))); })() };
    } }]; } };
    h.vscode.LanguageModelChatMessage = { User: value => ({ value }) };
    h.vscode.window.showWarningMessage = async () => 'Use AI';
}

test('AI proposal remains separate from manual text until explicitly used', async () => {
    const testCase = await create(xlf('<trans-unit id="a"><source>Order %1</source><target/></trans-unit>'));
    const { session, act, h } = testCase;
    try {
        mockAi(h);
        await session.start('translate-missing');
        await act('ai', 'Meine Übersetzung %1');
        assert.equal(session.error, '');
        assert.equal(session.current.proposal, 'Auftrag %1');
        assert.equal(session.drafts.get(0).translation, 'Meine Übersetzung %1');
        assert.equal(session.state().conflict, false);
        await act('useProposal');
        await act('apply', 'Auftrag %1');
        assert.equal(session.accepted, 1);
    } finally { testCase.close(); }
});

test('AI result is discarded when the backing XLIFF changes during its request', async () => {
    const testCase = await create(xlf('<trans-unit id="a"><source>Order %1</source><target/></trans-unit>'));
    const { session, act, h } = testCase;
    try {
        const external = h.document.getText() + '\n<!-- external edit -->';
        mockAi(h, () => h.externalChange(external));
        await session.start('translate-missing');
        await act('ai');
        assert.match(session.error, /changed/);
        assert.equal(h.document.getText(), external);
        assert.equal(session.current.proposal, '');
    } finally { testCase.close(); }
});
