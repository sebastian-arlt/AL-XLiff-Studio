'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createEditorHarness, generateLargeXliff } = require('../tools/editor-harness.cjs');
const { getExistingDocumentSession } = require('../src/documentSession');

test('editing during large Sync cancels its worker and never applies obsolete generator content', async () => {
    const {observeWorkers}=require('../src/xlfWorkerHost');
    const text=generateLargeXliff(1000,0);
    const h=await createEditorHarness({root:fs.mkdtempSync(path.join(os.tmpdir(),'xliff-sync-stale-')),text,configuration:{'performance.workerThreads.minUnits':1000}});
    let stop;
    try {
        await h.send({type:'ready'});
        fs.writeFileSync(path.join(path.dirname(h.uri.fsPath),'Stress.g.xlf'),text.replace('Customer 00001','OBSOLETE GENERATOR'));
        await h.send({type:'refresh'});
        stop=observeWorkers(event => {if(event.task==='sync' && event.event==='started') h.externalChange(text+'\n<!--new edit-->');});
        await h.send({type:'synchronizeFile'});
        assert.ok(h.document.getText().includes('<!--new edit-->'));
        assert.equal(h.document.getText().includes('OBSOLETE GENERATOR'),false);
        assert.equal(h.getErrors().length,0);
        assert.equal(h.last('syncBusy').busy,false);
    } finally {if(stop)stop();h.close();}
});

test('Dashboard large Sync runs in a worker and cancels safely when its open target changes', async () => {
    const {observeWorkers}=require('../src/xlfWorkerHost');
    const Module=require('node:module'), originalLoad=Module._load;
    const text=generateLargeXliff(1000,0);
    const h=await createEditorHarness({root:fs.mkdtempSync(path.join(os.tmpdir(),'xliff-dashboard-worker-')),text,configuration:{'performance.workerThreads.minUnits':1000}});
    let stop;
    try {
        fs.writeFileSync(path.join(path.dirname(h.uri.fsPath),'Stress.g.xlf'),text.replace('Customer 00001','DASHBOARD CHANGED'));
        h.vscode.workspace.findFiles=async()=>[h.uri];
        Module._load=function(request,parent,isMain){return request==='vscode'?h.vscode:originalLoad.call(this,request,parent,isMain);};
        delete require.cache[require.resolve('../src/dashboard')];
        const {TranslationDashboard}=require('../src/dashboard');
        const dashboard=Object.create(TranslationDashboard.prototype);
        dashboard.panel=h.panel;dashboard.refreshGeneration=0;dashboard.refresh=async()=>{};
        const events=[];
        stop=observeWorkers(event=>events.push(event));
        await dashboard.synchronizeAll();
        assert.ok(events.some(event=>event.task==='sync' && event.outcome==='completed'));
        assert.ok(h.document.getText().includes('DASHBOARD CHANGED'));
        stop();
        const edited=text+'\n<!--external edit-->';
        stop=observeWorkers(event=>{if(event.task==='sync' && event.event==='started') h.externalChange(edited);});
        await dashboard.synchronizeAll();
        assert.equal(h.document.getText(),edited);
        assert.equal(dashboard.syncController,undefined);
        assert.equal(h.popups.some(message=>/failed|sync errors/i.test(message)),false);
    } finally {if(stop)stop();Module._load=originalLoad;h.close();}
});

