'use strict';

const {
    getDeveloperCommentTranslation,
    getDeveloperCommentTranslationForUnits
} = require('./xliff');
const { findBestFuzzyMatch } = require('./fuzzy');
const { findExactGlossaryTranslation } = require('./glossary');

/**
 * Resolves an already-known translation without invoking AI.
 * Priority is deliberately fixed:
 * 1. explicit Developer comment on this exact trans-unit
 * 2. an unambiguous Developer comment on another missing trans-unit with the same source
 * 3. companion .lng translation memory (exact source match)
 * 4. project terminology glossary (exact source-term match)
 * 5. companion .lng translation memory (fuzzy/similarity match, opt-in, flagged for review)
 * 6. unresolved (caller may invoke AI)
 *
 * The exact-unit check is important: identical English captions may occur in
 * multiple Business Central objects with context-specific Developer comments.
 * `options.excludeTranslation` is used by per-row retry/retranslation so an
 * unchanged existing target does not stop the resolver chain.
 */
function resolveKnownTranslationForUnit(unit, sameSourceUnits, language, companionMap, fuzzyOptions, glossaryEntries, options = {}) {
    const excludedTranslation = typeof options.excludeTranslation === 'string' ? options.excludeTranslation : undefined;
    const isUsable = translation => Boolean(translation) && (excludedTranslation === undefined || translation !== excludedTranslation);
    const unitComment = getDeveloperCommentTranslation(unit, language);
    if (isUsable(unitComment.translation)) {
        return {
            translation: unitComment.translation,
            source: 'comment',
            commentScope: 'unit',
            commentConflict: false
        };
    }

    // If this unit has no usable direct translation, a unique comment from
    // another unit with the same source can still be reused. Conflicting
    // comments are never guessed.
    const groupComment = getDeveloperCommentTranslationForUnits(sameSourceUnits || [unit], language);
    if (!unitComment.conflict && isUsable(groupComment.translation)) {
        return {
            translation: groupComment.translation,
            source: 'comment',
            commentScope: 'same-source',
            commentConflict: false
        };
    }

    const sourceText = unit ? unit.source : '';
    const mapTranslation = sourceText ? companionMap.get(sourceText) : undefined;
    if (isUsable(mapTranslation)) {
        return {
            translation: mapTranslation,
            source: 'map',
            commentConflict: Boolean(unitComment.conflict || groupComment.conflict)
        };
    }

    const glossaryMatch = findExactGlossaryTranslation(sourceText, language, glossaryEntries || []);
    if (isUsable(glossaryMatch.translation)) {
        return {
            translation: glossaryMatch.translation,
            source: 'glossary',
            glossaryEntry: glossaryMatch.entry,
            glossaryConflict: false,
            commentConflict: Boolean(unitComment.conflict || groupComment.conflict)
        };
    }

    if (fuzzyOptions && fuzzyOptions.enabled && sourceText && companionMap.size) {
        const candidates = Array.from(companionMap, ([source, translation]) => ({ source, translation }));
        const fuzzyMatch = findBestFuzzyMatch(sourceText, candidates, fuzzyOptions.minimumQuality);
        if (fuzzyMatch && isUsable(fuzzyMatch.translation)) {
            return {
                translation: fuzzyMatch.translation,
                source: 'fuzzy',
                quality: fuzzyMatch.quality,
                matchedSource: fuzzyMatch.source,
                review: true,
                commentConflict: Boolean(unitComment.conflict || groupComment.conflict)
            };
        }
    }

    return {
        translation: undefined,
        source: undefined,
        commentConflict: Boolean(unitComment.conflict || groupComment.conflict)
    };
}

// Kept for compatibility with existing tests/callers. When called for a group,
// comments are intentionally treated as a shared translation only if they are
// unambiguous across the complete group.
function resolveKnownTranslation(units, language, companionMap, glossaryEntries) {
    const commentMatch = getDeveloperCommentTranslationForUnits(units, language);
    if (commentMatch.translation) {
        return {
            translation: commentMatch.translation,
            source: 'comment',
            commentConflict: false
        };
    }

    const sourceText = units && units.length ? units[0].source : '';
    const mapTranslation = sourceText ? companionMap.get(sourceText) : undefined;
    if (mapTranslation) {
        return {
            translation: mapTranslation,
            source: 'map',
            commentConflict: Boolean(commentMatch.conflict)
        };
    }

    const glossaryMatch = findExactGlossaryTranslation(sourceText, language, glossaryEntries || []);
    if (glossaryMatch.translation) {
        return {
            translation: glossaryMatch.translation,
            source: 'glossary',
            glossaryEntry: glossaryMatch.entry,
            glossaryConflict: false,
            commentConflict: Boolean(commentMatch.conflict)
        };
    }

    return {
        translation: undefined,
        source: undefined,
        commentConflict: Boolean(commentMatch.conflict)
    };
}

module.exports = { resolveKnownTranslation, resolveKnownTranslationForUnit };
