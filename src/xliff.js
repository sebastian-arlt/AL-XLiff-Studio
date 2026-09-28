'use strict';

const { languageKeyMatches } = require('./languageCodes');

function decodeXmlEntities(value) {
    return value
        .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&#([0-9]+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
}

function encodeXmlText(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function decodeXmlAttribute(value) {
    return decodeXmlEntities(value || '');
}

function getAttribute(attrs, name) {
    const re = new RegExp(`\\b${escapeRegExp(name)}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i');
    const match = attrs.match(re);
    return match ? decodeXmlAttribute(match[2]) : undefined;
}

function setAttribute(attrs, name, value) {
    const re = new RegExp(`(\\b${escapeRegExp(name)}\\s*=\\s*)(["'])([\\s\\S]*?)\\2`, 'i');
    if (re.test(attrs)) {
        return attrs.replace(re, `$1"${escapeXmlAttribute(value)}"`);
    }
    const prefix = attrs ? (/[\s]$/.test(attrs) ? attrs : `${attrs} `) : ' ';
    return `${prefix}${name}="${escapeXmlAttribute(value)}"`;
}

function escapeXmlAttribute(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function stripXmlTags(value) {
    return value.replace(/<[^>]+>/g, '');
}

function parseXliff(text) {
    const fileMatch = text.match(/<file\b([^>]*)>/i);
    const fileAttrs = fileMatch ? fileMatch[1] : '';
    const sourceLanguage = getAttribute(fileAttrs, 'source-language') || 'en-US';
    const targetLanguage = getAttribute(fileAttrs, 'target-language');
    const units = [];
    const unitRe = /<trans-unit\b([^>]*)>([\s\S]*?)<\/trans-unit>/gi;
    let match;
    let ordinal = 0;

    while ((match = unitRe.exec(text)) !== null) {
        const unitAttrs = match[1];
        const body = match[2];
        const sourceMatch = body.match(/<source\b([^>]*)>([\s\S]*?)<\/source>/i);
        if (!sourceMatch) {
            continue;
        }
        const targetMatch = body.match(/<target\b([^>]*)>([\s\S]*?)<\/target>/i);
        const selfClosingTargetMatch = targetMatch ? undefined : body.match(/<target\b([^>]*)\/\s*>/i);
        const notes = [];
        const noteDetails = [];
        const noteRe = /<note\b([^>]*)>([\s\S]*?)<\/note>/gi;
        let noteMatch;
        while ((noteMatch = noteRe.exec(body)) !== null) {
            const noteText = decodeXmlEntities(stripXmlTags(noteMatch[2])).trim();
            if (noteText) {
                notes.push(noteText);
                noteDetails.push({
                    text: noteText,
                    from: getAttribute(noteMatch[1], 'from') || '',
                    annotates: getAttribute(noteMatch[1], 'annotates') || '',
                    priority: getAttribute(noteMatch[1], 'priority') || ''
                });
            }
        }
        const sourceRaw = sourceMatch[2];
        const effectiveTargetMatch = targetMatch || selfClosingTargetMatch;
        const targetRaw = targetMatch ? targetMatch[2] : (selfClosingTargetMatch ? '' : undefined);
        const maxWidthAttr = getAttribute(unitAttrs, 'maxwidth');
        const maxWidth = maxWidthAttr ? parseInt(maxWidthAttr, 10) : undefined;
        units.push({
            ordinal: ordinal++,
            id: getAttribute(unitAttrs, 'id') || '',
            source: decodeXmlEntities(stripXmlTags(sourceRaw)),
            sourceRaw,
            target: effectiveTargetMatch ? decodeXmlEntities(stripXmlTags(targetRaw)) : undefined,
            targetRaw,
            targetAttrs: effectiveTargetMatch ? effectiveTargetMatch[1] : '',
            targetState: effectiveTargetMatch ? getAttribute(effectiveTargetMatch[1], 'state') : undefined,
            translate: getAttribute(unitAttrs, 'translate'),
            maxWidth: Number.isFinite(maxWidth) ? maxWidth : undefined,
            notes,
            noteDetails,
            raw: match[0]
        });
    }

    return { sourceLanguage, targetLanguage, units };
}


function parseCommentTranslations(text) {
    const result = new Map();
    const value = String(text || '').trim();
    if (!value) return result;

    // Matches both BCP-47 keys (de-DE, en-US, pt-BR, ...) and classic
    // Business Central/NAV three-letter language identifiers (DEU, ENU, ...).
    // A semicolon only ends the value when it is followed by another language assignment.
    const languageKey = String.raw`(?:[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})+|[A-Za-z]{3})`;
    const re = new RegExp(
        String.raw`(?:^|;\s*)(${languageKey})\s*=\s*([\s\S]*?)(?=;\s*${languageKey}\s*=|$)`,
        'gi'
    );

    let match;
    while ((match = re.exec(value)) !== null) {
        const key = match[1].trim();
        const translation = match[2].trim();
        if (translation) result.set(key, translation);
    }
    return result;
}

function getDeveloperCommentTranslation(unit, targetLanguage) {
    const translations = new Set();
    const details = unit && Array.isArray(unit.noteDetails) ? unit.noteDetails : [];

    for (const note of details) {
        if (String(note.from || '').trim().toLowerCase() !== 'developer') continue;
        const parsed = parseCommentTranslations(note.text);
        for (const [key, translation] of parsed) {
            if (languageKeyMatches(key, targetLanguage)) translations.add(translation);
        }
    }

    if (translations.size === 1) {
        return { translation: [...translations][0], conflict: false };
    }
    if (translations.size > 1) {
        return { translation: undefined, conflict: true, candidates: [...translations] };
    }
    return { translation: undefined, conflict: false };
}

function getDeveloperCommentTranslationForUnits(units, targetLanguage) {
    const translations = new Set();
    let conflict = false;

    for (const unit of units || []) {
        const match = getDeveloperCommentTranslation(unit, targetLanguage);
        if (match.conflict) conflict = true;
        if (match.translation) translations.add(match.translation);
    }

    if (conflict || translations.size > 1) {
        return { translation: undefined, conflict: true, candidates: [...translations] };
    }
    if (translations.size === 1) {
        return { translation: [...translations][0], conflict: false };
    }
    return { translation: undefined, conflict: false };
}

const REVIEW_TARGET_STATES = new Set([
    'needs-adaptation',
    'needs-l10n',
    'needs-review-adaptation',
    'needs-review-l10n',
    'needs-review-translation'
]);

const COMPLETED_TARGET_STATES = new Set(['translated', 'signed-off', 'final']);
const MISSING_TARGET_STATES = new Set(['new', 'needs-translation']);

function isReviewTranslation(unit) {
    if (!unit || !unit.target) return false;
    return REVIEW_TARGET_STATES.has(String(unit.targetState || '').toLowerCase());
}

function isMissingTranslation(unit, treatNeedsTranslationAsMissing = true) {
    if (unit && String(unit.translate || '').trim().toLowerCase() === 'no') {
        return false;
    }
    if (unit.target === undefined || unit.target.length === 0) {
        return true;
    }
    if (!treatNeedsTranslationAsMissing) {
        return false;
    }

    const state = String(unit.targetState || '').toLowerCase();
    if (!state || COMPLETED_TARGET_STATES.has(state) || REVIEW_TARGET_STATES.has(state)) {
        return false;
    }

    // Known untranslated states are eligible for deterministic/AI filling.
    // Unknown non-final states are treated conservatively as missing.
    return MISSING_TARGET_STATES.has(state) || !COMPLETED_TARGET_STATES.has(state);
}

function translatedPairs(parsed, options = {}) {
    const treatNeedsTranslationAsMissing = options.treatNeedsTranslationAsMissing !== false;
    const bySource = new Map();
    const conflicts = [];

    for (const unit of parsed.units) {
        // Translation-memory entries must be confirmed translations. Targets
        // that still need adaptation/review/l10n are intentionally excluded so
        // fuzzy, merge, or source-change candidates cannot pollute the .lng.
        if (!unit.source || !unit.target || String(unit.translate || '').trim().toLowerCase() === 'no' || isMissingTranslation(unit, treatNeedsTranslationAsMissing) || isReviewTranslation(unit)) {
            continue;
        }
        if (bySource.has(unit.source) && bySource.get(unit.source) !== unit.target) {
            conflicts.push({ source: unit.source, existing: bySource.get(unit.source), incoming: unit.target, id: unit.id });
            continue;
        }
        bySource.set(unit.source, unit.target);
    }

    return {
        entries: [...bySource.entries()].map(([source, translation]) => ({ source, translation })),
        conflicts
    };
}

function updateMissingTranslations(text, translationBySource, options = {}) {
    const treatNeedsTranslationAsMissing = options.treatNeedsTranslationAsMissing !== false;
    const setTranslatedState = options.setTranslatedState !== false;
    const translationByOrdinal = options.translationByOrdinal instanceof Map
        ? options.translationByOrdinal
        : new Map();
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    let updatedCount = 0;
    let unitOrdinal = 0;

    const result = text.replace(/<trans-unit\b([^>]*)>([\s\S]*?)<\/trans-unit>/gi, (unitRaw) => {
        const parsed = parseSingleUnit(unitRaw);
        if (!parsed) {
            return unitRaw;
        }
        const ordinal = unitOrdinal++;
        if (!isMissingTranslation(parsed, treatNeedsTranslationAsMissing)) {
            return unitRaw;
        }

        // A translation attached to this exact trans-unit always wins. This is
        // required for Developer comments because the same English source text
        // may intentionally have different translations in different contexts.
        // A value may be a plain string (accepted translation) or an object
        // { text, review, note } for fuzzy matches that still need human review.
        const unitTranslation = translationByOrdinal.get(ordinal);
        const sourceTranslation = translationBySource instanceof Map
            ? translationBySource.get(parsed.source)
            : undefined;
        const entry = unitTranslation !== undefined ? unitTranslation : sourceTranslation;
        const translation = typeof entry === 'string' ? entry : (entry && entry.text);
        const review = Boolean(entry && typeof entry === 'object' && entry.review);
        const note = entry && typeof entry === 'object' ? entry.note : undefined;

        if (typeof translation !== 'string' || translation.length === 0) {
            return unitRaw;
        }
        updatedCount++;
        const updated = setTarget(unitRaw, translation, eol, setTranslatedState && !review);
        const withState = review ? setTargetState(updated, 'needs-review-translation') : updated;
        return note ? appendSyncNote(withState, note, eol) : withState;
    });

    return { text: result, updatedCount };
}

function parseSingleUnit(unitRaw) {
    const wrapper = `<xliff><file source-language="en-US"><body>${unitRaw}</body></file></xliff>`;
    const parsed = parseXliff(wrapper);
    return parsed.units[0];
}

function setTarget(unitRaw, translation, eol, setTranslatedState) {
    const escaped = encodeXmlText(translation);
    const targetRe = /<target\b([^>]*)>([\s\S]*?)<\/target>/i;
    const selfClosingTargetRe = /<target\b([^>]*)\/\s*>/i;
    const targetMatch = unitRaw.match(targetRe);
    const selfClosingTargetMatch = targetMatch ? undefined : unitRaw.match(selfClosingTargetRe);

    if (targetMatch) {
        let attrs = targetMatch[1] || '';
        if (setTranslatedState) {
            attrs = setAttribute(attrs, 'state', 'translated');
        }
        const replacement = `<target${attrs}>${escaped}</target>`;
        return unitRaw.replace(targetRe, replacement);
    }

    if (selfClosingTargetMatch) {
        let attrs = selfClosingTargetMatch[1] || '';
        if (setTranslatedState) {
            attrs = setAttribute(attrs, 'state', 'translated');
        }
        const replacement = `<target${attrs}>${escaped}</target>`;
        return unitRaw.replace(selfClosingTargetRe, replacement);
    }

    const sourceRe = /(<source\b[^>]*>[\s\S]*?<\/source>)/i;
    const sourceMatch = unitRaw.match(sourceRe);
    if (!sourceMatch) {
        return unitRaw;
    }

    const beforeSource = unitRaw.slice(0, sourceMatch.index);
    const indentMatch = beforeSource.match(/(?:^|\r?\n)([ \t]*)$/);
    const indent = indentMatch ? indentMatch[1] : '          ';
    const target = `<target${setTranslatedState ? ' state="translated"' : ''}>${escaped}</target>`;
    return unitRaw.replace(sourceRe, `$1${eol}${indent}${target}`);
}

const SYNC_NOTE_FROM = 'BC.XliffMap';
const SOURCE_CHANGE_NOTE_PREFIX = 'Source changed from ';

// Compares a translation XLIFF against its generator (.g.xlf) by trans-unit id.
// Source changes are detected even when the target is currently empty so that
// a later translation always works with the current English source text.
function detectSourceChanges(targetParsed, sourceParsed) {
    const sourceById = new Map(sourceParsed.units.map(unit => [unit.id, unit]));
    const changed = new Map();
    for (const unit of targetParsed.units) {
        if (!unit.id) continue;
        const sourceUnit = sourceById.get(unit.id);
        if (!sourceUnit) continue;
        if (sourceUnit.source !== unit.source) {
            changed.set(unit.id, {
                oldSource: unit.source,
                newSource: sourceUnit.source,
                newSourceRaw: sourceUnit.sourceRaw
            });
        }
    }
    return changed;
}

// Synchronizes changed <source> content from the generator XLIFF. If a target
// already exists it is retained and marked needs-l10n for human review. The
// source-change note is specific, so unrelated BC.XliffMap notes (fuzzy/merge)
// never suppress source synchronization.
function flagSourceChangedUnits(text, changedIds) {
    if (!changedIds || changedIds.size === 0) {
        return { text, synchronizedCount: 0, flaggedCount: 0 };
    }
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    let flaggedCount = 0;
    let synchronizedCount = 0;

    const result = text.replace(/<trans-unit\b([^>]*)>([\s\S]*?)<\/trans-unit>/gi, (unitRaw, unitAttrs) => {
        const id = getAttribute(unitAttrs, 'id') || '';
        if (!changedIds.has(id)) {
            return unitRaw;
        }

        const change = changedIds instanceof Map ? changedIds.get(id) : undefined;
        let updated = unitRaw;
        synchronizedCount++;
        if (change && typeof change.newSourceRaw === 'string') {
            updated = setSourceRaw(updated, change.newSourceRaw);
        } else if (change && typeof change.newSource === 'string') {
            updated = setSourceRaw(updated, encodeXmlText(change.newSource));
        }

        const parsed = parseSingleUnit(updated);
        if (!parsed) return updated;

        // Empty/new/needs-translation targets should simply be translated later
        // from the synchronized source. Only an existing usable/review target is
        // preserved and converted to needs-l10n for human review.
        if (parsed.target && !isMissingTranslation(parsed, true)) {
            if (hasSpecificSyncNote(updated, SOURCE_CHANGE_NOTE_PREFIX)) {
                return updated;
            }
            flaggedCount++;
            updated = setTargetState(updated, 'needs-l10n');
            const oldSource = change && typeof change.oldSource === 'string' ? change.oldSource : parsed.source;
            const newSource = change && typeof change.newSource === 'string' ? change.newSource : parsed.source;
            updated = appendSyncNote(
                updated,
                `${SOURCE_CHANGE_NOTE_PREFIX}"${oldSource}" to "${newSource}". Review the translation.`,
                eol,
                'source'
            );
        }

        return updated;
    });

    return { text: result, synchronizedCount, flaggedCount };
}

function setSourceRaw(unitRaw, sourceRaw) {
    const sourceRe = /(<source\b[^>]*>)([\s\S]*?)(<\/source>)/i;
    return unitRaw.replace(sourceRe, `$1${sourceRaw}$3`);
}

function removeAttribute(attrs, name) {
    const re = new RegExp(`\\s*\\b${escapeRegExp(name)}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i');
    return String(attrs || '').replace(re, '');
}

function setTargetState(unitRaw, state) {
    const targetRe = /<target\b([^>]*)>([\s\S]*?)<\/target>/i;
    const selfClosingTargetRe = /<target\b([^>]*)\/\s*>/i;
    const targetMatch = unitRaw.match(targetRe);
    const applyState = attrs => state === undefined || state === null || state === ''
        ? removeAttribute(attrs, 'state')
        : setAttribute(attrs, 'state', state);
    if (targetMatch) {
        const attrs = applyState(targetMatch[1] || '');
        return unitRaw.replace(targetRe, `<target${attrs}>${targetMatch[2]}</target>`);
    }
    const selfClosingMatch = unitRaw.match(selfClosingTargetRe);
    if (selfClosingMatch) {
        const attrs = applyState(selfClosingMatch[1] || '');
        return unitRaw.replace(selfClosingTargetRe, `<target${attrs}/>`);
    }
    return unitRaw;
}

/**
 * Updates one trans-unit by its parse ordinal. This is used by the visual XLIFF
 * editor and deliberately works for both missing and already translated units.
 * Editing translation text implies a human-confirmed state unless a state is
 * supplied explicitly. Clearing the text returns the unit to needs-translation.
 */
function updateTranslationUnit(text, ordinal, changes = {}) {
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    let currentOrdinal = 0;
    let updatedCount = 0;
    const hasTranslation = Object.prototype.hasOwnProperty.call(changes, 'translation');
    const hasState = Object.prototype.hasOwnProperty.call(changes, 'state');

    const result = text.replace(/<trans-unit\b([^>]*)>([\s\S]*?)<\/trans-unit>/gi, unitRaw => {
        const parsed = parseSingleUnit(unitRaw);
        if (!parsed) return unitRaw;
        const current = currentOrdinal++;
        if (current !== ordinal) return unitRaw;
        if (String(parsed.translate || '').trim().toLowerCase() === 'no') return unitRaw;

        let updated = unitRaw;
        if (hasTranslation) {
            const translation = String(changes.translation ?? '');
            updated = setTarget(updated, translation, eol, false);
            const state = hasState
                ? changes.state
                : (translation.length ? 'translated' : 'needs-translation');
            updated = setTargetState(updated, state);
        } else if (hasState) {
            if (parsed.target === undefined) {
                updated = setTarget(updated, '', eol, false);
            }
            updated = setTargetState(updated, changes.state);
        }

        const note = typeof changes.note === 'string' ? changes.note.trim() : '';
        if (note && !hasSpecificSyncNote(updated, note)) {
            updated = appendSyncNote(updated, note, eol, changes.noteAnnotates || 'general');
        }

        if (updated !== unitRaw) updatedCount++;
        return updated;
    });

    return { text: result, updatedCount };
}

function hasSpecificSyncNote(unitRaw, notePrefix) {
    const noteRe = /<note\b([^>]*)>([\s\S]*?)<\/note>/gi;
    let match;
    while ((match = noteRe.exec(unitRaw)) !== null) {
        if (String(getAttribute(match[1], 'from') || '').trim().toLowerCase() !== SYNC_NOTE_FROM.toLowerCase()) continue;
        const text = decodeXmlEntities(stripXmlTags(match[2])).trim();
        if (text.startsWith(notePrefix)) return true;
    }
    return false;
}

function appendSyncNote(unitRaw, noteText, eol, annotates = 'general') {
    const targetCloseRe = /(<target\b[^>]*>[\s\S]*?<\/target>|<target\b[^>]*\/\s*>)/i;
    const targetMatch = unitRaw.match(targetCloseRe);
    if (!targetMatch) {
        return unitRaw;
    }
    const beforeTarget = unitRaw.slice(0, targetMatch.index);
    const indentMatch = beforeTarget.match(/(?:^|\r?\n)([ \t]*)$/);
    const indent = indentMatch ? indentMatch[1] : '          ';
    const note = `<note from="${SYNC_NOTE_FROM}" annotates="${escapeXmlAttribute(annotates)}" priority="1">${encodeXmlText(noteText)}</note>`;
    return unitRaw.replace(targetCloseRe, `$1${eol}${indent}${note}`);
}

function extractPlaceholders(text) {
    const matches = String(text).match(/%\d+|#\d+|\\[nrt]|\{\{?[^{}]+\}?\}/g) || [];
    return matches.sort();
}

function placeholdersMatch(source, translation) {
    const a = extractPlaceholders(source);
    const b = extractPlaceholders(translation);
    return a.length === b.length && a.every((value, index) => value === b[index]);
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
    parseXliff,
    isMissingTranslation,
    isReviewTranslation,
    translatedPairs,
    updateMissingTranslations,
    encodeXmlText,
    decodeXmlEntities,
    getAttribute,
    setAttribute,
    extractPlaceholders,
    placeholdersMatch,
    parseCommentTranslations,
    getDeveloperCommentTranslation,
    getDeveloperCommentTranslationForUnits,
    detectSourceChanges,
    flagSourceChangedUnits,
    updateTranslationUnit
};