test('Try Translation sends each unresolved source once and persists its AI proposal on every matching unit', async () => {
    const {parseXliff,getStagedTranslation} = require('../src/xliff');
    const text = '<xliff><file source-language="en-US" target-language="de-DE"><body>' +
        ['Hello %1','Other','Hello %1'].map((source,i) => `<trans-unit id="${i}"><source>${source}</source><target/></trans-unit>`).join('') +
        '<trans-unit id="saved"><source>Hello %1</source><target state="translated">Bestehend %1</target></trans-unit></body></file></xliff>';
    const h = await createEditorHarness({root:fs.mkdtempSync(path.join(os.tmpdir(),'xliff-ai-dedup-')),text,configuration:{'ai.usage.enabled':false,'ai.batchSize':1}});
    try {
        const sent = [];
        h.vscode.lm = {async selectChatModels() {return [{id:'test-model',async sendRequest(messages) {
            const prompt=messages[0].value;
            const payload=JSON.parse(prompt.slice(prompt.indexOf('INPUT=')+6));
            sent.push(...payload.map(item => item.source));
            const output=payload.map(item => ({id:item.id,translation:item.source === 'Other' ? 'Anderes' : 'Hallo %1'}));
            return {text:(async function*(){yield JSON.stringify(output);})()};
        }}];}};
        h.vscode.LanguageModelChatMessage = {User:value => ({value})};
        h.vscode.window.showWarningMessage = async () => 'Use AI';
        await h.send({type:'ready'});
        await h.send({type:'tryFile'});
        assert.deepEqual(sent,['Hello %1','Other']);
        const units=parseXliff(h.document.getText()).units;
        assert.equal(getStagedTranslation(units[0]).text,'Hallo %1');
        assert.equal(getStagedTranslation(units[2]).text,'Hallo %1');
        assert.equal(getStagedTranslation(units[0]).kind,'proposal');
        assert.equal(units[3].target,'Bestehend %1');
        assert.equal(getStagedTranslation(units[3]),undefined);
        assert.equal(h.getErrors().length,0);
    } finally {h.close();}
});

function webviewContext(html) {
    const messages = [], states = [], elements = new Map(), windowEvents = {};
    const element = id => {
        if (elements.has(id)) return elements.get(id);
        const classes = new Set(id === 'qualityPanel' ? ['hidden'] : []);
        const result = {
            id, value: '', textContent: '', innerHTML: '', checked: false, disabled: false, scrollTop: 0,
            style: {}, dataset: {}, events: {},
            classList: { add: (...values) => values.forEach(value => classes.add(value)), remove: (...values) => values.forEach(value => classes.delete(value)), contains: value => classes.has(value), toggle(value, force) { const next = force === undefined ? !classes.has(value) : force; if (next) classes.add(value); else classes.delete(value); return next; } },
            addEventListener(name, callback) { this.events[name] = callback; },
            setAttribute() {}, querySelector() { return null; }, querySelectorAll() { return []; },
            click() { if (this.events.click) this.events.click({}); }, focus() {}, closest() { return null; },
            getBoundingClientRect() { return { top: 0, bottom: 100, height: 100 }; }
        };
        elements.set(id, result);
        return result;
    };
    const context = vm.createContext({
        acquireVsCodeApi: () => ({ getState: () => ({}), setState: state => states.push(state), postMessage: message => messages.push(message) }),
        document: { getElementById: element, body: element('body'), activeElement: null, querySelectorAll: () => [], addEventListener() {} },
        window: { addEventListener: (name, callback) => { windowEvents[name] = callback; } },
        performance, setTimeout, clearTimeout, requestAnimationFrame: () => 0, console
    });
    const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
    vm.runInContext(script, context);
    // Isolate Quality DOM behavior from the separately tested translation renderer.
    vm.runInContext("const realUpdateSummary = updateSummary; render = function() {}; updateSummary = function() {}; activeLoadId = 1; latestDocumentVersion = 1;", context);
    return { messages, states, element, context, receive: message => windowEvents.message({ data: message }) };
}

