'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
    workerConfiguration,
    shouldUseXliffWorker,
    parseXliffOffThread,
    analyzeXliffQualityOffThread,
    parseXliffAdaptive,
    analyzeXliffQualityAdaptive
} = require('../src/xlfWorkerHost');
const { runWorkerTask, observeWorkers, cancelXliffWorkers } = require('../src/xlfWorkerHost');
const { synchronizeXliffAdaptive } = require('../src/xlfWorkerHost');

test('Sync worker preserves exact synchronization and translation-memory semantics', async () => {
    const {synchronizeTranslationUnits}=require('../src/synchronize');
    const {translationMemorySnapshots,mergeTranslationMemorySnapshots}=require('../src/translationMemory');
    const generated=SAMPLE.replace('Hello %1','Changed %1').replace('<trans-unit id="B">','<trans-unit id="C">');
    const expected=synchronizeTranslationUnits(SAMPLE,generated);
    const result=await synchronizeXliffAdaptive(SAMPLE,generated,config(),{unitCount:5000,resourceKey:'sync-equivalence'});
    assert.equal(result.text,expected.text);
    for(const field of ['synchronizedSources','addedUnits','flaggedTargets','removedUnits','synchronizedDeveloperNotes','synchronizedGeneratorNotes']) assert.deepEqual(result[field],expected[field]);
    assert.deepEqual(result.memorySnapshots,translationMemorySnapshots([SAMPLE,expected.text]));
    const memory=mergeTranslationMemorySnapshots([],result.memorySnapshots);
    assert.ok(memory.entries.some(entry => entry.source === 'Hello %1'));
    const small=await synchronizeXliffAdaptive(SAMPLE,generated,config({'performance.workerThreads.enabled':false}));
    assert.deepEqual(small,result);
});

test('Sync cancellation terminates a running thread and worker failure never starts a blocking fallback', async () => {
    const controller=new AbortController(), events=[];
    const stop=observeWorkers(event => {events.push(event); if(event.task==='sync' && event.event==='started') controller.abort('Changed');});
    try {
        await assert.rejects(synchronizeXliffAdaptive(SAMPLE,SAMPLE,config(),{unitCount:5000,resourceKey:'sync-cancel',signal:controller.signal,workerPath:path.join(__dirname,'../tools/fixtures/busy-worker.cjs')}),{name:'AbortError'});
        assert.ok(events.some(event => event.task==='sync' && event.outcome==='cancelled'));
        await assert.rejects(synchronizeXliffAdaptive(SAMPLE,SAMPLE,config(),{unitCount:5000,workerPath:path.join(__dirname,'../tools/fixtures/empty-worker.cjs')}),/without a result/);
    } finally {stop();}
});

function config(values = {}) {
    return { get(key, fallback) { return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : fallback; } };
}

const SAMPLE = `<?xml version="1.0" encoding="utf-8"?>
<xliff version="1.2"><file source-language="en-US" target-language="de-DE"><body>
<trans-unit id="A"><source>Hello %1</source><target state="translated">Hallo %1</target></trans-unit>
<trans-unit id="B"><source>World</source><target state="translated">Welt</target></trans-unit>
</body></file></xliff>`;

test('worker thresholds are configurable and disabled explicitly', () => {
    const defaults = workerConfiguration(config());
    assert.equal(defaults.enabled, true);
    assert.equal(defaults.unitThreshold, 5000);
    assert.equal(defaults.charThreshold, 3 * 1024 * 1024);

    assert.equal(shouldUseXliffWorker(SAMPLE, 2, config()), false);
    assert.equal(shouldUseXliffWorker(SAMPLE, 5000, config()), true);
    assert.equal(shouldUseXliffWorker(SAMPLE, 50000, config({ 'performance.workerThreads.enabled': false })), false);
    assert.equal(shouldUseXliffWorker(SAMPLE, 2000, config({ 'performance.workerThreads.minUnits': 2000 })), true);
});

