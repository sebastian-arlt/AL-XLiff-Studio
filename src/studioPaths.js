'use strict';

const vscode = require('vscode');
const path = require('path');
const { parseLng, serializeLng, mergeEntries } = require('./lng');

const STUDIO_DIRECTORY = '.alxliffstudio';
const LANGUAGE_MAP_DIRECTORY = 'lng';
const GLOSSARY_FILENAME = 'glossary.json';
const AI_USAGE_FILENAME = 'ai-usage.json';
const AI_DEBUG_DIRECTORY = 'debug';
const AI_DEBUG_FILENAME = 'ai-debug.log';
const PERFORMANCE_DEBUG_FILENAME = 'performance.log';
const PROJECT_QUALITY_IGNORE_FILENAME = 'quality-ignores.json';
const STUDIO_GITIGNORE_ENTRIES = ['ai-usage.json', 'debug/'];

async function findProjectRoot(resourceUri) {
    const folder = getWorkspaceFolder(resourceUri);
    if (!folder) return undefined;

    if (!resourceUri || resourceUri.scheme !== 'file' || !resourceUri.fsPath || folder.uri.scheme !== 'file') {
        return folder.uri;
    }

    const boundary = path.resolve(folder.uri.fsPath);
    const resourcePath = path.resolve(resourceUri.fsPath);
    const workspacePath = path.resolve(folder.uri.fsPath);
    let current = resourcePath === workspacePath ? resourcePath : path.dirname(resourcePath);
    while (current === boundary || current.startsWith(boundary + path.sep)) {
        const appJson = vscode.Uri.file(path.join(current, 'app.json'));
        if (await workspaceFileExists(appJson)) return vscode.Uri.file(current);
        if (current === boundary) break;
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }
    return folder.uri;
}

function getWorkspaceFolder(resourceUri) {
    let folder = resourceUri && vscode.workspace.getWorkspaceFolder
        ? vscode.workspace.getWorkspaceFolder(resourceUri)
        : undefined;
    if (!folder && vscode.window && vscode.window.activeTextEditor && vscode.workspace.getWorkspaceFolder) {
        folder = vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri);
    }
    const folders = vscode.workspace.workspaceFolders || [];
    if (!folder && folders.length === 1) folder = folders[0];
    return folder;
}

async function getStudioDirectoryUri(resourceUri) {
    const root = await findProjectRoot(resourceUri);
    return root ? vscode.Uri.joinPath(root, STUDIO_DIRECTORY) : undefined;
}

async function getLanguageMapDirectoryUri(resourceUri) {
    const studio = await getStudioDirectoryUri(resourceUri);
    return studio ? vscode.Uri.joinPath(studio, LANGUAGE_MAP_DIRECTORY) : undefined;
}

async function getLanguageMapUri(xlfUri, language) {
    const directory = await getLanguageMapDirectoryUri(xlfUri);
    if (!directory) return getLegacyLanguageMapUri(xlfUri, language);
    return vscode.Uri.joinPath(directory, languageMapFilename(xlfUri, language));
}

function getLegacyLanguageMapUri(xlfUri, language) {
    if (!xlfUri || !xlfUri.fsPath) return undefined;
    const ext = path.extname(xlfUri.fsPath);
    let base = xlfUri.fsPath.slice(0, -ext.length);
    const localeSuffix = new RegExp(`\\.${escapeRegExp(language)}$`, 'i');
    if (!localeSuffix.test(base)) base += `.${language}`;
    return vscode.Uri.file(`${base}.lng`);
}

function languageMapFilename(xlfUri, language) {
    const filename = path.basename(xlfUri && xlfUri.fsPath || xlfUri && xlfUri.path || 'translations.xlf');
    const ext = path.extname(filename);
    let base = ext ? filename.slice(0, -ext.length) : filename;
    const localeSuffix = new RegExp(`\\.${escapeRegExp(language)}$`, 'i');
    if (!localeSuffix.test(base)) base += `.${language}`;
    return `${base}.lng`;
}

