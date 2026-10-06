'use strict';

const vscode = require('vscode');
const { getProjectQualityIgnoreUri, ensureStudioStructure, workspaceFileExists } = require('./studioPaths');

const PROJECT_QUALITY_IGNORE_VERSION = 2;

const { normalizeProjectQualityIgnore, projectQualityIgnoreFromIssue, projectQualityIgnoreMatches } = require('./qualityIgnore');

function parseProjectQualityIgnores(text) {
    const raw = String(text || '').trim();
    if (!raw) return { version: PROJECT_QUALITY_IGNORE_VERSION, ignores: [], errors: [] };
    try {
        const parsed = JSON.parse(raw);
        const source = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.ignores) ? parsed.ignores : []);
        const ignores = source.map(normalizeProjectQualityIgnore).filter(Boolean);
        return { version: Number(parsed && parsed.version) || PROJECT_QUALITY_IGNORE_VERSION, ignores: deduplicateIgnores(ignores), errors: [] };
    } catch (err) {
        return { version: PROJECT_QUALITY_IGNORE_VERSION, ignores: [], errors: [`Invalid project Quality Ignore JSON: ${err.message || err}`] };
    }
}

function serializeProjectQualityIgnores(ignores) {
    const normalized = deduplicateIgnores((ignores || []).map(normalizeProjectQualityIgnore).filter(Boolean));
    normalized.sort((a, b) => a.code.localeCompare(b.code));
    return JSON.stringify({ version: PROJECT_QUALITY_IGNORE_VERSION, ignores: normalized }, null, 2) + '\n';
}

async function readProjectQualityIgnores(resourceUri) {
    const uri = await getProjectQualityIgnoreUri(resourceUri);
    if (!uri || !await workspaceFileExists(uri)) return { uri, version: PROJECT_QUALITY_IGNORE_VERSION, ignores: [], errors: [] };
    try {
        const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
        return { uri, ...parseProjectQualityIgnores(text) };
    } catch (err) {
        return { uri, version: PROJECT_QUALITY_IGNORE_VERSION, ignores: [], errors: [`Could not read project Quality Ignore file: ${err.message || err}`] };
    }
}

async function setProjectQualityIssueIgnored(resourceUri, issue, targetLanguage, ignored = true) {
    // Project/global ignore is rule-based: one stored Quality code suppresses that
    // rule for every XLIFF and target language in the AL project. targetLanguage
    // remains in the function signature for API compatibility with existing callers.
    void targetLanguage;
    const desired = projectQualityIgnoreFromIssue(issue);
    if (!desired) return { updated: false, ignores: [] };
    const current = await readProjectQualityIgnores(resourceUri);
    if (current.errors && current.errors.length) throw new Error(current.errors.join('; '));
    let ignores = current.ignores.slice();
    const existingIndex = ignores.findIndex(entry => projectQualityIgnoreMatches(entry, desired));
    let updated = false;
    if (ignored && existingIndex < 0) {
        ignores.push(desired);
        updated = true;
    } else if (!ignored && existingIndex >= 0) {
        ignores.splice(existingIndex, 1);
        updated = true;
    }
    if (!updated) return { updated: false, uri: current.uri, ignores };

    await ensureStudioStructure(resourceUri);
    const uri = current.uri || await getProjectQualityIgnoreUri(resourceUri);
    if (!uri) throw new Error('No AL project could be resolved for the project Quality Ignore file.');
    await vscode.workspace.fs.writeFile(uri, Buffer.from(serializeProjectQualityIgnores(ignores), 'utf8'));
    return { updated: true, uri, ignores };
}

function deduplicateIgnores(ignores) {
    const result = [];
    for (const ignore of ignores || []) {
        if (!result.some(existing => projectQualityIgnoreMatches(existing, ignore))) result.push(ignore);
    }
    return result;
}

module.exports = {
    PROJECT_QUALITY_IGNORE_VERSION,
    normalizeProjectQualityIgnore,
    projectQualityIgnoreFromIssue,
    projectQualityIgnoreMatches,
    parseProjectQualityIgnores,
    serializeProjectQualityIgnores,
    readProjectQualityIgnores,
    setProjectQualityIssueIgnored
};