test('Developer Try drafts retain saved targets, show row actions and clear all counters before Save', async () => {
    const {parseXliff,getStagedTranslation} = require('../src/xliff');
    const text='<xliff><file source-language="en-US" target-language="de-DE"><body>'+[0,1].map(i => `<trans-unit id="${i}"><source>Hello ${i}</source><target/><note from="Developer">DEU=Hallo ${i}</note></trans-unit>`).join('')+'</body></file></xliff>';
    const h=await createEditorHarness({root:fs.mkdtempSync(path.join(os.tmpdir(),'xliff-developer-drafts-')),text,configuration:{'ai.enabled':false}});
    try {
        await h.send({type:'ready'});
        await h.send({type:'tryFile'});
        const ui=webviewContext(h.panel.webview.html);
        ui.receive(structuredClone(h.last('document')));
        ui.receive(h.last('stageTranslationDrafts'));
        const overrides=vm.runInContext('collectViewOverrides()',ui.context);
        const document=h.last('document');
        await h.send({type:'requestViewPage',requestId:100,loadId:document.loadId,documentVersion:document.documentVersion,view:{pageSize:50},overrides});
        const page=h.last('viewPage');
        assert.equal(page.rows[0].savedTranslation,'');
        ui.context.hostRow=structuredClone(page.rows[0]);
        vm.runInContext('copyIndexStateToFullRow(hostRow); pageRowCache.set(hostRow.ordinal,hostRow); setRowSummarySnapshot(hostRow);',ui.context);
        assert.equal(vm.runInContext('hostRow.translationDirty',ui.context),true);
        const html=vm.runInContext('rowHtml(hostRow)',ui.context);
        assert.match(html,/data-action="acceptTranslation"[^>]*class=""/);
        assert.match(html,/data-action="revertTranslation"[^>]*class=""/);
        assert.equal(vm.runInContext('draftCount()',ui.context),2);
        // Only ordinal 0 is cached: ordinal 1 must clear immediately too.
        await h.send({type:'saveManyDrafts',items:[{ordinal:0},{ordinal:1}]});
        ui.receive(h.last('draftsSaved'));
        vm.runInContext('realUpdateSummary()',ui.context);
        assert.equal(ui.element('saveDrafts').textContent,'✓ Apply Drafts');
        assert.equal(ui.element('saveDrafts').disabled,true);
        assert.equal(vm.runInContext('stagedCount()',ui.context),0);
        const units=parseXliff(h.document.getText()).units;
        assert.ok(units.every(unit => unit.targetState === 'translated' && !getStagedTranslation(unit)));
        assert.equal(h.document.isDirty,true);
        assert.equal(h.getErrors().length,0);
    } finally {h.close();}
});

test('row Try stages Developer text with a working discard action, including explicit equal-text drafts', async () => {
    const {parseXliff,getStagedTranslation}=require('../src/xliff');
    const text='<xliff><file source-language="en-US" target-language="de-DE"><body><trans-unit id="A"><source>Hello</source><target/><note from="Developer">DEU=Hallo</note></trans-unit></body></file></xliff>';
    const h=await createEditorHarness({root:fs.mkdtempSync(path.join(os.tmpdir(),'xliff-developer-row-')),text,configuration:{'ai.enabled':false}});
    try {
        await h.send({type:'ready'});
        const ui=webviewContext(h.panel.webview.html);
        ui.receive(structuredClone(h.last('document')));
        ui.context.row={ordinal:0,source:'Hello',translation:'',savedTranslation:'',rawState:'',glossaryTerms:[],qualityIssues:[],missing:true};
        vm.runInContext('prepareFullRowFromHost(row); pageRowCache.set(0,row); setRowSummarySnapshot(row);',ui.context);
        await h.send({type:'tryUnit',ordinal:0,id:'A',source:'Hello'});
        ui.receive(h.last('stageTranslationDrafts'));
        assert.equal(vm.runInContext('row.translationDirty',ui.context),true);
        assert.equal(vm.runInContext('draftCount()',ui.context),1);
        assert.match(vm.runInContext('rowHtml(row)',ui.context),/data-action="revertTranslation"[^>]*class=""/);
        vm.runInContext('revertRowDraft(row)',ui.context);
        assert.equal(vm.runInContext('draftCount()',ui.context),0);
        assert.equal(vm.runInContext('row.translation',ui.context),'');
        const clear=ui.messages.findLast(message => message.type === 'clearStaged');
        assert.ok(clear);
        await h.send(clear);
        assert.equal(getStagedTranslation(parseXliff(h.document.getText()).units[0]),undefined);
        assert.equal(vm.runInContext("prepareFullRowFromHost({ordinal:9,translation:'Hallo',translationDraft:'Hallo',hasTranslationDraft:true}).translationDirty",ui.context),true);
    } finally {h.close();}
});

