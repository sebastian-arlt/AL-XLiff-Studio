'use strict';
const { localizeQualityReport } = require('./localization');

const path = require('path');
const { Worker } = require('worker_threads');
const { updateTranslationUnits, parseXliff } = require('./xliff');
const { analyzeXliffQuality } = require('./quality');
const { synchronizeTranslationUnits } = require('./synchronize');
const { translationMemorySnapshots } = require('./translationMemory');

const DEFAULT_WORKER_CHAR_THRESHOLD = 3 * 1024 * 1024;
const DEFAULT_WORKER_UNIT_THRESHOLD = 5000;
const DEFAULT_WORKER_TIMEOUT_MS = 120000;
const workerSlots = new Map();
const activeWorkers = new Set();
const workerObservers = new Set();

function abortError(reason) {
    const error = new Error(typeof reason === 'string' ? reason : 'XLIFF operation cancelled.');
    error.name = 'AbortError';
    return error;
}

function isWorkerCancellation(error) { return Boolean(error && error.name === 'AbortError'); }

function throwIfCancelled(signal) {
    if (signal && signal.aborted) throw abortError(signal.reason);
}

function observeWorkers(observer) {
    workerObservers.add(observer);
    return () => workerObservers.delete(observer);
}

function cancelXliffWorkers(resource, reason = 'Document changed or closed.', taskFilter) {
    const key = resource == null ? undefined : String(resource);
    const waits = [];
    for (const state of workerSlots.values()) {
        if ((key === undefined || state.resource === key) && (!taskFilter || state.task === taskFilter)) {
            state.controller.abort(reason);
            waits.push(state.promise.catch(() => undefined));
        }
    }
    return Promise.all(waits);
}

function configGet(config, key, fallback) {
    try {
        return config && typeof config.get === 'function' ? config.get(key, fallback) : fallback;
    } catch (_) {
        return fallback;
    }
}

function workerConfiguration(config) {
    const enabled = configGet(config, 'performance.workerThreads.enabled', true) !== false;
    let minFileSizeMb = Number(configGet(config, 'performance.workerThreads.minFileSizeMB', 3));
    if (!Number.isFinite(minFileSizeMb)) minFileSizeMb = 3;
    minFileSizeMb = Math.max(1, Math.min(100, minFileSizeMb));
    let minUnits = Number(configGet(config, 'performance.workerThreads.minUnits', DEFAULT_WORKER_UNIT_THRESHOLD));
    if (!Number.isFinite(minUnits)) minUnits = DEFAULT_WORKER_UNIT_THRESHOLD;
    minUnits = Math.max(1000, Math.min(100000, Math.trunc(minUnits)));
    return {
        enabled,
        charThreshold: Math.round(minFileSizeMb * 1024 * 1024),
        unitThreshold: minUnits
    };
}

function countTransUnitsFast(text) {
    const sourceText = String(text || '');
    let count = 0;
    let offset = 0;
    while (true) {
        offset = sourceText.indexOf('<trans-unit', offset);
        if (offset < 0) return count;
        count++;
        offset += 11;
    }
}

function shouldUseXliffWorker(text, unitCount, config) {
    const settings = workerConfiguration(config);
    if (!settings.enabled) return false;
    const sourceText = String(text || '');
    if (sourceText.length >= settings.charThreshold) return true;
    const units = Number.isFinite(Number(unitCount)) ? Number(unitCount) : countTransUnitsFast(sourceText);
    return units >= settings.unitThreshold;
}

function workerError(value) {
    const error = new Error(value && value.message ? String(value.message) : 'XLIFF worker failed.');
    if (value && value.name) error.name = String(value.name);
    if (value && value.stack) error.stack = String(value.stack);
    return error;
}

