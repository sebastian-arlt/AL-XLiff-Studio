'use strict';

const vscode = require('vscode');
const path = require('path');
const { calculateXliffMetrics } = require('./dashboardMetrics');
const { analyzeQualityForText } = require('./qualityCoordinator');
const { parseXliffAdaptive } = require('./xlfWorkerHost');
const { getDocumentSession, getParsedDocumentSessionAsync, getDocumentSessionStats, setDocumentSessionStats } = require('./documentSession');
const { readProjectGlossary } = require('./glossaryEditor');
const { findMissingSupportedLocaleRows } = require('./dashboard');
const {
    normalizeLocale,
    parseAppSupportedLocales,
    translationFilenameForGenerator,
    createTranslationXliffFromGenerator
} = require('./supportedLocales');
const {
    STUDIO_DIRECTORY,
    LANGUAGE_MAP_DIRECTORY,
    findProjectRoot,
    ensureStudioStructure,
    workspaceFileExists
} = require('./studioPaths');
const { BRAND_NAME, COMMAND_PREFIX, CONFIG_SECTION } = require('./identity');

class ActivityBarProvider {
    constructor(context, options = {}) {
        this.context = context;
        this.options = options;
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.snapshot = emptySnapshot();
        this.loaded = false;
        this.refreshPromise = undefined;
        this.refreshTimer = undefined;
        this.pendingFileRefresh = undefined;
        this.treeView = undefined;
        this.disposables = [];
    }

