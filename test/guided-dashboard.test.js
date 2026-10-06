'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { parseXliff } = require('../src/xliff');
const { synchronizeTranslationUnits } = require('../src/synchronize');

function load(name, stubs) {
    const filename = path.join(__dirname, '../src', name + '.js');
    const nativeRequire = createRequire(filename);
    const module = { exports: {} };
    new Function('require', 'module', 'exports', fs.readFileSync(filename, 'utf8'))(
        id => Object.hasOwn(stubs, id) ? stubs[id] : nativeRequire(id), module, module.exports);
    return module.exports;
}

function harness() {
    const files = new Map(), writes = [], opened = [], panels = [], messages = [], popups = [];
    const project = { root: undefined };
    const changeListeners = new Set(), saveListeners = new Set();
    const uri = value => ({ fsPath: value, toString: () => value });
    const subscribe = listener => { changeListeners.add(listener); return { dispose: () => changeListeners.delete(listener) }; };
    const config = { get: (key, fallback) => fallback };
    const makePanel = () => {
        const panel = { visible: true, reveal() {}, onDidDispose(fn) { this.disposeHandler = fn; }, webview: {
            cspSource: 'test', html: '', postMessage: async message => { messages.push(message); },
            onDidReceiveMessage(fn) { panel.receive = fn; }
        } };
        panels.push(panel); return panel;
    };
    const vscode = {
        Uri: { parse: uri, file: uri, joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)) },
        RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
        ViewColumn: { One: 1 },
        workspace: {
            textDocuments: [], getConfiguration: () => config,
            onDidSaveTextDocument: fn => { saveListeners.add(fn); return { dispose: () => saveListeners.delete(fn) }; },
            onDidChangeTextDocument: subscribe, onDidCloseTextDocument: () => ({ dispose() {} }),
            getWorkspaceFolder: () => undefined,
            findFiles: async () => [],
            fs: {
                stat: async selected => { if (!files.has(selected.toString())) throw Object.assign(new Error('Missing'), { code: 'ENOENT' }); },
                readFile: async selected => { if (!files.has(selected.toString())) throw Object.assign(new Error('Missing'), { code: 'ENOENT' }); return Buffer.from(files.get(selected.toString())); },
                createDirectory: async () => {},
                writeFile: async (selected, bytes) => { files.set(selected.toString(), bytes.toString()); writes.push(selected.toString()); }
            }
        },
        window: { createWebviewPanel: makePanel, showInformationMessage(message) { popups.push(message); } }
    };
    const editor = {
        XliffEditorProvider: { openWithFilter: async (selected, filter) => opened.push({ uri: selected.toString(), filter }) },
        getMapUriForXlf: async (selected, language) => uri(path.join(path.dirname(selected.fsPath), language + '.lng')),
        mergeTranslationMemorySnapshots: () => ({ entries: [] }),
        mergeTranslationMemoryFromXliffTexts: () => ({ entries: [] })
    };
    const icons = load('webviewIcons', { vscode });
    const html = load('guidedTranslationHtml', { './webviewIcons': icons });
    const guided = load('guidedTranslation', { vscode, './xlfEditor': editor, './guidedTranslationHtml': html });
    const worker = {
        parseXliffAdaptive: async text => ({ parsed: parseXliff(text) }),
        synchronizeXliffAdaptive: async (target, generator) => synchronizeTranslationUnits(target, generator),
        isWorkerCancellation: () => false
    };
    const dashboard = load('dashboard', {
        vscode, './xlfEditor': editor, './guidedTranslation': guided, './xlfWorkerHost': worker, './webviewIcons': icons,
        './glossaryEditor': { readProjectGlossary: async () => ({ entries: [] }) },
        './qualityCoordinator': { analyzeQualityForText: async () => ({ fingerprint: 'test', report: { summary: {} } }) },
        './studioPaths': { findProjectRoot: async () => project.root, workspaceFileExists: async selected => files.has(selected.toString()) }
    });
    return { ...dashboard, ...guided, files, writes, opened, panels, messages, popups, project, vscode, uri, worker, makePanel, changeListeners, saveListeners };
}