test('worker parses XLIFF and quality report preserves ordinal maps', async () => {
    const parsed = await parseXliffOffThread(SAMPLE);
    assert.equal(parsed.units.length, 2);
    assert.equal(parsed.targetLanguage, 'de-DE');
    assert.ok(Number.isInteger(parsed.units[0].startOffset));

    const report = await analyzeXliffQualityOffThread(parsed, {
        checkSourceEqualsTarget: true,
        glossaryEntries: [],
        projectQualityIgnores: []
    });
    assert.ok(report.byOrdinal instanceof Map);
    assert.ok(report.ignoredByOrdinal instanceof Map);
    assert.equal(typeof report.summary.total, 'number');
});

test('adaptive worker path offloads parse and quality when unit threshold is reached', async () => {
    const forced = config({ 'performance.workerThreads.minUnits': 1000 });
    const unitCount = 1000;
    const parsedResult = await parseXliffAdaptive(SAMPLE, forced, { unitCount });
    assert.equal(parsedResult.workerUsed, true);
    assert.equal(parsedResult.fallback, false);

    const largeParsed = {
        ...parsedResult.parsed,
        units: Array.from({ length: unitCount }, (_, ordinal) => ({
            ...parsedResult.parsed.units[ordinal % parsedResult.parsed.units.length],
            ordinal,
            id: `U${ordinal}`,
            source: `Source ${ordinal}`,
            target: `Target ${ordinal}`
        }))
    };
    const qualityResult = await analyzeXliffQualityAdaptive(largeParsed, {
        glossaryEntries: [],
        projectQualityIgnores: []
    }, SAMPLE, forced, { unitCount });
    assert.equal(qualityResult.workerUsed, true);
    assert.equal(qualityResult.fallback, false);
    assert.ok(qualityResult.report.byOrdinal instanceof Map);
});


test('adaptive Quality worker reparses source text and applies compact draft overrides instead of cloning the parsed graph', async () => {
    const forced = config({ 'performance.workerThreads.minUnits': 1000 });
    const parsedResult = await parseXliffAdaptive(SAMPLE, forced, { unitCount: 1000 });
    const largeParsed = {
        ...parsedResult.parsed,
        units: Array.from({ length: 1000 }, (_, ordinal) => ({
            ...parsedResult.parsed.units[ordinal % parsedResult.parsed.units.length],
            ordinal,
            id: `U${ordinal}`
        }))
    };
    const qualityResult = await analyzeXliffQualityAdaptive(largeParsed, {
        glossaryEntries: [],
        projectQualityIgnores: [],
        checkSourceEqualsTarget: true
    }, SAMPLE, forced, {
        unitCount: 1000,
        unitOverrides: [{ ordinal: 0, target: 'Hello %1', targetState: 'translated' }]
    });
    assert.equal(qualityResult.workerUsed, true);
    assert.ok(qualityResult.report.issues.some(issue => issue.ordinal === 0 && issue.code === 'source-equals-target'));
});

test('aborting a running parser or quality worker terminates it without synchronous fallback', async () => {
    for (const task of ['parse', 'quality']) {
        const controller = new AbortController();
        const events = [];
        const phases = [];
        const stop = observeWorkers(event => {
            events.push(event);
            if (event.event === 'started') controller.abort('test cancellation');
        });
        try {
            const options = { signal: controller.signal, unitCount: 5000, workerPath: path.join(__dirname, '../tools/fixtures/busy-worker.cjs'), onPhase: phase => phases.push(phase) };
            const promise = task === 'parse'
                ? parseXliffAdaptive(SAMPLE, config(), options)
                : analyzeXliffQualityAdaptive({ units: new Array(5000) }, {}, SAMPLE, config(), options);
            await assert.rejects(promise, { name: 'AbortError' });
            assert.equal(events.at(-1).event, 'terminated');
            assert.equal(events.at(-1).outcome, 'cancelled');
            assert.equal(events.at(-1).activeWorkers, 0);
            assert.ok(!phases.some(phase => phase.includes('fallback')));
        } finally { stop(); }
    }
});

