'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { monitorEventLoopDelay } = require('node:perf_hooks');
const { CONFIG_SECTION, BRAND_NAME } = require('./identity');
const { getPerformanceDebugLogUri, ensureAiDebugDirectory, workspaceFileExists } = require('./studioPaths');

let traceCounter = 0;
let eventCounter = 0;
let globalWriteQueue = Promise.resolve();
const writeQueues = new Map();
const MAX_LOG_BYTES = 5 * 1024 * 1024;

function isPerformanceDebugEnabled(configOrResource) {
    const config = configOrResource && typeof configOrResource.get === 'function'
        ? configOrResource
        : vscode.workspace.getConfiguration(CONFIG_SECTION, configOrResource);
    return config.get('debug.performance.enabled', false) === true;
}

function getSlowThresholdMs(configOrResource) {
    const config = configOrResource && typeof configOrResource.get === 'function'
        ? configOrResource
        : vscode.workspace.getConfiguration(CONFIG_SECTION, configOrResource);
    const value = Number(config.get('debug.performance.slowThresholdMs', 250));
    return Number.isFinite(value) && value >= 1 ? value : 250;
}

function nowNs() {
    return process.hrtime.bigint();
}

function elapsedMs(start, end = nowNs()) {
    return Number(end - start) / 1e6;
}

function memorySnapshot() {
    try {
        const memory = process.memoryUsage();
        return {
            rssMB: round(memory.rss / 1024 / 1024),
            heapUsedMB: round(memory.heapUsed / 1024 / 1024),
            heapTotalMB: round(memory.heapTotal / 1024 / 1024)
        };
    } catch (_) {
        return {};
    }
}

function round(value) {
    return Math.round(value * 10) / 10;
}

function safeMeta(meta) {
    if (!meta || typeof meta !== 'object') return {};
    const result = {};
    for (const [key, value] of Object.entries(meta)) {
        if (value === undefined) continue;
        if (typeof value === 'string') result[key] = value.length > 500 ? value.slice(0, 500) + '…' : value;
        else if (typeof value === 'number' || typeof value === 'boolean' || value === null) result[key] = value;
        else if (Array.isArray(value)) result[key] = value.slice(0, 20);
        else result[key] = String(value);
    }
    return result;
}

function createPerformanceTrace(resourceUri, operation, metadata = {}) {
    if (!isPerformanceDebugEnabled(resourceUri)) return noopTrace();
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION, resourceUri);
    const thresholdMs = getSlowThresholdMs(config);
    const traceId = `${Date.now().toString(36)}-${(++traceCounter).toString(36)}`;
    const started = nowNs();
    let last = started;
    let currentPhase = 'start';
    let finished = false;
    const baseMeta = safeMeta(metadata);

    void appendPerformanceEvent(resourceUri, {
        traceId,
        operation,
        event: 'START',
        phase: currentPhase,
        elapsedMs: 0,
        deltaMs: 0,
        thresholdMs,
        meta: baseMeta
    });

    const eventLoop = monitorEventLoopDelay({ resolution: 20 });
    eventLoop.enable();
    const eventLoopSnapshot = () => {
        eventLoop.disable();
        return { eventLoopMaxMs: round(eventLoop.max / 1e6), eventLoopP99Ms: round(eventLoop.percentile(99) / 1e6) };
    };
    const watchdogDelay = Math.max(1000, thresholdMs * 4);
    const watchdog = setInterval(() => {
        if (finished) return;
        const total = elapsedMs(started);
        void appendPerformanceEvent(resourceUri, {
            traceId,
            operation,
            event: 'STILL-RUNNING',
            phase: currentPhase,
            elapsedMs: total,
            deltaMs: elapsedMs(last),
            thresholdMs,
            slow: true,
            meta: baseMeta
        });
    }, watchdogDelay);
    if (watchdog && typeof watchdog.unref === 'function') watchdog.unref();

    return {
        id: traceId,
        mark(phase, meta = {}) {
            if (finished) return;
            const current = nowNs();
            const delta = elapsedMs(last, current);
            const total = elapsedMs(started, current);
            currentPhase = String(phase || 'checkpoint');
            last = current;
            void appendPerformanceEvent(resourceUri, {
                traceId,
                operation,
                event: delta >= thresholdMs ? 'SLOW-CHECKPOINT' : 'CHECKPOINT',
                phase: currentPhase,
                elapsedMs: total,
                deltaMs: delta,
                thresholdMs,
                slow: delta >= thresholdMs,
                meta: { ...baseMeta, ...safeMeta(meta) }
            });
        },
        end(meta = {}) {
            if (finished) return;
            finished = true;
            clearInterval(watchdog);
            const current = nowNs();
            const delta = elapsedMs(last, current);
            const total = elapsedMs(started, current);
            void appendPerformanceEvent(resourceUri, {
                traceId,
                operation,
                event: total >= thresholdMs ? 'SLOW-END' : 'END',
                phase: 'done',
                elapsedMs: total,
                deltaMs: delta,
                thresholdMs,
                slow: total >= thresholdMs,
                meta: { ...baseMeta, ...safeMeta(meta), ...eventLoopSnapshot() }
            });
        },
        fail(error, meta = {}) {
            if (finished) return;
            finished = true;
            clearInterval(watchdog);
            const current = nowNs();
            void appendPerformanceEvent(resourceUri, {
                traceId,
                operation,
                event: 'ERROR',
                phase: currentPhase,
                elapsedMs: elapsedMs(started, current),
                deltaMs: elapsedMs(last, current),
                thresholdMs,
                slow: true,
                error: error ? String(error.stack || error.message || error) : 'unknown error',
                meta: { ...baseMeta, ...safeMeta(meta), ...eventLoopSnapshot() }
            });
        }
    };
}