test('saving a known wizard language refreshes only its row even while dashboard is hidden', () => {
    const h=harness(), panel=h.makePanel();panel.visible=false;
    const dashboard=new h.TranslationDashboard(panel,{extensionUri:h.uri('root')});
    dashboard.files=[row('de.xlf','de-DE'),row('fr.xlf','fr-FR')];
    const refreshed=[];dashboard.refreshFile=async uri=>refreshed.push(uri.toString());
    for(const fn of h.saveListeners)fn({uri:h.uri('de.xlf')});
    for(const fn of h.saveListeners)fn({uri:h.uri('unrelated.xlf')});
    assert.deepEqual(refreshed,['de.xlf']);
    panel.disposeHandler();
});

function row(uri, language, status = 'synced') {
    return { kind: 'file', uri, fileName: 'App.' + language + '.xlf', relativePath: 'Translations/App.' + language + '.xlf', targetLanguage: language, sourceLanguage: 'en-US', syncStatus: status, metrics: { total: 10, translated: 8, missing: 1, review: 1, qualityIssues: 2 } };
}

function webview(html) {
    const elements = new Map(), listeners = {}, sent = [];
    const element = () => ({ value: '', style: {}, dataset: {}, classList: { add() {}, remove() {} }, addEventListener(type, fn) { this[type] = fn; }, querySelectorAll: () => [] });
    const context = vm.createContext({ document: { getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); } }, window: { addEventListener(type, fn) { listeners[type] = fn; } }, acquireVsCodeApi: () => ({ postMessage: message => sent.push(message) }) });
    vm.runInContext(html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1], context);
    return { context, elements, listeners, sent };
}

test('dashboard renders scoped actions for synced, unsynced and missing locales', () => {
    const h = harness();
    const dashboard = Object.create(h.TranslationDashboard.prototype);
    const page = webview(dashboard.getHtml({ cspSource: 'test' }));
    page.context.file = row('file:///de.xlf', 'de-DE');
    let html = vm.runInContext('fileRow(file)', page.context);
    assert.match(html, /data-wizard="file:\/\/\/de.xlf"/);
    assert.match(html, /XLIFF Editor/);
    assert.doesNotMatch(html, /data-sync=/);
    page.context.file.syncStatus = 'out-of-sync';
    html = vm.runInContext('fileRow(file)', page.context);
    assert.match(html, /data-sync="file:\/\/\/de.xlf"/);
    assert.match(html, /aria-label="Synchronize de-DE"/);
    page.context.file = { kind: 'missing-locale', targetLanguage: 'fr-FR', generateAvailable: true, generatorUri: 'generator', syncStatus: 'missing-file' };
    html = vm.runInContext('fileRow(file)', page.context);
    assert.match(html, /data-generate="1"/);
    assert.doesNotMatch(html, /data-wizard|data-sync|data-open/);
});

test('incremental dashboard messages preserve filter, other language and locale totals', () => {
    const h = harness();
    const page = webview(h.TranslationDashboard.prototype.getHtml({ cspSource: 'test' }));
    const de = row('de', 'de-DE', 'out-of-sync'), fr = row('fr', 'fr-FR');
    page.listeners.message({ data: { type: 'dashboard', files: [de, fr], summary: { languages: 3, missingXliffFiles: 1 } } });
    page.elements.get('search').value = 'de-DE';
    page.listeners.message({ data: { type: 'dashboardFile', file: { ...de, syncStatus: 'synced' }, summary: { languages: 2, total: 20 } } });
    assert.equal(page.elements.get('search').value, 'de-DE');
    assert.equal(vm.runInContext('model.files[1].uri', page.context), 'fr');
    assert.equal(vm.runInContext('model.files[0].syncStatus', page.context), 'synced');
    assert.equal(vm.runInContext('model.summary.languages', page.context), 3);
    assert.equal(vm.runInContext('model.summary.missingXliffFiles', page.context), 1);
});

