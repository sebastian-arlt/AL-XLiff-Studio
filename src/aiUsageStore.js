'use strict';

const vscode = require('vscode');
const path = require('path');
const { CONFIG_SECTION } = require('./identity');
const { modelKey, modelLabel, languagePairKey, normalizeUsageEntry } = require('./aiUsage');
const {
    STUDIO_DIRECTORY,
    AI_USAGE_FILENAME,
    getAiUsageUri,
    ensureStudioStructure,
    workspaceFileExists
} = require('./studioPaths');

const AI_USAGE_VERSION = 1;
const MAX_RECENT_REQUESTS = 250;
const MAX_DAILY_ENTRIES = 365;
const writeQueues = new Map();
const persistedListeners = new Set();

function createEmptyUsageDocument() {
    return {
        version: AI_USAGE_VERSION,
        createdAt: new Date().toISOString(),
        updatedAt: undefined,
        totals: emptyStats(),
        models: [],
        languagePairs: [],
        days: [],
        recentRequests: []
    };
}

function emptyStats() {
    return {
        requests: 0,
        measuredRequests: 0,
        translationItems: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0
    };
}

function addEntryToStats(stats, entry) {
    stats.requests = Number(stats.requests || 0) + 1;
    if (entry.measured) stats.measuredRequests = Number(stats.measuredRequests || 0) + 1;
    stats.translationItems = Number(stats.translationItems || 0) + Number(entry.itemCount || 0);
    stats.inputTokens = Number(stats.inputTokens || 0) + Number(entry.inputTokens || 0);
    stats.outputTokens = Number(stats.outputTokens || 0) + Number(entry.outputTokens || 0);
    stats.totalTokens = Number(stats.inputTokens || 0) + Number(stats.outputTokens || 0);
}