test('No State uses saved targets, excludes applied rows and drives the host page filter', async () => {
    const h = await createEditorHarness({ root: fs.mkdtempSync(path.join(os.tmpdir(), 'xliff-no-state-')), text: generateLargeXliff(3, 0) });
    try {
        const ui = webviewContext(h.panel.webview.html);
        assert.ok(h.panel.webview.html.indexOf('id="qualityPanel"') < h.panel.webview.html.indexOf('class="filterbar"'));
        assert.equal(vm.runInContext("noStateAcceptable({ordinal:9,noStateAcceptable:true,rawState:'translated',translation:'Ziel'})", ui.context), false);
        assert.equal(vm.runInContext("noStateAcceptable({ordinal:9,rawState:'',savedTranslation:'',translation:'Draft'})", ui.context), false);
        ui.element('noStateOnly').checked = true;
        assert.equal(vm.runInContext('currentViewDefinition().quick.noState', ui.context), true);
        vm.runInContext('clearQuickFilters()', ui.context);
        assert.equal(ui.element('noStateOnly').checked, false);
        const rows = [
            {ordinal:0,source:'Source %1',translation:'Ziel %1',rawState:''},
            {ordinal:1,source:'Source',translation:'Draft',savedTranslation:'',translationDirty:true,rawState:''},
            {ordinal:2,source:'Source',translation:'Ziel',rawState:'translated'},
            {ordinal:3,source:'Source %1',translation:'Ziel %2',rawState:''}
        ];
        const page = h.editor.queryViewRows(rows, {view:{quick:{noState:true}}});
        assert.deepEqual(page.ordinals, [0]);
        const applied = h.editor.queryViewRows(rows, {view:{quick:{noState:true}},overrides:[{ordinal:0,rawState:'translated'}]});
        assert.equal(applied.filteredCount, 0);
        assert.equal(vm.runInContext("placeholderError('Line\\\\n %1','Zeile\\\\r %1')", ui.context), '');
    } finally { h.close(); }
});

test('dashboard Sync all updates an open translation using its matching generator', async () => {
    const text = '<xliff><file source-language="en-US" target-language="de-DE"><body><trans-unit id="A"><source>Old</source><target state="translated">Alt</target></trans-unit></body></file></xliff>';
    const h = await createEditorHarness({root:fs.mkdtempSync(path.join(os.tmpdir(), 'xliff-dashboard-sync-')),text});
    const Module = require('node:module'), originalLoad = Module._load;
    try {
        fs.writeFileSync(path.join(path.dirname(h.uri.fsPath), 'Stress.g.xlf'), text.replace('Old','New'));
        h.vscode.workspace.findFiles = async () => [h.uri];
        Module._load = function(request,parent,isMain) { return request === 'vscode' ? h.vscode : originalLoad.call(this,request,parent,isMain); };
        delete require.cache[require.resolve('../src/dashboard')];
        const {TranslationDashboard} = require('../src/dashboard');
        const dashboard = Object.create(TranslationDashboard.prototype);
        dashboard.panel = h.panel; dashboard.refreshGeneration = 0;
        let refreshed = false;
        dashboard.refresh = async () => { refreshed = true; };
        await dashboard.synchronizeAll();
        assert.match(h.document.getText(), /<source>New<\/source>/);
        assert.match(h.document.getText(), /state="needs-l10n"/);
        assert.equal(refreshed,true);
        assert.equal(h.popups.some(message => /failed|sync errors/i.test(message)), false);
    } finally { Module._load = originalLoad; h.close(); }
});