test('row sync writes only selected XLIFF and its companion memory; no full refresh or popup', async () => {
    const h = harness();
    const directory = path.resolve('test-project/Translations');
    const de = h.uri(path.join(directory, 'App.de-DE.xlf')), fr = h.uri(path.join(directory, 'App.fr-FR.xlf')), generator = h.uri(path.join(directory, 'App.g.xlf'));
    const text = language => `<xliff><file source-language="en-US" target-language="${language}"><body><trans-unit id="A"><source>Old</source><target state="translated">Target</target></trans-unit></body></file></xliff>`;
    h.files.set(de.toString(), text('de-DE')); h.files.set(fr.toString(), text('fr-FR'));
    h.files.set(generator.toString(), '<xliff><file source-language="en-US"><body><trans-unit id="A"><source>New</source></trans-unit></body></file></xliff>');
    const dashboard = new h.TranslationDashboard(h.makePanel(), {});
    dashboard.files = [row(de.toString(), 'de-DE', 'out-of-sync'), row(fr.toString(), 'fr-FR', 'out-of-sync')];
    dashboard.refresh = () => { throw new Error('Unexpected full refresh'); };
    dashboard.scanFile = async selected => row(selected.toString(), 'de-DE', 'synced');
    await dashboard.synchronizeFile(de);
    assert.match(h.files.get(de.toString()), /<source>New<\/source>/);
    assert.equal(h.files.get(fr.toString()), text('fr-FR'));
    assert.ok(h.writes.every(item => item === de.toString() || item === path.join(directory, 'de-DE.lng')));
    assert.equal(h.messages.filter(message => message.type === 'dashboardFile').length, 1);
    assert.equal(h.messages.some(message => message.type === 'loading' || message.type === 'dashboard'), false);
    assert.equal(h.changeListeners.size, 0);
    assert.equal(dashboard.rowSyncs.size, 0);
    assert.deepEqual(h.popups, []);
});

test('simultaneous refreshes of separate rows both publish their updates', async () => {
    const h = harness();
    const dashboard = new h.TranslationDashboard(h.makePanel(), {});
    dashboard.files = [row('de', 'de-DE'), row('fr', 'fr-FR')];
    const resolvers = {};
    dashboard.scanFile = selected => new Promise(resolve => { resolvers[selected.toString()] = resolve; });
    const first = dashboard.refreshFile(h.uri('de')), second = dashboard.refreshFile(h.uri('fr'));
    resolvers.fr(row('fr', 'fr-FR')); await second;
    resolvers.de(row('de', 'de-DE')); await first;
    assert.deepEqual(h.messages.filter(message => message.type === 'dashboardFile').map(message => message.file.uri).sort(), ['de', 'fr']);
});

test('sync refuses stale worker results and releases listeners', async () => {
    const h = harness();
    const target = h.uri(path.resolve('App.de-DE.xlf')), generator = h.uri(path.resolve('App.g.xlf'));
    const before = '<xliff><file source-language="en-US" target-language="de-DE"><body><trans-unit id="A"><source>A</source></trans-unit></body></file></xliff>';
    h.files.set(target.toString(), before); h.files.set(generator.toString(), before);
    let release;
    // The worker method is destructured at module load; changing the file during the first read
    // emulates an external editor change while parsing is in flight.
    const originalRead = h.vscode.workspace.fs.readFile;
    h.vscode.workspace.fs.readFile = async selected => {
        const bytes = await originalRead(selected);
        if (!release && selected.toString() === target.toString()) {
            release = true;
            h.files.set(target.toString(), before + '\n<!-- external edit -->');
        }
        return bytes;
    };
    await assert.rejects(h.synchronizeTranslationFile(target), /changed/);
    assert.equal(h.writes.length, 0);
    assert.equal(h.changeListeners.size, 0);
});

