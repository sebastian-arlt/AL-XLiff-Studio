'use strict';

const vscode = require('vscode');
const { setTabIcon } = require('./tabIcons');
const { XliffEditorProvider } = require('./xlfEditor');
const { guidedTranslationHtml } = require('./guidedTranslationHtml');
const { GuidedWorkflowSession } = require('./guidedWorkflowSession');

/** @typedef {'new-language'|'translate-missing'|'review'|'quality-fix'|'sync-project'} WorkflowType */
/** @typedef {{type:'ready'}|{type:'selectWorkflow', workflow:WorkflowType}|{type:'openEditor',text?:string,revision?:number}|{type:'backToSelection',text?:string,revision?:number}|{type:'followup',workflow:'translate-missing'|'review'|'quality-fix'|'skipped'}|{type:'prepareLanguage',action:'sync'|'import'|'continue'}|{type:'guidedAction',action:import('./guidedWorkflowSession').GuidedAction,revision:number,text?:string}} GuidedMessage */

function workflowsFor(file) {
    const m = file.metrics || {};
    const usable = !file.error;
    return [
        { id: 'new-language', title: 'Neue Sprache übersetzen', description: 'Sync prüfen, lokale Übersetzungen vorbereiten und Einträge durchgehen.', enabled: usable && m.missing > 0, filter: 'missing' },
        { id: 'translate-missing', title: 'Fehlende Übersetzungen ergänzen', description: `${m.missing || 0} fehlende Übersetzungen`, enabled: usable && m.missing > 0, filter: 'missing' },
        { id: 'review', title: 'Übersetzungen überprüfen', description: `${m.review || 0} Einträge zur Prüfung; Entwürfe und Vorschläge einzeln prüfen.`, enabled: usable && m.review > 0, filter: 'review' },
        { id: 'quality-fix', title: 'Qualitätsprobleme beheben', description: `${m.qualityIssues || 0} Qualitätsprobleme`, enabled: usable && m.qualityIssues > 0, filter: 'quality' },
        { id: 'sync-project', title: 'Projekt synchronisieren', description: 'In diesem Einstieg wird ausschließlich die ausgewählte XLIFF synchronisiert.', enabled: usable && file.syncStatus === 'out-of-sync' }
    ];
}

class GuidedTranslationView {
    static views = new Map();
    static opening = new Map();

    static async open(uri, services) {
        const key = uri.toString();
        if (this.opening.has(key)) return this.opening.get(key);
        const pending = this.openView(uri, services);
        this.opening.set(key, pending);
        try { return await pending; }
        finally { this.opening.delete(key); }
    }

