'use strict';
const { getUnitIndex } = require('./unitIndex');

const { extractPlaceholders, isMissingTranslation, isReviewTranslation } = require('./xliff');
const { similarity } = require('./fuzzy');
const { glossaryHintsForSource } = require('./glossary');

const DEFAULT_CONTEXT_OPTIONS = Object.freeze({
    enabled: true,
    nearbyUnits: 4,
    translationMemoryExamples: 3,
    minimumMemorySimilarity: 35,
    sameSourceContexts: 3,
    maxCharactersPerItem: 6000
});

function getAiContextOptions(config) {
    const get = (key, fallback) => config && typeof config.get === 'function' ? config.get(key, fallback) : fallback;
    return {
        enabled: get('ai.context.enabled', DEFAULT_CONTEXT_OPTIONS.enabled) !== false,
        nearbyUnits: clampInteger(get('ai.context.nearbyUnits', DEFAULT_CONTEXT_OPTIONS.nearbyUnits), 0, 10),
        translationMemoryExamples: clampInteger(get('ai.context.translationMemoryExamples', DEFAULT_CONTEXT_OPTIONS.translationMemoryExamples), 0, 10),
        minimumMemorySimilarity: clampInteger(get('ai.context.minimumMemorySimilarity', DEFAULT_CONTEXT_OPTIONS.minimumMemorySimilarity), 0, 100),
        sameSourceContexts: clampInteger(get('ai.context.sameSourceContexts', DEFAULT_CONTEXT_OPTIONS.sameSourceContexts), 0, 10),
        maxCharactersPerItem: clampInteger(get('ai.context.maxCharactersPerItem', DEFAULT_CONTEXT_OPTIONS.maxCharactersPerItem), 1000, 20000)
    };
}

function createAiTranslationItem(unit, parsed, companionMap, glossaryEntries, options = {}) {
    const effective = { ...DEFAULT_CONTEXT_OPTIONS, ...options };
    const key = createUnitAiKey(unit);
    const terminology = glossaryHintsForSource(unit.source, parsed && parsed.targetLanguage, glossaryEntries || []);
    if (effective.enabled === false) {
        return { key, ordinal: unit.ordinal, source: unit.source, context: {}, terminology };
    }

    const generator = getGeneratorContext(unit);
    const developerNotes = getNotes(unit, 'developer');
    const otherNotes = (unit.noteDetails || [])
        .filter(note => {
            const from = String(note.from || '').trim().toLowerCase();
            return from && from !== 'developer' && from !== 'xliff generator' && !from.includes('xliffstudio');
        })
        .map(note => ({ from: note.from || '', text: truncate(note.text || '', 600) }))
        .slice(0, 4);

    const context = {
        generator,
        developerNotes: developerNotes.map(value => truncate(value, 800)).slice(0, 4),
        otherNotes,
        placeholders: extractPlaceholders(unit.source),
        maxWidth: Number.isFinite(unit.maxWidth) ? unit.maxWidth : undefined,
        currentTranslation: unit.target ? {
            text: truncate(unit.target, 1000),
            state: unit.targetState || ''
        } : undefined,
        sameSourceContexts: buildSameSourceContexts(unit, parsed, effective.sameSourceContexts),
        nearbyUnits: buildNearbyUnits(unit, parsed, effective.nearbyUnits, generator),
        translationMemoryExamples: buildTranslationMemoryExamples(
            unit.source,
            companionMap,
            effective.translationMemoryExamples,
            effective.minimumMemorySimilarity
        )
    };

    return {
        key,
        ordinal: unit.ordinal,
        source: unit.source,
        context: limitContext(context, effective.maxCharactersPerItem),
        terminology
    };
}

function createUnitAiKey(unit) {
    const id = String(unit && unit.id || '').trim();
    const ordinal = Number.isInteger(unit && unit.ordinal) ? unit.ordinal : 0;
    return `${id || 'unit'}#${ordinal}`;
}

function getGeneratorContext(unit) {
    const detail = (unit && unit.noteDetails || []).find(note =>
        String(note.from || '').trim().toLowerCase() === 'xliff generator'
    );
    if (!detail || !detail.text) return undefined;
    return parseGeneratorNote(detail.text);
}

function parseGeneratorNote(text) {
    const raw = String(text || '').trim();
    if (!raw) return undefined;
    const path = raw.split(/\s+-\s+/).map(value => value.trim()).filter(Boolean);
    const first = path[0] || '';
    const firstMatch = first.match(/^([A-Za-z][A-Za-z ]*?)\s+(.+)$/);
    const propertySegment = path.find(segment => /^Property\s+/i.test(segment));
    const elementSegments = path.slice(1).filter(segment => !/^Property\s+/i.test(segment));
    return compactObject({
        raw: truncate(raw, 1200),
        objectType: firstMatch ? firstMatch[1].trim() : undefined,
        objectName: firstMatch ? firstMatch[2].trim() : undefined,
        path: path.slice(0, 8),
        element: elementSegments.length ? elementSegments.join(' - ') : undefined,
        property: propertySegment ? propertySegment.replace(/^Property\s+/i, '').trim() : undefined
    });
}

function getNotes(unit, fromName) {
    const normalized = String(fromName || '').trim().toLowerCase();
    return (unit && unit.noteDetails || [])
        .filter(note => String(note.from || '').trim().toLowerCase() === normalized)
        .map(note => String(note.text || '').trim())
        .filter(Boolean);
}