test('real Quality webview script requests pages, rejects stale responses and maps ignore actions to page references', async () => {
    const h = await createEditorHarness({ root: fs.mkdtempSync(path.join(os.tmpdir(), 'xliff-webview-')), text: generateLargeXliff(3, 0) });
    try {
        const ui = webviewContext(h.panel.webview.html);
        const metadata = { revision: 2, summary: { total: 2000, errors: 0, warnings: 2000, infos: 0 }, ignoredSummary: { total: 0 }, issueCount: 2000 };
        ui.receive({ type: 'qualityReport', loadId: 1, documentVersion: 1, report: metadata });
        const request = ui.messages.at(-1);
        assert.equal(request.type, 'requestQualityPage');
        assert.equal(request.pageSize, 100);
        const issue = { ordinal: 99, code: 'punctuation', source: 'Source.', target: 'Ziel', severity: 'warning', message: 'Missing punctuation' };
        const page = { type: 'qualityPage', revision: 2, loadId: 1, documentVersion: 1, requestId: request.requestId, view: 'active', page: 2, pageCount: 20, start: 100, end: 101, filteredCount: 2000, totalCount: 2000, items: [{ sourceIndex: 800, issue }] };
        ui.receive(page);
        assert.match(ui.element('qualityList').innerHTML, /data-quality-index="800"/);
        ui.element('qualityList').events.click({ target: { closest: () => ({ dataset: { qualityAction: 'ignore', qualityOrdinal: '99', qualityIndex: '800' } }) } });
        assert.equal(ui.messages.at(-1).type, 'setQualityIgnored');
        assert.equal(ui.messages.at(-1).issue, issue);
        assert.equal(ui.messages.at(-1).qualityRevision, 2);
        ui.element('qualityFilterError').checked = true;
        ui.element('qualityFilterError').events.change();
        const nextRequest = ui.messages.at(-1);
        assert.deepEqual(Array.from(nextRequest.severities), ['error']);
        ui.receive({ ...page, items: [{ sourceIndex: 9, issue: { ...issue, message: 'STALE PAGE' } }] });
        assert.doesNotMatch(ui.element('qualityList').innerHTML, /STALE PAGE/);
        ui.receive({ ...page, requestId: nextRequest.requestId, revision: 1 });
        assert.doesNotMatch(ui.element('qualityList').innerHTML, /STALE PAGE/);
        assert.equal(vm.runInContext('currentQualityReport.issues', ui.context), undefined);
        ui.receive({ type: 'qualityInvalidated' });
        assert.equal(vm.runInContext('currentQualityPage', ui.context), null);
    } finally { h.close(); }
});

test('host Quality protocol transfers metadata and bounded pages and refuses stale page/action requests', async () => {
    const h = await createEditorHarness({ root: fs.mkdtempSync(path.join(os.tmpdir(), 'xliff-protocol-')), text: generateLargeXliff(1000, 0) });
    try {
        await h.send({ type: 'ready' });
        const report = h.last('qualityReport');
        assert.ok(report.report.issueCount > 100);
        assert.equal(report.report.issues, undefined);
        await h.send({ type: 'requestQualityPage', requestId: 1, loadId: report.loadId, documentVersion: report.documentVersion, revision: report.report.revision, pageSize: 50, severities: ['warning'] });
        const page = h.last('qualityPage');
        assert.equal(page.items.length, 50);
        assert.ok(page.items.every(item => item.issue.severity === 'warning'));
        const version = h.document.version, start = h.messages.length;
        await h.send({ type: 'requestQualityPage', requestId: 2, loadId: report.loadId, documentVersion: report.documentVersion, revision: -1 });
        await h.send({ type: 'setQualityIgnored', ordinal: page.items[0].issue.ordinal, issue: page.items[0].issue, ignored: true, qualityRevision: -1, documentVersion: report.documentVersion });
        assert.equal(h.document.version, version);
        assert.equal(h.messages.slice(start).filter(message => message.type === 'qualityPage').length, 0);
        assert.equal(h.getErrors().length, 0);
    } finally { h.close(); }
});