function updateUsageDocument(rawDocument, rawEntry) {
    const document = normalizeUsageDocument(rawDocument);
    const entry = normalizeUsageEntry(rawEntry);
    document.updatedAt = entry.timestamp;
    addEntryToStats(document.totals, entry);

    const key = modelKey(entry.model);
    let model = document.models.find(item => item.key === key);
    if (!model) {
        model = {
            key,
            id: entry.model && entry.model.id ? String(entry.model.id) : '',
            name: modelLabel(entry.model),
            vendor: entry.model && entry.model.vendor ? String(entry.model.vendor) : '',
            family: entry.model && entry.model.family ? String(entry.model.family) : '',
            version: entry.model && entry.model.version ? String(entry.model.version) : '',
            ...emptyStats()
        };
        document.models.push(model);
    }
    addEntryToStats(model, entry);

    const pairKey = languagePairKey(entry.sourceLanguage, entry.targetLanguage);
    let pair = document.languagePairs.find(item => item.key === pairKey);
    if (!pair) {
        pair = {
            key: pairKey,
            sourceLanguage: entry.sourceLanguage || 'unknown',
            targetLanguage: entry.targetLanguage || 'unknown',
            ...emptyStats()
        };
        document.languagePairs.push(pair);
    }
    addEntryToStats(pair, entry);

    const dayKey = String(entry.timestamp || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
    let day = document.days.find(item => item.date === dayKey);
    if (!day) {
        day = { date: dayKey, ...emptyStats() };
        document.days.push(day);
    }
    addEntryToStats(day, entry);
    document.days.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    if (document.days.length > MAX_DAILY_ENTRIES) document.days.splice(0, document.days.length - MAX_DAILY_ENTRIES);

    document.recentRequests.push({
        timestamp: entry.timestamp,
        modelId: entry.model && entry.model.id ? String(entry.model.id) : '',
        modelName: modelLabel(entry.model),
        sourceLanguage: entry.sourceLanguage,
        targetLanguage: entry.targetLanguage,
        translationItems: entry.itemCount,
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
        totalTokens: entry.totalTokens,
        measured: entry.measured
    });
    if (document.recentRequests.length > MAX_RECENT_REQUESTS) {
        document.recentRequests.splice(0, document.recentRequests.length - MAX_RECENT_REQUESTS);
    }
    return document;
}

function normalizeUsageDocument(raw) {
    const input = raw && typeof raw === 'object' ? raw : {};
    const result = createEmptyUsageDocument();
    result.createdAt = input.createdAt || result.createdAt;
    result.updatedAt = input.updatedAt;
    result.totals = normalizeStats(input.totals);
    result.models = (Array.isArray(input.models) ? input.models : []).map(item => ({
        key: String(item.key || item.id || item.name || 'unknown'),
        id: String(item.id || ''),
        name: String(item.name || item.id || 'Unknown model'),
        vendor: String(item.vendor || ''),
        family: String(item.family || ''),
        version: String(item.version || ''),
        ...normalizeStats(item)
    }));
    result.languagePairs = (Array.isArray(input.languagePairs) ? input.languagePairs : []).map(item => ({
        key: String(item.key || languagePairKey(item.sourceLanguage, item.targetLanguage)),
        sourceLanguage: String(item.sourceLanguage || 'unknown'),
        targetLanguage: String(item.targetLanguage || 'unknown'),
        ...normalizeStats(item)
    }));
    result.days = (Array.isArray(input.days) ? input.days : []).map(item => ({ date: String(item.date || ''), ...normalizeStats(item) })).filter(item => item.date);
    result.recentRequests = (Array.isArray(input.recentRequests) ? input.recentRequests : []).slice(-MAX_RECENT_REQUESTS).map(item => ({
        timestamp: String(item.timestamp || ''),
        modelId: String(item.modelId || ''),
        modelName: String(item.modelName || item.modelId || 'Unknown model'),
        sourceLanguage: String(item.sourceLanguage || ''),
        targetLanguage: String(item.targetLanguage || ''),
        translationItems: Math.max(0, Number(item.translationItems || 0)),
        inputTokens: optionalNumber(item.inputTokens),
        outputTokens: optionalNumber(item.outputTokens),
        totalTokens: Math.max(0, Number(item.totalTokens || 0)),
        measured: item.measured !== false
    }));
    return result;
}

function normalizeStats(raw) {
    const value = raw && typeof raw === 'object' ? raw : {};
    const inputTokens = Math.max(0, Number(value.inputTokens || 0));
    const outputTokens = Math.max(0, Number(value.outputTokens || 0));
    return {
        requests: Math.max(0, Number(value.requests || 0)),
        measuredRequests: Math.max(0, Number(value.measuredRequests || 0)),
        translationItems: Math.max(0, Number(value.translationItems || 0)),
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens
    };
}

function optionalNumber(value) {
    if (value === undefined || value === null || value === '') return undefined;
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric >= 0 ? numeric : undefined;
}

async function persistAiUsageEntry(resourceUri, rawEntry) {
    if (!resourceUri || !isAiUsageTrackingEnabled(vscode.workspace.getConfiguration(CONFIG_SECTION, resourceUri))) return undefined;
    const usageUri = await getAiUsageUri(resourceUri);
    if (!usageUri) return undefined;
    const key = usageUri.toString();
    const previous = writeQueues.get(key) || Promise.resolve();
    const current = previous.then(async () => {
        await ensureStudioStructure(resourceUri);
        let document = createEmptyUsageDocument();
        try {
            document = normalizeUsageDocument(JSON.parse(await readText(usageUri)));
        } catch (err) {
            if (!isFileNotFound(err) && !(err instanceof SyntaxError)) throw err;
        }
        const updated = updateUsageDocument(document, rawEntry);
        await vscode.workspace.fs.writeFile(usageUri, Buffer.from(JSON.stringify(updated, null, 2) + '\n', 'utf8'));
        emitPersistedChange(usageUri);
        return { uri: usageUri, document: updated };
    });
    const queued = current.catch(() => undefined);
    writeQueues.set(key, queued);
    try {
        return await current;
    } finally {
        if (writeQueues.get(key) === queued) writeQueues.delete(key);
    }
}

async function readAiUsageFile(uri) {
    try {
        return normalizeUsageDocument(JSON.parse(await readText(uri)));
    } catch (err) {
        if (isFileNotFound(err)) return createEmptyUsageDocument();
        throw err;
    }
}

async function findAiUsageFiles() {
    if (!vscode.workspace.findFiles) return [];
    const pattern = `**/${STUDIO_DIRECTORY}/${AI_USAGE_FILENAME}`;
    return vscode.workspace.findFiles(pattern, '**/{.git,node_modules,.alpackages}/**');
}

async function loadWorkspaceAiUsage() {
    const files = await findAiUsageFiles();
    const documents = [];
    for (const uri of files) {
        try {
            documents.push({ uri, project: projectLabelForUsageUri(uri), document: await readAiUsageFile(uri) });
        } catch (err) {
            documents.push({ uri, project: projectLabelForUsageUri(uri), error: String(err && err.message || err) });
        }
    }
    return aggregateUsageDocuments(documents);
}

function aggregateUsageDocuments(documents) {
    const aggregate = {
        totals: emptyStats(),
        models: [],
        languagePairs: [],
        days: [],
        recentRequests: [],
        projects: [],
        updatedAt: undefined,
        errors: []
    };
    const modelMap = new Map();
    const pairMap = new Map();
    const dayMap = new Map();

    for (const item of Array.isArray(documents) ? documents : []) {
        if (item.error || !item.document) {
            if (item.error) aggregate.errors.push(`${item.project || 'Project'}: ${item.error}`);
            continue;
        }
        const document = normalizeUsageDocument(item.document);
        addStats(aggregate.totals, document.totals);
        aggregate.projects.push({ project: item.project || 'Project', uri: item.uri && item.uri.toString ? item.uri.toString() : String(item.uri || ''), ...document.totals, updatedAt: document.updatedAt });
        if (!aggregate.updatedAt || String(document.updatedAt || '') > aggregate.updatedAt) aggregate.updatedAt = document.updatedAt;

        for (const model of document.models) mergeNamedStats(modelMap, model.key, model);
        for (const pair of document.languagePairs) mergeNamedStats(pairMap, pair.key, pair);
        for (const day of document.days) mergeNamedStats(dayMap, day.date, day);
        for (const recent of document.recentRequests) aggregate.recentRequests.push({ ...recent, project: item.project || 'Project' });
    }

    aggregate.models = [...modelMap.values()].sort((a, b) => Number(b.totalTokens || 0) - Number(a.totalTokens || 0));
    aggregate.languagePairs = [...pairMap.values()].sort((a, b) => Number(b.translationItems || 0) - Number(a.translationItems || 0));
    aggregate.days = [...dayMap.values()].sort((a, b) => String(a.date).localeCompare(String(b.date))).slice(-MAX_DAILY_ENTRIES);
    aggregate.recentRequests.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
    aggregate.recentRequests = aggregate.recentRequests.slice(0, MAX_RECENT_REQUESTS);
    aggregate.projects.sort((a, b) => String(a.project).localeCompare(String(b.project)));
    return aggregate;
}

function mergeNamedStats(map, key, item) {
    let target = map.get(key);
    if (!target) {
        target = { ...item, ...emptyStats() };
        map.set(key, target);
    }
    addStats(target, item);
}

function addStats(target, source) {
    target.requests = Number(target.requests || 0) + Number(source.requests || 0);
    target.measuredRequests = Number(target.measuredRequests || 0) + Number(source.measuredRequests || 0);
    target.translationItems = Number(target.translationItems || 0) + Number(source.translationItems || 0);
    target.inputTokens = Number(target.inputTokens || 0) + Number(source.inputTokens || 0);
    target.outputTokens = Number(target.outputTokens || 0) + Number(source.outputTokens || 0);
    target.totalTokens = Number(target.inputTokens || 0) + Number(target.outputTokens || 0);
}

async function resetWorkspaceAiUsage() {
    const files = await findAiUsageFiles();
    for (const uri of files) {
        try { await vscode.workspace.fs.delete(uri, { useTrash: false }); } catch (_) { /* continue */ }
    }
    emitPersistedChange(undefined);
}

function isAiUsageTrackingEnabled(config) {
    if (!config) return true;
    return config.get('ai.usage.enabled', true) !== false;
}

function onDidChangePersistedAiUsage(listener) {
    persistedListeners.add(listener);
    return { dispose() { persistedListeners.delete(listener); } };
}

function emitPersistedChange(uri) {
    for (const listener of persistedListeners) {
        try { listener(uri); } catch (_) { /* ignore */ }
    }
}

function projectLabelForUsageUri(uri) {
    if (!uri) return 'Project';
    const folder = vscode.workspace.getWorkspaceFolder ? vscode.workspace.getWorkspaceFolder(uri) : undefined;
    if (folder && folder.uri && folder.uri.scheme === 'file' && uri.scheme === 'file') {
        const relative = path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep);
        const studioIndex = relative.lastIndexOf(STUDIO_DIRECTORY);
        const projectParts = studioIndex > 0 ? relative.slice(0, studioIndex) : [];
        return projectParts.length ? `${folder.name}/${projectParts.join('/')}` : folder.name;
    }
    return folder ? folder.name : path.basename(path.dirname(path.dirname(uri.fsPath || ''))) || 'Project';
}

async function readText(uri) {
    const openDocument = (vscode.workspace.textDocuments || []).find(document => document.uri.toString() === uri.toString());
    if (openDocument) return openDocument.getText();
    return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
}

function isFileNotFound(err) {
    return err && (err.code === 'FileNotFound' || err.code === 'ENOENT');
}

module.exports = {
    AI_USAGE_VERSION,
    MAX_RECENT_REQUESTS,
    createEmptyUsageDocument,
    normalizeUsageDocument,
    updateUsageDocument,
    aggregateUsageDocuments,
    persistAiUsageEntry,
    readAiUsageFile,
    findAiUsageFiles,
    loadWorkspaceAiUsage,
    resetWorkspaceAiUsage,
    isAiUsageTrackingEnabled,
    onDidChangePersistedAiUsage
};
