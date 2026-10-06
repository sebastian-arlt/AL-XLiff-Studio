'use strict';

const { normalizeBcp47 } = require('./languageCodes');
const { normalizeQualityIgnoreCodes } = require('./qualityIgnore');

const GLOSSARY_VERSION = 1;
const DEFAULT_GLOSSARY_FILENAME = 'glossary.json';
const LEGACY_GLOSSARY_FILENAME = '.al-xliff-glossary.json';
const MATCH_MODES = new Set(['word', 'contains', 'exact']);
const NORMALIZED_ENTRIES_CACHE = new WeakMap();
const LANGUAGE_ENTRIES_CACHE = new WeakMap();
const WORD_PATTERN_CACHE = new WeakMap();

function parseGlossary(text) {
    const errors = [];
    let raw;
    try {
        raw = JSON.parse(String(text || '').trim() || '{}');
    } catch (err) {
        return { version: GLOSSARY_VERSION, entries: [], errors: [`Invalid JSON: ${err.message}`] };
    }

    const sourceEntries = Array.isArray(raw.entries) ? raw.entries : [];
    if (!Array.isArray(raw.entries) && raw.entries !== undefined) errors.push('"entries" must be an array.');
    const entries = [];
    const seen = new Set();

    sourceEntries.forEach((item, index) => {
        if (!item || typeof item !== 'object') {
            errors.push(`Entry ${index + 1}: must be an object.`);
            return;
        }
        const source = String(item.source || '').trim();
        const targetLanguage = normalizeBcp47(item.targetLanguage || '');
        const translation = String(item.translation || '').trim();
        const match = MATCH_MODES.has(String(item.match || '').toLowerCase()) ? String(item.match).toLowerCase() : 'word';
        const caseSensitive = Boolean(item.caseSensitive);
        const note = String(item.note || '').trim();
        const qualityIgnore = normalizeQualityIgnoreCodes(item.qualityIgnore || (item.quality && item.quality.ignore));
        if (!source) errors.push(`Entry ${index + 1}: source must not be empty.`);
        if (!targetLanguage) errors.push(`Entry ${index + 1}: targetLanguage must not be empty.`);
        if (!translation) errors.push(`Entry ${index + 1}: translation must not be empty.`);
        if (!source || !targetLanguage || !translation) return;
        const key = glossaryKey(source, targetLanguage, caseSensitive);
        if (seen.has(key)) {
            errors.push(`Entry ${index + 1}: duplicate term for ${targetLanguage}: ${source}`);
            return;
        }
        seen.add(key);
        entries.push({ source, targetLanguage, translation, match, caseSensitive, note, qualityIgnore });
    });

    return { version: Number(raw.version) || GLOSSARY_VERSION, entries, errors };
}

function serializeGlossary(entries) {
    const normalized = normalizeEntries(entries).map(entry => {
        const result = {
            source: entry.source,
            targetLanguage: entry.targetLanguage,
            translation: entry.translation,
            match: entry.match,
            caseSensitive: entry.caseSensitive,
            note: entry.note
        };
        if (entry.qualityIgnore.length) result.quality = { ignore: entry.qualityIgnore };
        return result;
    });
    return JSON.stringify({ version: GLOSSARY_VERSION, entries: normalized }, null, 2) + '\n';
}

function normalizeEntries(entries) {
    return (Array.isArray(entries) ? entries : [])
        .map(item => ({
            source: String(item.source || '').trim(),
            targetLanguage: normalizeBcp47(item.targetLanguage || ''),
            translation: String(item.translation || '').trim(),
            match: MATCH_MODES.has(String(item.match || '').toLowerCase()) ? String(item.match).toLowerCase() : 'word',
            caseSensitive: Boolean(item.caseSensitive),
            note: String(item.note || '').trim(),
            qualityIgnore: normalizeQualityIgnoreCodes(item.qualityIgnore || (item.quality && item.quality.ignore))
        }))
        .filter(item => item.source && item.targetLanguage && item.translation);
}

function glossaryKey(source, targetLanguage, caseSensitive) {
    const keySource = caseSensitive ? String(source) : String(source).toLocaleLowerCase();
    return `${normalizeBcp47(targetLanguage).toLocaleLowerCase()}\u0000${caseSensitive ? '1' : '0'}\u0000${keySource}`;
}

function normalizedEntriesCached(entries) {
    if (!Array.isArray(entries)) return [];
    const cached = NORMALIZED_ENTRIES_CACHE.get(entries);
    if (cached) return cached;
    const normalized = normalizeEntries(entries);
    NORMALIZED_ENTRIES_CACHE.set(entries, normalized);
    return normalized;
}

