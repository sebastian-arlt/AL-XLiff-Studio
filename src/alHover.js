'use strict';

const vscode = require('vscode');
const path = require('path');
const { getDocumentSession, getParsedDocumentSessionAsync } = require('./documentSession');
const { BRAND_NAME, COMMAND_PREFIX, CONFIG_SECTION } = require('./identity');
const { parseXliffAdaptive } = require('./xlfWorkerHost');
const {
    extractHoverTargetFromLine,
    extractAlContext,
    selectBestUnit
} = require('./alHoverCore');

class AlTranslationHoverIndex {
    constructor() {
        this.fileLists = new Map();
        this.projectRoots = new Map();
    }

    clear() {
        this.fileLists.clear();
        this.projectRoots.clear();
    }

    invalidateUri(uri) {
        if (!uri) return;
        for (const [key, list] of this.fileLists.entries()) {
            if ((list.translationFiles || []).some(item => item.toString() === uri.toString()) ||
                (list.generatorFiles || []).some(item => item.toString() === uri.toString())) {
                this.fileLists.delete(key);
            }
        }
    }

    invalidateFileLists() {
        this.fileLists.clear();
    }

    async getTranslations(document, source, context, token) {
        const projectRoot = await this.findProjectRoot(document.uri);
        if (!projectRoot || (token && token.isCancellationRequested)) return [];
        const { translationFiles, generatorFiles } = await this.getFileList(projectRoot, document.uri);
        if (token && token.isCancellationRequested) return [];

        let generatorMatch;
        for (const uri of generatorFiles) {
            const parsed = await this.getParsed(uri);
            const selected = selectBestUnit(parsed.units, source, context);
            if (!selected.unit) continue;
            if (!generatorMatch || selected.score > generatorMatch.score ||
                (selected.score === generatorMatch.score && !selected.ambiguous && generatorMatch.ambiguous)) {
                generatorMatch = { uri, parsed, ...selected };
            }
        }

        let candidates = translationFiles.slice();
        if (generatorMatch) {
            const base = path.basename(generatorMatch.uri.fsPath).replace(/\.g\.xlf$/i, '');
            const sameApp = candidates.filter(uri => path.basename(uri.fsPath).toLowerCase().startsWith(`${base.toLowerCase()}.`));
            if (sameApp.length) candidates = sameApp;
        }

        const byLanguage = new Map();
        for (const uri of candidates) {
            if (token && token.isCancellationRequested) return [];
            const parsed = await this.getParsed(uri);
            if (!parsed.targetLanguage) continue;
            let unit;
            let matchCount = 0;
            let ambiguous = false;
            if (generatorMatch && generatorMatch.unit && generatorMatch.unit.id) {
                unit = parsed.units.find(item => item.id === generatorMatch.unit.id);
                if (unit) matchCount = 1;
            }
            if (!unit) {
                const selected = selectBestUnit(parsed.units, source, context);
                unit = selected.unit;
                matchCount = selected.matches;
                ambiguous = selected.ambiguous;
            }

            const language = String(parsed.targetLanguage || '').trim();
            if (!language) continue;
            const record = {
                language,
                uri,
                unit,
                unitId: unit && unit.id,
                source,
                target: unit && typeof unit.target === 'string' ? unit.target : '',
                state: unit && unit.targetState ? unit.targetState : '',
                matchCount,
                ambiguous,
                fileName: path.basename(uri.fsPath)
            };

            const existing = byLanguage.get(language.toLowerCase());
            if (!existing || this.preferRecord(record, existing, generatorMatch)) {
                byLanguage.set(language.toLowerCase(), record);
            }
        }

        return [...byLanguage.values()].sort((a, b) => a.language.localeCompare(b.language));
    }

    preferRecord(incoming, existing, generatorMatch) {
        if (incoming.unit && !existing.unit) return true;
        if (!incoming.unit && existing.unit) return false;
        if (generatorMatch) {
            const base = path.basename(generatorMatch.uri.fsPath).replace(/\.g\.xlf$/i, '').toLowerCase();
            const incomingMatches = incoming.fileName.toLowerCase().startsWith(`${base}.`);
            const existingMatches = existing.fileName.toLowerCase().startsWith(`${base}.`);
            if (incomingMatches !== existingMatches) return incomingMatches;
        }
        return incoming.fileName.localeCompare(existing.fileName) < 0;
    }

    async getFileList(projectRoot, resourceUri) {
        const config = vscode.workspace.getConfiguration(CONFIG_SECTION, resourceUri);
        const include = config.get('xliffGlob', '**/Translations/*.xlf');
        const exclude = config.get('excludeGlob', '**/*.g.xlf');
        const key = `${projectRoot.toString()}|${include}|${exclude}`;
        const cached = this.fileLists.get(key);
        if (cached) return cached;

        const translationFiles = await vscode.workspace.findFiles(
            new vscode.RelativePattern(projectRoot.fsPath, include),
            new vscode.RelativePattern(projectRoot.fsPath, exclude)
        );
        const generatorFiles = await vscode.workspace.findFiles(
            new vscode.RelativePattern(projectRoot.fsPath, '**/*.g.xlf')
        );
        const result = { translationFiles, generatorFiles };
        this.fileLists.set(key, result);
        return result;
    }

