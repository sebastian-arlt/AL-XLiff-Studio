'use strict';

const { isStudioNoteFrom } = require('./identity');

const QUALITY_IGNORE_PREFIX = 'QualityIgnore:';

function normalizeQualityIgnoreCodes(value) {
    const source = Array.isArray(value) ? value : (typeof value === 'string' ? value.split(',') : []);
    return [...new Set(source.map(item => String(item || '').trim()).filter(Boolean))];
}

function serializeQualityIgnoreNote(issue) {
    if (!issue || !issue.code) return '';
    return `${QUALITY_IGNORE_PREFIX} ${JSON.stringify({
        code: String(issue.code),
        source: String(issue.source || ''),
        target: String(issue.target || '')
    })}`;
}

function parseQualityIgnoreText(text) {
    const value = String(text || '').trim();
    if (!value.startsWith(QUALITY_IGNORE_PREFIX)) return undefined;
    const payload = value.slice(QUALITY_IGNORE_PREFIX.length).trim();
    if (!payload) return undefined;
    try {
        const parsed = JSON.parse(payload);
        if (!parsed || !parsed.code) return undefined;
        return {
            code: String(parsed.code),
            source: String(parsed.source || ''),
            target: String(parsed.target || '')
        };
    } catch (_) {
        // Backward/simple form: QualityIgnore: punctuation
        return { code: payload, source: '', target: '' };
    }
}

function qualityIgnoreFromNoteDetail(note) {
    if (!note || !isStudioNoteFrom(note.from)) return undefined;
    return parseQualityIgnoreText(note.text);
}

function qualityIgnoresFromNotes(noteDetails) {
    return (Array.isArray(noteDetails) ? noteDetails : [])
        .map(qualityIgnoreFromNoteDetail)
        .filter(Boolean);
}

function qualityIgnoreMatches(ignore, issue) {
    if (!ignore || !issue || String(ignore.code) !== String(issue.code)) return false;
    if (ignore.source && String(ignore.source) !== String(issue.source || '')) return false;
    if (ignore.target && String(ignore.target) !== String(issue.target || '')) return false;
    return true;
}


function normalizeProjectQualityIgnore(value) {
    if (!value || !value.code) return undefined;
    return { code: String(value.code || '').trim() };
}

function projectQualityIgnoreFromIssue(issue) {
    return normalizeProjectQualityIgnore({ code: issue && issue.code });
}

function projectQualityIgnoreMatches(ignore, issue) {
    const expected = normalizeProjectQualityIgnore(ignore);
    if (!expected || !issue) return false;
    return expected.code === String(issue.code || '').trim();
}

module.exports = {
    QUALITY_IGNORE_PREFIX,
    normalizeQualityIgnoreCodes,
    serializeQualityIgnoreNote,
    parseQualityIgnoreText,
    qualityIgnoreFromNoteDetail,
    qualityIgnoresFromNotes,
    qualityIgnoreMatches,
    normalizeProjectQualityIgnore,
    projectQualityIgnoreFromIssue,
    projectQualityIgnoreMatches
};
