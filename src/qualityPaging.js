'use strict';

const { throwIfCancelled } = require('./xlfWorkerHost');
const PAGE_SIZES = [50, 100, 200];
const SORT_COLUMNS = ['report', 'ordinal', 'severity', 'code', 'source', 'target', 'message'];
const SEVERITIES = ['error', 'warning', 'info'];
const yieldToHost = () => new Promise(resolve => setImmediate(resolve));

function normalizeQualityQuery(request = {}) {
    const severities = SEVERITIES.filter(value => (Array.isArray(request.severities) ? request.severities : []).includes(value));
    return {
        view: request.view === 'ignored' ? 'ignored' : 'active',
        severities,
        filter: String(request.filter || '').toLowerCase(),
        sortColumn: SORT_COLUMNS.includes(request.sortColumn) ? request.sortColumn : 'report',
        sortDirection: request.sortDirection === 'desc' ? 'desc' : 'asc',
        pageSize: PAGE_SIZES.includes(Number(request.pageSize)) ? Number(request.pageSize) : 100,
        page: Math.max(1, Math.trunc(Number(request.page)) || 1)
    };
}

function createQualityPageStore(report, revision) {
    const issues = Array.isArray(report && report.issues) ? report.issues : [];
    const ignoredIssues = Array.isArray(report && report.ignoredIssues) ? report.ignoredIssues : [];
    return {
        report: report || {}, issues, ignoredIssues, revision,
        queries: new Map(), builds: 0,
        metadata: {
            revision,
            summary: report && report.summary,
            ignoredSummary: report && report.ignoredSummary,
            issueCount: issues.length,
            ignoredIssueCount: ignoredIssues.length,
            projectIgnoredCount: Number(report && report.projectIgnoredCount) || ignoredIssues.filter(issue => issue.ignoredBy === 'project').length
        }
    };
}

async function queryQualityPage(store, request = {}, options = {}) {
    const view = normalizeQualityQuery(request);
    const issues = view.view === 'ignored' ? store.ignoredIssues : store.issues;
    const signature = JSON.stringify([view.view, view.severities, view.filter, view.sortColumn, view.sortDirection]);
    let pending = store.queries.get(signature);
    const cacheHit = Boolean(pending);
    if (!pending) {
        pending = buildQualityIndex(issues, view, options.signal);
        store.queries.set(signature, pending);
        store.builds++;
        // Bound retained query indices even if many free-text queries are used.
        if (store.queries.size > 16) store.queries.delete(store.queries.keys().next().value);
        pending.catch(() => { if (store.queries.get(signature) === pending) store.queries.delete(signature); });
    }
    const indices = await pending;
    throwIfCancelled(options.signal);
    const pageCount = Math.max(1, Math.ceil(indices.length / view.pageSize));
    const page = Math.min(view.page, pageCount);
    const start = indices.length ? (page - 1) * view.pageSize : 0;
    const end = Math.min(start + view.pageSize, indices.length);
    return {
        revision: store.revision, view: view.view, page, pageSize: view.pageSize, pageCount,
        start, end, filteredCount: indices.length, totalCount: issues.length, cacheHit,
        items: indices.slice(start, end).map(sourceIndex => ({ sourceIndex, issue: issues[sourceIndex] }))
    };
}

async function buildQualityIndex(issues, view, signal) {
    const indices = [];
    for (let i = 0; i < issues.length; i++) {
        if (i % 1000 === 0) { throwIfCancelled(signal); await yieldToHost(); }
        const issue = issues[i];
        if (view.severities.length && !view.severities.includes(issue.severity || 'warning')) continue;
        if (view.filter && ![issue.code, issue.source, issue.target, issue.message].some(value => String(value || '').toLowerCase().includes(view.filter))) continue;
        indices.push(i);
    }
    if (view.sortColumn === 'report') {
        if (view.sortDirection === 'desc') indices.reverse();
        return indices;
    }
    const direction = view.sortDirection === 'desc' ? -1 : 1;
    const key = issue => view.sortColumn === 'severity' ? SEVERITIES.indexOf(issue.severity || 'warning')
        : view.sortColumn === 'ordinal' ? (Number.isInteger(issue.ordinal) ? issue.ordinal : -1)
        : String(issue[view.sortColumn] || '').toLowerCase();
    const compare = (a, b) => {
        const left = key(issues[a]), right = key(issues[b]);
        return (left < right ? -direction : left > right ? direction : 0) || a - b;
    };
    // Small native sorts plus a yielding merge avoid one long host sort for a
    // report with hundreds of thousands of findings.
    let runs = [];
    for (let i = 0; i < indices.length; i += 1000) {
        throwIfCancelled(signal);
        runs.push(indices.slice(i, i + 1000).sort(compare));
        await yieldToHost();
    }
    while (runs.length > 1) {
        const next = [];
        for (let r = 0; r < runs.length; r += 2) {
            if (!runs[r + 1]) { next.push(runs[r]); continue; }
            const a = runs[r], b = runs[r + 1], merged = [];
            let i = 0, j = 0;
            while (i < a.length || j < b.length) {
                if (merged.length % 1000 === 0) { throwIfCancelled(signal); await yieldToHost(); }
                merged.push(j >= b.length || (i < a.length && compare(a[i], b[j]) <= 0) ? a[i++] : b[j++]);
            }
            next.push(merged);
        }
        runs = next;
    }
    return runs[0] || [];
}

module.exports = { normalizeQualityQuery, createQualityPageStore, queryQualityPage };