    async getParsed(uri) {
        const key = uri.toString();
        const openDocument = (vscode.workspace.textDocuments || []).find(document => document.uri.toString() === key);
        if (openDocument) {
            const text = openDocument.getText();
            const session = getDocumentSession(uri, text, { version: Number(openDocument.version) });
            const config = vscode.workspace.getConfiguration(CONFIG_SECTION, uri);
            return getParsedDocumentSessionAsync(session, text, async value => (await parseXliffAdaptive(value, config)).parsed);
        }
        const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
        const session = getDocumentSession(uri, text);
        const config = vscode.workspace.getConfiguration(CONFIG_SECTION, uri);
        return getParsedDocumentSessionAsync(session, text, async value => (await parseXliffAdaptive(value, config)).parsed);
    }

    async findProjectRoot(uri) {
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        if (!folder) return undefined;
        const cacheKey = path.dirname(uri.fsPath).toLowerCase();
        if (this.projectRoots.has(cacheKey)) return this.projectRoots.get(cacheKey);
        const boundary = path.resolve(folder.uri.fsPath);
        let current = path.resolve(path.dirname(uri.fsPath));
        while (current === boundary || current.startsWith(boundary + path.sep)) {
            const appJson = vscode.Uri.file(path.join(current, 'app.json'));
            try {
                await vscode.workspace.fs.stat(appJson);
                const root = vscode.Uri.file(current);
                this.projectRoots.set(cacheKey, root);
                return root;
            } catch (_) {
                // Keep walking towards the workspace root.
            }
            if (current === boundary) break;
            const parent = path.dirname(current);
            if (parent === current) break;
            current = parent;
        }
        this.projectRoots.set(cacheKey, folder.uri);
        return folder.uri;
    }
}

function registerAlTranslationHover(context) {
    const index = new AlTranslationHoverIndex();
    const commandId = `${COMMAND_PREFIX}.openTranslationUnit`;

    const provider = vscode.languages.registerHoverProvider({ language: 'al', scheme: 'file' }, {
        async provideHover(document, position, token) {
            const config = vscode.workspace.getConfiguration(CONFIG_SECTION, document.uri);
            if (config.get('hover.enabled', true) === false) return undefined;
            const line = document.lineAt(position.line).text;
            const target = extractHoverTargetFromLine(line, position.character);
            if (!target || !target.source) return undefined;

            const lines = [];
            for (let i = 0; i < document.lineCount; i++) lines.push(document.lineAt(i).text);
            const alContext = extractAlContext(lines, position.line, target);
            const translations = await index.getTranslations(document, target.source, alContext, token);
            if (!translations.length || (token && token.isCancellationRequested)) return undefined;

            const markdown = new vscode.MarkdownString(undefined, true);
            markdown.supportThemeIcons = true;
            markdown.isTrusted = { enabledCommands: [commandId] };
            markdown.appendMarkdown(`**${escapeMarkdown(BRAND_NAME)} translations**  \n`);
            markdown.appendMarkdown(`\`${escapeInlineCode(target.source)}\`\n\n`);

            for (const item of translations) {
                const status = formatTargetStatus(item);
                if (item.unit && item.unitId) {
                    const args = encodeURIComponent(JSON.stringify([{ uri: item.uri.toString(), unitId: item.unitId, source: target.source }]));
                    const ambiguity = item.ambiguous && item.matchCount > 1 ? ` · ${item.matchCount} matches` : '';
                    markdown.appendMarkdown(`[$(globe) ${escapeMarkdown(item.language)}](command:${commandId}?${args}) — ${status}${escapeMarkdown(ambiguity)}  \n`);
                } else {
                    markdown.appendMarkdown(`$(circle-slash) **${escapeMarkdown(item.language)}** — _not synchronized_  \n`);
                }
            }

            const range = new vscode.Range(position.line, target.start, position.line, target.end);
            return new vscode.Hover(markdown, range);
        }
    });

    const watcher = vscode.workspace.createFileSystemWatcher('**/*.xlf');
    watcher.onDidChange(uri => index.invalidateUri(uri));
    watcher.onDidCreate(uri => { index.invalidateUri(uri); index.invalidateFileLists(); });
    watcher.onDidDelete(uri => { index.invalidateUri(uri); index.invalidateFileLists(); });

    const textChange = vscode.workspace.onDidChangeTextDocument(event => {
        if (event.document.uri.fsPath && event.document.uri.fsPath.toLowerCase().endsWith('.xlf')) index.invalidateUri(event.document.uri);
    });
    const foldersChanged = vscode.workspace.onDidChangeWorkspaceFolders(() => index.clear());
    const configChanged = vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration(`${CONFIG_SECTION}.xliffGlob`) ||
            event.affectsConfiguration(`${CONFIG_SECTION}.excludeGlob`) ||
            event.affectsConfiguration(`${CONFIG_SECTION}.hover.enabled`)) {
            index.clear();
        }
    });

    context.subscriptions.push(provider, watcher, textChange, foldersChanged, configChanged);
    return index;
}

function formatTargetStatus(item) {
    const target = String(item.target || '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
    const state = String(item.state || '').trim();
    if (!target) return state ? `_missing_ · \`${escapeInlineCode(state)}\`` : '_missing_';
    const shortened = target.length > 100 ? `${target.slice(0, 97)}…` : target;
    return `${escapeMarkdown(shortened)}${state ? ` · \`${escapeInlineCode(state)}\`` : ' · `(no state)'}`;
}

function escapeMarkdown(value) {
    return String(value || '').replace(/([\\`*_{}\[\]()#+\-.!|>])/g, '\\$1');
}

function escapeInlineCode(value) {
    return String(value || '').replace(/`/g, '\\`').replace(/[\r\n]+/g, ' ');
}

module.exports = {
    AlTranslationHoverIndex,
    registerAlTranslationHover,
    formatTargetStatus
};
