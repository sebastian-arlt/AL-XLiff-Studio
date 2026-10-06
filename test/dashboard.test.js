'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { parseXliff } = require('../src/xliff');
const { calculateXliffMetrics, summarizeDashboardFiles } = require('../src/dashboardMetrics');


function loadDashboardWithVscodeStub() {
    const originalLoad = Module._load;
    const vscodeStub = {
        Uri: { parse(value) { return { toString() { return value; }, fsPath: value }; } },
        ViewColumn: { One: 1 },
        workspace: { textDocuments: [] },
        window: {}
    };
    Module._load = function(request, parent, isMain) {
        if (request === 'vscode') return vscodeStub;
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        for (const mod of ['../src/dashboard', '../src/xlfEditor', '../src/ai']) {
            try { delete require.cache[require.resolve(mod)]; } catch (_) {}
        }
        return require('../src/dashboard');
    } finally {
        Module._load = originalLoad;
    }
}

test('dashboard metrics distinguish translated, missing, review and placeholder errors', () => {
    const parsed = parseXliff(`<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A"><source>Customer</source><target state="translated">Debitor</target></trans-unit>
<trans-unit id="B"><source>Name</source><target state="needs-translation"/></trans-unit>
<trans-unit id="C"><source>Order</source><target state="needs-review-translation">Auftrag</target></trans-unit>
<trans-unit id="D"><source>Customer %1</source><target state="translated">Debitor %2</target></trans-unit>
<trans-unit id="E" translate="no"><source>Internal</source><target>Intern</target></trans-unit>
</group></body></file></xliff>`);
    const metrics = calculateXliffMetrics(parsed);
    assert.equal(metrics.total, 4);
    assert.equal(metrics.translated, 2);
    assert.equal(metrics.missing, 1);
    assert.equal(metrics.review, 1);
    assert.equal(metrics.placeholderErrors, 1);
    assert.equal(metrics.percent, 50);
    assert.ok(metrics.qualityIssues >= 1);
    assert.ok(metrics.qualityErrors >= 1);
});

test('dashboard summary aggregates files and distinct languages', () => {
    const summary = summarizeDashboardFiles([
        { targetLanguage: 'de-DE', metrics: { total: 100, translated: 80, missing: 10, review: 10, placeholderErrors: 2, structuralWarnings: 1 } },
        { targetLanguage: 'fr-FR', metrics: { total: 50, translated: 40, missing: 5, review: 5, placeholderErrors: 1, structuralWarnings: 0 } },
        { targetLanguage: 'DE-de', metrics: { total: 10, translated: 10, missing: 0, review: 0, placeholderErrors: 0, structuralWarnings: 0 } }
    ]);
    assert.equal(summary.files, 3);
    assert.equal(summary.languages, 2);
    assert.equal(summary.total, 160);
    assert.equal(summary.translated, 130);
    assert.equal(summary.missing, 15);
    assert.equal(summary.review, 15);
    assert.equal(summary.placeholderErrors, 3);
    assert.equal(summary.structuralWarnings, 1);
    assert.equal(summary.qualityIssues, 0);
    assert.equal(summary.percent, 81);
});

test('dashboard is registered and XLIFF editor accepts dashboard filters', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    assert.ok(pkg.contributes.commands.some(command => command.command === 'alXliffStudio.openDashboard'));
    assert.ok(pkg.activationEvents.includes('onCommand:alXliffStudio.openDashboard'));

    const dashboard = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8');
    assert.match(dashboard, /Translation Dashboard/);
    assert.match(dashboard, /metricButton\(file,m\.missing,'missing'/);
    assert.match(dashboard, /metricButton\(file,m\.review,'review'/);
    assert.match(dashboard, /metricButton\(file,m\.qualityIssues,'quality'/);
    assert.match(dashboard, /metricButton\(file,m\.translated,'translated'/);

    const editor = fs.readFileSync(path.join(__dirname, '..', 'src', 'xlfEditor.js'), 'utf8');
    assert.match(editor, /message\.type === 'dashboardFilter'/);
    assert.match(editor, /dashboardFilter === 'missing'/);
    assert.match(editor, /dashboardFilter === 'review'/);
    assert.match(editor, /dashboardFilter === 'errors'/);
    assert.match(editor, /dashboardFilter === 'translated'/);
    assert.match(editor, /dashboardFilter === 'quality'/);
});


test('dashboard webview script is valid JavaScript and exposes actionable project metrics', () => {
    const { TranslationDashboard } = loadDashboardWithVscodeStub();
    const dashboard = Object.create(TranslationDashboard.prototype);
    const html = dashboard.getHtml({ cspSource: 'vscode-webview://test' });
    const match = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/);
    assert.ok(match, 'dashboard webview script block not found');
    assert.doesNotThrow(() => new Function(match[1]));
    for (const label of ['Translation Dashboard', 'Translated', 'Missing', 'Review', 'Quality']) {
        assert.match(html, new RegExp(label));
    }
    assert.match(html, /data-filter="all"/);
    assert.match(html, /openFile/);
    assert.match(html, /↻ Refresh/);
    assert.match(html, /⇄ Sync all XLIFFs/);
    assert.match(html, /syncAll/);
    assert.match(html, /Out of sync/);
    assert.match(html, />Sync<\/th>/);
    assert.match(html, /typeof value==='number'&&Number\.isFinite\(value\)/);
    assert.doesNotMatch(html, /Number\(value\|\|0\)\.toLocaleString\(\)/);
});



test('dashboard links to the dedicated AI Usage overview without embedding usage statistics', () => {
    const { TranslationDashboard } = loadDashboardWithVscodeStub();
    const dashboard = Object.create(TranslationDashboard.prototype);
    const html = dashboard.getHtml({ cspSource: 'vscode-webview://test' });
    assert.match(html, /id="aiUsage"/);
    assert.match(html, /openAiUsage/);
    assert.doesNotMatch(html, /data-ai-usage-toggle|aiUsageCollapsed|current VS Code session/);
});

test('dashboard wires project-wide generator synchronization and sync-state detection', () => {
    const dashboard = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8');
    assert.match(dashboard, /async synchronizeAll\(\)/);
    assert.match(dashboard, /getSynchronizationState/);
    assert.match(dashboard, /await synchronizeXliffAdaptive\(before,/);
    assert.match(dashboard, /result\.text === targetText/);
    assert.match(dashboard, /updateCompanionMapFromXliffTexts/);
    assert.match(dashboard, /missing-generator/);
    assert.match(dashboard, /out-of-sync/);
    assert.match(dashboard, /result\.removedUnits\.length/);
    assert.match(dashboard, /obsolete unit\(s\) to remove/);
});

test('dashboard counts target text without state as review instead of translated', () => {
    const parsed = parseXliff(`<xliff><file source-language="en-US" target-language="de-DE"><body><group>
<trans-unit id="A"><source>A</source><target>Eintrag A</target></trans-unit>
<trans-unit id="B"><source>B</source><target state="translated">Eintrag B</target></trans-unit>
<trans-unit id="C"><source>C</source><target/></trans-unit>
</group></body></file></xliff>`);
    const metrics = calculateXliffMetrics(parsed);
    assert.equal(metrics.total, 3);
    assert.equal(metrics.translated, 1);
    assert.equal(metrics.review, 1);
    assert.equal(metrics.missing, 1);
    assert.equal(metrics.percent, 33);
});