test('wizard uses selected file and host services, validates workflows and reuses its view', async () => {
    const h = harness();
    const selected = h.uri('de'), scanned = [], synced = [];
    let file = row('de', 'de-DE', 'out-of-sync');
    const started = [];
    const services = { scan: async uri => { scanned.push(uri.toString()); return file; }, sync: async uri => { synced.push(uri.toString()); file = { ...file, syncStatus: 'synced' }; }, createSession: async () => ({ drafts: new Map(), start: async workflow => started.push(workflow), dispose() {}, publish() {} }) };
    const [wizard, repeated] = await Promise.all([h.GuidedTranslationView.open(selected, services), h.GuidedTranslationView.open(selected, services)]);
    assert.equal(wizard, repeated);
    assert.doesNotThrow(() => new Function(wizard.getHtml().match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1]));
    await wizard.handleMessage({ type: 'ready' });
    const state = h.messages.find(message => message.type === 'state');
    assert.equal(state.file.targetLanguage, 'de-DE');
    assert.equal(state.workflows.length, 5);
    await wizard.handleMessage({ type: 'selectWorkflow', workflow: 'translate-missing' });
    await wizard.handleMessage({ type: 'openEditor' });
    assert.deepEqual(h.opened, [{ uri: 'de', filter: 'all' }]);
    assert.deepEqual(started, ['translate-missing']);
    await wizard.handleMessage({ type: 'selectWorkflow', workflow: 'sync-project' });
    await wizard.handleMessage({ type: 'selectWorkflow', workflow: 'sync-project' });
    await wizard.handleMessage({ type: 'selectWorkflow', workflow: '__proto__' });
    assert.deepEqual(synced, ['de']);
    assert.ok(scanned.every(value => value === 'de'));
    assert.equal(await h.GuidedTranslationView.open(selected, services), wizard);
    assert.equal(h.panels.length, 1);
    h.panels[0].disposeHandler();
    assert.equal(h.GuidedTranslationView.views.size, 0);
});

test('completed XLIFF disables missing, review, quality and sync workflows', () => {
    const h = harness();
    const workflows = h.workflowsFor({ syncStatus: 'synced', metrics: { total: 1, missing: 0, review: 0, qualityIssues: 0 } });
    for (const id of ['new-language', 'translate-missing', 'review', 'quality-fix', 'sync-project']) assert.equal(workflows.find(item => item.id === id).enabled, false);
    assert.equal(h.workflowsFor({ metrics: { total: 10, review: 1 } }).find(item => item.id === 'review').enabled, true);
    assert.equal(h.workflowsFor({ metrics: { total: 10 } }).find(item => item.id === 'review').enabled, false);
});

test('new language preparation syncs only selected file, imports explicitly and continues in the same view', async () => {
    const h = harness(), calls = [];
    let file = row('de-prep', 'de-DE', 'out-of-sync');
    const wizard = await h.GuidedTranslationView.open(h.uri('de-prep'), {
        scan: async () => file,
        sync: async uri => { calls.push(uri.toString()); file = { ...file, syncStatus: 'synced' }; },
        createSession: async () => ({ drafts: new Map(), importLocal: async () => calls.push('import'), start: async workflow => calls.push(workflow), dispose() {}, publish() {} })
    });
    await wizard.handleMessage({ type: 'selectWorkflow', workflow: 'new-language' });
    assert.equal(calls.length, 0);
    assert.ok(h.messages.some(message => message.type === 'preparation'));
    await wizard.handleMessage({ type: 'prepareLanguage', action: 'sync' });
    await wizard.handleMessage({ type: 'prepareLanguage', action: 'sync' });
    await wizard.handleMessage({ type: 'prepareLanguage', action: 'import' });
    await wizard.handleMessage({ type: 'prepareLanguage', action: 'continue' });
    assert.deepEqual(calls, ['de-prep', 'import', 'new-language']);
    h.panels[0].disposeHandler();
});

