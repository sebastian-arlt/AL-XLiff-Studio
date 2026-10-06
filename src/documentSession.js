'use strict';
const { cancelXliffWorkers, throwIfCancelled } = require('./xlfWorkerHost');

const crypto = require('crypto');

// A DocumentSession is the single reusable snapshot for one XLIFF resource/content
// version. Keep only a small LRU set because parsed XLIFFs can be large and retaining
// snapshots for every file discovered by Dashboard/Activity Bar would trade CPU for RAM.
const DEFAULT_MAX_SESSIONS = 8;
const DEFAULT_MAX_SESSION_BYTES = 384 * 1024 * 1024;
const sessions = new Map();
const retainedKeys = new Map();
let accessSequence = 0;
let configuredMaxSessions = DEFAULT_MAX_SESSIONS;
let configuredMaxSessionBytes = DEFAULT_MAX_SESSION_BYTES;

function resourceKey(uri) {
    return uri && typeof uri.toString === 'function' ? uri.toString() : String(uri || '');
}

function contentHash(text) {
    return crypto.createHash('sha1').update(String(text || ''), 'utf8').digest('hex');
}

function normalizeVersion(value) {
    const version = Number(value);
    return Number.isInteger(version) && version >= 0 ? version : undefined;
}

function touch(session) {
    session.lastAccess = ++accessSequence;
    return session;
}

function estimateSessionBytes(session) {
    if (!session) return 0;
    const textLength = Math.max(0, Number(session.textLength) || 0);
    let bytes = 2048 + textLength * 2;
    const parsed = session.parsed;
    if (parsed) {
        const units = Array.isArray(parsed.units) ? parsed.units : [];
        // Parsed XLIFF fields retain multiple decoded/raw strings, note arrays and
        // offset metadata. A multiplier is intentionally conservative: this is a
        // cache budget heuristic, not a V8 heap profiler.
        bytes += textLength * 6 + units.length * 384;
        for (const unit of units) {
            if (!unit) continue;
            const notes = Array.isArray(unit.noteDetails) ? unit.noteDetails.length : 0;
            bytes += notes * 160;
        }
    }
    const quality = session.quality && session.quality.analysis;
    const report = quality && quality.report;
    if (report) {
        bytes += ((Array.isArray(report.issues) ? report.issues.length : 0) +
            (Array.isArray(report.ignoredIssues) ? report.ignoredIssues.length : 0)) * 384;
    }
    if (session.stats instanceof Map) bytes += session.stats.size * 2048;
    return Math.max(2048, Math.trunc(bytes));
}

function totalEstimatedSessionBytes() {
    let total = 0;
    for (const session of sessions.values()) total += estimateSessionBytes(session);
    return total;
}

function trimSessions(maxSessions, maxSessionBytes) {
    const limit = Math.max(1, Number(maxSessions) || configuredMaxSessions || DEFAULT_MAX_SESSIONS);
    const byteLimit = Math.max(1024, Number(maxSessionBytes) || configuredMaxSessionBytes || DEFAULT_MAX_SESSION_BYTES);
    let estimatedBytes = totalEstimatedSessionBytes();
    while (sessions.size > limit || estimatedBytes > byteLimit) {
        // Always allow one snapshot to exist even when a single exceptionally large
        // XLIFF exceeds the nominal cache budget. Active editor sessions are pinned.
        if (sessions.size <= 1) break;
        let oldestKey;
        let oldestAccess = Number.POSITIVE_INFINITY;
        for (const [key, session] of sessions) {
            if ((retainedKeys.get(key) || 0) > 0) continue;
            if (session.lastAccess < oldestAccess) {
                oldestAccess = session.lastAccess;
                oldestKey = key;
            }
        }
        if (oldestKey === undefined) break;
        const removed = sessions.get(oldestKey);
        sessions.delete(oldestKey);
        estimatedBytes = Math.max(0, estimatedBytes - estimateSessionBytes(removed));
    }
}

function configureDocumentSessionCache(options = {}) {
    const nextMaxSessions = Number(options.maxSessions);
    const nextMaxBytes = Number(options.maxBytes != null ? options.maxBytes : options.maxSessionBytes);
    configuredMaxSessions = Number.isFinite(nextMaxSessions) && nextMaxSessions >= 1
        ? Math.trunc(nextMaxSessions)
        : DEFAULT_MAX_SESSIONS;
    configuredMaxSessionBytes = Number.isFinite(nextMaxBytes) && nextMaxBytes >= 1024
        ? Math.trunc(nextMaxBytes)
        : DEFAULT_MAX_SESSION_BYTES;
    trimSessions();
    return { maxSessions: configuredMaxSessions, maxBytes: configuredMaxSessionBytes };
}

function getDocumentSessionCacheLimits() {
    return { maxSessions: configuredMaxSessions, maxBytes: configuredMaxSessionBytes };
}

function getDocumentSession(uri, text, options = {}) {
    const key = resourceKey(uri);
    const sourceText = String(text || '');
    const version = normalizeVersion(options.version);
    let session = sessions.get(key);

    // VS Code guarantees that TextDocument.version changes with content edits. When a
    // caller supplies the same version we can reuse the session without hashing a
    // multi-megabyte document again. Non-editor callers still use the content hash.
    if (session && version !== undefined && session.version === version && session.textLength === sourceText.length) {
        if (options.parsed && !session.parsed) session.parsed = options.parsed;
        return touch(session);
    }

    const hash = options.contentHash || contentHash(sourceText);
    if (session && session.contentHash === hash && session.textLength === sourceText.length) {
        if (version !== undefined) session.version = version;
        if (options.parsed && !session.parsed) session.parsed = options.parsed;
        return touch(session);
    }

    if (session && session.parseController) session.parseController.abort('Document snapshot replaced.');
    void cancelXliffWorkers(key, 'Document snapshot replaced.');
    session = {
        key,
        uri: key,
        version,
        contentHash: hash,
        textLength: sourceText.length,
        parsed: options.parsed,
        parsedPromise: undefined,
        parseController: new AbortController(),
        quality: undefined,
        stats: new Map(),
        createdAt: Date.now(),
        lastAccess: 0
    };
    sessions.set(key, touch(session));
    trimSessions(options.maxSessions, options.maxSessionBytes);
    return session;
}