    static async openView(uri, services) {
        const key = uri.toString();
        const existing = this.views.get(key);
        if (existing) {
            existing.panel.reveal();
            await existing.refresh();
            return existing;
        }
        const file = await services.scan(uri);
        const panel = vscode.window.createWebviewPanel('alXliffStudio.guidedTranslation', `Wizard · ${file.targetLanguage}`, vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true });
        const view = new GuidedTranslationView(panel, uri, services, file);
        this.views.set(key, view);
        return view;
    }

    constructor(panel, uri, services, file) {
        setTabIcon(panel, services.extensionUri, vscode, 'wizard');
        this.panel = panel;
        this.uri = uri;
        this.services = services;
        this.file = file;
        this.busy = false;
        this.disposables = [];
        panel.webview.html = this.getHtml();
        panel.onDidDispose(() => {
            this.disposed = true;
            if (this.session) this.session.dispose();
            GuidedTranslationView.views.delete(uri.toString());
            for (const disposable of this.disposables) disposable.dispose();
        }, null, this.disposables);
        panel.webview.onDidReceiveMessage(message => this.handleMessage(message), null, this.disposables);
    }

    async refresh() {
        this.file = await this.services.scan(this.uri);
        if (!this.disposed) await this.panel.webview.postMessage({ type: 'state', file: this.file, workflows: workflowsFor(this.file) });
    }

    /** @param {GuidedMessage} message */
    async handleMessage(message) {
        if (!message || this.disposed || this.busy) return;
        this.busy = true;
        try {
            if (message.type === 'ready') {
                this.ready = true;
                if (this.preparing) await this.showPreparation();
                else { await this.refresh(); if (this.session) this.session.publish(); }
                if (this.pendingWorkflow) { const workflow = this.pendingWorkflow; this.pendingWorkflow = undefined; this.busy = false; await this.handleMessage({ type: 'selectWorkflow', workflow }); }
                return;
            }
            if (message.type === 'guidedAction') { if (this.session) await this.session.act(message); return; }
            if (message.type === 'followup') {
                const counts = this.session && this.session.summary;
                const key = { 'translate-missing': 'missing', review: 'review', 'quality-fix': 'quality', skipped: 'skipped' }[message.workflow];
                if (!counts || !key || !counts[key]) throw new Error('Für diesen Schritt sind keine offenen Einträge verfügbar.');
                await this.session.start(message.workflow);
                return;
            }
            if (message.type === 'backToSelection') {
                await this.preserveEntry(message);
                if (this.session && this.session.drafts.size) throw new Error('Bitte zuerst die Entwürfe speichern.');
                if (this.session) this.session.active = false;
                this.preparing = false;
                await this.refresh();
                await this.panel.webview.postMessage({ type: 'selection' });
                return;
            }
            if (message.type === 'prepareLanguage') {
                if (!this.preparing) throw new Error('Kein aktiver Neue-Sprache-Ablauf.');
                if (!['sync', 'import', 'continue'].includes(message.action)) throw new Error('Unbekannter Vorbereitungsschritt.');
                if (message.action === 'sync') {
                    await this.refresh();
                    if (this.file.syncStatus === 'out-of-sync') await this.services.sync(this.uri);
                    if (this.session) { this.session.dispose(); this.session = undefined; }
                } else {
                    await this.ensureSession();
                    if (message.action === 'import') await this.session.importLocal();
                    else {
                        this.preparing = false;
                        await this.session.start('new-language');
                        return;
                    }
                }
                await this.showPreparation();
                return;
            }
            if (message.type === 'openEditor') {
                await this.preserveEntry(message);
                if (this.session && this.session.current) return await XliffEditorProvider.openAtOrdinal(this.uri, this.session.current.ordinal);
                return await XliffEditorProvider.openWithFilter(this.uri, 'all');
            }
            if (message.type !== 'selectWorkflow') return;
            await this.refresh();
            const workflow = workflowsFor(this.file).find(item => item.id === message.workflow);
            if (!workflow || !workflow.enabled) return;
            if (workflow.id === 'sync-project') {
                await this.services.sync(this.uri);
                await this.refresh();
            } else {
                if (workflow.id === 'new-language') {
                    if (this.session && this.session.drafts.size) throw new Error('Bitte zuerst die Entwürfe speichern.');
                    if (this.session) this.session.active = false;
                    this.preparing = true;
                    await this.showPreparation();
                    return;
                }
                await this.ensureSession();
                await this.session.start(workflow.id);
            }
        } catch (error) {
            if (!this.disposed) await this.panel.webview.postMessage({ type: 'error', message: error.message || String(error) });
        } finally {
            this.busy = false;
            if (!this.disposed) await this.panel.webview.postMessage({ type: 'idle' });
        }
    }

    async requestWorkflow(workflow) {
        if (!this.ready) { this.pendingWorkflow = workflow; return; }
        await this.handleMessage({ type: 'selectWorkflow', workflow });
    }

    async preserveEntry(message) {
        if (!this.session || (!this.session.current && !this.session.drafts.size)) return;
        await this.session.act({ action: 'checkpoint', revision: message.revision ?? this.session.revision, text: message.text });
        if (this.session.error) throw new Error(this.session.error);
    }

    async showPreparation() {
        await this.refresh();
        await this.panel.webview.postMessage({ type: 'preparation', file: this.file });
    }

    async ensureSession() {
        if (this.session) return;
        if (this.services.createSession) this.session = await this.services.createSession(state => this.panel.webview.postMessage(state));
        else {
            const document = await vscode.workspace.openTextDocument(this.uri);
            this.session = new GuidedWorkflowSession(document, new XliffEditorProvider({ extensionUri: this.services.extensionUri }), state => {
                if (!this.disposed) void this.panel.webview.postMessage(state);
            });
            await this.session.connect();
        }
    }

    getHtml() {
        return guidedTranslationHtml(this.panel.webview, this.services.extensionUri);
    }
}

module.exports = { GuidedTranslationView, workflowsFor };
