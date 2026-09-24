'use strict';

const {
    getDeveloperCommentTranslation,
    getDeveloperCommentTranslationForUnits
} = require('./xliff');

/**
 * Resolves an already-known translation without invoking AI.
 * Priority is deliberately fixed:
 * 1. explicit Developer comment on this exact trans-unit
 * 2. an unambiguous Developer comment on another missing trans-unit with the same source
 * 3. companion .lng translation memory
 * 4. unresolved (caller may invoke AI)
 *
 * The exact-unit check is important: identical English captions may occur in
 * multiple Business Central objects with context-specific Developer comments.
 */
function resolveKnownTranslationForUnit(unit, sameSourceUnits, language, companionMap) {
    const unitComment = getDeveloperCommentTranslation(unit, language);
    if (unitComment.translation) {
        return {
            translation: unitComment.translation,
            source: 'comment',
            commentConflict: false
        };
    }

    // If this unit has no usable direct translation, a unique comment from
    // another unit with the same source can still be reused. Conflicting
    // comments are never guessed.
    const groupComment = getDeveloperCommentTranslationForUnits(sameSourceUnits || [unit], language);
    if (!unitComment.conflict && groupComment.translation) {
        return {
            translation: groupComment.translation,
            source: 'comment',
            commentConflict: false
        };
    }

    const sourceText = unit ? unit.source : '';
    const mapTranslation = sourceText ? companionMap.get(sourceText) : undefined;
    if (mapTranslation) {
        return {
            translation: mapTranslation,
            source: 'map',
            commentConflict: Boolean(unitComment.conflict || groupComment.conflict)
        };
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
function resolveKnownTranslation(units, language, companionMap) {
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

    return {
        translation: undefined,
        source: undefined,
        commentConflict: Boolean(commentMatch.conflict)
    };
}

module.exports = { resolveKnownTranslation, resolveKnownTranslationForUnit };
