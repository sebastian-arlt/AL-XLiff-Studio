'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('automatic quality checks activate after VS Code startup and can be disabled', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.ok(pkg.activationEvents.includes('onStartupFinished'));
    const setting = pkg.contributes.configuration.properties['alXliffStudio.quality.autoRun.enabled'];
    assert.ok(setting);
    assert.equal(setting.default, true);
});

test('automatic quality checks cover startup, XLIFF saves/file changes, glossary changes and workspace/config changes', () => {
    const source = fs.readFileSync(path.join(root, 'src', 'autoQuality.js'), 'utf8');
    assert.match(source, /scheduleFullScan\(500\)/);
    assert.match(source, /createFileSystemWatcher\('\*\*\/\*\.xlf'\)/);
    assert.match(source, /onDidSaveTextDocument/);
    assert.match(source, /DEFAULT_GLOSSARY_FILENAME/);
    assert.match(source, /PROJECT_QUALITY_IGNORE_FILENAME/);
    assert.match(source, /quality-ignores\.json|PROJECT_QUALITY_IGNORE_FILENAME/);
    assert.match(source, /onDidChangeWorkspaceFolders/);
    assert.match(source, /onDidChangeConfiguration/);
    assert.match(source, /!lower\.endsWith\('\.g\.xlf'\)/);
});

test('visual XLIFF editor shares cached quality analysis and publishes diagnostics without a second analysis', () => {
    const source = fs.readFileSync(path.join(root, 'src', 'xlfEditor.js'), 'utf8');
    const coordinator = fs.readFileSync(path.join(root, 'src', 'qualityCoordinator.js'), 'utf8');
    assert.match(source, /static async runQualityCheckForUri\(uri, text\)/);
    assert.match(source, /analyzeQualityForText\(uri, sourceText/);
    assert.match(source, /publishQualityDiagnosticsForText\(uri, sourceText, analysis\.report, analysis\.parsed/);
    assert.match(source, /if \(analysis\.stale\)/);
    assert.match(coordinator, /getDocumentSession/);
    assert.match(coordinator, /setDocumentSessionQuality/);
    assert.match(coordinator, /const inFlight = new Map\(\)/);
});

test('very large XLIFF quality work can run off the extension host thread', () => {
    const coordinator = fs.readFileSync(path.join(root, 'src', 'qualityCoordinator.js'), 'utf8');
    const workerHost = fs.readFileSync(path.join(root, 'src', 'xlfWorkerHost.js'), 'utf8');
    const worker = fs.readFileSync(path.join(root, 'src', 'xlfWorker.js'), 'utf8');
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.match(coordinator, /getParsedDocumentSessionAsync/);
    assert.match(coordinator, /parseXliffAdaptive/);
    assert.match(coordinator, /analyzeXliffQualityAdaptive/);
    assert.match(workerHost, /new Worker\(options\.workerPath \|\| workerPath/);
    assert.match(worker, /workerData/);
    assert.equal(pkg.contributes.configuration.properties['alXliffStudio.performance.workerThreads.enabled'].default, true);
    assert.equal(pkg.contributes.configuration.properties['alXliffStudio.performance.workerThreads.minFileSizeMB'].default, 3);
    assert.equal(pkg.contributes.configuration.properties['alXliffStudio.performance.workerThreads.minUnits'].default, 5000);
});
