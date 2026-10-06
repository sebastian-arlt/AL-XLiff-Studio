'use strict';

const vscode = require('vscode');
const { CONFIG_SECTION } = require('./identity');
const { qualityOptionsFromConfiguration } = require('./quality');
const { parseXliffAdaptive, analyzeXliffQualityAdaptive, cancelXliffWorkers, throwIfCancelled } = require('./xlfWorkerHost');
const { readProjectGlossary } = require('./glossaryEditor');
const { readProjectQualityIgnores } = require('./projectQualityIgnore');
const {
    resourceKey,
    contentHash,
    getDocumentSession,
    getDocumentSessionQuality,
    setDocumentSessionQuality,
    clearDocumentSessionQuality,
    getParsedDocumentSessionAsync,
    setParsedDocumentSession
} = require('./documentSession');

// One shared analysis pipeline for the editor, Problems diagnostics, Activity Bar,
// Dashboard and automatic background QA. Parsed XLIFF, quality output and stats now
// live in the central DocumentSession; only in-flight coordination/revisions remain here.
const inFlight = new Map();
const revisions = new Map();

function qualityConfigurationSignature(config) {
    const quality = qualityOptionsFromConfiguration(config);
    return JSON.stringify({
        quality,
        glossaryEnabled: config.get('glossary.enabled', true) !== false,
        glossaryPath: String(config.get('glossary.path', '') || '')
    });
}

function projectIgnoresSignature(projectIgnores) {
    const ignores = Array.isArray(projectIgnores) ? projectIgnores : [];
    return ignores.length ? contentHash(JSON.stringify(ignores)) : 'none';
}

function glossarySignature(glossary) {
    const entries = glossary && Array.isArray(glossary.entries) ? glossary.entries : [];
    if (!entries.length) return 'none';
    return contentHash(JSON.stringify(entries));
}

function revisionFor(key) {
    return revisions.get(key) || 0;
}

function invalidateQualityAnalysis(uri) {
    if (!uri) {
        for (const key of new Set([...inFlight.keys(), ...revisions.keys()])) {
            revisions.set(key, revisionFor(key) + 1);
            const running = inFlight.get(key);
            if (running) running.controller.abort('Quality analysis invalidated.');
        }
        void cancelXliffWorkers(undefined, 'Quality analysis invalidated.', 'quality');
        clearDocumentSessionQuality();
        return;
    }
    const key = resourceKey(uri);
    revisions.set(key, revisionFor(key) + 1);
    const running = inFlight.get(key);
    if (running) running.controller.abort('Quality analysis invalidated.');
    void cancelXliffWorkers(key, 'Quality analysis invalidated.', 'quality');
    clearDocumentSessionQuality(uri);
}

function getCachedQualityAnalysis(uri, text, config) {
    const sourceText = String(text || '');
    const session = getDocumentSession(uri, sourceText);
    const effectiveConfig = config || vscode.workspace.getConfiguration(CONFIG_SECTION, uri);
    const revision = revisionFor(session.key);
    const baseFingerprint = `${session.contentHash}:${qualityConfigurationSignature(effectiveConfig)}`;
    const current = session.quality && session.quality.analysis;
    if (!current || current.revision !== revision || !current.fingerprint.startsWith(`${baseFingerprint}:`)) return undefined;
    return getDocumentSessionQuality(session, session.quality.fingerprint);
}

