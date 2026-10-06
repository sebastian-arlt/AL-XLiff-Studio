'use strict';
const { cancelXliffWorkers } = require('../src/xlfWorkerHost');

const test = require('node:test');
const assert = require('node:assert/strict');
const sessionApi = require('../src/documentSession');

test('replacing or invalidating an async parse session cannot populate the obsolete snapshot', async () => {
    for (const invalidate of [false, true]) {
        sessionApi.resetDocumentSessions();
        const session = sessionApi.getDocumentSession('cancel-session.xlf', 'old text', { version: 1 });
        let finish;
        const pending = sessionApi.getParsedDocumentSessionAsync(session, 'old text', async (_text, options) => {
            assert.equal(options.resourceKey, 'cancel-session.xlf');
            return new Promise(resolve => { finish = () => resolve({ units: [] }); });
        });
        await new Promise(resolve => setImmediate(resolve));
        if (invalidate) sessionApi.invalidateDocumentSession('cancel-session.xlf');
        else sessionApi.getDocumentSession('cancel-session.xlf', 'new text', { version: 2 });
        finish();
        await assert.rejects(pending, { name: 'AbortError' });
        assert.equal(session.parsed, undefined);
        assert.equal(session.parsedPromise, undefined);
    }
    await cancelXliffWorkers();
});
const {
    DEFAULT_MAX_SESSIONS,
    DEFAULT_MAX_SESSION_BYTES,
    getDocumentSession,
    getExistingDocumentSession,
    configureDocumentSessionCache,
    getDocumentSessionCacheLimits,
    getParsedDocumentSession,
    getDocumentSessionQuality,
    setDocumentSessionQuality,
    clearDocumentSessionQuality,
    getDocumentSessionStats,
    setDocumentSessionStats,
    retainDocumentSession,
    releaseDocumentSession,
    trimSessions,
    estimateSessionBytes,
    totalEstimatedSessionBytes,
    sessionCount,
    resetDocumentSessions
} = require('../src/documentSession');

function uri(value) {
    return { toString: () => `file://${value}` };
}

test.beforeEach(() => resetDocumentSessions());

test('DocumentSession reuses one parsed XLIFF snapshot for identical content across document versions', () => {
    const file = uri('/Translations/Test.de-DE.xlf');
    const text = '<xliff><file><body><trans-unit id="A"><source>A</source></trans-unit></body></file></xliff>';
    let parses = 0;
    const first = getDocumentSession(file, text, { version: 7 });
    const parsed1 = getParsedDocumentSession(first, text, value => {
        parses++;
        return { text: value, units: [{ id: 'A' }] };
    });
    const second = getDocumentSession(file, text, { version: 8 });
    const parsed2 = getParsedDocumentSession(second, text, () => {
        parses++;
        return { units: [] };
    });

    assert.equal(first, second);
    assert.equal(parsed1, parsed2);
    assert.equal(parses, 1);
    assert.equal(second.version, 8);
});

test('DocumentSession replaces parsed, quality and stats when XLIFF content changes', () => {
    const file = uri('/Translations/Test.de-DE.xlf');
    const first = getDocumentSession(file, '<xliff>A</xliff>', { version: 1 });
    getParsedDocumentSession(first, '<xliff>A</xliff>', () => ({ units: [{ id: 'A' }] }));
    setDocumentSessionQuality(first, 'qa-a', { report: { summary: { total: 1 } } });
    setDocumentSessionStats(first, 'dashboardMetrics', 'a', { total: 1 });

    const second = getDocumentSession(file, '<xliff>B</xliff>', { version: 2 });
    assert.notEqual(second, first);
    assert.equal(second.parsed, undefined);
    assert.equal(second.quality, undefined);
    assert.equal(getDocumentSessionStats(second, 'dashboardMetrics', 'a'), undefined);
});

test('DocumentSession keeps quality and stats centrally and invalidates dependent stats with quality', () => {
    const file = uri('/Translations/Test.de-DE.xlf');
    const session = getDocumentSession(file, '<xliff>A</xliff>');
    const quality = { report: { summary: { total: 3 } } };
    const stats = { total: 10, missing: 2 };
    setDocumentSessionQuality(session, 'qa', quality);
    setDocumentSessionStats(session, 'xlfEditor', 'qa:missing=1', stats);

    assert.equal(getDocumentSessionQuality(session, 'qa'), quality);
    assert.equal(getDocumentSessionStats(session, 'xlfEditor', 'qa:missing=1'), stats);
    assert.equal(getDocumentSessionStats(session, 'xlfEditor', 'other'), undefined);

    clearDocumentSessionQuality(file);
    assert.equal(getDocumentSessionQuality(session, 'qa'), undefined);
    assert.equal(getDocumentSessionStats(session, 'xlfEditor', 'qa:missing=1'), undefined);
});

