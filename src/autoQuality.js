'use strict';

const vscode = require('vscode');
const path = require('path');
const { CONFIG_SECTION, BRAND_NAME } = require('./identity');
const { XliffEditorProvider } = require('./xlfEditor');
const { invalidateQualityAnalysis } = require('./qualityCoordinator');
const { invalidateDocumentSession } = require('./documentSession');
const { DEFAULT_GLOSSARY_FILENAME, LEGACY_GLOSSARY_FILENAME } = require('./glossary');
const { STUDIO_DIRECTORY, PROJECT_QUALITY_IGNORE_FILENAME } = require('./studioPaths');

const QUALITY_RELEVANT_SETTINGS = [
    `${CONFIG_SECTION}.quality`,
    `${CONFIG_SECTION}.validation.checkMaxWidth`,
    `${CONFIG_SECTION}.glossary`,
    `${CONFIG_SECTION}.xliffGlob`,
    `${CONFIG_SECTION}.excludeGlob`
];

class AutomaticQualityChecks {
    constructor(context) {
        this.context = context;
        this.disposables = [];
        this.pending = new Map();
        this.scanGeneration = 0;
    }

    start() {
        const xlfWatcher = vscode.workspace.createFileSystemWatcher('**/*.xlf');
        xlfWatcher.onDidCreate(uri => this.scheduleXliff(uri), null, this.disposables);
        xlfWatcher.onDidChange(uri => this.scheduleXliff(uri), null, this.disposables);
        xlfWatcher.onDidDelete(uri => this.clearXliff(uri), null, this.disposables);
        this.disposables.push(xlfWatcher);

        const qualityDependencyWatchers = [
            vscode.workspace.createFileSystemWatcher(`**/${STUDIO_DIRECTORY}/${DEFAULT_GLOSSARY_FILENAME}`),
            vscode.workspace.createFileSystemWatcher(`**/${LEGACY_GLOSSARY_FILENAME}`),
            vscode.workspace.createFileSystemWatcher(`**/${STUDIO_DIRECTORY}/${PROJECT_QUALITY_IGNORE_FILENAME}`)
        ];
        for (const dependencyWatcher of qualityDependencyWatchers) {
            dependencyWatcher.onDidCreate(uri => this.scheduleWorkspaceFolder(uri), null, this.disposables);
            dependencyWatcher.onDidChange(uri => this.scheduleWorkspaceFolder(uri), null, this.disposables);
            dependencyWatcher.onDidDelete(uri => this.scheduleWorkspaceFolder(uri), null, this.disposables);
            this.disposables.push(dependencyWatcher);
        }

        this.disposables.push(vscode.workspace.onDidSaveTextDocument(document => {
            if (isTranslationXliff(document.uri)) {
                this.scheduleXliff(document.uri, document.getText(), 50);
                return;
            }
            if (this.isQualityDependencyResource(document.uri)) this.scheduleWorkspaceFolder(document.uri, 100);
        }));

        this.disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
            this.scheduleFullScan(150);
        }));

        this.disposables.push(vscode.workspace.onDidChangeConfiguration(event => {
            if (!QUALITY_RELEVANT_SETTINGS.some(setting => event.affectsConfiguration(setting))) return;
            invalidateQualityAnalysis();
            if (this.isEnabled()) this.scheduleFullScan(150);
        }));

        this.context.subscriptions.push(...this.disposables, { dispose: () => this.dispose() });
        if (this.isEnabled()) this.scheduleFullScan(500);
    }

    dispose() {
        for (const timer of this.pending.values()) clearTimeout(timer);
        this.pending.clear();
        for (const disposable of this.disposables.splice(0)) {
            try { disposable.dispose(); } catch (_) { /* ignore */ }
        }
    }

    isEnabled(resource) {
        return vscode.workspace.getConfiguration(CONFIG_SECTION, resource).get('quality.autoRun.enabled', true) !== false;
    }

    scheduleXliff(uri, text, delay = 250) {
        if (!isTranslationXliff(uri) || !this.isEnabled(uri)) return;
        const key = `xlf:${uri.toString()}`;
        this.schedule(key, delay, async () => {
            try {
                await XliffEditorProvider.runQualityCheckForUri(uri, typeof text === 'string' ? text : undefined);
            } catch (err) {
                // Broken/incomplete files can briefly exist while a generator or external
                // process is writing them. Leave the previous diagnostics untouched and let
                // the next file/save event retry rather than displaying a noisy popup.
            }
        });
    }

    clearXliff(uri) {
        if (!uri) return;
        invalidateQualityAnalysis(uri);
        invalidateDocumentSession(uri);
        XliffEditorProvider.clearQualityDiagnostics(uri);
    }

    scheduleWorkspaceFolder(resourceUri, delay = 250) {
        // Glossary changes alter quality results without changing XLIFF text. Invalidate
        // shared snapshots even when automatic diagnostics are disabled because the
        // Dashboard/Activity Bar use the same cache.
        invalidateQualityAnalysis();
        if (!this.isEnabled(resourceUri)) return;
        const folder = vscode.workspace.getWorkspaceFolder(resourceUri);
        if (!folder) {
            this.scheduleFullScan(delay);
            return;
        }
        const key = `folder:${folder.uri.toString()}`;
        this.schedule(key, delay, () => this.scanWorkspaceFolder(folder));
    }

    scheduleFullScan(delay = 250) {
        if (!this.isEnabled()) return;
        this.schedule('workspace', delay, () => this.scanWorkspace());
    }

    schedule(key, delay, callback) {
        const existing = this.pending.get(key);
        if (existing) clearTimeout(existing);
        const timer = setTimeout(async () => {
            this.pending.delete(key);
            await callback();
        }, Math.max(0, delay));
        this.pending.set(key, timer);
    }

    async scanWorkspace() {
        if (!this.isEnabled()) return;
        const generation = ++this.scanGeneration;
        const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
        const include = config.get('xliffGlob', '**/Translations/*.xlf');
        const exclude = config.get('excludeGlob', '**/*.g.xlf');
        const uris = await vscode.workspace.findFiles(include, exclude);
        if (generation !== this.scanGeneration) return;
        await this.runFilesWithProgress(uris, generation);
    }

    async scanWorkspaceFolder(folder) {
        if (!folder || !this.isEnabled(folder.uri)) return;
        const generation = ++this.scanGeneration;
        const config = vscode.workspace.getConfiguration(CONFIG_SECTION, folder.uri);
        const include = config.get('xliffGlob', '**/Translations/*.xlf');
        const exclude = config.get('excludeGlob', '**/*.g.xlf');
        const all = await vscode.workspace.findFiles(include, exclude);
        const prefix = folder.uri.toString().replace(/\/$/, '') + '/';
        const uris = all.filter(uri => uri.toString().startsWith(prefix));
        if (generation !== this.scanGeneration) return;
        await this.runFilesWithProgress(uris, generation);
    }

    async runFilesWithProgress(uris, generation) {
        if (!Array.isArray(uris) || !uris.length) return;
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Window,
            title: `${BRAND_NAME}: Quality Check`,
            cancellable: false
        }, async progress => {
            for (let index = 0; index < uris.length; index++) {
                if (generation !== this.scanGeneration || !this.isEnabled(uris[index])) return;
                const uri = uris[index];
                progress.report({ message: `${index + 1}/${uris.length} ${path.basename(uri.fsPath)}` });
                try {
                    await XliffEditorProvider.runQualityCheckForUri(uri);
                } catch (_) {
                    // Keep startup/background QA unobtrusive. Explicit Quality Check commands
                    // still surface parse/read errors to the user through their normal flow.
                }
                await yieldToEventLoop();
            }
        });
    }

    isQualityDependencyResource(uri) {
        if (!uri || !uri.fsPath) return false;
        const baseName = path.basename(uri.fsPath).toLowerCase();
        if (baseName === PROJECT_QUALITY_IGNORE_FILENAME.toLowerCase() && path.basename(path.dirname(uri.fsPath)).toLowerCase() === STUDIO_DIRECTORY.toLowerCase()) return true;
        if (baseName === LEGACY_GLOSSARY_FILENAME.toLowerCase()) return true;
        if (baseName === DEFAULT_GLOSSARY_FILENAME.toLowerCase() && path.basename(path.dirname(uri.fsPath)).toLowerCase() === STUDIO_DIRECTORY.toLowerCase()) return true;
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        if (!folder) return false;
        const configured = String(vscode.workspace.getConfiguration(CONFIG_SECTION, folder.uri).get('glossary.path', '') || '').trim();
        if (!configured) return false;
        const configuredPath = path.isAbsolute(configured) ? configured : path.join(folder.uri.fsPath, configured);
        return path.normalize(configuredPath).toLowerCase() === path.normalize(uri.fsPath).toLowerCase();
    }
}

function registerAutomaticQualityChecks(context) {
    const manager = new AutomaticQualityChecks(context);
    manager.start();
    return manager;
}

function isTranslationXliff(uri) {
    const fsPath = String(uri && uri.fsPath || '');
    const lower = fsPath.toLowerCase();
    return lower.endsWith('.xlf') && !lower.endsWith('.g.xlf');
}

function yieldToEventLoop() {
    return new Promise(resolve => setTimeout(resolve, 0));
}

module.exports = {
    AutomaticQualityChecks,
    registerAutomaticQualityChecks,
    isTranslationXliff,
    QUALITY_RELEVANT_SETTINGS
};
