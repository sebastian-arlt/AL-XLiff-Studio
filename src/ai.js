'use strict';

const vscode = require('vscode');
const { BRAND_NAME, CONFIG_SECTION, CONFIG_AI_SECTION } = require('./identity');
const { placeholdersMatch } = require('./xliff');
const { recordAiUsage } = require('./aiUsage');
const { persistAiUsageEntry, isAiUsageTrackingEnabled } = require('./aiUsageStore');
const { appendAiDebugEntry, isAiDebugEnabled } = require('./aiDebug');

const INCOMPATIBLE_TRANSLATION_MODEL_VENDORS = new Set([
    // Copilot CLI registers language models in VS Code, but its response path can
    // complete without exposing assistant text through LanguageModelChatResponse.text.
    // AL Xliff Studio requires a text response, so those models must not be offered.
    'copilotcli'
]);

function isCompatibleTranslationModel(model) {
    if (!model || typeof model !== 'object') return false;
    if (!model.id || typeof model.sendRequest !== 'function') return false;
    const vendor = String(model.vendor || '').trim().toLowerCase();
    if (INCOMPATIBLE_TRANSLATION_MODEL_VENDORS.has(vendor)) return false;
    return true;
}

function compatibleTranslationModels(models) {
    const filtered = (Array.isArray(models) ? models : []).filter(isCompatibleTranslationModel);

    // Multiple extensions/providers can expose the same logical model. Prefer the
    // standard VS Code Copilot provider and keep only one entry per id/family pair.
    filtered.sort((a, b) => {
        const aCopilot = String(a.vendor || '').toLowerCase() === 'copilot' ? 0 : 1;
        const bCopilot = String(b.vendor || '').toLowerCase() === 'copilot' ? 0 : 1;
        if (aCopilot !== bCopilot) return aCopilot - bCopilot;
        return String(a.name || a.id).localeCompare(String(b.name || b.id));
    });

    const seen = new Set();
    return filtered.filter(model => {
        const key = `${String(model.id || '').toLowerCase()}|${String(model.family || '').toLowerCase()}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function preferredConfiguredModel(models, vendor) {
    const compatible = compatibleTranslationModels(models);
    if (!compatible.length) return undefined;
    const preferredVendor = String(vendor || '').trim().toLowerCase();
    if (preferredVendor && !INCOMPATIBLE_TRANSLATION_MODEL_VENDORS.has(preferredVendor)) {
        const exactVendor = compatible.find(model => String(model.vendor || '').trim().toLowerCase() === preferredVendor);
        if (exactVendor) return exactVendor;
    }
    return compatible[0];
}

async function selectModelFromConfiguration() {
    const config = vscode.workspace.getConfiguration(CONFIG_AI_SECTION);
    const modelId = (config.get('modelId') || '').trim();
    const vendor = (config.get('vendor') || '').trim();
    const family = (config.get('family') || '').trim();

    // Never pin an incompatible provider into the selector. If an older workspace
    // setting contains e.g. copilotcli, resolve the same model id/family through a
    // compatible provider instead.
    const selector = {};
    if (modelId) selector.id = modelId;
    if (family) selector.family = family;
    if (vendor && !INCOMPATIBLE_TRANSLATION_MODEL_VENDORS.has(vendor.toLowerCase())) selector.vendor = vendor;

    let models = await vscode.lm.selectChatModels(selector);
    let selected = preferredConfiguredModel(models, vendor);
    if (selected) return selected;

    if (modelId || family || vendor) {
        // Retry without the vendor so a compatible provider exposing the same model
        // can be used. If that still fails, fall back to any compatible LM model.
        const fallbackSelector = {};
        if (modelId) fallbackSelector.id = modelId;
        if (family) fallbackSelector.family = family;
        models = await vscode.lm.selectChatModels(fallbackSelector);
        selected = preferredConfiguredModel(models, undefined);
        if (selected) return selected;
    }

    models = await vscode.lm.selectChatModels({});
    return compatibleTranslationModels(models)[0];
}

async function chooseAiModelCommand() {
    const allModels = await vscode.lm.selectChatModels({});
    const models = compatibleTranslationModels(allModels);
    if (!models.length) {
        vscode.window.showWarningMessage('No compatible VS Code language model is currently available for XLIFF translation.');
        return;
    }

    const items = models.map(model => ({
        label: model.name || model.id,
        description: [model.vendor, model.family, model.version].filter(Boolean).join(' · '),
        detail: model.id,
        model
    }));
    const pick = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a compatible AI model for XLIFF translations',
        matchOnDescription: true,
        matchOnDetail: true
    });
    if (!pick) return;

    const config = vscode.workspace.getConfiguration(CONFIG_AI_SECTION);
    await config.update('modelId', pick.model.id, vscode.ConfigurationTarget.Workspace);
    await config.update('vendor', pick.model.vendor || '', vscode.ConfigurationTarget.Workspace);
    await config.update('family', pick.model.family || '', vscode.ConfigurationTarget.Workspace);
    vscode.window.showInformationMessage(`${BRAND_NAME}: translation model set to ${pick.model.name || pick.model.id}.`);
}

async function translateItemsByKeyDetailed(items, sourceLanguage, targetLanguage, token, onProgress, resourceUri) {
    if (!items.length) return { translations: new Map(), model: undefined };

    const config = vscode.workspace.getConfiguration(CONFIG_SECTION, resourceUri);
    if (config.get('ai.enabled', true) === false) {
        return { translations: new Map(), model: undefined };
    }

    const model = await selectModelFromConfiguration();
    if (!model) {
        throw new Error('No compatible VS Code language model is available for XLIFF translation. Select a compatible model or disable AI fallback.');
    }

    const batchSize = Math.max(1, Math.min(50, config.get('ai.batchSize', 20)));
    const trackTokenUsage = isAiUsageTrackingEnabled(config);
    const debugEnabled = isAiDebugEnabled(config);
    const result = new Map();

    // Group before batching so duplicates spanning batch boundaries are sent once.
    // Exact text equality preserves whitespace, casing and parameter distinctions.
    const bySource = new Map();
    for (const item of items) {
        const source = String(item.source == null ? '' : item.source);
        let group = bySource.get(source);
        if (!group) {
            group = { representative: item, items: [] };
            bySource.set(source, group);
        }
        group.items.push(item);
    }
    const groups = Array.from(bySource.values());

    let completed = 0;
    for (let i = 0; i < groups.length; i += batchSize) {
        if (token && token.isCancellationRequested) break;
        const batchGroups = groups.slice(i, i + batchSize);
        const batch = batchGroups.map(group => group.representative);
        const translated = await translateBatch(model, batch, sourceLanguage, targetLanguage, token, trackTokenUsage, resourceUri, debugEnabled);
        for (const group of batchGroups) {
            const translation = translated.get(group.representative.key);
            for (const item of group.items) {
                if (translation && placeholdersMatch(item.source, translation)) {
                    result.set(item.key, translation);
                }
            }
            completed += group.items.length;
        }
        if (typeof onProgress === 'function') {
            onProgress(completed, items.length);
        }
    }

    return { translations: result, model: modelMetadata(model) };
}

async function translateItemsByKey(items, sourceLanguage, targetLanguage, token, onProgress, resourceUri) {
    const detailed = await translateItemsByKeyDetailed(items, sourceLanguage, targetLanguage, token, onProgress, resourceUri);
    return detailed.translations;
}

function modelMetadata(model) {
    if (!model) return undefined;
    const result = {};
    for (const key of ['id', 'name', 'vendor', 'family', 'version']) {
        if (model[key]) result[key] = String(model[key]);
    }
    return Object.keys(result).length ? result : undefined;
}

// Compatibility helper for older callers/tests that expect a map keyed by source.
// Keyed callers retain one result per unit, with a shared translation for the
// same source text within each invocation and target language.
async function translateItems(items, sourceLanguage, targetLanguage, token, onProgress) {
    const byKey = await translateItemsByKey(items, sourceLanguage, targetLanguage, token, onProgress);
    const result = new Map();
    for (const item of items) {
        const translation = byKey.get(item.key);
        if (translation) result.set(item.source, translation);
    }
    return result;
}

async function translateBatch(model, items, sourceLanguage, targetLanguage, token, trackTokenUsage = true, resourceUri, debugEnabled = false) {
    const payload = items.map((item, index) => ({
        id: `t${index}`,
        source: item.source,
        context: item.context && typeof item.context === 'object' ? item.context : (item.context || {}),
        terminology: Array.isArray(item.terminology) ? item.terminology : []
    }));

    const prompt = [
        `Translate Microsoft Dynamics 365 Business Central UI text from ${sourceLanguage || 'en-US'} to ${targetLanguage}.`,
        'Return ONLY a valid JSON array. Do not use Markdown, an object wrapper, prose, or explanations.',
        'The first character of your response must be [ and the last character must be ].',
        'Each result must have exactly: {"id":"t0","translation":"..."}.',
        'Preserve placeholders such as %1, %2, #1, escaped sequences, punctuation, leading/trailing whitespace, product names, and technical identifiers when appropriate.',
        'Use concise terminology suitable for Business Central UI, captions, tooltips, labels, and error messages.',
        'Use context.generator to understand the exact AL object, element, and property behind short or ambiguous UI text.',
        'Use context.developerNotes as authoritative semantic guidance. Placeholder descriptions in those notes are context, not text to translate.',
        'Use context.currentTranslation only as a reference when it exists; improve or adapt it when the source/context requires it.',
        'Use context.nearbyUnits and context.sameSourceContexts to disambiguate meaning and keep wording consistent inside the same Business Central object.',
        'Use context.translationMemoryExamples as confirmed style/terminology examples, but do not copy an example when its meaning does not fit.',
        'When context.maxWidth is present, prefer a concise translation that fits that character limit without changing meaning or placeholders.',
        'When INPUT contains terminology entries, use those required source-to-target terms consistently whenever they apply to the source text.',
        'Each input has a unique source text. Its translation will be reused for every occurrence of that same source text. Use consistent wording and keep its id unchanged.',
        `INPUT=${JSON.stringify(payload)}`
    ].join('\n');

    const messages = [vscode.LanguageModelChatMessage.User(prompt)];
    const cancellationToken = token || new vscode.CancellationTokenSource().token;
    const inputTokens = trackTokenUsage ? await countTokensSafe(model, prompt) : undefined;
    let output = '';
    try {
        const response = await model.sendRequest(messages, {}, cancellationToken);
        for await (const fragment of response.text) {
            output += fragment;
        }
    } catch (error) {
        await writeAiDebugEntry(debugEnabled, resourceUri, {
            status: 'request-error',
            model: modelMetadata(model),
            sourceLanguage,
            targetLanguage,
            items,
            prompt,
            response: output,
            error
        });
        throw error;
    }
    if (trackTokenUsage) {
        const outputTokens = await countTokensSafe(model, output);
        const usageEntry = {
            model: modelMetadata(model),
            inputTokens,
            outputTokens,
            itemCount: items.length,
            sourceLanguage,
            targetLanguage,
            resourceUri
        };
        recordAiUsage(usageEntry);
        if (resourceUri) {
            try { await persistAiUsageEntry(resourceUri, usageEntry); } catch (_) { /* usage persistence must never block translation */ }
        }
    }

    let parsed;
    try {
        parsed = parseJsonArray(output, items.length);
        await writeAiDebugEntry(debugEnabled, resourceUri, {
            status: 'parsed',
            model: modelMetadata(model),
            sourceLanguage,
            targetLanguage,
            items,
            prompt,
            response: output,
            parsed
        });
    } catch (error) {
        const debugLogUri = await writeAiDebugEntry(debugEnabled, resourceUri, {
            status: items.length > 1 ? 'parse-error-retrying' : 'parse-error',
            model: modelMetadata(model),
            sourceLanguage,
            targetLanguage,
            items,
            prompt,
            response: output,
            error
        });
        // Compact/fast models occasionally ignore a batched structured-output request.
        // If that happens, retry smaller batches. A single-item request can then safely
        // accept a bare translation line without losing the unit mapping.
        if (items.length > 1) {
            const midpoint = Math.ceil(items.length / 2);
            const left = await translateBatch(model, items.slice(0, midpoint), sourceLanguage, targetLanguage, token, trackTokenUsage, resourceUri, debugEnabled);
            const right = await translateBatch(model, items.slice(midpoint), sourceLanguage, targetLanguage, token, trackTokenUsage, resourceUri, debugEnabled);
            return new Map([...left, ...right]);
        }
        if (debugLogUri) {
            const wrapped = new Error(`${error && error.message ? error.message : String(error)} AI debug log: .alxliffstudio/debug/ai-debug.log (command: AL Xliff Studio: Open AI Debug Log).`);
            wrapped.cause = error;
            throw wrapped;
        }
        throw error;
    }

    const parsedIds = parsed
        .map(row => row && typeof row.id === 'string' ? row.id.toLowerCase() : '')
        .filter(id => /^t\d+$/.test(id));
    const numericIds = parsedIds.map(id => Number(id.slice(1)));
    const oneBased = items.length > 0
        && parsedIds.length > 0
        && !parsedIds.includes('t0')
        && numericIds.every(value => Number.isInteger(value) && value >= 1 && value <= items.length);

    const byKey = new Map();
    for (const row of parsed) {
        if (!row || typeof row.id !== 'string' || typeof row.translation !== 'string') continue;
        let index;
        if (/^t\d+$/i.test(row.id)) {
            index = Number(row.id.slice(1));
            if (oneBased) index -= 1;
        } else {
            index = items.findIndex(item => item.key === row.id);
        }
        if (!Number.isInteger(index) || index < 0 || index >= items.length) continue;
        byKey.set(items[index].key, row.translation);
    }

    // A valid-looking but incomplete batch is common with compact models. Retry only
    // the missing units in smaller requests instead of silently leaving them untranslated.
    const missing = items.filter(item => !byKey.has(item.key) || !String(byKey.get(item.key) || '').trim());
    if (missing.length && items.length > 1) {
        let recovered;
        if (missing.length === items.length) {
            // The model returned rows, but none of their ids could be mapped. Avoid
            // retrying the identical batch forever; split it just like a parse failure.
            const midpoint = Math.ceil(items.length / 2);
            const left = await translateBatch(model, items.slice(0, midpoint), sourceLanguage, targetLanguage, token, trackTokenUsage, resourceUri, debugEnabled);
            const right = await translateBatch(model, items.slice(midpoint), sourceLanguage, targetLanguage, token, trackTokenUsage, resourceUri, debugEnabled);
            recovered = new Map([...left, ...right]);
        } else {
            recovered = await translateBatch(model, missing, sourceLanguage, targetLanguage, token, trackTokenUsage, resourceUri, debugEnabled);
        }
        for (const [key, translation] of recovered) byKey.set(key, translation);
    }
    return byKey;
}



async function writeAiDebugEntry(enabled, resourceUri, data) {
    if (!enabled || !resourceUri) return undefined;
    const error = data && data.error;
    const items = Array.isArray(data && data.items) ? data.items : [];
    const entry = {
        timestamp: new Date().toISOString(),
        status: data && data.status || 'unknown',
        model: data && data.model,
        sourceLanguage: data && data.sourceLanguage,
        targetLanguage: data && data.targetLanguage,
        itemCount: items.length,
        items: items.map(item => ({
            key: item && item.key,
            source: item && item.source,
            context: item && item.context,
            terminology: item && item.terminology
        })),
        request: {
            prompt: String(data && data.prompt || '')
        },
        response: {
            rawText: String(data && data.response || '')
        }
    };
    if (Array.isArray(data && data.parsed)) entry.parsed = data.parsed;
    if (error) {
        entry.error = {
            name: error.name || 'Error',
            message: error.message || String(error),
            stack: error.stack
        };
    }
    try {
        return await appendAiDebugEntry(resourceUri, entry);
    } catch (_) {
        return undefined;
    }
}

async function countTokensSafe(model, text) {
    if (!model || typeof model.countTokens !== 'function') return undefined;
    try {
        const count = await model.countTokens(String(text || ''));
        const numeric = Number(count);
        return Number.isFinite(numeric) && numeric >= 0 ? Math.round(numeric) : undefined;
    } catch (_) {
        return undefined;
    }
}

function translationTextFromValue(value) {
    if (typeof value === 'string') return value;
    if (!value || typeof value !== 'object') return undefined;
    for (const key of ['translation', 'target', 'translatedText', 'translated_text', 'text', 'value', 'result']) {
        if (typeof value[key] === 'string') return value[key];
    }
    return undefined;
}

function normalizeTranslationRow(row, index) {
    if (typeof row === 'string') return { id: `t${index}`, translation: row };
    if (!row || typeof row !== 'object') return undefined;

    const translation = translationTextFromValue(row);
    if (typeof translation !== 'string') return undefined;

    let id = row.id ?? row.key ?? row.index;
    if (typeof id === 'number' && Number.isInteger(id)) id = `t${id}`;
    if (typeof id === 'string' && /^\d+$/.test(id)) id = `t${id}`;
    if (typeof id !== 'string' || !id.trim()) id = `t${index}`;
    return { id: String(id).trim(), translation };
}

function normalizeTranslationRows(value, expectedCount) {
    if (Array.isArray(value)) {
        const rows = value
            .map((row, index) => normalizeTranslationRow(row, index))
            .filter(Boolean);
        return rows.length ? rows : undefined;
    }

    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return undefined;
        try {
            return normalizeTranslationRows(JSON.parse(trimmed), expectedCount);
        } catch (_) {
            return undefined;
        }
    }

    if (!value || typeof value !== 'object') return undefined;

    const direct = normalizeTranslationRow(value, 0);
    if (direct && (typeof value.id === 'string' || typeof value.key === 'string' || expectedCount === 1)) return [direct];

    for (const key of ['translations', 'results', 'items', 'data', 'output', 'response', 'content', 'message']) {
        if (Object.prototype.hasOwnProperty.call(value, key)) {
            const nested = value[key];
            if (typeof nested === 'string') {
                try {
                    const normalized = normalizeTranslationRows(JSON.parse(nested), expectedCount);
                    if (normalized) return normalized;
                } catch (_) {
                    if (expectedCount === 1 && nested.trim()) return [{ id: 't0', translation: nested.trim() }];
                }
            }
            const normalized = normalizeTranslationRows(nested, expectedCount);
            if (normalized) return normalized;
        }
    }

    // Some models return an OpenAI-like envelope even though VS Code normally
    // exposes text directly. Accept it defensively.
    if (Array.isArray(value.choices)) {
        for (const choice of value.choices) {
            const nested = choice && choice.message ? choice.message.content : choice && choice.text;
            const normalized = normalizeTranslationRows(nested, expectedCount);
            if (normalized) return normalized;
        }
    }

    const keyed = [];
    for (const [rawKey, rawTranslation] of Object.entries(value)) {
        let id;
        if (/^t\d+$/i.test(rawKey)) id = rawKey.toLowerCase();
        else if (/^\d+$/.test(rawKey)) id = `t${rawKey}`;
        else continue;
        const translation = translationTextFromValue(rawTranslation);
        if (typeof translation === 'string') keyed.push({ id, translation });
    }
    keyed.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
    return keyed.length ? keyed : undefined;
}

function tryParseTranslationJson(text, expectedCount) {
    const candidates = [String(text || '').trim()];
    const withoutTrailingCommas = candidates[0].replace(/,\s*([}\]])/g, '$1');
    if (withoutTrailingCommas !== candidates[0]) candidates.push(withoutTrailingCommas);

    for (const candidate of candidates) {
        try {
            const normalized = normalizeTranslationRows(JSON.parse(candidate), expectedCount);
            if (normalized) return normalized;
        } catch (_) {
            // Keep trying more tolerant shapes below.
        }
    }
    return undefined;
}

function extractBalancedJson(text, openChar, closeChar) {
    for (let start = 0; start < text.length; start++) {
        if (text[start] !== openChar) continue;
        let depth = 0;
        let quoted = false;
        let escaped = false;
        for (let i = start; i < text.length; i++) {
            const ch = text[i];
            if (quoted) {
                if (escaped) escaped = false;
                else if (ch === '\\') escaped = true;
                else if (ch === '"') quoted = false;
                continue;
            }
            if (ch === '"') { quoted = true; continue; }
            if (ch === openChar) depth++;
            else if (ch === closeChar) {
                depth--;
                if (depth === 0) return text.slice(start, i + 1);
            }
        }
    }
    return undefined;
}

function stripSimpleTranslationDecorations(value) {
    let text = String(value || '').trim();
    text = text.replace(/^[-*•]\s+/, '');
    text = text.replace(/^\d+[.)]\s+/, '');
    text = text.replace(/^translation\s*[:=-]\s*/i, '');
    if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
        text = text.slice(1, -1);
    }
    return text.trim();
}

function parseSequentialLines(text, expectedCount) {
    if (!Number.isInteger(expectedCount) || expectedCount < 1) return undefined;
    const lines = String(text || '')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .filter(line => !/^```/.test(line));

    const numbered = lines
        .map(line => {
            const match = line.match(/^(?:[-*•]\s+|\d+[.)]\s+)(.+)$/);
            return match ? stripSimpleTranslationDecorations(match[1]) : undefined;
        })
        .filter(value => value !== undefined && value !== '');
    if (numbered.length === expectedCount) {
        return numbered.map((translation, index) => ({ id: `t${index}`, translation }));
    }

    if (expectedCount === 1 && lines.length === 1) {
        const single = stripSimpleTranslationDecorations(lines[0]);
        if (single && !/^[\[{]/.test(single)) return [{ id: 't0', translation: single }];
    }
    return undefined;
}

function parseMarkdownTable(text, expectedCount) {
    const rows = [];
    for (const line of String(text || '').split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) continue;
        const cells = trimmed.slice(1, -1).split('|').map(cell => cell.trim());
        if (cells.every(cell => /^:?-{2,}:?$/.test(cell))) continue;
        const idIndex = cells.findIndex(cell => /^t\d+$/i.test(cell));
        if (idIndex < 0) continue;
        const translation = cells.slice(idIndex + 1).find(cell => cell && !/^(translation|target|text)$/i.test(cell));
        if (translation) rows.push({ id: cells[idIndex].toLowerCase(), translation: stripSimpleTranslationDecorations(translation) });
    }
    if (rows.length) return rows;

    // Header + positional translations without explicit ids.
    if (Number.isInteger(expectedCount) && expectedCount > 0) {
        const data = String(text || '').split(/\r?\n/)
            .map(line => line.trim())
            .filter(line => line.startsWith('|') && line.endsWith('|'))
            .map(line => line.slice(1, -1).split('|').map(cell => cell.trim()))
            .filter(cells => !cells.every(cell => /^:?-{2,}:?$/.test(cell)));
        if (data.length >= 2) {
            const header = data[0].map(cell => cell.toLowerCase());
            const targetIndex = header.findIndex(cell => ['translation', 'target', 'translated text', 'translated_text'].includes(cell));
            if (targetIndex >= 0) {
                const values = data.slice(1).map(cells => stripSimpleTranslationDecorations(cells[targetIndex] || '')).filter(Boolean);
                if (values.length === expectedCount) return values.map((translation, index) => ({ id: `t${index}`, translation }));
            }
        }
    }
    return undefined;
}

function parseLooseStructuredRows(text) {
    const rows = [];
    const objectPattern = /\{([\s\S]*?)\}/g;
    let objectMatch;
    while ((objectMatch = objectPattern.exec(String(text || ''))) !== null) {
        const body = objectMatch[1];
        const idMatch = body.match(/(?:["']?id["']?|["']?key["']?)\s*[:=]\s*["']?(t\d+)["']?/i);
        if (!idMatch) continue;
        let translation;
        for (const field of ['translation', 'target', 'translatedText', 'translated_text', 'text', 'value', 'result']) {
            const quoted = body.match(new RegExp(`(?:["']?${field}["']?)\\s*[:=]\\s*(["'])([\\s\\S]*?)\\1\\s*(?:,|$)`, 'i'));
            if (quoted) { translation = quoted[2].replace(/\\([\\"'])/g, '$1'); break; }
            const bare = body.match(new RegExp(`(?:["']?${field}["']?)\\s*[:=]\\s*([^,]+?)(?:,|$)`, 'i'));
            if (bare) { translation = stripSimpleTranslationDecorations(bare[1]); break; }
        }
        if (typeof translation === 'string' && translation) rows.push({ id: idMatch[1].toLowerCase(), translation });
    }
    if (rows.length) return rows;

    // YAML-like compact output, e.g. "- id: t0" followed by "translation: Kunde".
    let currentId;
    for (const rawLine of String(text || '').split(/\r?\n/)) {
        const line = rawLine.trim().replace(/^[-*•]\s*/, '');
        const idMatch = line.match(/^(?:id|key)\s*:\s*["']?(t\d+)["']?\s*$/i);
        if (idMatch) { currentId = idMatch[1].toLowerCase(); continue; }
        if (!currentId) continue;
        const translationMatch = line.match(/^(?:translation|target|translatedText|translated_text|text|value|result)\s*:\s*(.+)$/i);
        if (translationMatch) {
            rows.push({ id: currentId, translation: stripSimpleTranslationDecorations(translationMatch[1]) });
            currentId = undefined;
        }
    }
    return rows.length ? rows : undefined;
}

function parseJsonArray(output, expectedCount) {
    let text = String(output || '').replace(/^\uFEFF/, '').trim();
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

    let parsed = tryParseTranslationJson(text, expectedCount);
    if (parsed) return parsed;

    const arrayText = extractBalancedJson(text, '[', ']');
    if (arrayText) {
        parsed = tryParseTranslationJson(arrayText, expectedCount);
        if (parsed) return parsed;
    }

    const jsonLines = [];
    for (const line of text.split(/\r?\n/)) {
        const candidate = line.trim().replace(/^[-*•]\s*/, '').replace(/,$/, '');
        if (!candidate.startsWith('{') || !candidate.endsWith('}')) continue;
        const rows = tryParseTranslationJson(candidate, expectedCount);
        if (rows) jsonLines.push(...rows);
    }
    if (jsonLines.length > 1) return jsonLines;

    const objectText = extractBalancedJson(text, '{', '}');
    if (objectText) {
        parsed = tryParseTranslationJson(objectText, expectedCount);
        if (parsed) return parsed;
    }
    if (jsonLines.length) return jsonLines;

    parsed = parseLooseStructuredRows(text);
    if (parsed) return parsed;

    const keyedRows = [];
    for (const line of text.split(/\r?\n/)) {
        const candidate = line.trim().replace(/^[-*•]\s*/, '');
        const match = candidate.match(/^(?:["']?)(t\d+)(?:["']?)\s*[:=\-]\s*(.*?)\s*,?$/i);
        if (match && match[2]) keyedRows.push({ id: match[1].toLowerCase(), translation: stripSimpleTranslationDecorations(match[2]) });
        const xmlMatch = candidate.match(/^<t(\d+)>([\s\S]*?)<\/t\1>$/i);
        if (xmlMatch && xmlMatch[2]) keyedRows.push({ id: `t${xmlMatch[1]}`, translation: xmlMatch[2].trim() });
    }
    if (keyedRows.length) return keyedRows;

    parsed = parseMarkdownTable(text, expectedCount);
    if (parsed) return parsed;

    parsed = parseSequentialLines(text, expectedCount);
    if (parsed) return parsed;

    throw new Error('AI response could not be parsed as translation JSON. The selected model returned an unsupported response format.');
}

module.exports = {
    translateItems,
    translateItemsByKey,
    translateItemsByKeyDetailed,
    chooseAiModelCommand,
    parseJsonArray,
    selectModelFromConfiguration,
    modelMetadata,
    isCompatibleTranslationModel,
    compatibleTranslationModels
};
