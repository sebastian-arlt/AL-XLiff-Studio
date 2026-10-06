'use strict';

const vscode = require('vscode');
const path = require('path');
const { calculateXliffMetrics, summarizeDashboardFiles } = require('./dashboardMetrics');
const { BRAND_NAME, CONFIG_SECTION, DASHBOARD_VIEW_TYPE, COMMAND_PREFIX } = require('./identity');
const { XliffEditorProvider, mergeTranslationMemoryFromXliffTexts, mergeTranslationMemorySnapshots, getMapUriForXlf } = require('./xlfEditor');
const { readProjectGlossary } = require('./glossaryEditor');
const { analyzeQualityForText } = require('./qualityCoordinator');
const { synchronizeXliffAdaptive, isWorkerCancellation, parseXliffAdaptive } = require('./xlfWorkerHost');
const { getDocumentSession, getParsedDocumentSessionAsync, getDocumentSessionStats, setDocumentSessionStats } = require('./documentSession');
const { getGeneratorCompanionFilename } = require('./paths');
const { parseLng, serializeLng } = require('./lng');
const { findProjectRoot, workspaceFileExists } = require('./studioPaths');
const { normalizeLocale, parseAppSupportedLocales, translationFilenameForGenerator, createTranslationXliffFromGenerator } = require('./supportedLocales');

class TranslationDashboard {
    static currentPanel = undefined;
    static viewType = DASHBOARD_VIEW_TYPE;

