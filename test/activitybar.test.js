'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const extensionSource = fs.readFileSync(path.join(root, 'extension.js'), 'utf8');
const activitySource = fs.readFileSync(path.join(root, 'src', 'activityBar.js'), 'utf8');

test('contributes an AL Xliff Studio Activity Bar container with bundled SVG icon', () => {
    const containers = pkg.contributes.viewsContainers.activitybar;
    const container = containers.find(item => item.id === 'alXliffStudio');
    assert.ok(container);
    assert.equal(container.title, 'AL Xliff Studio');
    assert.equal(container.icon, 'resources/xliff-dashboard.svg');
    assert.ok(fs.existsSync(path.join(root, container.icon)));
});

test('contributes a project overview Activity Bar tree', () => {
    const views = pkg.contributes.views.alXliffStudio;
    const view = views.find(item => item.id === 'alXliffStudio.dashboardLauncher');
    assert.ok(view);
    assert.equal(view.name, 'Project Overview');
    assert.ok(pkg.activationEvents.includes('onView:alXliffStudio.dashboardLauncher'));
    assert.match(extensionSource, /registerActivityBar\(context/);
    assert.doesNotMatch(extensionSource, /registerDashboardActivityBar/);
});

test('Activity Bar has Languages, Tools, and Project sections with direct actions', () => {
    assert.match(activitySource, /'Languages'/);
    assert.match(activitySource, /'Tools'/);
    assert.match(activitySource, /'Project'/);
    assert.match(activitySource, /Translation Dashboard/);
    assert.match(activitySource, /Glossary/);
    assert.match(activitySource, /AI Usage/);
    assert.match(activitySource, /Sync all XLIFFs/);
    assert.match(activitySource, /Quality Check/);
    assert.match(activitySource, /Translation Memory/);
});

test('Activity Bar displays missing supportedLocales and can generate their XLIFFs', () => {
    assert.match(activitySource, /findMissingSupportedLocaleRows/);
    assert.match(activitySource, /Not created/);
    assert.match(activitySource, /activity\.generateLocale/);
    assert.match(activitySource, /createTranslationXliffFromGenerator/);
});

test('Activity Bar language status includes missing, review, and quality counts', () => {
    assert.match(activitySource, /metrics\.missing/);
    assert.match(activitySource, /metrics\.review/);
    assert.match(activitySource, /metrics\.qualityIssues/);
    assert.match(activitySource, /treeView\.badge/);
});

test('opening the Activity Bar container also opens the Translation Dashboard', () => {
    assert.match(activitySource, /onDidChangeVisibility/);
    assert.match(activitySource, /if \(!event\.visible\) return/);
    assert.match(activitySource, /executeCommand\(`\$\{COMMAND_PREFIX\}\.openDashboard`\)/);
});