test('dashboard routes Wizard and Expert Editor to the requested language and rejects unknown sync rows', async () => {
    const h = harness();
    const panel = h.makePanel();
    const dashboard = new h.TranslationDashboard(panel, {});
    dashboard.files = [row('de', 'de-DE'), row('fr', 'fr-FR')];
    const wizardUris = [];
    dashboard.openWizard = async selected => wizardUris.push(selected.toString());
    await panel.receive({ type: 'openWizard', uri: 'fr' });
    await panel.receive({ type: 'openFile', uri: 'de', filter: 'all' });
    await panel.receive({ type: 'openWizard', uri: 'unknown' });
    await panel.receive({ type: 'syncFile', uri: 'unknown' });
    assert.deepEqual(wizardUris, ['fr']);
    assert.deepEqual(h.opened, [{ uri: 'de', filter: 'all' }]);
    assert.equal(h.writes.length, 0);
    assert.equal(h.messages.at(-1).busy, false);
});

test('app.json locale creation still creates only missing translation and does not overwrite it', async () => {
    const h = harness();
    h.project.root = h.uri(path.resolve('create-project'));
    const generator = h.uri(path.join(h.project.root.fsPath, 'Translations', 'App.g.xlf'));
    const target = path.join(h.project.root.fsPath, 'Translations', 'App.fr-FR.xlf');
    h.files.set(path.join(h.project.root.fsPath, 'app.json'), JSON.stringify({ supportedLocales: ['fr-FR', 'en-US'] }));
    h.files.set(generator.toString(), '<xliff><file source-language="en-US"><body><trans-unit id="A"><source>Hello</source></trans-unit></body></file></xliff>');
    const dashboard = new h.TranslationDashboard(h.makePanel(), {});
    let refreshed = 0;
    dashboard.refresh = async () => { refreshed++; };
    const message = { targetLanguage: 'fr-FR', generatorUri: generator.toString() };
    await dashboard.generateSupportedLocale(message);
    assert.equal(parseXliff(h.files.get(target)).targetLanguage, 'fr-FR');
    assert.equal(parseXliff(h.files.get(target)).units[0].target, '');
    assert.deepEqual(h.writes, [target]);
    await dashboard.generateSupportedLocale(message);
    assert.deepEqual(h.writes, [target]);
    assert.equal(refreshed, 2);
});

test('busy status affects only selected row and duplicate row clicks are suppressed', () => {
    const h = harness();
    const page = webview(h.TranslationDashboard.prototype.getHtml({ cspSource: 'test' }));
    page.context.de = row('de', 'de-DE', 'out-of-sync');
    page.context.fr = row('fr', 'fr-FR', 'out-of-sync');
    const event = { target: { closest: selector => selector === '[data-sync]' ? { dataset: { sync: 'de' } } : null } };
    page.elements.get('rows').click(event);
    page.elements.get('rows').click(event);
    assert.equal(page.sent.filter(message => message.type === 'syncFile').length, 1);
    assert.match(vm.runInContext('rowSync(de)', page.context), /disabled aria-busy="true"/);
    assert.doesNotMatch(vm.runInContext('rowSync(fr)', page.context), /disabled/);
});

test('table headers and each supported row type retain the same column count', () => {
    const h = harness();
    const html = h.TranslationDashboard.prototype.getHtml({ cspSource: 'test' });
    const page = webview(html);
    const columns = (html.match(/<th[ >]/g) || []).length;
    for (const file of [row('de', 'de-DE'), { kind: 'missing-locale', targetLanguage: 'fr-FR', syncStatus: 'missing-file' }]) {
        page.context.file = file;
        assert.equal((vm.runInContext('fileRow(file)', page.context).match(/<td[ >]/g) || []).length, columns);
    }
});