async function analyzeQualityForText(uri, text, options = {}) {
    throwIfCancelled(options.signal);
    const sourceText = String(text || '');
    const session = options.session || getDocumentSession(uri, sourceText, {
        version: options.documentVersion,
        parsed: options.parsed
    });
    if (options.parsed) setParsedDocumentSession(session, options.parsed);

    const key = session.key;
    const config = options.config || vscode.workspace.getConfiguration(CONFIG_SECTION, uri);
    const revision = revisionFor(key);
    const baseFingerprint = `${session.contentHash}:${qualityConfigurationSignature(config)}`;
    const providedGlossary = options.glossary;
    const providedGlossaryPart = providedGlossary ? glossarySignature(providedGlossary) : undefined;
    const providedProjectIgnores = Array.isArray(options.projectQualityIgnores) ? options.projectQualityIgnores : undefined;
    const providedProjectIgnorePart = providedProjectIgnores ? projectIgnoresSignature(providedProjectIgnores) : undefined;

    const cached = session.quality && session.quality.analysis;
    if (cached && cached.revision === revision && cached.fingerprint.startsWith(`${baseFingerprint}:`)) {
        if ((!providedGlossaryPart || cached.glossarySignature === providedGlossaryPart) && (!providedProjectIgnorePart || cached.projectIgnoreSignature === providedProjectIgnorePart)) {
            if (typeof options.onPhase === 'function') options.onPhase('quality cache hit', { issues: cached.report.summary && cached.report.summary.total });
            return { ...cached, session, cacheHit: true, stale: false };
        }
    }

    const running = inFlight.get(key);
    if (running && !running.signal.aborted && running.revision === revision && running.baseFingerprint === baseFingerprint && (!providedGlossaryPart || running.glossarySignature === providedGlossaryPart) && (!providedProjectIgnorePart || running.projectIgnoreSignature === providedProjectIgnorePart)) {
        const result = await running.promise;
        throwIfCancelled(options.signal);
        if (typeof options.onPhase === 'function') options.onPhase('await existing quality run', { issues: result.report && result.report.summary ? result.report.summary.total : undefined });
        return { ...result, session, sharedRun: true };
    }

    if (running) running.controller.abort('Superseded quality analysis.');
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    const token = Symbol('quality-run');
    const state = {
        token,
        controller,
        signal,
        revision,
        baseFingerprint,
        glossarySignature: providedGlossaryPart,
        projectIgnoreSignature: providedProjectIgnorePart
    };

    state.promise = (async () => {
        const hadParsed = Boolean(session.parsed);
        throwIfCancelled(signal);
        const parsed = await getParsedDocumentSessionAsync(session, sourceText, async (value, workerOptions) => {
            const parsedResult = await parseXliffAdaptive(value, config, {
                ...workerOptions,
                unitCount: options.estimatedUnits,
                onPhase: options.onPhase
            });
            return parsedResult.parsed;
        });
        throwIfCancelled(signal);
        if (typeof options.onPhase === 'function') options.onPhase('parse XLIFF', { units: (parsed.units || []).length, reused: hadParsed || Boolean(options.parsed) });

        const glossary = providedGlossary || (config.get('glossary.enabled', true) ? await readProjectGlossary(uri) : { entries: [] });
        throwIfCancelled(signal);
        const glossSig = glossarySignature(glossary);
        state.glossarySignature = glossSig;
        if (typeof options.onPhase === 'function') options.onPhase('read glossary', { glossaryEntries: (glossary.entries || []).length, reused: Boolean(providedGlossary) });

        const projectIgnoreData = providedProjectIgnores ? { ignores: providedProjectIgnores, errors: [] } : await readProjectQualityIgnores(uri);
        throwIfCancelled(signal);
        const projectIgnores = projectIgnoreData.ignores || [];
        const projectIgnoreErrors = projectIgnoreData.errors || [];
        const projectIgnoreSig = projectIgnoresSignature(projectIgnores);
        state.projectIgnoreSignature = projectIgnoreSig;
        if (typeof options.onPhase === 'function') options.onPhase('read project quality ignores', { projectIgnores: projectIgnores.length, reused: Boolean(providedProjectIgnores) });

        const qualityOptions = {
            ...qualityOptionsFromConfiguration(config),
            glossaryEntries: glossary.entries || [],
            projectQualityIgnores: projectIgnores
        };
        const qualityResult = await analyzeXliffQualityAdaptive(parsed, qualityOptions, sourceText, config, {
            signal,
            resourceKey: key,
            unitCount: (parsed.units || []).length,
            onPhase: options.onPhase
        });
        throwIfCancelled(signal);
        const report = qualityResult.report;
        if (typeof options.onPhase === 'function') options.onPhase('analyze quality', {
            issues: report && report.summary ? report.summary.total : undefined,
            workerUsed: Boolean(qualityResult.workerUsed),
            workerFallback: Boolean(qualityResult.fallback)
        });

        const fingerprint = `${baseFingerprint}:${glossSig}:${projectIgnoreSig}`;
        const result = {
            parsed,
            glossary,
            glossarySignature: glossSig,
            projectQualityIgnores: projectIgnores,
            projectIgnoreErrors,
            projectIgnoreSignature: projectIgnoreSig,
            report,
            revision,
            fingerprint,
            cacheHit: false,
            stale: false
        };
        const current = inFlight.get(key);
        if (revisionFor(key) !== revision || !current || current.token !== token) {
            result.stale = true;
            return result;
        }
        setDocumentSessionQuality(session, fingerprint, result);
        return result;
    })();

    inFlight.set(key, state);
    try {
        const result = await state.promise;
        return { ...result, session };
    } finally {
        const current = inFlight.get(key);
        if (current && current.token === token) inFlight.delete(key);
    }
}

function seedQualityAnalysis(uri, text, report, options = {}) {
    if (!uri || !report) return;
    const sourceText = String(text || '');
    const session = options.session || getDocumentSession(uri, sourceText, {
        version: options.documentVersion,
        parsed: options.parsed
    });
    if (options.parsed) setParsedDocumentSession(session, options.parsed);
    const config = options.config || vscode.workspace.getConfiguration(CONFIG_SECTION, uri);
    const glossary = options.glossary || { entries: [] };
    const glossSig = glossarySignature(glossary);
    const projectQualityIgnores = Array.isArray(options.projectQualityIgnores) ? options.projectQualityIgnores : [];
    const projectIgnoreSig = projectIgnoresSignature(projectQualityIgnores);
    const fingerprint = `${session.contentHash}:${qualityConfigurationSignature(config)}:${glossSig}:${projectIgnoreSig}`;
    const analysis = {
        parsed: session.parsed,
        glossary,
        glossarySignature: glossSig,
        projectQualityIgnores,
        projectIgnoreSignature: projectIgnoreSig,
        report,
        revision: revisionFor(session.key),
        fingerprint,
        cacheHit: false,
        stale: false
    };
    setDocumentSessionQuality(session, fingerprint, analysis);
}

module.exports = {
    analyzeQualityForText,
    getCachedQualityAnalysis,
    invalidateQualityAnalysis,
    seedQualityAnalysis,
    contentHash,
    qualityConfigurationSignature,
    projectIgnoresSignature,
    glossarySignature
};
