'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createQualityPageStore, queryQualityPage } = require('../src/qualityPaging');

function report(count = 305) {
    const issues = Array.from({ length: count }, (_, ordinal) => ({ ordinal, severity: ['error', 'warning', 'info'][ordinal % 3], code: `Q${ordinal % 4}`, source: `Source ${ordinal}`, target: `Target ${ordinal}`, message: `Finding ${ordinal}` }));
    return { issues, ignoredIssues: issues.slice(0, 17).map(issue => ({ ...issue, ignoredBy: 'project' })), summary: { total: count }, ignoredSummary: { total: 17 } };
}

test('quality host pages retain stable finding references and never transfer the full report', async () => {
    const full = report();
    const store = createQualityPageStore(full, 7);
    const first = await queryQualityPage(store, { pageSize: 50 });
    const last = await queryQualityPage(store, { pageSize: 50, page: 999 });
    assert.equal(first.items.length, 50);
    assert.equal(first.revision, 7);
    assert.equal(last.page, 7);
    assert.equal(last.items.length, 5);
    assert.equal(last.items[0].sourceIndex, 300);
    assert.equal(last.items[0].issue, full.issues[300]);
    assert.equal(store.builds, 1);
    assert.equal(last.cacheHit, true);
    assert.equal(store.metadata.issueCount, 305);
    assert.equal(store.metadata.projectIgnoredCount, 17);
    assert.ok(!Object.hasOwn(store.metadata, 'issues'));
    assert.ok(!Object.hasOwn(first, 'report'));
});

test('quality filtering is OR-combined, independent for ignored findings and sorted in the host', async () => {
    const store = createQualityPageStore(report(), 1);
    const page = await queryQualityPage(store, { severities: ['error', 'info'], sortColumn: 'ordinal', sortDirection: 'desc', pageSize: 50 });
    assert.equal(page.filteredCount, 203);
    assert.equal(page.items[0].issue.ordinal, 303);
    assert.ok(page.items.every(item => item.issue.severity !== 'warning'));
    const ignored = await queryQualityPage(store, { view: 'ignored', severities: ['warning'] });
    assert.equal(ignored.filteredCount, 6);
    assert.equal(ignored.items[0].sourceIndex, 1);
    const filtered = await queryQualityPage(store, { filter: 'Source 304' });
    assert.equal(filtered.items.length, 1);
    assert.equal(filtered.items[0].issue.ordinal, 304);
    const empty = await queryQualityPage(store, { filter: 'not found', page: 100 });
    assert.equal(empty.filteredCount, 0);
    assert.equal(empty.start, 0);
    assert.equal(empty.page, 1);
});

test('quality query clamps page sizes and maintains stable order for equal sort keys', async () => {
    const store = createQualityPageStore(report(), 1);
    const page = await queryQualityPage(store, { pageSize: 100000, sortColumn: 'code' });
    assert.equal(page.items.length, 100);
    assert.equal(page.pageSize, 100);
    const ties = page.items.filter(item => item.issue.code === 'Q0');
    assert.ok(ties.every((item, i) => !i || ties[i - 1].sourceIndex < item.sourceIndex));
});

test('quality index builds yield to the event loop, cancel and bound retained filter indices', async () => {
    const store = createQualityPageStore(report(30000), 1);
    let heartbeat = false;
    setImmediate(() => { heartbeat = true; });
    await queryQualityPage(store, { sortColumn: 'source' });
    assert.equal(heartbeat, true);
    const controller = new AbortController();
    const pending = queryQualityPage(store, { filter: 'cancelled' }, { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    for (let i = 0; i < 20; i++) await queryQualityPage(store, { filter: String(i) });
    assert.ok(store.queries.size <= 16);
});

test('Quality sort applies to the complete result set before slicing a page', async () => {
 const {createQualityPageStore,queryQualityPage}=require('../src/qualityPaging');
 const issues=Array.from({length:120},(_,ordinal)=>({ordinal,severity:ordinal%2?'warning':'error',code:'Q',source:'Source '+ordinal,target:'Target '+ordinal}));
 const store=createQualityPageStore({issues,ignoredIssues:[],summary:{total:120}},1);
 const last=await queryQualityPage(store,{sortColumn:'ordinal',sortDirection:'desc',pageSize:50,page:3});
 assert.equal(last.items[0].issue.ordinal,19);assert.equal(last.items.at(-1).issue.ordinal,0);
 const severity=await queryQualityPage(store,{sortColumn:'severity',sortDirection:'asc',pageSize:50,page:1});
 assert.ok(severity.items.every(item=>item.issue.severity==='error'));
});