test('Save without content changes reuses the valid Quality cache instead of scanning again', async () => {
    const h = await createEditorHarness({ root: fs.mkdtempSync(path.join(os.tmpdir(), 'xliff-save-cache-')), text: generateLargeXliff(1000, 0) });
    try {
        await h.send({ type: 'ready' });
        const session = getExistingDocumentSession(h.uri);
        const cached = session.quality;
        assert.ok(cached);
        const start = h.messages.length;
        await h.send({ type: 'saveDocument', items: [] });
        await h.waitFor(message => message.type === 'qualityReport', start);
        assert.equal(getExistingDocumentSession(h.uri).quality, cached);
        assert.equal(h.getErrors().length, 0);
    } finally { h.close(); }
});

test('No State bulk action immediately updates the counter and the host filter without Save', async () => {
 const text='<xliff><file source-language="en-US" target-language="de-DE"><body><trans-unit id="A"><source>Hello</source><target>Hallo</target></trans-unit></body></file></xliff>';
 const h=await createEditorHarness({root:fs.mkdtempSync(path.join(os.tmpdir(),'xliff-no-state-count-')),text});
 try {
  h.vscode.window.showWarningMessage=async()=> 'Set to translated';
  await h.send({type:'ready'});
  const ui=webviewContext(h.panel.webview.html);ui.receive(structuredClone(h.last('document')));
  await h.send({type:'acceptAllNoState',targetLanguage:'de-DE'});
  const accepted=h.last('allNoStateAccepted');assert.equal(accepted.items.length,1);
  ui.receive(accepted);vm.runInContext('realUpdateSummary()',ui.context);
  assert.equal(vm.runInContext('model.stats.noState',ui.context),0);
  assert.equal(ui.element('acceptAllNoState').disabled,true);
  assert.equal(ui.element('acceptAllNoState').textContent.includes('(1)'),false);
  await h.send({type:'requestViewPage',loadId:h.last('document').loadId,requestId:900,view:{quick:{noState:true}}});
  assert.equal(h.last('viewPage').filteredCount,0);
 } finally {h.close();}
});

test('Dashboard refresh scans files without accessing Sync-only cancellation variables', async () => {
 const h=await createEditorHarness({root:fs.mkdtempSync(path.join(os.tmpdir(),'xliff-dashboard-refresh-')),text:generateLargeXliff(1,0)});
 const Module=require('node:module'), original=Module._load;
 try {
  h.vscode.workspace.findFiles=async()=>[h.uri];
  Module._load=function(request,parent,isMain){return request==='vscode'?h.vscode:original.call(this,request,parent,isMain);};
  delete require.cache[require.resolve('../src/dashboard')];
  const {TranslationDashboard}=require('../src/dashboard');
  const dashboard=Object.create(TranslationDashboard.prototype);dashboard.panel=h.panel;dashboard.refreshGeneration=0;
  dashboard.scanFile=async()=>({kind:'file',uri:h.uri.toString(),metrics:{total:1,translated:1}});
  await dashboard.refresh();assert.equal(dashboard.files.length,1);
 } finally {Module._load=original;h.close();}
});

test('Quality invalidation keeps the existing list visible and rejects actions until its replacement arrives', async () => {
 const h=await createEditorHarness({root:fs.mkdtempSync(path.join(os.tmpdir(),'xliff-quality-stable-')),text:generateLargeXliff(1,0)});
 try {
  const ui=webviewContext(h.panel.webview.html);
  vm.runInContext('currentQualityPage={view:"active",items:[]};currentQualityReport={revision:1};qualityReportAvailable=true;',ui.context);
  ui.element('qualityList').innerHTML='<div>Existing finding</div>';
  ui.receive({type:'qualityInvalidated'});
  assert.equal(ui.element('qualityList').innerHTML,'<div>Existing finding</div>');
  assert.equal(vm.runInContext('currentQualityPage',ui.context),null);
  assert.equal(vm.runInContext('currentQualityReport',ui.context),null);
 } finally {h.close();}
});