    static createOrShow(context) {
        const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;
        if (TranslationDashboard.currentPanel) {
            TranslationDashboard.currentPanel.panel.reveal(column);
            void TranslationDashboard.currentPanel.refresh();
            return TranslationDashboard.currentPanel;
        }

        const panel = vscode.window.createWebviewPanel(
            TranslationDashboard.viewType,
            `${BRAND_NAME} — Translation Dashboard`,
            column || vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        TranslationDashboard.currentPanel = new TranslationDashboard(panel, context);
        return TranslationDashboard.currentPanel;
    }

    constructor(panel, context) {
        this.panel = panel;
        this.context = context;
        this.disposables = [];
        this.refreshGeneration = 0;
        this.files = [];
        panel.webview.html = this.getHtml(panel.webview);

        panel.onDidDispose(() => this.dispose(), null, this.disposables);
        panel.webview.onDidReceiveMessage(async message => {
            try {
                if (!message || !message.type) return;
                if (message.type === 'ready' || message.type === 'refresh') {
                    await this.refresh();
                    return;
                }
                if (message.type === 'openFile' && message.uri) {
                    await XliffEditorProvider.openWithFilter(vscode.Uri.parse(message.uri), message.filter || 'all');
                    return;
                }
                if (message.type === 'openGlossary') {
                    await vscode.commands.executeCommand(`${COMMAND_PREFIX}.openGlossary`);
                    return;
                }
                if (message.type === 'openAiUsage') {
                    await vscode.commands.executeCommand(`${COMMAND_PREFIX}.openAiUsage`);
                    return;
                }
                if (message.type === 'syncAll') {
                    await this.synchronizeAll();
                    return;
                }
                if (message.type === 'generateLocale') {
                    await this.generateSupportedLocale(message);
                }
            } catch (err) {
                await panel.webview.postMessage({ type: 'error', message: formatError(err) });
            }
        }, null, this.disposables);

        this.disposables.push(vscode.workspace.onDidSaveTextDocument(document => {
            const lower = document.uri.fsPath.toLowerCase();
            if (lower.endsWith('.xlf') && !lower.endsWith('.g.xlf')) {
                if (this.panel.visible) void this.refreshFile(document.uri);
                return;
            }
            if (path.basename(lower) === 'app.json' && this.panel.visible) void this.refresh();
        }));

    }

    dispose() {
        if (this.syncController) this.syncController.abort("Dashboard closed.");
        if (TranslationDashboard.currentPanel === this) TranslationDashboard.currentPanel = undefined;
        for (const disposable of this.disposables.splice(0)) {
            try { disposable.dispose(); } catch (_) { /* ignore */ }
        }
    }

    async refresh() {
        const generation = ++this.refreshGeneration;
        const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
        const include = config.get('xliffGlob', '**/Translations/*.xlf');
        const exclude = config.get('excludeGlob', '**/*.g.xlf');
        const treatNeedsTranslationAsMissing = config.get('treatNeedsTranslationAsMissing', true);

        await this.panel.webview.postMessage({ type: 'loading', message: 'Finding translation XLIFF files…', current: 0, total: 0 });
        const uris = await vscode.workspace.findFiles(include, exclude);
        if (generation !== this.refreshGeneration) return;

        const files = [];
        for (let index = 0; index < uris.length; index++) {
            if (generation !== this.refreshGeneration) return;
            const uri = uris[index];
            await this.panel.webview.postMessage({
                type: 'loading',
                message: `Scanning ${path.basename(uri.fsPath)}`,
                current: index,
                total: uris.length
            });
            try {
                files.push(await this.scanFile(uri, config, treatNeedsTranslationAsMissing));
            } catch (err) {
                files.push({
                    kind: 'file',
                    uri: uri.toString(),
                    project: '',
                    relativePath: path.basename(uri.fsPath),
                    fileName: path.basename(uri.fsPath),
                    sourceLanguage: '',
                    targetLanguage: '',
                    syncStatus: 'error',
                    syncDetails: formatError(err),
                    error: formatError(err),
                    metrics: { total: 0, translated: 0, missing: 0, review: 0, placeholderErrors: 0, percent: 0, structuralWarnings: 0, qualityIssues: 0, qualityErrors: 0, qualityWarnings: 0 }
                });
            }
            await yieldToEventLoop();
        }

        this.files = files.slice();
        const missingLocales = await findMissingSupportedLocaleRows(this.files);
        files.push(...missingLocales);

        files.sort((a, b) => {
            const projectCmp = String(a.project).localeCompare(String(b.project), undefined, { sensitivity: 'base' });
            if (projectCmp) return projectCmp;
            const langCmp = String(a.targetLanguage).localeCompare(String(b.targetLanguage), undefined, { sensitivity: 'base' });
            if (langCmp) return langCmp;
            return String(a.relativePath).localeCompare(String(b.relativePath), undefined, { sensitivity: 'base' });
        });

        if (generation !== this.refreshGeneration) return;
        const summaryFiles = files.filter(file => file.kind !== 'missing-locale');
        const summary = summarizeDashboardFiles(summaryFiles);
        summary.languages = new Set(files.map(file => normalizeLocale(file.targetLanguage)).filter(Boolean)).size;
        summary.missingXliffFiles = missingLocales.length;
        await this.panel.webview.postMessage({
            type: 'dashboard',
            files,
            summary,
            refreshedAt: new Date().toLocaleTimeString()
        });
    }

    async scanFile(uri, config, treatNeedsTranslationAsMissing) {
        const text = await readText(uri);
        const session = getDocumentSession(uri, text);
        const parsed = await getParsedDocumentSessionAsync(session, text, async value => (await parseXliffAdaptive(value, config)).parsed);
        const sync = await getSynchronizationState(uri, text, parsed);
        const glossary = config.get('glossary.enabled', true) ? await readProjectGlossary(uri) : { entries: [] };
        const qualityAnalysis = await analyzeQualityForText(uri, text, { config, session, parsed, glossary });
        const metricsSignature = `${qualityAnalysis.fingerprint}:missing=${treatNeedsTranslationAsMissing ? '1' : '0'}`;
        let metrics = getDocumentSessionStats(session, 'dashboardMetrics', metricsSignature);
        if (!metrics) {
            metrics = calculateXliffMetrics(parsed, {
                treatNeedsTranslationAsMissing,
                qualitySummary: qualityAnalysis.report.summary
            });
            setDocumentSessionStats(session, 'dashboardMetrics', metricsSignature, metrics);
        }
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
        const projectRoot = await findProjectRoot(uri);
        return {
            kind: 'file',
            uri: uri.toString(),
            projectRoot: projectRoot ? projectRoot.toString() : '',
            project: workspaceFolder ? workspaceFolder.name : '',
            relativePath: workspaceFolder
                ? path.relative(workspaceFolder.uri.fsPath, uri.fsPath).split(path.sep).join('/')
                : path.basename(uri.fsPath),
            fileName: path.basename(uri.fsPath),
            sourceLanguage: parsed.sourceLanguage || '',
            targetLanguage: parsed.targetLanguage || '',
            syncStatus: sync.status,
            syncDetails: sync.details,
            generatorUri: sync.generatorUri || '',
            metrics
        };
    }

    async refreshFile(uri) {
        if (!this.panel.visible || !Array.isArray(this.files) || !this.files.length) return this.refresh();
        const generation = ++this.refreshGeneration;
        const config = vscode.workspace.getConfiguration(CONFIG_SECTION, uri);
        const treatNeedsTranslationAsMissing = config.get('treatNeedsTranslationAsMissing', true);
        try {
            const updated = await this.scanFile(uri, config, treatNeedsTranslationAsMissing);
            if (generation !== this.refreshGeneration) return;
            const index = this.files.findIndex(file => file.uri === uri.toString());
            if (index < 0) return this.refresh();
            this.files[index] = updated;
            const files = this.files.slice();
            const missingLocales = await findMissingSupportedLocaleRows(this.files);
            files.push(...missingLocales);
            files.sort((a, b) => {
                const projectCmp = String(a.project).localeCompare(String(b.project), undefined, { sensitivity: 'base' });
                if (projectCmp) return projectCmp;
                const langCmp = String(a.targetLanguage).localeCompare(String(b.targetLanguage), undefined, { sensitivity: 'base' });
                return langCmp || String(a.relativePath).localeCompare(String(b.relativePath), undefined, { sensitivity: 'base' });
            });
            if (generation !== this.refreshGeneration) return;
            const summary = summarizeDashboardFiles(this.files);
            summary.languages = new Set(files.map(file => normalizeLocale(file.targetLanguage)).filter(Boolean)).size;
            summary.missingXliffFiles = missingLocales.length;
            await this.panel.webview.postMessage({
                type: 'dashboard',
                files,
                summary,
                refreshedAt: new Date().toLocaleTimeString()
            });
        } catch (_) {
            return this.refresh();
        }
    }

    async generateSupportedLocale(message) {
        const targetLanguage = String(message && message.targetLanguage || '').trim().replace(/_/g, '-');
        if (!targetLanguage) throw new Error('Missing target locale.');

        let generatorUri;
        try {
            generatorUri = vscode.Uri.parse(String(message && message.generatorUri || ''));
        } catch (_) {
            generatorUri = undefined;
        }
        if (!generatorUri || !generatorUri.fsPath || !generatorUri.fsPath.toLowerCase().endsWith('.g.xlf')) {
            throw new Error('The generated .g.xlf for this locale is no longer available.');
        }

        const projectRoot = await findProjectRoot(generatorUri);
        if (!projectRoot) throw new Error('Could not determine the AL project for the selected .g.xlf.');
        const appJsonUri = vscode.Uri.joinPath(projectRoot, 'app.json');
        const app = parseAppSupportedLocales(await readText(appJsonUri));
        if (!app.supportedLocales.some(locale => normalizeLocale(locale) === normalizeLocale(targetLanguage))) {
            throw new Error(`${targetLanguage} is no longer listed in app.json supportedLocales.`);
        }

        const generatorText = await readText(generatorUri);
        const generatorSession = getDocumentSession(generatorUri, generatorText);
        const generatorConfig = vscode.workspace.getConfiguration(CONFIG_SECTION, generatorUri);
        const generator = await getParsedDocumentSessionAsync(generatorSession, generatorText, async value => (await parseXliffAdaptive(value, generatorConfig)).parsed);
        if (normalizeLocale(generator.sourceLanguage) === normalizeLocale(targetLanguage)) {
            throw new Error(`${targetLanguage} is the source language of the generated .g.xlf and does not require a translation XLIFF.`);
        }

        const filename = translationFilenameForGenerator(generatorUri.fsPath, targetLanguage);
        if (!filename) throw new Error('Could not determine the translation XLIFF filename.');
        const targetUri = vscode.Uri.file(path.join(path.dirname(generatorUri.fsPath), filename));
        if (await workspaceFileExists(targetUri)) {
            vscode.window.showInformationMessage(`${BRAND_NAME}: ${filename} already exists.`);
            await this.refresh();
            return;
        }

        const text = createTranslationXliffFromGenerator(generatorText, targetLanguage);
        await writeText(targetUri, text);
        vscode.window.showInformationMessage(`${BRAND_NAME}: created ${filename} for ${targetLanguage}.`);
        await this.refresh();
    }

    async synchronizeAll() {
        if (this.syncController) this.syncController.abort('Superseded Sync all.');
        const controller = new AbortController();
        this.syncController = controller;
        const resources = new Set();
        const subscriptions = [];
        const cancelChanged = document => {
            if (document && resources.has(document.uri.toString())) controller.abort('Sync document changed or closed.');
        };
        if (vscode.workspace.onDidChangeTextDocument) subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
            if (!Array.isArray(event.contentChanges) || event.contentChanges.length) cancelChanged(event.document);
        }));
        if (vscode.workspace.onDidCloseTextDocument) subscriptions.push(vscode.workspace.onDidCloseTextDocument(cancelChanged));
        try {
        ++this.refreshGeneration;
        const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
        const include = config.get('xliffGlob', '**/Translations/*.xlf');
        const exclude = config.get('excludeGlob', '**/*.g.xlf');
        const uris = await vscode.workspace.findFiles(include, exclude);

        let changedFiles = 0;
        let alreadySynchronized = 0;
        let missingGenerators = 0;
        let synchronizedSources = 0;
        let addedUnits = 0;
        let flaggedTargets = 0;
        let synchronizedDeveloperNotes = 0;
        let synchronizedGeneratorNotes = 0;
        let removedUnits = 0;
        let updatedMaps = 0;
        const failedFiles = [];

        for (let index = 0; index < uris.length; index++) {
            const uri = uris[index];
            await this.panel.webview.postMessage({
                type: 'loading',
                message: `Synchronizing ${path.basename(uri.fsPath)}`,
                current: index + 1,
                total: uris.length
            });

            try {
                const before = await readText(uri);
                const parsed = (await parseXliffAdaptive(before, config, {signal:controller.signal, resourceKey:uri.toString()})).parsed;
                const siblingUri = await findSiblingGxlf(uri, parsed.targetLanguage);
                if (!siblingUri) {
                    missingGenerators++;
                    continue;
                }

                resources.add(siblingUri.toString());
                const generatorText = await readText(siblingUri);
                const result = await synchronizeXliffAdaptive(before, generatorText, config, {signal:controller.signal, resourceKey:uri.toString(),unitCount:parsed.units.length});
                if (controller.signal.aborted || await readText(uri) !== before || await readText(siblingUri) !== generatorText) return;
                synchronizedSources += result.synchronizedSources;
                addedUnits += result.addedUnits;
                flaggedTargets += result.flaggedTargets;
                synchronizedDeveloperNotes += result.synchronizedDeveloperNotes || 0;
                synchronizedGeneratorNotes += result.synchronizedGeneratorNotes || 0;
                removedUnits += result.removedUnits.length;
                if (await updateCompanionMapFromXliffTexts(uri, parsed.targetLanguage, [before, result.text], result.memorySnapshots)) updatedMaps++;

                if (result.text === before) {
                    alreadySynchronized++;
                    continue;
                }

                if (controller.signal.aborted || await readText(uri) !== before) return;
                resources.delete(uri.toString()); // Our own successful document edit is not external cancellation.
                await writeText(uri, result.text);
                changedFiles++;
            } catch (err) {
                if (isWorkerCancellation(err) || controller.signal.aborted) return;
                failedFiles.push(`${path.basename(uri.fsPath)}: ${formatError(err)}`);
            }
            await yieldToEventLoop();
        }

        if (controller.signal.aborted) return;
        const missingText = missingGenerators ? ` ${missingGenerators} file(s) had no unambiguous matching .g.xlf.` : '';
        const failedText = failedFiles.length ? ` ${failedFiles.length} file(s) failed.` : '';
        vscode.window.showInformationMessage(
            `AL Xliff Studio: synchronized ${changedFiles} XLIFF file(s); ${alreadySynchronized} already synchronized; ${synchronizedSources} changed source(s), ${synchronizedDeveloperNotes} Developer note set(s) synchronized, ${synchronizedGeneratorNotes} Xliff Generator note set(s) synchronized, ${addedUnits} missing unit(s) added, ${flaggedTargets} target(s) flagged for review, ${removedUnits} obsolete unit(s) removed; ${updatedMaps} companion .lng file(s) updated.${missingText}${failedText}`
        );
        if (failedFiles.length) {
            vscode.window.showWarningMessage(`AL Xliff Studio sync errors: ${failedFiles.slice(0, 3).join(' | ')}${failedFiles.length > 3 ? ' …' : ''}`);
        }

        await this.refresh();
        } finally {
            for (const subscription of subscriptions) subscription.dispose();
            if (this.syncController === controller) this.syncController = undefined;
        }
    }

    getHtml(webview) {
        const nonce = String(Date.now());
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>${BRAND_NAME} — Translation Dashboard</title>
<style>
*{box-sizing:border-box} body{margin:0;padding:0;background:var(--vscode-editor-background);color:var(--vscode-foreground);font-family:var(--vscode-font-family)}
header{position:sticky;top:0;z-index:4;padding:14px 16px 12px;background:var(--vscode-editor-background);border-bottom:1px solid var(--vscode-panel-border)}
.title-row{display:flex;align-items:center;gap:10px}.title{font-size:1.25em;font-weight:650;flex:1}.subtitle{color:var(--vscode-descriptionForeground);margin-top:3px}
button,input{font:inherit;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,var(--vscode-panel-border));border-radius:2px;padding:5px 8px}button{cursor:pointer}button:hover{background:var(--vscode-list-hoverBackground)}
.summary{display:grid;grid-template-columns:repeat(9,minmax(100px,1fr));gap:8px;padding:14px 16px}.card{border:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background);padding:10px 12px;border-radius:3px}.card .value{font-size:1.35em;font-weight:650}.card .label{margin-top:2px;color:var(--vscode-descriptionForeground);font-size:.82em}
.toolbar{display:flex;gap:8px;align-items:center;padding:0 16px 10px}.toolbar input{min-width:280px;flex:1;max-width:560px}.meta{color:var(--vscode-descriptionForeground);font-size:.86em}
.table-wrap{padding:0 16px 18px}table{width:100%;border-collapse:collapse;table-layout:fixed}thead{position:sticky;top:72px;z-index:3;background:var(--vscode-editor-background)}th,td{padding:8px 7px;border-bottom:1px solid var(--vscode-panel-border);text-align:left;vertical-align:middle}th{font-weight:600}tbody tr:hover{background:var(--vscode-list-hoverBackground)}
.file{font-weight:550;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.path{font-size:.78em;color:var(--vscode-descriptionForeground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.language{white-space:nowrap}.number{text-align:right;font-variant-numeric:tabular-nums}.metric{border:0;background:transparent;padding:2px 4px;text-decoration:underline;text-decoration-style:dotted;text-underline-offset:2px}.metric.zero{text-decoration:none;color:var(--vscode-descriptionForeground);cursor:default}.metric.problem{color:var(--vscode-editorWarning-foreground)}.metric.error-count{color:var(--vscode-editorError-foreground)}
.progress-shell{height:8px;background:var(--vscode-progressBar-background);opacity:.28;border-radius:5px;overflow:hidden;margin-top:4px}.progress-bar{height:100%;background:var(--vscode-progressBar-background);opacity:1}.completion{display:flex;justify-content:space-between;gap:8px;font-variant-numeric:tabular-nums}
.sync-status{display:inline-block;white-space:nowrap;font-size:.84em}.sync-status.synced{color:var(--vscode-testing-iconPassed,var(--vscode-foreground))}.sync-status.out-of-sync{color:var(--vscode-editorWarning-foreground)}.sync-status.missing-generator{color:var(--vscode-descriptionForeground)}.sync-status.error{color:var(--vscode-editorError-foreground)}.sync-status.missing-file{color:var(--vscode-editorWarning-foreground)}.missing-locale-row{background:color-mix(in srgb,var(--vscode-editorWarning-foreground) 4%,transparent)}.generate-xlf{white-space:nowrap;margin-top:4px}
.warning{color:var(--vscode-editorWarning-foreground);font-size:.82em;margin-top:3px}.error-text{color:var(--vscode-editorError-foreground);font-size:.82em}.empty{padding:28px 16px;text-align:center;color:var(--vscode-descriptionForeground)}
.loading{position:fixed;inset:0;z-index:10;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb,var(--vscode-editor-background) 88%,transparent)}.loading.hidden{display:none}.loading-card{width:min(480px,80vw);padding:18px;border:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background);box-shadow:0 6px 20px rgba(0,0,0,.25)}.loading-title{font-weight:600}.loading-count{margin-top:6px;color:var(--vscode-descriptionForeground)}.loading-track{height:5px;background:var(--vscode-panel-border);margin-top:12px;overflow:hidden}.loading-bar{height:100%;width:0;background:var(--vscode-progressBar-background)}
@media(max-width:900px){.summary{grid-template-columns:repeat(3,1fr)}.col-project{display:none}}
</style>
</head>
<body>
<header><div class="title-row"><div><div class="title">Translation Dashboard</div><div class="subtitle">Project-wide XLIFF status for AL / Business Central</div></div><button id="glossary" title="Open project terminology glossary">T Glossary</button><button id="aiUsage" title="Open persistent AI usage statistics">AI Usage</button><button id="syncAll" title="Synchronize all translation XLIFFs with their matching .g.xlf">⇄ Sync all XLIFFs</button><button id="refresh" title="Rescan translation files">↻ Refresh</button></div></header>
<section class="summary" id="summary"></section>
<div class="toolbar"><input id="search" placeholder="Filter by project, file or language…"><span class="meta" id="refreshMeta"></span></div>
<div class="table-wrap"><table><thead><tr><th class="col-project" style="width:11%">Project</th><th style="width:22%">XLIFF</th><th style="width:9%">Language</th><th style="width:10%">Sync</th><th style="width:16%">Completion</th><th class="number" style="width:8%">Translated</th><th class="number" style="width:8%">Missing</th><th class="number" style="width:8%">Review</th><th class="number" style="width:8%">Quality</th></tr></thead><tbody id="rows"></tbody></table><div id="empty" class="empty" style="display:none"></div></div>
<div id="loading" class="loading hidden"><div class="loading-card"><div id="loadingTitle" class="loading-title">Loading dashboard</div><div id="loadingCount" class="loading-count">Working…</div><div class="loading-track"><div id="loadingBar" class="loading-bar"></div></div></div></div>
<script nonce="${nonce}">
const vscode=acquireVsCodeApi();let model={files:[],summary:{}};const rows=document.getElementById('rows');const search=document.getElementById('search');const empty=document.getElementById('empty');const loading=document.getElementById('loading');
function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function card(value,label){const display=typeof value==='number'&&Number.isFinite(value)?value.toLocaleString():String(value==null?'':value);return '<div class="card"><div class="value">'+esc(display)+'</div><div class="label">'+esc(label)+'</div></div>';}
function renderSummary(){const s=model.summary||{};document.getElementById('summary').innerHTML=card(s.files,'XLIFF files')+card(s.languages,'Languages')+card((s.percent||0)+'%','Translated')+card(s.total,'Translation units')+card(s.missing,'Missing')+card(s.review,'Review')+card(s.placeholderErrors,'Placeholder errors')+card(s.qualityIssues,'Quality issues')+card(s.missingXliffFiles||0,'Locales missing XLIFF');}
function metricButton(file,value,filter,css,title){const n=Number(value)||0;if(!n)return '<button class="metric zero" disabled>0</button>';return '<button class="metric '+(css||'')+'" data-open="'+esc(file.uri)+'" data-filter="'+esc(filter)+'" title="'+esc(title||'Open in XLIFF editor')+'">'+n.toLocaleString()+'</button>';}
function syncStatus(file){const status=String(file.syncStatus||'error');const labels={synced:'✓ Synced','out-of-sync':'⇄ Out of sync','missing-generator':'— No .g.xlf','missing-file':'○ Not created',error:'! Error'};return '<span class="sync-status '+esc(status)+'" title="'+esc(file.syncDetails||'')+'">'+esc(labels[status]||status)+'</span>';}
function fileRow(file){if(file.kind==='missing-locale'){const canGenerate=Boolean(file.generateAvailable&&file.generatorUri);const action=canGenerate?'<button class="generate-xlf" data-generate="1" data-generator="'+esc(file.generatorUri)+'" data-locale="'+esc(file.targetLanguage)+'" title="Create an untranslated XLIFF from the generated .g.xlf">＋ Generate XLIFF</button>':'<div class="path">Compile the AL project first to create an unambiguous .g.xlf.</div>';return '<tr class="missing-locale-row"><td class="col-project">'+esc(file.project||'—')+'</td><td><div class="file">'+esc(file.fileName||'Translation XLIFF')+'</div><div class="path">'+esc(file.relativePath||'')+'</div><div class="warning">Listed in app.json supportedLocales</div></td><td class="language">'+esc(file.sourceLanguage||'—')+' → '+esc(file.targetLanguage||'—')+'</td><td>'+syncStatus(file)+action+'</td><td><span class="meta">Not generated</span></td><td class="number">—</td><td class="number">—</td><td class="number">—</td><td class="number">—</td></tr>';}if(file.error)return '<tr><td class="col-project">'+esc(file.project)+'</td><td><div class="file">'+esc(file.fileName)+'</div><div class="path">'+esc(file.relativePath)+'</div><div class="error-text">'+esc(file.error)+'</div></td><td colspan="7"></td></tr>';const m=file.metrics||{};const warn=m.structuralWarnings?'<div class="warning">'+m.structuralWarnings+' structural warning(s)</div>':'';return '<tr><td class="col-project">'+esc(file.project||'—')+'</td><td><button class="metric file" data-open="'+esc(file.uri)+'" data-filter="all">'+esc(file.fileName)+'</button><div class="path">'+esc(file.relativePath)+'</div>'+warn+'</td><td class="language">'+esc(file.sourceLanguage||'—')+' → '+esc(file.targetLanguage||'—')+'</td><td>'+syncStatus(file)+'</td><td><div class="completion"><span>'+esc((m.percent||0)+'%')+'</span><span>'+esc((m.translated||0)+' / '+(m.total||0))+'</span></div><div class="progress-shell"><div class="progress-bar" style="width:'+Math.max(0,Math.min(100,Number(m.percent)||0))+'%"></div></div></td><td class="number">'+metricButton(file,m.translated,'translated','','Show translated entries')+'</td><td class="number">'+metricButton(file,m.missing,'missing','problem','Show missing entries')+'</td><td class="number">'+metricButton(file,m.review,'review','problem','Show review entries')+'</td><td class="number">'+metricButton(file,m.qualityIssues,'quality',m.qualityErrors?'error-count':'problem','Show quality issues')+'</td></tr>';}

function render(){renderSummary();const q=String(search.value||'').toLowerCase();const visible=(model.files||[]).filter(f=>!q||[f.project,f.relativePath,f.fileName,f.sourceLanguage,f.targetLanguage,f.syncStatus].join(' ').toLowerCase().includes(q));rows.innerHTML=visible.map(fileRow).join('');empty.style.display=visible.length?'none':'block';empty.textContent=(model.files||[]).length?'No files match the filter.':'No translation XLIFF files found.';}
function setLoading(message,current,total){document.getElementById('syncAll').disabled=true;document.getElementById('refresh').disabled=true;loading.classList.remove('hidden');document.getElementById('loadingTitle').textContent=message||'Loading dashboard';const c=Number(current)||0,t=Number(total)||0;document.getElementById('loadingCount').textContent=t?c.toLocaleString()+' / '+t.toLocaleString()+' files':'Working…';document.getElementById('loadingBar').style.width=(t?Math.round((c/t)*100):8)+'%';}
document.getElementById('refresh').addEventListener('click',()=>vscode.postMessage({type:'refresh'}));document.getElementById('syncAll').addEventListener('click',()=>vscode.postMessage({type:'syncAll'}));document.getElementById('glossary').addEventListener('click',()=>vscode.postMessage({type:'openGlossary'}));document.getElementById('aiUsage').addEventListener('click',()=>vscode.postMessage({type:'openAiUsage'}));search.addEventListener('input',render);rows.addEventListener('click',e=>{const generate=e.target.closest('[data-generate]');if(generate){vscode.postMessage({type:'generateLocale',generatorUri:generate.dataset.generator,targetLanguage:generate.dataset.locale});return;}const b=e.target.closest('[data-open]');if(b)vscode.postMessage({type:'openFile',uri:b.dataset.open,filter:b.dataset.filter||'all'});});
window.addEventListener('message',e=>{const msg=e.data;if(msg.type==='loading'){setLoading(msg.message,msg.current,msg.total);}else if(msg.type==='dashboard'){model=msg;document.getElementById('refreshMeta').textContent='Refreshed '+(msg.refreshedAt||'');document.getElementById('syncAll').disabled=false;document.getElementById('refresh').disabled=false;loading.classList.add('hidden');render();}else if(msg.type==='error'){document.getElementById('syncAll').disabled=false;document.getElementById('refresh').disabled=false;loading.classList.add('hidden');empty.style.display='block';empty.textContent=msg.message||'Dashboard error.';}});vscode.postMessage({type:'ready'});
</script>
</body></html>`;
    }
}

async function findMissingSupportedLocaleRows(files) {
    if (!vscode.workspace.findFiles) return [];
    const appJsonUris = await vscode.workspace.findFiles('**/app.json', '**/{.git,node_modules,.alpackages}/**');
    const rows = [];

    for (const appJsonUri of appJsonUris) {
        try {
            const app = parseAppSupportedLocales(await readText(appJsonUri));
            if (!app.supportedLocales.length) continue;
            const projectRoot = vscode.Uri.file(path.dirname(appJsonUri.fsPath));
            const projectRootKey = projectRoot.toString();
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(appJsonUri);
            const projectName = workspaceFolder ? workspaceFolder.name : (app.name || path.basename(projectRoot.fsPath));
            const projectFiles = files.filter(file => file.kind !== 'missing-locale' && file.projectRoot === projectRootKey);
            const existingLocales = new Set(projectFiles.map(file => normalizeLocale(file.targetLanguage)).filter(Boolean));
            const generatorUris = await vscode.workspace.findFiles(new vscode.RelativePattern(projectRoot.fsPath, 'Translations/*.g.xlf'));
            let generatorUri = generatorUris.length === 1 ? generatorUris[0] : undefined;
            let generatorParsed;
            if (generatorUri) {
                const generatorText = await readText(generatorUri);
                const generatorSession = getDocumentSession(generatorUri, generatorText);
                const generatorConfig = vscode.workspace.getConfiguration(CONFIG_SECTION, generatorUri);
                generatorParsed = await getParsedDocumentSessionAsync(generatorSession, generatorText, async value => (await parseXliffAdaptive(value, generatorConfig)).parsed);
            }

            for (const locale of app.supportedLocales) {
                const localeKey = normalizeLocale(locale);
                if (!localeKey || existingLocales.has(localeKey)) continue;
                if (generatorParsed && normalizeLocale(generatorParsed.sourceLanguage) === localeKey) continue;

                const filename = generatorUri
                    ? translationFilenameForGenerator(generatorUri.fsPath, locale)
                    : undefined;
                const targetUri = filename && generatorUri
                    ? vscode.Uri.file(path.join(path.dirname(generatorUri.fsPath), filename))
                    : undefined;
                // Never offer to overwrite an existing file merely because it was excluded
                // by the current dashboard glob or could not be parsed during this scan.
                if (targetUri && await workspaceFileExists(targetUri)) continue;

                const relativePath = targetUri && workspaceFolder
                    ? path.relative(workspaceFolder.uri.fsPath, targetUri.fsPath).split(path.sep).join('/')
                    : (filename ? `Translations/${filename}` : `Translations/(${locale})`);
                rows.push({
                    kind: 'missing-locale',
                    uri: '',
                    projectRoot: projectRootKey,
                    project: projectName,
                    relativePath,
                    fileName: filename || `${locale} translation XLIFF`,
                    sourceLanguage: generatorParsed ? generatorParsed.sourceLanguage || '' : '',
                    targetLanguage: locale,
                    syncStatus: 'missing-file',
                    syncDetails: generatorUri
                        ? `${locale} is listed in app.json supportedLocales, but no translation XLIFF exists.`
                        : `${locale} is listed in app.json supportedLocales, but no unambiguous Translations/*.g.xlf is available.`,
                    generatorUri: generatorUri ? generatorUri.toString() : '',
                    generateAvailable: Boolean(generatorUri),
                    metrics: emptyMetrics()
                });
            }
        } catch (_) {
            // Invalid app.json or generated XLIFF is already surfaced by the AL tooling.
            // Do not break the translation dashboard because one project is incomplete.
        }
    }
    return rows;
}

function emptyMetrics() {
    return { total: 0, translated: 0, missing: 0, review: 0, placeholderErrors: 0, percent: 0, structuralWarnings: 0, qualityIssues: 0, qualityErrors: 0, qualityWarnings: 0 };
}

async function getSynchronizationState(uri, targetText, parsed) {
    try {
        const siblingUri = await findSiblingGxlf(uri, parsed.targetLanguage);
        if (!siblingUri) {
            return {
                status: 'missing-generator',
                details: 'No unambiguous matching .g.xlf was found next to this translation XLIFF.'
            };
        }

        const result = await synchronizeXliffAdaptive(targetText, await readText(siblingUri), vscode.workspace.getConfiguration(CONFIG_SECTION, uri), {
            resourceKey: uri.toString(), unitCount: parsed.units.length, includeMemory: false
        });
        if (result.text === targetText) {
            return {
                status: 'synced',
                details: 'Synchronized with the matching .g.xlf.',
                generatorUri: siblingUri.toString()
            };
        }

        const changes = [];
        if (result.synchronizedSources) changes.push(`${result.synchronizedSources} changed source(s)`);
        if (result.addedUnits) changes.push(`${result.addedUnits} missing unit(s)`);
        if (result.flaggedTargets) changes.push(`${result.flaggedTargets} target(s) to flag for review`);
        if (result.synchronizedDeveloperNotes) changes.push(`${result.synchronizedDeveloperNotes} Developer note set(s)`);
        if (result.synchronizedGeneratorNotes) changes.push(`${result.synchronizedGeneratorNotes} Xliff Generator note set(s)`);
        if (!changes.length) changes.push('unit order or structure differs');
        if (result.removedUnits.length) changes.push(`${result.removedUnits.length} obsolete unit(s) to remove`);
        return {
            status: 'out-of-sync',
            details: `Not synchronized: ${changes.join(', ')}.`,
            generatorUri: siblingUri.toString()
        };
    } catch (err) {
        return { status: 'error', details: formatError(err) };
    }
}

async function findSiblingGxlf(uri, targetLanguage) {
    const folder = path.dirname(uri.fsPath);
    if (targetLanguage) {
        const exactName = getGeneratorCompanionFilename(uri.fsPath, targetLanguage);
        if (exactName) {
            const exactUri = vscode.Uri.file(path.join(folder, exactName));
            try {
                await vscode.workspace.fs.stat(exactUri);
                return exactUri;
            } catch (_) {
                // Fall through to the unambiguous single-generator fallback.
            }
        }
    }

    const found = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '*.g.xlf'));
    return found.length === 1 ? found[0] : undefined;
}

async function updateCompanionMapFromXliffTexts(uri, targetLanguage, xlfTexts, memorySnapshots) {
    if (!targetLanguage) return false;
    const mapUri = await getMapUriForXlf(uri, targetLanguage);
    let existing = { entries: [] };
    let beforeMapText = '';
    try {
        beforeMapText = await readText(mapUri);
        existing = parseLng(beforeMapText);
    } catch (err) {
        if (!isFileNotFound(err)) throw err;
    }

    const result = memorySnapshots ? mergeTranslationMemorySnapshots(existing.entries, memorySnapshots) : mergeTranslationMemoryFromXliffTexts(existing.entries, xlfTexts);
    const afterMapText = serializeLng(result.entries, targetLanguage);
    if (afterMapText === beforeMapText) return false;
    await writeText(mapUri, afterMapText);
    return true;
}

function isFileNotFound(err) {
    return err && (err.code === 'FileNotFound' || err.code === 'ENOENT');
}

async function readText(uri) {
    const openDocument = (vscode.workspace.textDocuments || []).find(document => document.uri.toString() === uri.toString());
    if (openDocument) return openDocument.getText();
    return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
}

async function writeText(uri, text) {
    const openDocument = (vscode.workspace.textDocuments || []).find(document => document.uri.toString() === uri.toString());
    if (!openDocument) {
        const parent = vscode.Uri.joinPath(uri, '..');
        if (vscode.workspace.fs.createDirectory) await vscode.workspace.fs.createDirectory(parent);
        await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
        return;
    }
    if (openDocument.getText() === text) return;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(openDocument.positionAt(0), openDocument.positionAt(openDocument.getText().length)), text);
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) throw new Error(`Could not apply synchronized changes to ${path.basename(uri.fsPath)}.`);
}

function formatError(err) {
    if (err instanceof Error) return err.message;
    return String(err || 'Unknown error');
}

function yieldToEventLoop() {
    return new Promise(resolve => setTimeout(resolve, 0));
}

module.exports = { TranslationDashboard, findMissingSupportedLocaleRows, emptyMetrics };
