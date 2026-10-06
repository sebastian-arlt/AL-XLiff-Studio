'use strict';

const listeners = new Set();

let state = createEmptyState();

function createEmptyState() {
    return {
        requests: 0,
        measuredRequests: 0,
        inputTokens: 0,
        outputTokens: 0,
        translationItems: 0,
        models: new Map(),
        languagePairs: new Map(),
        lastUpdated: undefined
    };
}

function normalizeTokens(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.round(number) : undefined;
}

function normalizeCount(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.round(number) : 0;
}

function modelKey(model) {
    if (!model) return 'unknown';
    return String(model.id || [model.vendor, model.family, model.name, model.version].filter(Boolean).join(':') || 'unknown');
}

function modelLabel(model) {
    if (!model) return 'Unknown model';
    return String(model.name || model.id || model.family || 'Unknown model');
}

function languagePairKey(sourceLanguage, targetLanguage) {
    return `${String(sourceLanguage || 'unknown')}→${String(targetLanguage || 'unknown')}`;
}

function normalizeUsageEntry(entry = {}) {
    const inputTokens = normalizeTokens(entry.inputTokens);
    const outputTokens = normalizeTokens(entry.outputTokens);
    return {
        timestamp: entry.timestamp || new Date().toISOString(),
        model: entry.model || {},
        inputTokens,
        outputTokens,
        totalTokens: (inputTokens || 0) + (outputTokens || 0),
        measured: inputTokens !== undefined && outputTokens !== undefined,
        itemCount: normalizeCount(entry.itemCount),
        sourceLanguage: String(entry.sourceLanguage || ''),
        targetLanguage: String(entry.targetLanguage || ''),
        resourceUri: entry.resourceUri
    };
}

function recordAiUsage(entry = {}) {
    const normalized = normalizeUsageEntry(entry);
    const { inputTokens, outputTokens, measured, model, itemCount, sourceLanguage, targetLanguage } = normalized;
    const key = modelKey(model);

    state.requests++;
    if (measured) state.measuredRequests++;
    if (inputTokens !== undefined) state.inputTokens += inputTokens;
    if (outputTokens !== undefined) state.outputTokens += outputTokens;
    state.translationItems += itemCount;
    state.lastUpdated = normalized.timestamp;

    let modelStats = state.models.get(key);
    if (!modelStats) {
        modelStats = {
            id: model.id ? String(model.id) : '',
            name: modelLabel(model),
            vendor: model.vendor ? String(model.vendor) : '',
            family: model.family ? String(model.family) : '',
            version: model.version ? String(model.version) : '',
            requests: 0,
            measuredRequests: 0,
            inputTokens: 0,
            outputTokens: 0,
            translationItems: 0
        };
        state.models.set(key, modelStats);
    }

    modelStats.requests++;
    if (measured) modelStats.measuredRequests++;
    if (inputTokens !== undefined) modelStats.inputTokens += inputTokens;
    if (outputTokens !== undefined) modelStats.outputTokens += outputTokens;
    modelStats.translationItems += itemCount;

    const pairKey = languagePairKey(sourceLanguage, targetLanguage);
    let pairStats = state.languagePairs.get(pairKey);
    if (!pairStats) {
        pairStats = {
            sourceLanguage: sourceLanguage || 'unknown',
            targetLanguage: targetLanguage || 'unknown',
            requests: 0,
            inputTokens: 0,
            outputTokens: 0,
            translationItems: 0
        };
        state.languagePairs.set(pairKey, pairStats);
    }
    pairStats.requests++;
    if (inputTokens !== undefined) pairStats.inputTokens += inputTokens;
    if (outputTokens !== undefined) pairStats.outputTokens += outputTokens;
    pairStats.translationItems += itemCount;

    const snapshot = getAiUsage();
    for (const listener of listeners) {
        try { listener(snapshot, normalized); } catch (_) { /* ignore listener errors */ }
    }
    return snapshot;
}

function withTotals(item) {
    return {
        ...item,
        totalTokens: Number(item.inputTokens || 0) + Number(item.outputTokens || 0)
    };
}

function getAiUsage() {
    const models = Array.from(state.models.values()).map(model => ({
        ...withTotals(model),
        unmeasuredRequests: Math.max(0, model.requests - model.measuredRequests)
    }));
    const languagePairs = Array.from(state.languagePairs.values()).map(withTotals);
    return {
        requests: state.requests,
        measuredRequests: state.measuredRequests,
        unmeasuredRequests: Math.max(0, state.requests - state.measuredRequests),
        inputTokens: state.inputTokens,
        outputTokens: state.outputTokens,
        totalTokens: state.inputTokens + state.outputTokens,
        translationItems: state.translationItems,
        models,
        languagePairs,
        lastUpdated: state.lastUpdated
    };
}

function onDidChangeAiUsage(listener) {
    listeners.add(listener);
    return {
        dispose() {
            listeners.delete(listener);
        }
    };
}

function resetAiUsage() {
    state = createEmptyState();
    const snapshot = getAiUsage();
    for (const listener of listeners) {
        try { listener(snapshot, undefined); } catch (_) { /* ignore listener errors */ }
    }
    return snapshot;
}

module.exports = {
    recordAiUsage,
    getAiUsage,
    onDidChangeAiUsage,
    resetAiUsage,
    normalizeUsageEntry,
    modelKey,
    modelLabel,
    languagePairKey
};