test('Quality page refresh preserves scroll while deliberate page changes reset it', async () => {
 const h=await createEditorHarness({root:fs.mkdtempSync(path.join(os.tmpdir(),'xliff-quality-scroll-')),text:generateLargeXliff(1,0)});
 try {
  const ui=webviewContext(h.panel.webview.html);
  vm.runInContext('currentQualityReport={summary:{total:2}};paintQualityPage({page:1,pageCount:2,totalCount:2,filteredCount:2,items:[]});',ui.context);
  ui.element('qualityList').scrollTop=175;
  ui.receive({type:'qualityInvalidated'});
  vm.runInContext('currentQualityReport={summary:{total:1}};paintQualityPage({page:1,pageCount:2,totalCount:1,filteredCount:1,items:[]});',ui.context);
  assert.equal(ui.element('qualityList').scrollTop,175);
  vm.runInContext('paintQualityPage({page:2,pageCount:2,totalCount:1,filteredCount:1,items:[]});',ui.context);
  assert.equal(ui.element('qualityList').scrollTop,0);
 } finally {h.close();}
});

test('Developer transfer button stages exact note text and preserves proposal, Apply and Undo behavior', async () => {
 const text='<xliff><file source-language="en-US" target-language="de-DE"><body><trans-unit id="A"><source>Customer</source><target state="translated">Debitor</target><note from="Developer">DEU= Kunde </note></trans-unit></body></file></xliff>';
 const h=await createEditorHarness({root:fs.mkdtempSync(path.join(os.tmpdir(),'xliff-developer-button-')),text});
 try {
  await h.send({type:'ready'});
  await h.send({type:'requestViewPage',loadId:h.last('document').loadId,requestId:10,view:{}});
  const row=h.last('viewPage').rows[0];assert.equal(row.developerTranslation,' Kunde ');
  const ui=webviewContext(h.panel.webview.html);ui.receive(structuredClone(h.last('document')));
  ui.context.hostRow=structuredClone(row);
  vm.runInContext('prepareFullRowFromHost(hostRow);pageRowCache.set(0,hostRow);setRowSummarySnapshot(hostRow);hostRow.proposal="Other proposal";',ui.context);
  const html=vm.runInContext('rowHtml(hostRow)',ui.context);
  assert.ok(html.indexOf('data-action="accept"')<html.indexOf('data-action="useDeveloperTranslation"'));
  vm.runInContext('useDeveloperTranslation(hostRow);realUpdateSummary();',ui.context);
  assert.equal(vm.runInContext('hostRow.translation',ui.context),' Kunde ');
  assert.equal(vm.runInContext('hostRow.proposal',ui.context),'Other proposal');
  assert.equal(vm.runInContext('hostRow.translationDirty',ui.context),true);
  assert.equal(vm.runInContext('developerTranslationDiffers(hostRow)',ui.context),false);
  assert.equal(vm.runInContext('draftCount()',ui.context),1);
  const staged=ui.messages.findLast(m=>m.type==='translationDraftChanged');assert.equal(staged.text,' Kunde ');
  await h.send(staged);assert.equal(h.document.getText(),text);
  await h.send({type:'saveManyDrafts',items:[{ordinal:0,translation:staged.text,provenance:staged.provenance,origin:staged.origin}]});
  const {parseXliff}=require('../src/xliff');assert.equal(parseXliff(h.document.getText()).units[0].target,' Kunde ');
  assert.equal(h.last('draftsSaved').items[0].canUndoApply,true);
  vm.runInContext('hostRow.developerTranslation=undefined;',ui.context);assert.equal(vm.runInContext('developerTranslationDiffers(hostRow)',ui.context),false);
  vm.runInContext('hostRow.developerTranslation="New";model.readOnly=true;useDeveloperTranslation(hostRow);',ui.context);
  assert.equal(vm.runInContext('hostRow.translation',ui.context),' Kunde ');
 } finally {h.close();}
});

