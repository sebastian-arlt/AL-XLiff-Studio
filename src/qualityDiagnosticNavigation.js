'use strict';

const vscode = require('vscode');
const { CONFIG_SECTION, BRAND_NAME, COMMAND_PREFIX } = require('./identity');

const NAVIGATION_SETTING = 'quality.problemsNavigation.enabled';
const SHOW_TRANSLATION_UNIT_COMMAND = `${COMMAND_PREFIX}.showTranslationUnitFromDiagnostic`;
const mappingsByResource = new Map();
const mappingsByDiagnostic = new WeakMap();

function isQualityDiagnosticNavigationEnabled(resource) {
    return vscode.workspace.getConfiguration(CONFIG_SECTION, resource).get(NAVIGATION_SETTING, true) !== false;
}

function resourceKey(uri) {
    return uri && typeof uri.toString === 'function' ? uri.toString() : String(uri || '');
}

function diagnosticKey(diagnostic) {
    if (!diagnostic) return '';
    const range = diagnostic.range || {};
    const start = range.start || {};
    const end = range.end || {};
    const code = diagnostic.code && typeof diagnostic.code === 'object' ? diagnostic.code.value : diagnostic.code;
    return [
        Number(start.line) || 0,
        Number(start.character) || 0,
        Number(end.line) || 0,
        Number(end.character) || 0,
        String(code == null ? '' : code),
        String(diagnostic.message || '')
    ].join('\u0000');
}

function beginQualityDiagnosticMappings(uri) {
    const key = resourceKey(uri);
    if (!key) return;
    if (!isQualityDiagnosticNavigationEnabled(uri)) {
        mappingsByResource.delete(key);
        return;
    }
    mappingsByResource.set(key, new Map());
}

function registerQualityDiagnosticMapping(uri, diagnostic, issue) {
    if (!uri || !diagnostic || !issue || !isQualityDiagnosticNavigationEnabled(uri)) return;
    if (!Number.isInteger(issue.ordinal)) return;
    const target = Object.freeze({
        ordinal: issue.ordinal,
        unitId: String(issue.id || ''),
        source: String(issue.source || ''),
        code: String(issue.code || ''),
        severity: String(issue.severity || ''),
        message: String(issue.message || '')
    });
    mappingsByDiagnostic.set(diagnostic, target);
    const key = resourceKey(uri);
    let resourceMappings = mappingsByResource.get(key);
    if (!resourceMappings) {
        resourceMappings = new Map();
        mappingsByResource.set(key, resourceMappings);
    }
    resourceMappings.set(diagnosticKey(diagnostic), target);
}

function clearQualityDiagnosticMappings(uri) {
    if (!uri) {
        mappingsByResource.clear();
        return;
    }
    mappingsByResource.delete(resourceKey(uri));
}

function getQualityDiagnosticMapping(uri, diagnostic) {
    if (!isQualityDiagnosticNavigationEnabled(uri) || !diagnostic) return undefined;
    const direct = mappingsByDiagnostic.get(diagnostic);
    if (direct) return direct;
    const resourceMappings = mappingsByResource.get(resourceKey(uri));
    return resourceMappings ? resourceMappings.get(diagnosticKey(diagnostic)) : undefined;
}

function registerQualityDiagnosticNavigation(context, openTarget) {
    if (!context || !Array.isArray(context.subscriptions)) throw new Error('Extension context is required.');
    if (typeof openTarget !== 'function') throw new Error('openTarget callback is required.');

    const command = vscode.commands.registerCommand(SHOW_TRANSLATION_UNIT_COMMAND, async arg => {
        const value = arg && typeof arg === 'object' ? arg : {};
        let uri;
        try {
            uri = value.uri && value.uri.scheme ? value.uri : vscode.Uri.parse(String(value.uri || ''));
        } catch (_) {
            uri = undefined;
        }
        if (!uri || !isQualityDiagnosticNavigationEnabled(uri)) return false;
        const target = value.target && typeof value.target === 'object' ? value.target : undefined;
        if (!target || !Number.isInteger(Number(target.ordinal))) {
            vscode.window.showWarningMessage(`${BRAND_NAME}: the Quality Check navigation target is no longer available.`);
            return false;
        }
        return openTarget(uri, target);
    });

    const provider = vscode.languages.registerCodeActionsProvider(
        { pattern: '**/*.xlf' },
        {
            provideCodeActions(document, _range, codeActionContext) {
                if (!document || !document.uri || !isQualityDiagnosticNavigationEnabled(document.uri)) return [];
                const diagnostics = Array.isArray(codeActionContext && codeActionContext.diagnostics)
                    ? codeActionContext.diagnostics
                    : [];
                const seenTargets = new Set();
                const actions = [];
                for (const diagnostic of diagnostics) {
                    if (!diagnostic || diagnostic.source !== BRAND_NAME) continue;
                    const target = getQualityDiagnosticMapping(document.uri, diagnostic);
                    if (!target) continue;
                    const targetKey = `${target.ordinal}\u0000${target.unitId}\u0000${target.source}`;
                    if (seenTargets.has(targetKey)) continue;
                    seenTargets.add(targetKey);
                    const action = new vscode.CodeAction(`${BRAND_NAME}: Show translation unit`, vscode.CodeActionKind.QuickFix);
                    action.diagnostics = [diagnostic];
                    action.isPreferred = true;
                    action.command = {
                        command: SHOW_TRANSLATION_UNIT_COMMAND,
                        title: `${BRAND_NAME}: Show translation unit`,
                        arguments: [{ uri: document.uri, target }]
                    };
                    actions.push(action);
                }
                return actions;
            }
        },
        { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
    );

    const configurationListener = vscode.workspace.onDidChangeConfiguration(event => {
        if (!event.affectsConfiguration(`${CONFIG_SECTION}.${NAVIGATION_SETTING}`)) return;
        // Resource-scoped settings can differ between AL projects in a multi-root
        // workspace. Drop every old mapping and let the next Quality publication
        // repopulate only those resources for which navigation is enabled.
        clearQualityDiagnosticMappings();
    });

    context.subscriptions.push(command, provider, configurationListener);
    return { command, provider, configurationListener };
}

module.exports = {
    NAVIGATION_SETTING,
    SHOW_TRANSLATION_UNIT_COMMAND,
    beginQualityDiagnosticMappings,
    registerQualityDiagnosticMapping,
    clearQualityDiagnosticMappings,
    getQualityDiagnosticMapping,
    isQualityDiagnosticNavigationEnabled,
    registerQualityDiagnosticNavigation,
    diagnosticKey
};