test('superseding workers waits for termination and cancels queued older runs', async () => {
    const events = [];
    const stop = observeWorkers(event => events.push(event));
    const options = { resourceKey: 'supersede.xlf', workerPath: path.join(__dirname, '../tools/fixtures/busy-worker.cjs') };
    try {
        const first = runWorkerTask('parse', {}, options).catch(error => error);
        await new Promise(resolve => setImmediate(resolve));
        const second = runWorkerTask('parse', {}, options).catch(error => error);
        const third = parseXliffOffThread(SAMPLE, { resourceKey: options.resourceKey });
        assert.equal((await first).name, 'AbortError');
        assert.equal((await second).name, 'AbortError');
        assert.equal((await third).units.length, 2);
        assert.equal(events.filter(event => event.event === 'started').length, 2);
        assert.ok(events.every(event => event.activeWorkers <= 1));
        assert.equal(events.at(-1).activeWorkers, 0);
    } finally { stop(); }
});

test('document cancellation terminates both task types and leaves other resources intact', async () => {
    const options = { resourceKey: 'close.xlf', workerPath: path.join(__dirname, '../tools/fixtures/busy-worker.cjs') };
    const first = runWorkerTask('parse', {}, options).catch(error => error);
    const second = runWorkerTask('quality', {}, options).catch(error => error);
    await new Promise(resolve => setImmediate(resolve));
    const other = parseXliffOffThread(SAMPLE, { resourceKey: 'other.xlf' });
    await cancelXliffWorkers(options.resourceKey);
    assert.equal((await first).name, 'AbortError');
    assert.equal((await second).name, 'AbortError');
    assert.equal((await other).units.length, 2);
});

test('pre-cancelled work never starts a worker and clean exit without a result rejects promptly', async () => {
    const events = [];
    const stop = observeWorkers(event => events.push(event));
    const controller = new AbortController();
    controller.abort();
    try {
        await assert.rejects(parseXliffOffThread(SAMPLE, { signal: controller.signal }), { name: 'AbortError' });
        assert.equal(events.length, 0);
        await assert.rejects(runWorkerTask('parse', {}, { workerPath: path.join(__dirname, '../tools/fixtures/empty-worker.cjs') }), /without a result/);
        assert.equal(events.at(-1).activeWorkers, 0);
    } finally { stop(); }
});

test('a replacement parser waits for the obsolete Quality thread on the same document to exit', async () => {
    const events = [];
    const stop = observeWorkers(event => events.push(event));
    try {
        const previous = runWorkerTask('quality', {}, { resourceKey: 'cross-task.xlf', workerPath: path.join(__dirname, '../tools/fixtures/busy-worker.cjs') }).catch(error => error);
        await new Promise(resolve => setImmediate(resolve));
        const current = parseXliffOffThread(SAMPLE, { resourceKey: 'cross-task.xlf' });
        assert.equal((await previous).name, 'AbortError');
        assert.equal((await current).units.length, 2);
        assert.deepEqual(events.map(event => [event.event, event.task]), [
            ['started', 'quality'], ['terminated', 'quality'], ['started', 'parse'], ['terminated', 'parse']
        ]);
        assert.ok(events.every(event => event.activeWorkers <= 1));
    } finally { stop(); }
});

test('Apply worker matches batch XML edits and terminates on cancellation without blocking fallback', async () => {
 const {updateTranslationUnitsAdaptive}=require('../src/xlfWorkerHost');
 const {updateTranslationUnits}=require('../src/xliff');
 const changes=[{ordinal:0,changes:{translation:'Neu %1',state:'translated',clearStaged:true}}];
 assert.deepEqual(await updateTranslationUnitsAdaptive(SAMPLE,changes,config(),{unitCount:5000}),updateTranslationUnits(SAMPLE,changes));
 const controller=new AbortController(), events=[];
 const stop=observeWorkers(event=>{events.push(event);if(event.task==='apply'&&event.event==='started')controller.abort('Changed');});
 try {
  await assert.rejects(updateTranslationUnitsAdaptive(SAMPLE,changes,config(),{unitCount:5000,signal:controller.signal,workerPath:path.join(__dirname,'../tools/fixtures/busy-worker.cjs')}),{name:'AbortError'});
  assert.ok(events.some(event=>event.task==='apply'&&event.outcome==='cancelled'));
  await assert.rejects(updateTranslationUnitsAdaptive(SAMPLE,changes,config(),{unitCount:5000,workerPath:path.join(__dirname,'../tools/fixtures/empty-worker.cjs')}),/without a result/);
 } finally {stop();}
});