async function migrateLegacyLanguageMapIfNeeded(xlfUri, language) {
    const target = await getLanguageMapUri(xlfUri, language);
    if (!target) return undefined;
    if (await workspaceFileExists(target)) return target;

    const legacy = getLegacyLanguageMapUri(xlfUri, language);
    if (!legacy || sameUri(legacy, target) || !await workspaceFileExists(legacy)) return target;

    await ensureStudioStructure(xlfUri);
    const content = await vscode.workspace.fs.readFile(legacy);
    await vscode.workspace.fs.writeFile(target, content);
    try {
        if (typeof vscode.workspace.fs.delete === 'function') await vscode.workspace.fs.delete(legacy, { useTrash: false });
    } catch (_) {
        // The new location is already complete. Leaving the legacy file is safer than
        // treating a cleanup failure as a migration failure.
    }
    return target;
}


async function migrateWorkspaceLegacyLanguageMaps() {
    if (!vscode.workspace.findFiles) return { migrated: 0, merged: 0, skipped: 0 };
    const legacyFiles = await vscode.workspace.findFiles('**/*.lng', `**/{.git,node_modules,.alpackages,${STUDIO_DIRECTORY}}/**`);
    const result = { migrated: 0, merged: 0, skipped: 0 };

    for (const legacy of legacyFiles) {
        if (!legacy || legacy.scheme !== 'file' || !legacy.fsPath) continue;
        const language = inferLanguageFromLngFilename(legacy.fsPath);
        if (!language) continue;
        const xlfUri = vscode.Uri.file(legacy.fsPath.slice(0, -4) + '.xlf');
        if (!await workspaceFileExists(xlfUri) || xlfUri.fsPath.toLowerCase().endsWith('.g.xlf')) continue;

        const target = await getLanguageMapUri(xlfUri, language);
        if (!target || sameUri(legacy, target)) continue;
        await ensureStudioStructure(xlfUri);

        try {
            const legacyBytes = await vscode.workspace.fs.readFile(legacy);
            if (await workspaceFileExists(target)) {
                const currentText = Buffer.from(await vscode.workspace.fs.readFile(target)).toString('utf8');
                const legacyText = Buffer.from(legacyBytes).toString('utf8');
                const currentMap = parseLng(currentText);
                const legacyMap = parseLng(legacyText);
                if (currentMap.errors.length || legacyMap.errors.length) {
                    result.skipped += 1;
                    continue;
                }
                const merged = mergeEntries(currentMap.entries, legacyMap.entries, { overwrite: false });
                // Never delete the legacy map when the two locations disagree for the same
                // source. Keeping both is safer than silently choosing one translation.
                if (merged.conflicts.length) {
                    result.skipped += 1;
                    continue;
                }
                await vscode.workspace.fs.writeFile(target, Buffer.from(serializeLng(merged.entries, language), 'utf8'));
                result.merged += 1;
            } else {
                await vscode.workspace.fs.writeFile(target, legacyBytes);
                result.migrated += 1;
            }
            if (typeof vscode.workspace.fs.delete === 'function') {
                await vscode.workspace.fs.delete(legacy, { useTrash: false });
            }
        } catch (_) {
            result.skipped += 1;
        }
    }
    return result;
}

function inferLanguageFromLngFilename(filePath) {
    const match = path.basename(filePath || '').match(/\.([a-z]{2,3}(?:-[A-Za-z0-9]{2,8})+)\.lng$/i);
    return match ? match[1] : undefined;
}

async function getDefaultGlossaryUri(resourceUri) {
    const studio = await getStudioDirectoryUri(resourceUri);
    return studio ? vscode.Uri.joinPath(studio, GLOSSARY_FILENAME) : undefined;
}

async function getProjectQualityIgnoreUri(resourceUri) {
    const studio = await getStudioDirectoryUri(resourceUri);
    return studio ? vscode.Uri.joinPath(studio, PROJECT_QUALITY_IGNORE_FILENAME) : undefined;
}

