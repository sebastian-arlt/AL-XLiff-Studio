'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const { createEditorHarness, generateLargeXliff } = require('./editor-harness.cjs');
const { observeWorkers, cancelXliffWorkers } = require('../src/xlfWorkerHost');
const { assessStressBudgets } = require('./stress-budgets.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function runStress(options = {}) {
    const root = path.resolve(options.output || 'artifacts/large-xlf');
    const unitCount = options.units || 30000;
    const fixture = generateLargeXliff(unitCount, options.bytes || 15 * 1024 * 1024);
    const events = [], measurements = [];
    const stop = observeWorkers(event => events.push({ ...event, timestamp: performance.now() }));
    const h = await createEditorHarness({ root, text: fixture, configuration: { 'debug.performance.enabled': true, 'debug.performance.slowThresholdMs': 100 } });
    let requestId = 0;
    const viewPage = async view => {
        const doc = h.last('document');
        await h.send({ type: 'requestViewPage', loadId: doc.loadId, requestId: ++requestId, view });
        return h.last('viewPage');
    };
    const qualityPage = async query => {
        const report = h.last('qualityReport');
        await h.send({ type: 'requestQualityPage', loadId: report.loadId, revision: report.report.revision, documentVersion: report.documentVersion, requestId: ++requestId, ...query });
        return h.last('qualityPage');
    };
    const snapshot = () => { const m = process.memoryUsage(); return { rssMB: m.rss / 1048576, heapUsedMB: m.heapUsed / 1048576, externalMB: m.external / 1048576 }; };
    const measure = async (name, action) => {
        const eventStart = events.length, transferStart = h.transfers.length;
        const histogram = monitorEventLoopDelay({ resolution: 10 });
        histogram.enable();
        let peak = snapshot(), gap = 0, lastBeat = performance.now();
        const sampler = setInterval(() => {
            const now = performance.now();
            gap = Math.max(gap, now - lastBeat - 5);
            lastBeat = now;
            const memory = snapshot();
            peak.rssMB = Math.max(peak.rssMB, memory.rssMB);
            peak.heapUsedMB = Math.max(peak.heapUsedMB, memory.heapUsedMB);
        }, 5);
        await delay(15);
        const before = snapshot(), started = performance.now();
        let detail;
        try { detail = await action(); }
        finally {
            const elapsedMs = performance.now() - started;
            const after = snapshot();
            peak.rssMB = Math.max(peak.rssMB, after.rssMB);
            peak.heapUsedMB = Math.max(peak.heapUsedMB, after.heapUsedMB);
            await delay(15);
            clearInterval(sampler);
            histogram.disable();
            const transfers = h.transfers.slice(transferStart);
            const workerEvents = events.slice(eventStart);
            const measurement = { name, elapsedMs, eventLoopMaxDelayMs: histogram.max / 1e6, eventLoopP99DelayMs: histogram.percentile(99) / 1e6, heartbeatMaxStallMs: gap, before, after, peak, transferBytes: transfers.reduce((sum, item) => sum + item.bytes, 0), workersStarted: workerEvents.filter(event => event.event === 'started').length, workersCancelled: workerEvents.filter(event => event.outcome === 'cancelled').length, detail };
            measurements.push(measurement);
            console.log(`${name}: ${elapsedMs.toFixed(1)} ms, stall ${gap.toFixed(1)} ms, peak RSS ${peak.rssMB.toFixed(1)} MiB`);
        }
        assert.equal(h.getErrors().length, 0, JSON.stringify(h.getErrors()));
    };
    let result;
    try {
        await measure('Open + first translation page', async () => {
            await h.send({ type: 'ready' });
            assert.ok(h.last('document').rowStateIndex.length <= unitCount);
            const page = await viewPage({ page: 1, pageSize: 100 });
            assert.equal(page.rows.length, 100);
            assert.equal(page.totalCount, unitCount);
            return { units: page.totalCount, pageRows: page.rows.length, deferredQuality: h.last('document').qualityPending };
        });
        await measure('Filter + sort', async () => {
            const page = await viewPage({ filters: { source: 'Customer 000' }, sortField: 'source', sortDirection: -1, pageSize: 50 });
            assert.equal(page.filteredCount, 100);
            assert.equal(page.rows[0].ordinal, 99);
            return { filteredCount: page.filteredCount };
        });
        await measure('Translation paging', async () => {
            for (const page of [2, 30, 100, Math.ceil(unitCount / 100)]) {
                const result = await viewPage({ page, pageSize: 100 });
                assert.equal(result.rows[0].ordinal, (result.page - 1) * 100);
            }
        });
        await measure('Deferred Quality Check + Problems', async () => {
            const start = h.messages.length;
            const doc = h.last('document');
            await h.send({ type: 'initialPageRendered', loadId: doc.loadId, documentVersion: doc.documentVersion });
            const report = await h.waitFor(message => message.type === 'qualityReport', start);
            assert.ok(report.report.issueCount > 2000);
            assert.ok(!Object.hasOwn(report.report, 'issues'));
            assert.equal(h.diagnostics.get(h.uri.toString()).length, 2000);
            return { findings: report.report.issueCount, diagnostics: 2000 };
        });
        await measure('Quality filter + sort', async () => {
            const page = await qualityPage({ severities: ['error', 'warning'], sortColumn: 'ordinal', sortDirection: 'desc', pageSize: 50 });
            assert.equal(page.items.length, 50);
            assert.ok(page.items.every(item => item.issue.severity !== 'info'));
            assert.ok(page.items[0].issue.ordinal >= page.items[49].issue.ordinal);
            return { findings: page.filteredCount };
        });
        await measure('Quality paging + query cache', async () => {
            for (const page of [2, 3, 999999]) {
                const result = await qualityPage({ severities: ['error', 'warning'], sortColumn: 'ordinal', sortDirection: 'desc', pageSize: 50, page });
                assert.ok(result.items.length <= 50);
                assert.equal(result.cacheHit, true);
            }
            const ignored = await qualityPage({ view: 'ignored' });
            assert.equal(ignored.items.length, 0);
        });
        await measure('Problems → Editor', async () => {
            const diagnostic = h.diagnostics.get(h.uri.toString())[0];
            const target = h.navigation.getQualityDiagnosticMapping(h.uri, diagnostic);
            assert.ok(target);
            assert.equal(await h.editor.XliffEditorProvider.openAtDiagnosticTarget(h.uri, target), true);
            const jump = h.last('jumpToOrdinal');
            assert.equal(jump.ordinal, target.ordinal);
            const page = await viewPage({ filters: { source: 'does not match' }, navigationOrdinal: jump.ordinal });
            assert.equal(page.rows[0].ordinal, target.ordinal);
        });
        await measure('QC-Go → filtered translation page', async () => {
            const page = await qualityPage({ pageSize: 100 });
            const issue = page.items.find(item => Number.isInteger(item.issue.ordinal)).issue;
            const translationPage = await viewPage({ quick: { translated: true }, navigationOrdinal: issue.ordinal, pageSize: 50 });
            assert.ok(translationPage.rows.some(row => row.ordinal === issue.ordinal));
        });
        const draft = { ordinal: 0, translation: 'Geänderter Kunde %1.', source: 'Customer 00000 %1.' };
        await measure('Edit / volatile draft + draft Quality Check', async () => {
            const original = h.document.getText(), version = h.document.version;
            await h.send({ type: 'translationDraftChanged', ordinal: 0, text: draft.translation, hasDraft: true, revision: 1 });
            assert.equal(h.document.version, version);
            assert.equal(h.document.getText(), original);
            const page = await viewPage({ navigationOrdinal: 0, quick: { draft: true }, overrides: [] });
            // Unsent drafts are included via the request's compact overrides.
            assert.ok(page.rows.some(row => row.ordinal === 0));
            await h.send({ type: 'validateQuality', items: [draft] });
            assert.equal(h.last('qualityReport').includesDrafts, true);
            return { versionUnchanged: true, includesDrafts: true };
        });
        await measure('Apply draft + background maintenance', async () => {
            const start = h.messages.length;
            const started = performance.now(), eventStart = events.length;
            await h.send({ type: 'saveManyDrafts', items: [draft] });
            const commitMs = performance.now() - started;
            assert.ok(events.slice(eventStart).some(event => event.task === 'apply' && event.outcome === 'completed'));
            assert.equal(h.last('draftsSaved').items.length, 1);
            await h.waitFor(message => message.type === 'qualityReport', start);
            assert.ok(h.document.getText().includes(draft.translation));
            assert.equal(h.document.isDirty, true);
            return { commitMs };
        });
        await measure('Save + background Quality Check', async () => {
            const start = h.messages.length;
            const started = performance.now();
            await h.send({ type: 'saveDocument', items: [] });
            const commitMs = performance.now() - started;
            assert.equal(h.document.isDirty, false);
            assert.equal(await fs.promises.readFile(h.uri.fsPath, 'utf8'), h.document.getText());
            await h.waitFor(message => message.type === 'qualityReport', start);
            return { commitMs };
        });
        await measure('Rapid Quality refresh / real cancellation', async () => {
            const start = h.messages.length, eventStart = events.length;
            const first = h.send({ type: 'validateQuality', items: [{ ...draft, translation: 'Alt %1.' }] });
            // Wait for an actual worker before testing cancellation. A fixed
            // delay can supersede only queued work on a busy machine.
            const workerDeadline = performance.now() + 5000;
            while (!events.slice(eventStart).some(event => event.event === 'started') && performance.now() < workerDeadline) await delay(5);
            assert.ok(events.slice(eventStart).some(event => event.event === 'started'), 'first quality worker must start');
            const second = h.send({ type: 'validateQuality', items: [{ ...draft, translation: 'Neu %1.' }] });
            await Promise.all([first, second]);
            assert.equal(h.messages.slice(start).filter(message => message.type === 'qualityReport').length, 1);
            assert.ok(events.slice(eventStart).some(event => event.outcome === 'cancelled'));
        });
        await measure('Sync + companion translation memory', async () => {
            const eventStart = events.length;
            const generated = fixture.replace('Customer 00001 %1.', 'Changed customer 00001 %1.');
            await fs.promises.writeFile(path.join(root, 'Translations/Stress.g.xlf'), generated);
            await h.send({ type: 'refresh' });
            assert.equal(h.last('syncStatus').status, 'out-of-sync');
            await h.send({ type: 'synchronizeFile' });
            assert.ok(events.slice(eventStart).some(event => event.task === 'sync' && event.outcome === 'completed'), 'large Sync must compute in a worker');
            assert.ok(h.document.getText().includes('Changed customer 00001 %1.'));
            assert.ok(h.document.getText().includes(draft.translation));
            const map = await fs.promises.readFile(path.join(root, '.alxliffstudio/lng/Stress.de-DE.lng'), 'utf8');
            assert.ok(map.includes(draft.translation));
            assert.ok(h.statuses.some(message => message.includes('synchronized')));
            assert.equal((await viewPage({ page: 1 })).totalCount, unitCount);
        });
        await measure('Change while parsing + close while quality worker is running', async () => {
            const start = events.length;
            // Force a new parser snapshot, then change and close during the next run.
            h.externalChange(h.document.getText() + '\n');
            const refresh = h.send({ type: 'refresh' });
            await delay(10);
            h.externalChange(h.document.getText() + '\n');
            await refresh;
            assert.ok(events.slice(start).some(event => event.task === 'parse' && event.outcome === 'cancelled'));
            await h.send({ type: 'refresh' });
            const workerStarted = new Promise((resolve, reject) => {
                const timer = setTimeout(() => { unobserve(); reject(new Error('Quality worker did not start')); }, 10000);
                const unobserve = observeWorkers(event => {
                    if (event.event === 'started' && event.task === 'qualityText') { clearTimeout(timer); unobserve(); resolve(); }
                });
            });
            const quality = h.send({ type: 'validateQuality', items: [draft] });
            await workerStarted;
            h.close();
            await quality;
            await cancelXliffWorkers();
            assert.ok(events.slice(start).some(event => event.task === 'qualityText' && event.outcome === 'cancelled'));
            assert.equal(events.at(-1).activeWorkers, 0);
        });
        assert.equal(h.popups.length, 0);
        assert.ok(h.transfers.filter(item => item.type === 'qualityPage').every(item => item.items <= 200));
        const alive = new Map();
        for (const event of events) {
            const key = event.resourceKey;
            if (event.event === 'started') { assert.ok(!alive.has(key), 'parallel older worker'); alive.set(key, event.threadId); }
            else { assert.equal(alive.get(key), event.threadId); alive.delete(key); }
        }
        assert.equal(alive.size, 0);
        result = {
            version: require('../package.json').version, fixture: { units: unitCount, bytes: Buffer.byteLength(fixture), sha256: crypto.createHash('sha256').update(fixture).digest('hex') },
            environment: { node: process.version, platform: process.platform, arch: process.arch, cpus: os.cpus().length, cpu: os.cpus()[0].model, totalMemoryMB: os.totalmem() / 1048576 },
            scope: 'Real editor host handlers, real worker threads and filesystem; VS Code document/event/transport adapter. No Chromium paint, UI input latency or actual VS Code Problems widget measurement.',
            budgets: assessStressBudgets(measurements, options),
            measurements, workerEvents: events, transfers: h.transfers, popups: h.popups,
            limitations: ['RSS sampled at 5 ms plus phase boundaries; worker RSS is included, short peaks can be missed.', 'Event-loop histograms have a 10 ms floor; heartbeat stalls subtract the 5 ms sampling interval.', 'This adapter does not provide a rendered VS Code acceptance test; use docs/large-xlf-stress.md for that checklist.']
        };
        await fs.promises.writeFile(path.join(root, 'stress-report.json'), JSON.stringify(result, null, 2));
        assert.deepEqual(result.budgets.exceeded, [], 'Configured stress performance budget exceeded');
        return result;
    } catch (error) {
        await fs.promises.writeFile(path.join(root, 'stress-failure.json'), JSON.stringify({ error: error.stack, measurements, workerEvents: events, messages: h.getErrors() }, null, 2));
        throw error;
    } finally {
        h.close();
        await cancelXliffWorkers();
        stop();
        await h.performanceDebug.flushPerformanceDebug();
    }
}

if (require.main === module) {
    const args = Object.fromEntries(process.argv.slice(2).map(argument => argument.replace(/^--/, '').split('=')));
    runStress({ output: args.output, units: Number(args.units) || undefined, bytes: Number(args.bytes) || undefined, maxStallMs: args['max-stall-ms'], maxRssMB: args['max-rss-mb'], syncMaxStallMs:args['max-sync-stall-ms'] }).catch(error => { console.error(error); process.exitCode = 1; });
}
module.exports = { runStress };
