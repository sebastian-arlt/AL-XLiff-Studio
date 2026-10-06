'use strict';

const vscode = require('vscode');
const { CONFIG_SECTION, BRAND_NAME } = require('./identity');
const { getAiDebugLogUri, ensureAiDebugDirectory, workspaceFileExists } = require('./studioPaths');

function isAiDebugEnabled(configOrResource) {
    const config = configOrResource && typeof configOrResource.get === 'function'
        ? configOrResource
        : vscode.workspace.getConfiguration(CONFIG_SECTION, configOrResource);
    return config.get('debug.enabled', false) === true;
}


function formatDebugEntry(entry) {
    const model = entry && entry.model || {};
    const header = [
        '='.repeat(88),
        `${entry && entry.timestamp || new Date().toISOString()}  ${entry && entry.status || 'unknown'}`,
        `Model: ${model.name || model.id || 'unknown'}${model.id && model.name ? ` (${model.id})` : ''}`,
        `Vendor/Family: ${[model.vendor, model.family, model.version].filter(Boolean).join(' / ') || '-'}`,
        `Language: ${entry && entry.sourceLanguage || '-'} -> ${entry && entry.targetLanguage || '-'}`,
        `Items: ${entry && entry.itemCount != null ? entry.itemCount : 0}`,
        '',
        '--- AI REQUEST (exact prompt) ---',
        entry && entry.request && entry.request.prompt || '',
        '',
        '--- AI RESPONSE (raw text) ---',
        entry && entry.response && entry.response.rawText || '',
        ''
    ];
    if (entry && entry.parsed) {
        header.push('--- PARSED RESPONSE ---', JSON.stringify(entry.parsed, null, 2), '');
    }
    if (entry && entry.error) {
        header.push('--- ERROR ---', `${entry.error.name || 'Error'}: ${entry.error.message || ''}`);
        if (entry.error.stack) header.push(entry.error.stack);
        header.push('');
    }
    header.push('');
    return header.join('\n');
}

async function appendAiDebugEntry(resourceUri, entry) {
    if (!resourceUri) return undefined;
    const directory = await ensureAiDebugDirectory(resourceUri);
    if (!directory) return undefined;
    const uri = await getAiDebugLogUri(resourceUri);
    if (!uri) return undefined;

    const line = formatDebugEntry(entry);
    let previous = '';
    if (await workspaceFileExists(uri)) {
        try {
            previous = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
        } catch (_) {
            previous = '';
        }
    }
    await vscode.workspace.fs.writeFile(uri, Buffer.from(previous + line, 'utf8'));
    return uri;
}

async function openAiDebugLog(resourceUri) {
    let resource = resourceUri;
    if (!resource || !resource.scheme) {
        const active = vscode.window.activeTextEditor && vscode.window.activeTextEditor.document;
        resource = active && active.uri;
    }
    const uri = await getAiDebugLogUri(resource);
    if (!uri) {
        vscode.window.showInformationMessage(`${BRAND_NAME}: no project is available for the AI debug log.`);
        return;
    }
    await ensureAiDebugDirectory(resource);
    if (!await workspaceFileExists(uri)) {
        await vscode.workspace.fs.writeFile(uri, Buffer.from('', 'utf8'));
    }
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: false });
}

module.exports = {
    isAiDebugEnabled,
    appendAiDebugEntry,
    openAiDebugLog
};
