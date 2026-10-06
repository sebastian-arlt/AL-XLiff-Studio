'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const extensionSource = fs.readFileSync(path.join(root, 'extension.js'), 'utf8');
const editorSource = fs.readFileSync(path.join(root, 'src', 'xlfEditor.js'), 'utf8');
const activitySource = fs.readFileSync(path.join(root, 'src', 'activityBar.js'), 'utf8');
const perfSource = fs.readFileSync(path.join(root, 'src', 'performanceDebug.js'), 'utf8');
const pathsSource = fs.readFileSync(path.join(root, 'src', 'studioPaths.js'), 'utf8');

test('performance debug tracing is opt-in and has a configurable slow threshold', () => {
    const enabled = pkg.contributes.configuration.properties['alXliffStudio.debug.performance.enabled'];
    const threshold = pkg.contributes.configuration.properties['alXliffStudio.debug.performance.slowThresholdMs'];
    assert.ok(enabled);
    assert.equal(enabled.type, 'boolean');
    assert.equal(enabled.default, false);
    assert.ok(threshold);
    assert.equal(threshold.type, 'integer');
    assert.equal(threshold.default, 250);
});

test('performance debug exposes a persistent log command and Activity Bar entry', () => {
    assert.ok(pkg.contributes.commands.some(command => command.command === 'alXliffStudio.openPerformanceDebugLog'));
    assert.ok(pkg.activationEvents.includes('onCommand:alXliffStudio.openPerformanceDebugLog'));
    assert.match(extensionSource, /openPerformanceDebugLog/);
    assert.match(activitySource, /Performance Debug Log/);
    assert.match(pathsSource, /performance\.log/);
});

test('XLIFF editor performance trace covers backend phases and webview rendering', () => {
    for (const phase of ['parse XLIFF', 'read glossary', 'quality check', 'prepare rows', 'post document payload']) {
        assert.match(editorSource, new RegExp(`perf\\.mark\\('${phase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    }
    assert.match(editorSource, /xlfEditor\.message\.\$\{/);
    assert.match(editorSource, /xlfEditor\.webview\.render/);
    assert.match(editorSource, /message\.type === 'performanceTrace'/);
});

test('performance trace writes checkpoints, slow markers, watchdogs and memory snapshots without translation text', () => {
    assert.match(perfSource, /STILL-RUNNING/);
    assert.match(perfSource, /SLOW-CHECKPOINT/);
    assert.match(perfSource, /process\.memoryUsage/);
    assert.match(perfSource, /MAX_LOG_BYTES/);
    assert.doesNotMatch(perfSource, /translation:/);
});

test('quality diagnostics build one line index instead of slicing and splitting the XLIFF for every issue', () => {
    assert.match(editorSource, /function buildLineStarts\(text\)/);
    assert.match(editorSource, /while \(low <= high\)/);
    assert.match(editorSource, /const positionCache = new Map\(\)/);
    assert.doesNotMatch(editorSource, /const before = String\(text \|\| ''\)\.slice\(0, clamped\)/);
    assert.doesNotMatch(editorSource, /before\.split\(\/\\r\?\\n\/\)/);
});

test('performance events capture sequence, timestamp and memory before queued filesystem work', () => {
    assert.match(perfSource, /sequence: \+\+eventCounter/);
    assert.match(perfSource, /timestamp: new Date\(\)\.toISOString\(\)/);
    assert.match(perfSource, /memory: memorySnapshot\(\)/);
    assert.match(perfSource, /globalWriteQueue = queued\.catch/);
});

test('Activity Bar and Dashboard update a saved XLIFF incrementally and share the quality cache', () => {
    const dashboardSource = fs.readFileSync(path.join(root, 'src', 'dashboard.js'), 'utf8');
    assert.match(activitySource, /async refreshFile\(uri\)/);
    assert.match(activitySource, /analyzeQualityForText\(uri, text/);
    assert.match(dashboardSource, /async refreshFile\(uri\)/);
    assert.match(dashboardSource, /analyzeQualityForText\(uri, text/);
});