function buildSameSourceContexts(unit, parsed, limit) {
    if (!parsed || !Array.isArray(parsed.units) || limit <= 0 || !unit.source) return [];
    return (getUnitIndex(parsed).bySource.get(String(unit.source)) || [])
        .filter(other => other.ordinal !== unit.ordinal)
        .sort((a, b) => Math.abs(a.ordinal - unit.ordinal) - Math.abs(b.ordinal - unit.ordinal))
        .slice(0, limit)
        .map(other => compactObject({
            generator: getGeneratorContext(other),
            confirmedTranslation: isConfirmedTranslation(other) ? truncate(other.target, 800) : undefined,
            state: other.targetState || undefined
        }));
}

function buildNearbyUnits(unit, parsed, limit, currentGenerator) {
    if (!parsed || !Array.isArray(parsed.units) || limit <= 0) return [];
    const currentObject = generatorObjectKey(currentGenerator);
    let candidates = parsed.units.filter(other => other.ordinal !== unit.ordinal);
    if (currentObject) {
        const sameObject = candidates.filter(other => generatorObjectKey(getGeneratorContext(other)) === currentObject);
        if (sameObject.length) candidates = sameObject;
    }

    return candidates
        .sort((a, b) => Math.abs(a.ordinal - unit.ordinal) - Math.abs(b.ordinal - unit.ordinal))
        .slice(0, limit)
        .map(other => compactObject({
            source: truncate(other.source, 500),
            confirmedTranslation: isConfirmedTranslation(other) ? truncate(other.target, 800) : undefined,
            generator: getGeneratorContext(other),
            state: other.targetState || undefined
        }));
}

function buildTranslationMemoryExamples(sourceText, companionMap, limit, minimumSimilarity) {
    if (!(companionMap instanceof Map) || !sourceText || limit <= 0) return [];
    const results = [];
    for (const [source, translation] of companionMap) {
        if (!source || !translation || source === sourceText) continue;
        const quality = similarity(sourceText, source);
        if (quality < minimumSimilarity) continue;
        results.push({ source, translation, similarity: quality });
    }
    return results
        .sort((a, b) => b.similarity - a.similarity || a.source.localeCompare(b.source))
        .slice(0, limit)
        .map(item => ({
            source: truncate(item.source, 500),
            translation: truncate(item.translation, 800),
            similarity: item.similarity
        }));
}

function isConfirmedTranslation(unit) {
    return Boolean(unit && unit.target && !isMissingTranslation(unit, true) && !isReviewTranslation(unit));
}

function generatorObjectKey(generator) {
    if (!generator) return '';
    return [generator.objectType || '', generator.objectName || ''].join('\u0000').toLocaleLowerCase();
}

function limitContext(context, maxCharacters) {
    const compact = compactObject(context);
    if (JSON.stringify(compact).length <= maxCharacters) return compact;

    const reduced = { ...compact };
    // Remove the least authoritative/broadest context first. Explicit notes,
    // generator path, placeholders and maxWidth are kept as long as possible.
    if (Array.isArray(reduced.nearbyUnits)) reduced.nearbyUnits = reduced.nearbyUnits.slice(0, 2);
    if (Array.isArray(reduced.translationMemoryExamples)) reduced.translationMemoryExamples = reduced.translationMemoryExamples.slice(0, 2);
    if (Array.isArray(reduced.sameSourceContexts)) reduced.sameSourceContexts = reduced.sameSourceContexts.slice(0, 1);
    if (JSON.stringify(reduced).length <= maxCharacters) return compactObject(reduced);

    delete reduced.otherNotes;
    if (JSON.stringify(reduced).length <= maxCharacters) return compactObject(reduced);

    delete reduced.nearbyUnits;
    if (JSON.stringify(reduced).length <= maxCharacters) return compactObject(reduced);

    delete reduced.translationMemoryExamples;
    if (JSON.stringify(reduced).length <= maxCharacters) return compactObject(reduced);

    if (Array.isArray(reduced.developerNotes)) {
        reduced.developerNotes = reduced.developerNotes.map(value => truncate(value, 300)).slice(0, 2);
    }
    return compactObject(reduced);
}

function compactObject(value) {
    if (Array.isArray(value)) {
        return value.map(compactObject).filter(item => item !== undefined && !(Array.isArray(item) && !item.length));
    }
    if (!value || typeof value !== 'object') return value;
    const result = {};
    for (const [key, item] of Object.entries(value)) {
        const compacted = compactObject(item);
        if (compacted === undefined || compacted === null || compacted === '') continue;
        if (Array.isArray(compacted) && !compacted.length) continue;
        result[key] = compacted;
    }
    return result;
}

function truncate(value, length) {
    const text = String(value || '');
    if (text.length <= length) return text;
    return `${text.slice(0, Math.max(0, length - 1))}…`;
}

function clampInteger(value, min, max) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return min;
    return Math.min(max, Math.max(min, parsed));
}

module.exports = {
    DEFAULT_CONTEXT_OPTIONS,
    getAiContextOptions,
    createAiTranslationItem,
    createUnitAiKey,
    getGeneratorContext,
    parseGeneratorNote,
    buildTranslationMemoryExamples,
    buildNearbyUnits,
    buildSameSourceContexts,
    isConfirmedTranslation,
    limitContext
};