async function runWorkerTask(task, payload, options = {}) {
    throwIfCancelled(options.signal);
    const resource = options.resourceKey == null ? undefined : String(options.resourceKey);
    // One slot per document across both task types: a replacement parser must
    // also await termination of an obsolete Quality worker (and vice versa).
    const slot = resource === undefined ? Symbol(task) : resource;
    const previous = workerSlots.get(slot);
    const controller = new AbortController();
    const onAbort = () => controller.abort(options.signal.reason);
    if (options.signal) options.signal.addEventListener('abort', onAbort, { once: true });
    const state = { resource, controller, task: task === 'parse' || task === 'sync' || task === 'apply' ? task : 'quality' };
    // Reserve the slot before awaiting termination. A third request cancels the
    // queued second request too, so old jobs can never start after newer ones.
    workerSlots.set(slot, state);
    if (previous) previous.controller.abort('Superseded by a new worker run.');
    state.promise = Promise.resolve().then(async () => {
        if (previous) await previous.promise.catch(() => undefined);
        throwIfCancelled(controller.signal);
        return executeWorkerTask(task, payload, { ...options, signal: controller.signal });
    });
    try {
        const result = await state.promise;
        throwIfCancelled(controller.signal);
        return result;
    } catch (error) {
        throwIfCancelled(controller.signal);
        throw error;
    }
    finally {
        if (options.signal) options.signal.removeEventListener('abort', onAbort);
        if (workerSlots.get(slot) === state) workerSlots.delete(slot);
    }
}

function executeWorkerTask(task, payload, options) {
    const timeoutMs = Math.max(1000, Number(options.timeoutMs) || DEFAULT_WORKER_TIMEOUT_MS);
    const workerPath = path.join(__dirname, 'xlfWorker.js');
    return new Promise((resolve, reject) => {
        let settled = false;
        const worker = new Worker(options.workerPath || workerPath, { workerData: { task, payload } });
        const startedAt = Date.now();
        const threadId = worker.threadId;
        activeWorkers.add(worker);
        const emit = (event, extra = {}) => {
            const meta = { task, resourceKey: options.resourceKey, threadId, activeWorkers: activeWorkers.size, elapsedMs: Date.now() - startedAt, ...extra };
            try { if (typeof options.onPhase === 'function') options.onPhase(`worker ${event}`, meta); } catch (_) { /* tracing cannot leak a thread */ }
            for (const observer of workerObservers) {
                try { observer({ event, ...meta }); } catch (_) { /* observers cannot break worker cleanup */ }
            }
        };
        const finish = async (handler, value, outcome) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            options.signal.removeEventListener('abort', onAbort);
            // Resolve/reject only after the thread has actually exited.
            await worker.terminate().catch(() => undefined);
            activeWorkers.delete(worker);
            emit('terminated', { outcome });
            handler(value);
        };
        const onAbort = () => { void finish(reject, abortError(options.signal.reason), 'cancelled'); };
        const timer = setTimeout(() => {
            void finish(reject, new Error(`XLIFF worker timed out after ${timeoutMs} ms.`), 'timeout');
        }, timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
        worker.once('message', message => {
            if (message && message.ok) void finish(resolve, message.result, 'completed');
            else void finish(reject, workerError(message && message.error), 'error');
        });
        worker.once('error', err => { void finish(reject, err, 'error'); });
        worker.once('exit', code => {
            if (!settled) void finish(reject, new Error(`XLIFF worker exited without a result (code ${code}).`), 'error');
        });
        options.signal.addEventListener('abort', onAbort, { once: true });
        emit('started');
        if (options.signal.aborted) onAbort();
    });
}

async function parseXliffOffThread(text, options = {}) {
    return runWorkerTask('parse', { text: String(text || '') }, options);
}

async function updateTranslationUnitsAdaptive(text, changes, config, options = {}) {
    throwIfCancelled(options.signal);
    if (shouldUseXliffWorker(text, options.unitCount, config)) {
        return runWorkerTask('apply', { text, changes }, options);
    }
    return updateTranslationUnits(text, changes);
}

async function synchronizeXliffAdaptive(targetText, sourceText, config, options = {}) {
    throwIfCancelled(options.signal);
    if (shouldUseXliffWorker(targetText, options.unitCount, config) || shouldUseXliffWorker(sourceText, undefined, config)) {
        // Never fall back to a large blocking synchronization after worker failure.
        return runWorkerTask('sync', { targetText, sourceText, includeMemory: options.includeMemory !== false }, options);
    }
    const result = synchronizeTranslationUnits(targetText, sourceText);
    return options.includeMemory === false ? result : { ...result, memorySnapshots: translationMemorySnapshots([targetText, result.text]) };
}