function getExistingDocumentSession(uri) {
    const session = sessions.get(resourceKey(uri));
    return session ? touch(session) : undefined;
}

function getParsedDocumentSession(session, text, parser) {
    if (!session) throw new Error('DocumentSession is required.');
    if (!session.parsed) {
        if (typeof parser !== 'function') throw new Error('A parser is required when the DocumentSession has no parsed XLIFF.');
        session.parsed = parser(String(text || ''));
    }
    touch(session);
    trimSessions();
    return session.parsed;
}

async function getParsedDocumentSessionAsync(session, text, parserAsync) {
    if (!session) throw new Error('DocumentSession is required.');
    if (session.parsed) {
        touch(session);
        return session.parsed;
    }
    if (!session.parsedPromise) {
        if (typeof parserAsync !== 'function') throw new Error('An async parser is required when the DocumentSession has no parsed XLIFF.');
        session.parsedPromise = Promise.resolve()
            .then(() => {
                throwIfCancelled(session.parseController.signal);
                return parserAsync(String(text || ''), { signal: session.parseController.signal, resourceKey: session.key });
            })
            .then(parsed => {
                throwIfCancelled(session.parseController.signal);
                if (!session.parsed) session.parsed = parsed;
                return session.parsed;
            })
            .finally(() => {
                session.parsedPromise = undefined;
                touch(session);
                trimSessions();
            });
    }
    const parsed = await session.parsedPromise;
    touch(session);
    return parsed;
}

function setParsedDocumentSession(session, parsed) {
    if (!session || !parsed) return parsed;
    session.parsed = parsed;
    touch(session);
    trimSessions();
    return parsed;
}

function getDocumentSessionQuality(session, fingerprint) {
    if (!session || !session.quality) return undefined;
    if (fingerprint && session.quality.fingerprint !== fingerprint) return undefined;
    touch(session);
    return session.quality.analysis;
}

function setDocumentSessionQuality(session, fingerprint, analysis) {
    if (!session || !analysis) return analysis;
    session.quality = { fingerprint: String(fingerprint || ''), analysis };
    touch(session);
    trimSessions();
    return analysis;
}

function clearDocumentSessionQuality(uri) {
    if (uri === undefined || uri === null) {
        for (const session of sessions.values()) {
            session.quality = undefined;
            session.stats.clear();
        }
        return;
    }
    const session = sessions.get(resourceKey(uri));
    if (!session) return;
    session.quality = undefined;
    session.stats.clear();
    touch(session);
}

function getDocumentSessionStats(session, name, signature) {
    if (!session || !session.stats) return undefined;
    const entry = session.stats.get(String(name || 'default'));
    if (!entry) return undefined;
    if (signature !== undefined && entry.signature !== String(signature)) return undefined;
    touch(session);
    return entry.value;
}

function setDocumentSessionStats(session, name, signature, value) {
    if (!session || !session.stats) return value;
    session.stats.set(String(name || 'default'), {
        signature: String(signature == null ? '' : signature),
        value
    });
    touch(session);
    trimSessions();
    return value;
}


function retainDocumentSession(uri) {
    const key = resourceKey(uri);
    retainedKeys.set(key, (retainedKeys.get(key) || 0) + 1);
}

function releaseDocumentSession(uri) {
    const key = resourceKey(uri);
    const count = retainedKeys.get(key) || 0;
    if (count <= 1) retainedKeys.delete(key);
    else retainedKeys.set(key, count - 1);
    trimSessions();
}

function invalidateDocumentSession(uri) {
    if (uri === undefined || uri === null) {
        for (const session of sessions.values()) session.parseController.abort('Document sessions invalidated.');
        void cancelXliffWorkers();
        sessions.clear();
        return;
    }
    const key = resourceKey(uri);
    const session = sessions.get(key);
    if (session) session.parseController.abort('Document closed or changed.');
    void cancelXliffWorkers(key);
    sessions.delete(key);
}

function sessionCount() {
    return sessions.size;
}

function resetDocumentSessions() {
    invalidateDocumentSession();
    retainedKeys.clear();
    accessSequence = 0;
    configuredMaxSessions = DEFAULT_MAX_SESSIONS;
    configuredMaxSessionBytes = DEFAULT_MAX_SESSION_BYTES;
}

module.exports = {
    DEFAULT_MAX_SESSIONS,
    DEFAULT_MAX_SESSION_BYTES,
    resourceKey,
    contentHash,
    configureDocumentSessionCache,
    getDocumentSessionCacheLimits,
    getDocumentSession,
    getExistingDocumentSession,
    getParsedDocumentSession,
    getParsedDocumentSessionAsync,
    setParsedDocumentSession,
    getDocumentSessionQuality,
    setDocumentSessionQuality,
    clearDocumentSessionQuality,
    getDocumentSessionStats,
    setDocumentSessionStats,
    retainDocumentSession,
    releaseDocumentSession,
    invalidateDocumentSession,
    trimSessions,
    estimateSessionBytes,
    totalEstimatedSessionBytes,
    sessionCount,
    resetDocumentSessions
};