async function getAiUsageUri(resourceUri) {
    const studio = await getStudioDirectoryUri(resourceUri);
    return studio ? vscode.Uri.joinPath(studio, AI_USAGE_FILENAME) : undefined;
}

async function getAiDebugDirectoryUri(resourceUri) {
    const studio = await getStudioDirectoryUri(resourceUri);
    return studio ? vscode.Uri.joinPath(studio, AI_DEBUG_DIRECTORY) : undefined;
}

async function getAiDebugLogUri(resourceUri) {
    const directory = await getAiDebugDirectoryUri(resourceUri);
    return directory ? vscode.Uri.joinPath(directory, AI_DEBUG_FILENAME) : undefined;
}

async function getPerformanceDebugLogUri(resourceUri) {
    const directory = await getAiDebugDirectoryUri(resourceUri);
    return directory ? vscode.Uri.joinPath(directory, PERFORMANCE_DEBUG_FILENAME) : undefined;
}

async function ensureAiDebugDirectory(resourceUri) {
    const studio = await ensureStudioStructure(resourceUri);
    if (!studio) return undefined;
    const directory = vscode.Uri.joinPath(studio, AI_DEBUG_DIRECTORY);
    if (vscode.workspace.fs.createDirectory) await vscode.workspace.fs.createDirectory(directory);
    return directory;
}

async function ensureStudioStructure(resourceUri) {
    const studio = await getStudioDirectoryUri(resourceUri);
    if (!studio) return undefined;
    if (vscode.workspace.fs.createDirectory) {
        await vscode.workspace.fs.createDirectory(studio);
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(studio, LANGUAGE_MAP_DIRECTORY));
    }
    const ignoreUri = vscode.Uri.joinPath(studio, '.gitignore');
    try {
        let existing = '';
        if (await workspaceFileExists(ignoreUri)) {
            existing = Buffer.from(await vscode.workspace.fs.readFile(ignoreUri)).toString('utf8');
        }
        const lines = existing.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        let changed = false;
        for (const entry of STUDIO_GITIGNORE_ENTRIES) {
            if (!lines.includes(entry)) {
                lines.push(entry);
                changed = true;
            }
        }
        if (changed || !existing) {
            await vscode.workspace.fs.writeFile(ignoreUri, Buffer.from(lines.join('\n') + '\n', 'utf8'));
        }
    } catch (_) { /* optional convenience */ }
    return studio;
}

async function workspaceFileExists(uri) {
    if (!uri) return false;
    try {
        await vscode.workspace.fs.stat(uri);
        return true;
    } catch (_) {
        return false;
    }
}

function sameUri(a, b) {
    if (!a || !b) return false;
    if (a.scheme === 'file' && b.scheme === 'file') return path.normalize(a.fsPath).toLowerCase() === path.normalize(b.fsPath).toLowerCase();
    return a.toString() === b.toString();
}

function escapeRegExp(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
    STUDIO_DIRECTORY,
    LANGUAGE_MAP_DIRECTORY,
    GLOSSARY_FILENAME,
    AI_USAGE_FILENAME,
    AI_DEBUG_DIRECTORY,
    AI_DEBUG_FILENAME,
    PERFORMANCE_DEBUG_FILENAME,
    PROJECT_QUALITY_IGNORE_FILENAME,
    findProjectRoot,
    getStudioDirectoryUri,
    getLanguageMapDirectoryUri,
    getLanguageMapUri,
    getLegacyLanguageMapUri,
    migrateLegacyLanguageMapIfNeeded,
    migrateWorkspaceLegacyLanguageMaps,
    getDefaultGlossaryUri,
    getProjectQualityIgnoreUri,
    getAiUsageUri,
    getAiDebugDirectoryUri,
    getAiDebugLogUri,
    getPerformanceDebugLogUri,
    ensureAiDebugDirectory,
    ensureStudioStructure,
    workspaceFileExists,
    languageMapFilename
};