test('DocumentSession cache is LRU bounded so project scans cannot retain every parsed XLIFF', () => {
    for (let index = 0; index < DEFAULT_MAX_SESSIONS + 3; index++) {
        getDocumentSession(uri(`/Translations/${index}.xlf`), `<xliff>${index}</xliff>`);
    }
    assert.equal(sessionCount(), DEFAULT_MAX_SESSIONS);
    assert.equal(getExistingDocumentSession(uri('/Translations/0.xlf')), undefined);
    assert.ok(getExistingDocumentSession(uri(`/Translations/${DEFAULT_MAX_SESSIONS + 2}.xlf`)));
});


test('DocumentSession keeps active editor resources pinned while evicting unpinned project-scan sessions', () => {
    const active = uri('/Translations/Active.xlf');
    retainDocumentSession(active);
    const activeSession = getDocumentSession(active, '<xliff>active</xliff>');
    for (let index = 0; index < DEFAULT_MAX_SESSIONS + 4; index++) {
        getDocumentSession(uri(`/Translations/scan-${index}.xlf`), `<xliff>${index}</xliff>`);
    }
    assert.equal(getExistingDocumentSession(active), activeSession);
    releaseDocumentSession(active);
});

test('DocumentSession coalesces concurrent asynchronous parse requests', async () => {
    const { getParsedDocumentSessionAsync } = require('../src/documentSession');
    const file = uri('/Translations/Large.de-DE.xlf');
    const text = '<xliff><file><body><trans-unit id="A"><source>A</source></trans-unit></body></file></xliff>';
    const session = getDocumentSession(file, text, { version: 1 });
    let parses = 0;
    const parser = async value => {
        parses++;
        await new Promise(resolve => setTimeout(resolve, 20));
        return { text: value, units: [{ id: 'A' }] };
    };
    const [first, second] = await Promise.all([
        getParsedDocumentSessionAsync(session, text, parser),
        getParsedDocumentSessionAsync(session, text, parser)
    ]);
    assert.equal(parses, 1);
    assert.equal(first, second);
    assert.equal(session.parsed, first);
    assert.equal(session.parsedPromise, undefined);
});


test('DocumentSession cache also evicts by estimated memory budget', () => {
    const a = getDocumentSession(uri('/Translations/a.xlf'), '<xliff>' + 'A'.repeat(4000) + '</xliff>');
    getParsedDocumentSession(a, '<xliff>' + 'A'.repeat(4000) + '</xliff>', () => ({ units: Array.from({ length: 20 }, (_, ordinal) => ({ ordinal, noteDetails: [] })) }));
    const b = getDocumentSession(uri('/Translations/b.xlf'), '<xliff>' + 'B'.repeat(4000) + '</xliff>');
    getParsedDocumentSession(b, '<xliff>' + 'B'.repeat(4000) + '</xliff>', () => ({ units: Array.from({ length: 20 }, (_, ordinal) => ({ ordinal, noteDetails: [] })) }));
    const before = totalEstimatedSessionBytes();
    assert.ok(before > 0);
    assert.ok(estimateSessionBytes(a) > 0);
    trimSessions(DEFAULT_MAX_SESSIONS, Math.max(1024, Math.floor(before / 2)));
    assert.ok(sessionCount() < 2, 'memory budget should evict the least-recently-used unpinned snapshot');
    assert.ok(totalEstimatedSessionBytes() <= before);
});

test('DocumentSession memory budget never evicts a retained active editor session', () => {
    const activeUri = uri('/Translations/active-budget.xlf');
    retainDocumentSession(activeUri);
    const active = getDocumentSession(activeUri, '<xliff>' + 'A'.repeat(4000) + '</xliff>');
    getParsedDocumentSession(active, '<x/>', () => ({ units: Array.from({ length: 20 }, (_, ordinal) => ({ ordinal, noteDetails: [] })) }));
    for (let index = 0; index < 3; index++) {
        const text = '<xliff>' + String(index).repeat(4000) + '</xliff>';
        const session = getDocumentSession(uri(`/Translations/budget-${index}.xlf`), text);
        getParsedDocumentSession(session, text, () => ({ units: Array.from({ length: 20 }, (_, ordinal) => ({ ordinal, noteDetails: [] })) }));
    }
    trimSessions(DEFAULT_MAX_SESSIONS, 1024);
    assert.equal(getExistingDocumentSession(activeUri), active);
    releaseDocumentSession(activeUri);
});

test('DocumentSession default memory budget is explicit and bounded', () => {
    assert.equal(DEFAULT_MAX_SESSION_BYTES, 384 * 1024 * 1024);
});


test('DocumentSession memory budget can be configured at runtime', () => {
    const limits = configureDocumentSessionCache({ maxBytes: 96 * 1024 * 1024 });
    assert.equal(limits.maxBytes, 96 * 1024 * 1024);
    assert.equal(getDocumentSessionCacheLimits().maxBytes, 96 * 1024 * 1024);
});