async function analyzeXliffQualityOffThread(parsed, qualityOptions, options = {}) {
    return runWorkerTask('quality', { parsed, options: qualityOptions || {} }, options);
}

async function analyzeXliffQualityTextOffThread(sourceText, qualityOptions, options = {}) {
    return runWorkerTask('qualityText', {
        text: String(sourceText || ''),
        options: qualityOptions || {},
        unitOverrides: Array.isArray(options.unitOverrides) ? options.unitOverrides : []
    }, options);
}

async function parseXliffAdaptive(text, config, options = {}) {
    throwIfCancelled(options.signal);
    const sourceText = String(text || '');
    const useWorker = shouldUseXliffWorker(sourceText, options.unitCount, config);
    if (!useWorker) return { parsed: parseXliff(sourceText), workerUsed: false, fallback: false };
    if (typeof options.onPhase === 'function') options.onPhase('worker parse start', { chars: sourceText.length, units: options.unitCount });
    try {
        const parsed = await parseXliffOffThread(sourceText, options);
        if (typeof options.onPhase === 'function') options.onPhase('worker parse done', { units: (parsed.units || []).length });
        return { parsed, workerUsed: true, fallback: false };
    } catch (err) {
        if (isWorkerCancellation(err)) throw err;
        throwIfCancelled(options.signal);
        if (typeof options.onPhase === 'function') options.onPhase('worker parse fallback', { error: err && err.message ? err.message : String(err) });
        return { parsed: parseXliff(sourceText), workerUsed: false, fallback: true };
    }
}

async function analyzeXliffQualityAdaptive(parsed, qualityOptions, sourceText, config, options = {}) {
    throwIfCancelled(options.signal);
    const units = parsed && Array.isArray(parsed.units) ? parsed.units.length : options.unitCount;
    const useWorker = shouldUseXliffWorker(sourceText, units, config);
    if (!useWorker) return { report: analyzeXliffQuality(parsed, qualityOptions || {}), workerUsed: false, fallback: false };
    if (typeof options.onPhase === 'function') options.onPhase('worker quality start', { units });
    try {
        // Do not structured-clone the full parsed XLIFF into the worker. For large files
        // that object graph can be many times larger than the source XML and the clone
        // itself runs on the extension-host thread. Reparse the compact source text in
        // the worker and send only small ordinal overrides for draft previews.
        const report = await analyzeXliffQualityTextOffThread(sourceText, qualityOptions, options);
        if (typeof options.onPhase === 'function') options.onPhase('worker quality done', { issues: report && report.summary ? report.summary.total : undefined });
        return { report: localizeQualityReport(report), workerUsed: true, fallback: false };
    } catch (err) {
        if (isWorkerCancellation(err)) throw err;
        throwIfCancelled(options.signal);
        if (typeof options.onPhase === 'function') options.onPhase('worker quality fallback', { error: err && err.message ? err.message : String(err) });
        return { report: analyzeXliffQuality(parsed, qualityOptions || {}), workerUsed: false, fallback: true };
    }
}

module.exports = {
    updateTranslationUnitsAdaptive,
    synchronizeXliffAdaptive,
    abortError,
    isWorkerCancellation,
    throwIfCancelled,
    cancelXliffWorkers,
    observeWorkers,
    DEFAULT_WORKER_CHAR_THRESHOLD,
    DEFAULT_WORKER_UNIT_THRESHOLD,
    DEFAULT_WORKER_TIMEOUT_MS,
    workerConfiguration,
    countTransUnitsFast,
    shouldUseXliffWorker,
    runWorkerTask,
    parseXliffOffThread,
    analyzeXliffQualityOffThread,
    analyzeXliffQualityTextOffThread,
    parseXliffAdaptive,
    analyzeXliffQualityAdaptive
};