test('Editor and Apply allow repeated source placeholders once and in any target order', async () => {
 const text='<xliff><file source-language="en-US" target-language="de-DE"><body><trans-unit id="A"><source>%1 %1 %2 %3 %4</source><target state="translated">%1 %1 %2 %3 %4</target></trans-unit></body></file></xliff>';
 const h=await createEditorHarness({root:fs.mkdtempSync(path.join(os.tmpdir(),'xliff-placeholder-set-')),text});
 try {
  await h.send({type:'ready'});const ui=webviewContext(h.panel.webview.html);
  assert.equal(vm.runInContext('placeholderError("%1 %1 %2 %3 %4","%4 %2 %1 %3")',ui.context),'');
  assert.notEqual(vm.runInContext('placeholderError("%1","%10")',ui.context),'');
  await h.send({type:'saveManyDrafts',items:[{ordinal:0,translation:'%4 %2 %1 %3'}]});
  assert.equal(h.last('draftsSaved').items.length,1);
  assert.ok(h.document.getText().includes('%4 %2 %1 %3'));
 } finally {h.close();}
});

test('Editor Sync is enabled only for refreshed out-of-sync saved documents', async () => {
 const text='<xliff><file source-language="en-US" target-language="de-DE"><body><trans-unit id="A"><source>Old</source><target state="translated">Alt</target></trans-unit></body></file></xliff>';
 const h=await createEditorHarness({root:fs.mkdtempSync(path.join(os.tmpdir(),'xliff-sync-gating-')),text});
 try {
  await h.send({type:'ready'});assert.equal(h.last('syncStatus').status,'missing-generator');
  fs.writeFileSync(path.join(path.dirname(h.uri.fsPath),'Stress.g.xlf'),text.replace('Old','New'));
  await h.send({type:'refresh'});assert.equal(h.last('syncStatus').status,'out-of-sync');
  const ui=webviewContext(h.panel.webview.html);ui.receive(structuredClone(h.last('document')));ui.receive(h.last('syncStatus'));
  vm.runInContext('realUpdateSummary()',ui.context);assert.equal(ui.element('sync').disabled,false);
  vm.runInContext('model.dirty=true;realUpdateSummary();',ui.context);assert.equal(ui.element('sync').disabled,true);
  vm.runInContext('model.dirty=false;dirtyOrdinals.add(0);realUpdateSummary();',ui.context);assert.equal(ui.element('sync').disabled,true);
  vm.runInContext('dirtyOrdinals.clear();model.syncStatus="synced";realUpdateSummary();',ui.context);assert.equal(ui.element('sync').disabled,true);
  h.externalChange(text+'<!--unsaved-->');
  const edited=h.document.getText();await h.send({type:'synchronizeFile'});assert.equal(h.document.getText(),edited);
 } finally {h.close();}
});

test('Quality sort selection changes the host query, resets page and preserves selection across refreshes', async () => {
 const h=await createEditorHarness({root:fs.mkdtempSync(path.join(os.tmpdir(),'xliff-quality-sort-')),text:generateLargeXliff(3,0)});
 try {
  const ui=webviewContext(h.panel.webview.html);
  vm.runInContext('currentQualityReport={revision:7,documentVersion:1};qualityPage=4;',ui.context);
  ui.element('qualitySort').value='severity';ui.element('qualitySortDirection').value='asc';
  ui.element('qualitySort').events.change();
  const request=ui.messages.findLast(m=>m.type==='requestQualityPage');
  assert.equal(request.sortColumn,'severity');assert.equal(request.sortDirection,'asc');assert.equal(request.page,1);
  assert.equal(ui.states.at(-1).qualitySortColumn,'severity');
  ui.element('qualitySortDirection').value='desc';ui.element('qualitySortDirection').events.change();
  assert.equal(ui.messages.findLast(m=>m.type==='requestQualityPage').sortDirection,'desc');
  vm.runInContext('requestQualityPage()',ui.context);
  assert.equal(ui.messages.findLast(m=>m.type==='requestQualityPage').sortColumn,'severity');
 } finally {h.close();}
});