    register() {
        const viewId = `${COMMAND_PREFIX}.dashboardLauncher`;
        this.treeView = vscode.window.createTreeView(viewId, {
            treeDataProvider: this,
            showCollapseAll: true
        });
        this.disposables.push(this.treeView);

        const xlfWatcher = vscode.workspace.createFileSystemWatcher('**/Translations/*.xlf');
        xlfWatcher.onDidCreate(() => this.scheduleRefresh(), null, this.disposables);
        xlfWatcher.onDidChange(uri => this.scheduleFileRefresh(uri), null, this.disposables);
        xlfWatcher.onDidDelete(() => this.scheduleRefresh(), null, this.disposables);
        this.disposables.push(xlfWatcher);

        const appWatcher = vscode.workspace.createFileSystemWatcher('**/app.json');
        appWatcher.onDidCreate(() => this.scheduleRefresh(), null, this.disposables);
        appWatcher.onDidChange(() => this.scheduleRefresh(), null, this.disposables);
        appWatcher.onDidDelete(() => this.scheduleRefresh(), null, this.disposables);
        this.disposables.push(appWatcher);

        const glossaryWatcher = vscode.workspace.createFileSystemWatcher(`**/${STUDIO_DIRECTORY}/glossary.json`);
        glossaryWatcher.onDidCreate(() => this.scheduleRefresh(), null, this.disposables);
        glossaryWatcher.onDidChange(() => this.scheduleRefresh(), null, this.disposables);
        glossaryWatcher.onDidDelete(() => this.scheduleRefresh(), null, this.disposables);
        this.disposables.push(glossaryWatcher);

        this.disposables.push(vscode.workspace.onDidSaveTextDocument(document => {
            const lower = String(document.uri && document.uri.fsPath || '').toLowerCase();
            if (lower.endsWith('.xlf') && !lower.endsWith('.g.xlf')) {
                this.scheduleFileRefresh(document.uri, 60);
                return;
            }
            if (path.basename(lower) === 'app.json' || lower.endsWith('/.alxliffstudio/glossary.json'.replace(/\//g, path.sep))) {
                this.scheduleRefresh(60);
            }
        }));
        this.disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(() => this.scheduleRefresh(50)));
        this.disposables.push(vscode.workspace.onDidChangeConfiguration(event => {
            const settings = [
                `${CONFIG_SECTION}.xliffGlob`,
                `${CONFIG_SECTION}.excludeGlob`,
                `${CONFIG_SECTION}.treatNeedsTranslationAsMissing`,
                `${CONFIG_SECTION}.validation`,
                `${CONFIG_SECTION}.quality`,
                `${CONFIG_SECTION}.glossary`,
                `${CONFIG_SECTION}.debug.enabled`,
                `${CONFIG_SECTION}.debug.performance.enabled`
            ];
            if (settings.some(setting => event.affectsConfiguration(setting))) this.scheduleRefresh(50);
        }));
        this.disposables.push(this.treeView.onDidChangeVisibility(event => {
            if (!event.visible) return;
            void this.refresh();
            // The Activity Bar icon represents the Translation Dashboard. Opening the
            // container keeps the navigator visible and opens the full dashboard beside it.
            void vscode.commands.executeCommand(`${COMMAND_PREFIX}.openDashboard`);
        }));

        this.context.subscriptions.push(...this.disposables, { dispose: () => this.dispose() });
        void this.refresh();
        return this;
    }

    dispose() {
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        this.refreshTimer = undefined;
        for (const disposable of this.disposables.splice(0)) {
            try { disposable.dispose(); } catch (_) { /* ignore */ }
        }
        try { this._onDidChangeTreeData.dispose(); } catch (_) { /* ignore */ }
    }

    scheduleRefresh(delay = 150) {
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(() => {
            this.refreshTimer = undefined;
            void this.refresh();
        }, Math.max(0, delay));
    }

    scheduleFileRefresh(uri, delay = 120) {
        if (!uri) return this.scheduleRefresh(delay);
        const key = uri.toString();
        if (this.pendingFileRefresh && this.pendingFileRefresh !== key) {
            this.pendingFileRefresh = undefined;
            return this.scheduleRefresh(delay);
        }
        this.pendingFileRefresh = key;
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(() => {
            this.refreshTimer = undefined;
            const pending = this.pendingFileRefresh;
            this.pendingFileRefresh = undefined;
            if (!pending) return void this.refresh();
            void this.refreshFile(vscode.Uri.parse(pending));
        }, Math.max(0, delay));
    }

    async refreshFile(uri) {
        if (!this.loaded || !this.snapshot || !Array.isArray(this.snapshot.files)) return this.refresh();
        const config = vscode.workspace.getConfiguration(CONFIG_SECTION, uri);
        try {
            const file = await this.scanFile(uri, config);
            const files = this.snapshot.files.slice();
            const index = files.findIndex(item => item.uri === uri.toString());
            if (index < 0) return this.refresh();
            files[index] = file;
            const missingLocales = await findMissingSupportedLocaleRows(files);
            const languages = [...files, ...missingLocales].sort((a, b) => {
                const projectCmp = String(a.project).localeCompare(String(b.project), undefined, { sensitivity: 'base' });
                return projectCmp || String(a.targetLanguage || a.fileName).localeCompare(String(b.targetLanguage || b.fileName), undefined, { sensitivity: 'base' });
            });
            const totals = calculateActivityTotals(languages);
            this.snapshot = { ...this.snapshot, files, languages, totals, error: '' };
            this.updateBadge();
            this._onDidChangeTreeData.fire(undefined);
        } catch (_) {
            // Fall back to a complete refresh if the saved resource disappeared or its
            // project context changed while the incremental update was running.
            return this.refresh();
        }
    }

    async refresh() {
        if (this.refreshPromise) return this.refreshPromise;
        this.refreshPromise = this.scan().then(snapshot => {
            this.snapshot = snapshot;
            this.loaded = true;
            this.updateBadge();
            this._onDidChangeTreeData.fire(undefined);
        }).catch(err => {
            this.snapshot = { ...emptySnapshot(), error: formatError(err) };
            this.loaded = true;
            this.updateBadge();
            this._onDidChangeTreeData.fire(undefined);
        }).finally(() => {
            this.refreshPromise = undefined;
        });
        return this.refreshPromise;
    }

    updateBadge() {
        if (!this.treeView || !('badge' in this.treeView)) return;
        const totals = this.snapshot.totals || {};
        const open = Number(totals.missing || 0) + Number(totals.review || 0) + Number(totals.quality || 0) + Number(totals.missingLocales || 0) + Number(totals.errors || 0);
        this.treeView.badge = open > 0 ? {
            value: open,
            tooltip: `${open} open translation/quality item${open === 1 ? '' : 's'}`
        } : undefined;
    }

    async scan() {
        const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
        const include = config.get('xliffGlob', '**/Translations/*.xlf');
        const exclude = config.get('excludeGlob', '**/*.g.xlf');
        const treatNeedsTranslationAsMissing = config.get('treatNeedsTranslationAsMissing', true);
        const uris = await vscode.workspace.findFiles(include, exclude);
        const files = [];
        const glossaryCache = new Map();

        for (const uri of uris) {
            try {
                files.push(await this.scanFile(uri, config, glossaryCache));
            } catch (err) {
                const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
                files.push({
                    kind: 'file',
                    uri: uri.toString(),
                    projectRoot: '',
                    project: workspaceFolder ? workspaceFolder.name : '',
                    relativePath: workspaceFolder ? path.relative(workspaceFolder.uri.fsPath, uri.fsPath).split(path.sep).join('/') : path.basename(uri.fsPath),
                    fileName: path.basename(uri.fsPath),
                    sourceLanguage: '',
                    targetLanguage: inferLocaleFromFilename(uri.fsPath),
                    error: formatError(err),
                    metrics: emptyMetrics()
                });
            }
        }

        const missingLocales = await findMissingSupportedLocaleRows(files);
        const projects = await this.scanProjects();
        const allLanguages = [...files, ...missingLocales].sort((a, b) => {
            const projectCmp = String(a.project).localeCompare(String(b.project), undefined, { sensitivity: 'base' });
            if (projectCmp) return projectCmp;
            return String(a.targetLanguage || a.fileName).localeCompare(String(b.targetLanguage || b.fileName), undefined, { sensitivity: 'base' });
        });
        const totals = calculateActivityTotals(allLanguages);

        return { files, languages: allLanguages, projects, totals, error: '' };
    }

    async scanFile(uri, config, glossaryCache = new Map()) {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
        let projectRoot;
        try { projectRoot = await findProjectRoot(uri); } catch (_) { projectRoot = undefined; }
        const projectKey = projectRoot ? projectRoot.toString() : '';
        let glossaryEntries = [];
        if (config.get('glossary.enabled', true)) {
            if (!glossaryCache.has(projectKey)) {
                const glossary = await readProjectGlossary(uri);
                glossaryCache.set(projectKey, glossary.entries || []);
            }
            glossaryEntries = glossaryCache.get(projectKey) || [];
        }
        const text = await readText(uri);
        const session = getDocumentSession(uri, text);
        const parsed = await getParsedDocumentSessionAsync(session, text, async value => (await parseXliffAdaptive(value, config)).parsed);
        const qualityAnalysis = await analyzeQualityForText(uri, text, {
            config,
            session,
            parsed,
            glossary: { entries: glossaryEntries }
        });
        const treatNeedsTranslationAsMissing = config.get('treatNeedsTranslationAsMissing', true);
        const metricsSignature = `${qualityAnalysis.fingerprint}:missing=${treatNeedsTranslationAsMissing ? '1' : '0'}`;
        let metrics = getDocumentSessionStats(session, 'dashboardMetrics', metricsSignature);
        if (!metrics) {
            metrics = calculateXliffMetrics(parsed, {
                treatNeedsTranslationAsMissing,
                qualitySummary: qualityAnalysis.report.summary
            });
            setDocumentSessionStats(session, 'dashboardMetrics', metricsSignature, metrics);
        }
        return {
            kind: 'file',
            uri: uri.toString(),
            projectRoot: projectKey,
            project: workspaceFolder ? workspaceFolder.name : '',
            relativePath: workspaceFolder ? path.relative(workspaceFolder.uri.fsPath, uri.fsPath).split(path.sep).join('/') : path.basename(uri.fsPath),
            fileName: path.basename(uri.fsPath),
            sourceLanguage: parsed.sourceLanguage || '',
            targetLanguage: parsed.targetLanguage || inferLocaleFromFilename(uri.fsPath),
            metrics
        };
    }

    async scanProjects() {
        const appJsonUris = await vscode.workspace.findFiles('**/app.json', '**/{.git,node_modules,.alpackages}/**');
        const projects = [];
        const debugConfig = vscode.workspace.getConfiguration(CONFIG_SECTION);
        const debugEnabled = debugConfig.get('debug.enabled', false) === true;
        const performanceDebugEnabled = debugConfig.get('debug.performance.enabled', false) === true;
        for (const appJsonUri of appJsonUris) {
            try {
                const app = parseAppSupportedLocales(await readText(appJsonUri));
                const root = vscode.Uri.file(path.dirname(appJsonUri.fsPath));
                const workspaceFolder = vscode.workspace.getWorkspaceFolder(appJsonUri);
                const generators = await vscode.workspace.findFiles(new vscode.RelativePattern(root.fsPath, 'Translations/*.g.xlf'));
                projects.push({
                    name: app.name || (workspaceFolder ? workspaceFolder.name : path.basename(root.fsPath)),
                    rootUri: root.toString(),
                    appJsonUri: appJsonUri.toString(),
                    generators: generators.map(uri => uri.toString()),
                    studioUri: vscode.Uri.joinPath(root, STUDIO_DIRECTORY).toString(),
                    languageMapUri: vscode.Uri.joinPath(root, STUDIO_DIRECTORY, LANGUAGE_MAP_DIRECTORY).toString(),
                    debugEnabled,
                    performanceDebugEnabled
                });
            } catch (_) {
                // Keep the Activity Bar usable if another AL project has a temporarily invalid app.json.
            }
        }
        return projects.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    }

    getTreeItem(element) {
        const item = new vscode.TreeItem(element.label, element.collapsibleState == null ? vscode.TreeItemCollapsibleState.None : element.collapsibleState);
        if (element.description) item.description = element.description;
        if (element.tooltip) item.tooltip = element.tooltip;
        if (element.icon) item.iconPath = new vscode.ThemeIcon(element.icon);
        if (element.command) item.command = element.command;
        if (element.contextValue) item.contextValue = element.contextValue;
        if (element.resourceUri) item.resourceUri = element.resourceUri;
        return item;
    }

    async getChildren(element) {
        if (!this.loaded) await this.refresh();
        if (!element) {
            const languageCount = this.snapshot.languages.length;
            const projectCount = this.snapshot.projects.length;
            const roots = [
                node('section-languages', 'Languages', `${languageCount}`, 'globe', vscode.TreeItemCollapsibleState.Expanded),
                node('section-tools', 'Tools', '', 'tools', vscode.TreeItemCollapsibleState.Expanded),
                node('section-project', 'Project', projectCount > 1 ? `${projectCount} projects` : '', 'project', vscode.TreeItemCollapsibleState.Expanded)
            ];
            if (this.snapshot.error) roots.unshift(node('error', 'Could not load AL Xliff Studio overview', '', 'error', vscode.TreeItemCollapsibleState.None, this.snapshot.error));
            return roots;
        }

        if (element.id === 'section-languages') return this.languageNodes();
        if (element.id === 'section-tools') return this.toolNodes();
        if (element.id === 'section-project') return this.projectNodes();
        if (element.kind === 'translation-language') return this.languageActionNodes(element);
        if (element.kind === 'project-group') return this.projectResourceNodes(element.project);
        return [];
    }

    languageNodes() {
        const multiProject = new Set(this.snapshot.languages.map(item => item.project).filter(Boolean)).size > 1;
        if (!this.snapshot.languages.length) {
            return [node('languages-empty', 'No translation XLIFFs found', '', 'info', vscode.TreeItemCollapsibleState.None, 'No translation XLIFFs or missing supportedLocales were found.')];
        }
        return this.snapshot.languages.map((entry, index) => {
            const locale = entry.targetLanguage || entry.fileName || 'Unknown language';
            if (entry.kind === 'missing-locale') {
                const canGenerate = Boolean(entry.generateAvailable && entry.generatorUri);
                const description = multiProject ? `${entry.project} · Not created` : 'Not created';
                const tooltip = `${locale} is listed in app.json supportedLocales but no translation XLIFF exists.${canGenerate ? '\nClick to generate it from the project .g.xlf.' : '\nNo unambiguous .g.xlf is available for generation.'}`;
                return node(
                    `language-missing-${index}`,
                    locale,
                    description,
                    canGenerate ? 'add' : 'warning',
                    vscode.TreeItemCollapsibleState.None,
                    tooltip,
                    canGenerate ? command(`${COMMAND_PREFIX}.activity.generateLocale`, 'Generate XLIFF', { generatorUri: entry.generatorUri, targetLanguage: locale }) : undefined
                );
            }
            if (entry.error) {
                return node(
                    `language-error-${index}`,
                    locale,
                    multiProject ? `${entry.project} · Error` : 'Error',
                    'error',
                    vscode.TreeItemCollapsibleState.None,
                    `${entry.relativePath}\n${entry.error}`,
                    command(`${COMMAND_PREFIX}.openXliffEditor`, 'Open XLIFF', vscode.Uri.parse(entry.uri))
                );
            }
            const metrics = entry.metrics || emptyMetrics();
            const parts = [];
            if (metrics.missing) parts.push(`${metrics.missing} missing`);
            if (metrics.review) parts.push(`${metrics.review} review`);
            if (metrics.qualityIssues) parts.push(`${metrics.qualityIssues} quality`);
            const ready = parts.length === 0;
            const status = ready ? 'Ready' : parts.join(' · ');
            const description = multiProject ? `${entry.project} · ${status}` : status;
            const tooltip = [
                `${entry.sourceLanguage || '?'} → ${locale}`,
                entry.relativePath,
                `${metrics.translated || 0} / ${metrics.total || 0} translated`,
                `${metrics.missing || 0} missing`,
                `${metrics.review || 0} review`,
                `${metrics.qualityIssues || 0} quality issue${metrics.qualityIssues === 1 ? '' : 's'}`,
                '',
                'Click to open this XLIFF in AL Xliff Studio.'
            ].join('\n');
            const language = node(
                `language-${index}`,
                locale,
                description,
                ready ? 'check' : 'warning',
                vscode.TreeItemCollapsibleState.Collapsed,
                tooltip,
                command(`${COMMAND_PREFIX}.openXliffEditor`, 'Open XLIFF', vscode.Uri.parse(entry.uri))
            );
            language.kind = 'translation-language'; language.entry = entry;
            return language;
        });
    }

    languageActionNodes(element) {
        const entry = element.entry, m = entry.metrics || {}, uri = vscode.Uri.parse(entry.uri);
        const wizard = (workflow, label, description, icon, enabled, tooltip) => {
            const item = node(element.id + '-' + workflow, label, description, icon, vscode.TreeItemCollapsibleState.None, tooltip);
            if (enabled) item.command = { command: COMMAND_PREFIX + '.openGuidedTranslation', title: label, arguments: [uri, workflow] };
            return item;
        };
        return [
            wizard('', 'Guided Translation', 'Wizard', 'wand', true, 'Common guided workflow: previous/next navigation, protected drafts, AI and Developer proposals, invisible characters, Save and final summary with follow-up actions.'),
            wizard('new-language', 'New language', 'Sync and local import', 'globe', m.missing > 0, 'Check selected-file Sync, prepare Developer/.lng/glossary drafts, then translate.'),
            wizard('translate-missing', 'Translate missing', String(m.missing || 0), 'edit', m.missing > 0, 'Translate missing entries one at a time.'),
            wizard('review', 'Review translations', String(m.review || 0), 'checklist', m.review > 0, 'Review translations, drafts and proposals; enabled only when review entries exist.'),
            wizard('quality-fix', 'Fix quality issues', String(m.qualityIssues || 0), 'warning', m.qualityIssues > 0, 'Fix quality issues; matching Developer comments appear as proposals.'),
            wizard('sync-project', 'Sync this XLIFF', entry.syncStatus || '', 'sync', entry.syncStatus === 'out-of-sync', 'Synchronize only this language; dashboard updates its row.'),
            node(element.id + '-expert', 'Expert XLIFF Editor', '', 'file-code', vscode.TreeItemCollapsibleState.None, 'Open the full editor with filters and pagination.', command(COMMAND_PREFIX + '.openXliffEditor', 'Open XLIFF', uri))
        ];
    }

    toolNodes() {
        return [
            node('tool-dashboard', 'Translation Dashboard', 'Project overview', 'dashboard', vscode.TreeItemCollapsibleState.None, 'Open the project-wide Translation Dashboard.', command(`${COMMAND_PREFIX}.openDashboard`, 'Open Translation Dashboard')),
            node('tool-glossary', 'Glossary', 'Terminology', 'book', vscode.TreeItemCollapsibleState.None, 'Open the AL Xliff Studio terminology glossary.', command(`${COMMAND_PREFIX}.openGlossary`, 'Open Glossary')),
            node('tool-ai-usage', 'AI Usage', 'Token statistics', 'graph', vscode.TreeItemCollapsibleState.None, 'Open persistent AI token usage statistics.', command(`${COMMAND_PREFIX}.openAiUsage`, 'Open AI Usage')),
            node('tool-sync', 'Sync all XLIFFs', '', 'sync', vscode.TreeItemCollapsibleState.None, 'Synchronize all translation XLIFFs with their matching .g.xlf.', command(`${COMMAND_PREFIX}.activity.syncAll`, 'Sync all XLIFFs')),
            node('tool-quality', 'Quality Check', '', 'checklist', vscode.TreeItemCollapsibleState.None, 'Run the Quality Check for all translation XLIFFs and open the Problems view.', command(`${COMMAND_PREFIX}.activity.qualityAll`, 'Run Quality Check')),
            node('tool-refresh', 'Refresh', '', 'refresh', vscode.TreeItemCollapsibleState.None, 'Refresh the AL Xliff Studio Activity Bar overview.', command(`${COMMAND_PREFIX}.activity.refresh`, 'Refresh'))
        ];
    }

    projectNodes() {
        if (!this.snapshot.projects.length) {
            return [node('project-empty', 'No app.json found', '', 'warning', vscode.TreeItemCollapsibleState.None, 'No AL project app.json was found in the workspace.')];
        }
        if (this.snapshot.projects.length === 1) return this.projectResourceNodes(this.snapshot.projects[0]);
        return this.snapshot.projects.map((project, index) => ({
            id: `project-group-${index}`,
            kind: 'project-group',
            project,
            label: project.name,
            description: 'AL project',
            icon: 'folder',
            collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
            tooltip: vscode.Uri.parse(project.rootUri).fsPath
        }));
    }

    projectResourceNodes(project) {
        const rootUri = vscode.Uri.parse(project.rootUri);
        const items = [
            node(`project-root-${project.rootUri}`, project.name, 'AL project', 'project', vscode.TreeItemCollapsibleState.None, rootUri.fsPath, command(`${COMMAND_PREFIX}.activity.reveal`, 'Reveal project', { uri: project.rootUri, ensureStudio: false })),
            node(`project-app-${project.rootUri}`, 'app.json', '', 'json', vscode.TreeItemCollapsibleState.None, vscode.Uri.parse(project.appJsonUri).fsPath, command(`${COMMAND_PREFIX}.activity.openText`, 'Open app.json', project.appJsonUri))
        ];
        for (let i = 0; i < project.generators.length; i++) {
            const uri = vscode.Uri.parse(project.generators[i]);
            items.push(node(`project-generator-${project.rootUri}-${i}`, path.basename(uri.fsPath), '.g.xlf', 'file-code', vscode.TreeItemCollapsibleState.None, uri.fsPath, command(`${COMMAND_PREFIX}.activity.openText`, 'Open generated XLIFF', project.generators[i])));
        }
        if (!project.generators.length) {
            items.push(node(`project-generator-missing-${project.rootUri}`, 'No .g.xlf found', '', 'warning', vscode.TreeItemCollapsibleState.None, 'No Translations/*.g.xlf was found in this AL project.'));
        }
        items.push(
            node(`project-studio-${project.rootUri}`, '.alxliffstudio', 'Studio data', 'folder', vscode.TreeItemCollapsibleState.None, vscode.Uri.parse(project.studioUri).fsPath, command(`${COMMAND_PREFIX}.activity.reveal`, 'Reveal .alxliffstudio', { uri: project.studioUri, ensureStudio: true, projectUri: project.rootUri })),
            node(`project-lng-${project.rootUri}`, 'Translation Memory', '.alxliffstudio/lng', 'database', vscode.TreeItemCollapsibleState.None, vscode.Uri.parse(project.languageMapUri).fsPath, command(`${COMMAND_PREFIX}.activity.reveal`, 'Reveal Translation Memory', { uri: project.languageMapUri, ensureStudio: true, projectUri: project.rootUri })),
            node(`project-glossary-${project.rootUri}`, 'Glossary', '.alxliffstudio/glossary.json', 'book', vscode.TreeItemCollapsibleState.None, 'Open the terminology glossary for this AL project.', command(`${COMMAND_PREFIX}.openGlossary`, 'Open Glossary', rootUri))
        );
        if (project.debugEnabled) {
            items.push(node(`project-debug-${project.rootUri}`, 'AI Debug Log', '.alxliffstudio/debug', 'output', vscode.TreeItemCollapsibleState.None, 'Open the AI request/response debug log for this project.', command(`${COMMAND_PREFIX}.openAiDebugLog`, 'Open AI Debug Log', rootUri)));
        }
        if (project.performanceDebugEnabled) {
            items.push(node(`project-performance-debug-${project.rootUri}`, 'Performance Debug Log', '.alxliffstudio/debug/performance.log', 'pulse', vscode.TreeItemCollapsibleState.None, 'Open detailed timing traces for XLIFF loading, saving, draft persistence, Quality Check, editor messages, and webview rendering.', command(`${COMMAND_PREFIX}.openPerformanceDebugLog`, 'Open Performance Debug Log', rootUri)));
        }
        return items;
    }

    async generateLocale(arg) {
        const value = arg && typeof arg === 'object' ? arg : {};
        const targetLanguage = String(value.targetLanguage || '').trim().replace(/_/g, '-');
        let generatorUri;
        try { generatorUri = vscode.Uri.parse(String(value.generatorUri || '')); } catch (_) { generatorUri = undefined; }
        if (!targetLanguage || !generatorUri || !generatorUri.fsPath || !generatorUri.fsPath.toLowerCase().endsWith('.g.xlf')) {
            throw new Error('The generated .g.xlf or target locale is no longer available.');
        }
        const projectRoot = await findProjectRoot(generatorUri);
        if (!projectRoot) throw new Error('Could not determine the AL project for the selected .g.xlf.');
        const app = parseAppSupportedLocales(await readText(vscode.Uri.joinPath(projectRoot, 'app.json')));
        if (!app.supportedLocales.some(locale => normalizeLocale(locale) === normalizeLocale(targetLanguage))) {
            throw new Error(`${targetLanguage} is no longer listed in app.json supportedLocales.`);
        }
        const generatorText = await readText(generatorUri);
        const generatorSession = getDocumentSession(generatorUri, generatorText);
        const generatorConfig = vscode.workspace.getConfiguration(CONFIG_SECTION, generatorUri);
        const parsed = await getParsedDocumentSessionAsync(generatorSession, generatorText, async value => (await parseXliffAdaptive(value, generatorConfig)).parsed);
        if (normalizeLocale(parsed.sourceLanguage) === normalizeLocale(targetLanguage)) {
            throw new Error(`${targetLanguage} is the source language and does not require a translation XLIFF.`);
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
        await vscode.workspace.fs.writeFile(targetUri, Buffer.from(text, 'utf8'));
        vscode.window.showInformationMessage(`${BRAND_NAME}: created ${filename} for ${targetLanguage}.`);
        await this.refresh();
        await vscode.commands.executeCommand(`${COMMAND_PREFIX}.openXliffEditor`, targetUri);
    }
}

function registerActivityBar(context, options = {}) {
    const provider = new ActivityBarProvider(context, options).register();

    context.subscriptions.push(
        vscode.commands.registerCommand(`${COMMAND_PREFIX}.activity.refresh`, () => provider.refresh()),
        vscode.commands.registerCommand(`${COMMAND_PREFIX}.activity.generateLocale`, async arg => {
            try { await provider.generateLocale(arg); }
            catch (err) { vscode.window.showErrorMessage(`${BRAND_NAME}: ${formatError(err)}`); }
        }),
        vscode.commands.registerCommand(`${COMMAND_PREFIX}.activity.openText`, async uriValue => {
            try {
                const uri = toUri(uriValue);
                if (!uri) return;
                const document = await vscode.workspace.openTextDocument(uri);
                await vscode.window.showTextDocument(document, { preview: false });
            } catch (err) {
                vscode.window.showErrorMessage(`${BRAND_NAME}: ${formatError(err)}`);
            }
        }),
        vscode.commands.registerCommand(`${COMMAND_PREFIX}.activity.reveal`, async arg => {
            try {
                const value = arg && typeof arg === 'object' ? arg : { uri: arg };
                if (value.ensureStudio) await ensureStudioStructure(toUri(value.projectUri || value.uri));
                const uri = toUri(value.uri);
                if (uri) await vscode.commands.executeCommand('revealInExplorer', uri);
            } catch (err) {
                vscode.window.showErrorMessage(`${BRAND_NAME}: ${formatError(err)}`);
            }
        }),
        vscode.commands.registerCommand(`${COMMAND_PREFIX}.activity.syncAll`, async () => {
            if (typeof options.syncAll === 'function') await options.syncAll();
            await provider.refresh();
        }),
        vscode.commands.registerCommand(`${COMMAND_PREFIX}.activity.qualityAll`, async () => {
            if (options.qualityManager && typeof options.qualityManager.scanWorkspace === 'function') {
                await options.qualityManager.scanWorkspace();
            }
            await vscode.commands.executeCommand('workbench.actions.view.problems');
            await provider.refresh();
        })
    );
    return provider;
}

function node(id, label, description, icon, collapsibleState, tooltip, cmd) {
    return { id, label, description, icon, collapsibleState, tooltip, command: cmd };
}

function command(commandId, title, argument) {
    const result = { command: commandId, title };
    if (argument !== undefined) result.arguments = [argument];
    return result;
}

function toUri(value) {
    if (!value) return undefined;
    if (value.scheme && typeof value.toString === 'function') return value;
    try { return vscode.Uri.parse(String(value)); } catch (_) { return undefined; }
}

function inferLocaleFromFilename(filePath) {
    const match = path.basename(String(filePath || '')).match(/\.([a-z]{2,3}(?:-[A-Za-z0-9]{2,8})+)\.xlf$/i);
    return match ? match[1] : '';
}

function calculateActivityTotals(languages) {
    return (languages || []).reduce((sum, item) => {
        if (item.kind === 'missing-locale') {
            sum.missingLocales++;
            return sum;
        }
        if (item.error) {
            sum.errors++;
            return sum;
        }
        sum.missing += Number(item.metrics && item.metrics.missing || 0);
        sum.review += Number(item.metrics && item.metrics.review || 0);
        sum.quality += Number(item.metrics && item.metrics.qualityIssues || 0);
        return sum;
    }, { missing: 0, review: 0, quality: 0, missingLocales: 0, errors: 0 });
}

function emptyMetrics() {
    return { total: 0, translated: 0, missing: 0, review: 0, placeholderErrors: 0, qualityIssues: 0 };
}

function emptySnapshot() {
    return { files: [], languages: [], projects: [], totals: { missing: 0, review: 0, quality: 0, missingLocales: 0, errors: 0 }, error: '' };
}

async function readText(uri) {
    const openDocument = (vscode.workspace.textDocuments || []).find(document => document.uri.toString() === uri.toString());
    if (openDocument) return openDocument.getText();
    return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
}

function formatError(err) {
    return err instanceof Error ? err.message : String(err || 'Unknown error');
}

module.exports = {
    ActivityBarProvider,
    registerActivityBar,
    inferLocaleFromFilename,
    emptySnapshot
};
