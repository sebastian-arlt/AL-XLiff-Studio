'use strict';

const vscode = require('vscode');
const { BRAND_NAME, CONFIG_SECTION, CONFIG_AI_SECTION } = require('./identity');
const { placeholdersMatch } = require('./xliff');

async function selectModelFromConfiguration() {
    const config = vscode.workspace.getConfiguration(CONFIG_AI_SECTION);
    const modelId = (config.get('modelId') || '').trim();
    const vendor = (config.get('vendor') || '').trim();
    const family = (config.get('family') || '').trim();

    const selector = {};
    if (modelId) selector.id = modelId;
    if (vendor) selector.vendor = vendor;
    if (family) selector.family = family;

    let models = await vscode.lm.selectChatModels(selector);
    if (models.length === 0 && (modelId || family)) {
        const fallback = {};
        if (vendor) fallback.vendor = vendor;
        models = await vscode.lm.selectChatModels(fallback);
    }
    return models[0];
}

async function chooseAiModelCommand() {
    let models = await vscode.lm.selectChatModels({});
    if (!models.length) {
        vscode.window.showWarningMessage('No VS Code language model is currently available.');
        return;
    }

    const items = models.map(model => ({
        label: model.name || model.id,
        description: [model.vendor, model.family, model.version].filter(Boolean).join(' · '),
        detail: model.id,
        model
    }));
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Select the AI model for XLIFF translations' });
    if (!pick) return;

    const config = vscode.workspace.getConfiguration(CONFIG_AI_SECTION);
    await config.update('modelId', pick.model.id, vscode.ConfigurationTarget.Workspace);
    if (pick.model.vendor) {
        await config.update('vendor', pick.model.vendor, vscode.ConfigurationTarget.Workspace);
    }
    vscode.window.showInformationMessage(`${BRAND_NAME}: translation model set to ${pick.model.name || pick.model.id}.`);
}

async function translateItems(items, sourceLanguage, targetLanguage, token, onProgress) {
    if (!items.length) return new Map();

    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    if (config.get('ai.enabled', true) === false) {
        return new Map();
    }

    const model = await selectModelFromConfiguration();
    if (!model) {
        throw new Error('No VS Code language model is available. Configure one or disable AI fallback.');
    }

    const batchSize = Math.max(1, Math.min(50, config.get('ai.batchSize', 20)));
    const result = new Map();

    let completed = 0;
    for (let i = 0; i < items.length; i += batchSize) {
        if (token && token.isCancellationRequested) break;
        const batch = items.slice(i, i + batchSize);
        const translated = await translateBatch(model, batch, sourceLanguage, targetLanguage, token);
        for (const item of batch) {
            const translation = translated.get(item.key);
            if (translation && placeholdersMatch(item.source, translation)) {
                result.set(item.source, translation);
            }
        }
        completed += batch.length;
        if (typeof onProgress === 'function') {
            onProgress(completed, items.length);
        }
    }

    return result;
}

async function translateBatch(model, items, sourceLanguage, targetLanguage, token) {
    const payload = items.map((item, index) => ({
        id: `t${index}`,
        source: item.source,
        context: item.context || ''
    }));

    const prompt = [
        `Translate Microsoft Dynamics 365 Business Central UI text from ${sourceLanguage || 'en-US'} to ${targetLanguage}.`,
        'Return ONLY a valid JSON array. Do not use Markdown or explanations.',
        'Each result must have exactly: {"id":"t0","translation":"..."}.',
        'Preserve placeholders such as %1, %2, #1, escaped sequences, punctuation, leading/trailing whitespace, product names, and technical identifiers when appropriate.',
        'Use concise terminology suitable for Business Central UI, captions, tooltips, labels, and error messages.',
        'Translate each source exactly once and keep its id unchanged.',
        `INPUT=${JSON.stringify(payload)}`
    ].join('\n');

    const messages = [vscode.LanguageModelChatMessage.User(prompt)];
    const cancellationToken = token || new vscode.CancellationTokenSource().token;
    const response = await model.sendRequest(messages, {}, cancellationToken);
    let output = '';
    for await (const fragment of response.text) {
        output += fragment;
    }

    const parsed = parseJsonArray(output);
    const byKey = new Map();
    for (const row of parsed) {
        if (!row || typeof row.id !== 'string' || typeof row.translation !== 'string') continue;
        const index = Number(row.id.slice(1));
        if (!Number.isInteger(index) || index < 0 || index >= items.length) continue;
        byKey.set(items[index].key, row.translation);
    }
    return byKey;
}

function parseJsonArray(output) {
    let text = String(output).trim();
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start < 0 || end < start) {
        throw new Error('AI response did not contain a JSON array.');
    }
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(parsed)) {
        throw new Error('AI response was not a JSON array.');
    }
    return parsed;
}

module.exports = {
    translateItems,
    chooseAiModelCommand,
    parseJsonArray,
    selectModelFromConfiguration
};