function entriesForLanguage(entries, targetLanguage) {
    if (!Array.isArray(entries) || !entries.length) return [];
    const normalizedLanguage = normalizeBcp47(targetLanguage).toLocaleLowerCase();
    let byLanguage = LANGUAGE_ENTRIES_CACHE.get(entries);
    if (!byLanguage) {
        byLanguage = new Map();
        LANGUAGE_ENTRIES_CACHE.set(entries, byLanguage);
    }
    if (byLanguage.has(normalizedLanguage)) return byLanguage.get(normalizedLanguage);
    const languageEntries = normalizedEntriesCached(entries).filter(entry => entry.targetLanguage.toLocaleLowerCase() === normalizedLanguage);
    byLanguage.set(normalizedLanguage, languageEntries);
    return languageEntries;
}

function findExactGlossaryTranslation(sourceText, targetLanguage, entries) {
    const matches = entriesForLanguage(entries, targetLanguage).filter(entry => textEquals(sourceText, entry.source, entry.caseSensitive));
    const translations = [...new Set(matches.map(entry => entry.translation))];
    if (translations.length === 1) return { translation: translations[0], entry: matches[0], conflict: false };
    if (translations.length > 1) return { translation: undefined, entry: undefined, conflict: true };
    return { translation: undefined, entry: undefined, conflict: false };
}

function findRelevantGlossaryTerms(sourceText, targetLanguage, entries) {
    const source = String(sourceText || '');
    if (!source) return [];
    const sourceLower = source.toLocaleLowerCase();
    return entriesForLanguage(entries, targetLanguage).filter(entry => sourceMatchesPrepared(source, sourceLower, entry));
}

function findTerminologyViolationsForTerms(translation, relevantEntries) {
    const text = String(translation || '');
    if (!text) return [];
    return (Array.isArray(relevantEntries) ? relevantEntries : [])
        .filter(entry => !containsText(text, entry.translation, false))
        .map(entry => ({
            source: entry.source,
            expected: entry.translation,
            note: entry.note,
            message: `Terminology: “${entry.source}” should use “${entry.translation}”.`
        }));
}

function findTerminologyViolations(sourceText, translation, targetLanguage, entries) {
    return findTerminologyViolationsForTerms(translation, findRelevantGlossaryTerms(sourceText, targetLanguage, entries));
}

function glossaryHintsForSource(sourceText, targetLanguage, entries) {
    return findRelevantGlossaryTerms(sourceText, targetLanguage, entries).map(entry => ({
        source: entry.source,
        translation: entry.translation,
        note: entry.note || undefined
    }));
}

function sourceMatchesEntry(sourceText, entry) {
    const source = String(sourceText || '');
    if (!source) return false;
    return sourceMatchesPrepared(source, source.toLocaleLowerCase(), entry);
}

function sourceMatchesPrepared(source, sourceLower, entry) {
    const term = String(entry && entry.source || '');
    if (!term) return false;
    if (entry.match === 'exact') return entry.caseSensitive ? source === term : sourceLower === term.toLocaleLowerCase();
    if (entry.match === 'contains') return entry.caseSensitive ? source.includes(term) : sourceLower.includes(term.toLocaleLowerCase());
    let pattern = WORD_PATTERN_CACHE.get(entry);
    if (!pattern) {
        const flags = entry.caseSensitive ? 'u' : 'iu';
        pattern = new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escapeRegExp(term)}(?=$|[^\\p{L}\\p{N}_])`, flags);
        WORD_PATTERN_CACHE.set(entry, pattern);
    }
    return pattern.test(source);
}

function textEquals(a, b, caseSensitive) {
    const left = String(a || '');
    const right = String(b || '');
    return caseSensitive ? left === right : left.toLocaleLowerCase() === right.toLocaleLowerCase();
}

function containsText(text, term, caseSensitive) {
    const haystack = String(text || '');
    const needle = String(term || '');
    if (!needle) return false;
    return caseSensitive ? haystack.includes(needle) : haystack.toLocaleLowerCase().includes(needle.toLocaleLowerCase());
}

function containsWholeTerm(text, term, caseSensitive) {
    const flags = caseSensitive ? 'u' : 'iu';
    const pattern = `(?:^|[^\\p{L}\\p{N}_])${escapeRegExp(term)}(?=$|[^\\p{L}\\p{N}_])`;
    return new RegExp(pattern, flags).test(String(text || ''));
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
    GLOSSARY_VERSION,
    DEFAULT_GLOSSARY_FILENAME,
    LEGACY_GLOSSARY_FILENAME,
    parseGlossary,
    serializeGlossary,
    normalizeEntries,
    entriesForLanguage,
    findExactGlossaryTranslation,
    findRelevantGlossaryTerms,
    findTerminologyViolations,
    findTerminologyViolationsForTerms,
    glossaryHintsForSource,
    sourceMatchesEntry
};