function noopTrace() {
    return { id: '', mark() {}, end() {}, fail() {} };
}

async function appendPerformanceEvent(resourceUri, entry) {
    if (!resourceUri || !isPerformanceDebugEnabled(resourceUri)) return undefined;

    // Capture ordering, wall-clock time and memory immediately when the event occurs.
    // Resolving the project/debug URI can await filesystem work; doing the snapshot after
    // those awaits made older events appear after newer ones and attributed memory to the
    // wrong phase.
    const enriched = {
        sequence: ++eventCounter,
        timestamp: new Date().toISOString(),
        ...entry,
        memory: memorySnapshot()
    };

    const task = async () => {
        const directory = await ensureAiDebugDirectory(resourceUri);
        if (!directory) return undefined;
        const uri = await getPerformanceDebugLogUri(resourceUri);
        if (!uri) return undefined;
        const line = formatPerformanceEntry(enriched) + '\n';
        const key = uri.toString();
        const previous = writeQueues.get(key) || Promise.resolve();
        const next = previous.then(() => appendLine(uri, line), () => appendLine(uri, line));
        writeQueues.set(key, next.catch(() => undefined));
        await next;
        return uri;
    };

    // Serialize event resolution as well as file writes so invocation order is retained
    // even when several traces emit checkpoints in the same event-loop turn.
    const queued = globalWriteQueue.then(task, task);
    globalWriteQueue = queued.catch(() => undefined);
    return queued;
}

async function appendLine(uri, line) {
    if (uri.scheme === 'file' && uri.fsPath) {
        await fs.promises.mkdir(path.dirname(uri.fsPath), { recursive: true });
        try {
            const stat = await fs.promises.stat(uri.fsPath);
            if (stat.size > MAX_LOG_BYTES) {
                await fs.promises.rename(uri.fsPath, uri.fsPath + '.1').catch(() => fs.promises.unlink(uri.fsPath).catch(() => undefined));
            }
        } catch (_) { /* first write */ }
        await fs.promises.appendFile(uri.fsPath, line, 'utf8');
        return;
    }

    let previous = '';
    if (await workspaceFileExists(uri)) {
        try { previous = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'); } catch (_) { previous = ''; }
    }
    if (Buffer.byteLength(previous, 'utf8') > MAX_LOG_BYTES) previous = '';
    await vscode.workspace.fs.writeFile(uri, Buffer.from(previous + line, 'utf8'));
}

function formatPerformanceEntry(entry) {
    const flags = entry.slow ? ' SLOW' : '';
    const timing = `total=${round(Number(entry.elapsedMs) || 0)}ms delta=${round(Number(entry.deltaMs) || 0)}ms`;
    const memory = entry.memory || {};
    const memoryText = `rss=${memory.rssMB || 0}MB heap=${memory.heapUsedMB || 0}/${memory.heapTotalMB || 0}MB`;
    const meta = entry.meta && Object.keys(entry.meta).length ? ` meta=${JSON.stringify(entry.meta)}` : '';
    const error = entry.error ? ` error=${JSON.stringify(String(entry.error))}` : '';
    const sequence = Number.isFinite(Number(entry.sequence)) ? ` seq=${Number(entry.sequence)}` : '';
    return `[${entry.timestamp}] [${entry.event || 'EVENT'}${flags}]${sequence} trace=${entry.traceId || '-'} op=${JSON.stringify(entry.operation || '')} phase=${JSON.stringify(entry.phase || '')} ${timing} ${memoryText}${meta}${error}`;
}

async function openPerformanceDebugLog(resourceUri) {
    let resource = resourceUri;
    if (!resource || !resource.scheme) {
        const active = vscode.window.activeTextEditor && vscode.window.activeTextEditor.document;
        resource = active && active.uri;
    }
    const uri = await getPerformanceDebugLogUri(resource);
    if (!uri) {
        vscode.window.showInformationMessage(`${BRAND_NAME}: no project is available for the performance debug log.`);
        return;
    }
    await ensureAiDebugDirectory(resource);
    if (!await workspaceFileExists(uri)) await vscode.workspace.fs.writeFile(uri, Buffer.from('', 'utf8'));
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: false });
}

module.exports = {
    flushPerformanceDebug: () => globalWriteQueue,
    isPerformanceDebugEnabled,
    getSlowThresholdMs,
    createPerformanceTrace,
    appendPerformanceEvent,
    formatPerformanceEntry,
    openPerformanceDebugLog
};
