'use strict';

const { NOTE_FROM, isStudioNoteFrom } = require('./identity');
const { serializeProvenanceNote, sanitizeProvenance } = require('./provenance');
const { serializeQualityIgnoreNote, parseQualityIgnoreText } = require('./qualityIgnore');

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

const NAB_TARGET_MARKERS = new Map([
    ['REVIEW', { state: 'needs-review-translation', kind: 'review' }],
    ['SUGGESTION', { state: 'needs-review-translation', kind: 'suggestion' }],
    ['NOT TRANSLATED', { state: 'new', kind: 'not-translated' }]
]);

function parseNabTargetMarker(value) {
    const text = String(value == null ? '' : value);
    const match = text.match(/^\s*\[NAB:\s*(REVIEW|SUGGESTION|NOT TRANSLATED)\]/i);
    if (!match) return undefined;
    const key = match[1].toUpperCase();
    const metadata = NAB_TARGET_MARKERS.get(key);
    if (!metadata) return undefined;
    return {
        marker: `[NAB: ${key}]`,
        kind: metadata.kind,
        state: metadata.state,
        text: text.slice(match[0].length)
    };
}

function isNabNoteFrom(value) {
    return String(value || '').trim().toLowerCase() === 'nab al tools';
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
        const noteRe = /<note\b([^>]*?)(?:\/\s*>|>([\s\S]*?)<\/note>)/gi;
        let noteMatch;
        while ((noteMatch = noteRe.exec(body)) !== null) {
            const rawNoteText = decodeXmlEntities(stripXmlTags(noteMatch[2] || ''));
            const noteText = rawNoteText.trim();
            if (noteText) {
                notes.push(noteText);
                noteDetails.push({
                    text: noteText,
                    ...(String(getAttribute(noteMatch[1], 'from') || '').toLowerCase() === 'developer' && rawNoteText !== noteText ? { rawText: rawNoteText } : {}),
                    from: getAttribute(noteMatch[1], 'from') || '',
                    annotates: getAttribute(noteMatch[1], 'annotates') || '',
                    priority: getAttribute(noteMatch[1], 'priority') || ''
                });
            }
        }
        const sourceRaw = sourceMatch[2];
        const unitStartOffset = match.index;
        const unitEndOffset = match.index + match[0].length;
        const bodyStartOffset = unitStartOffset + match[0].indexOf('>') + 1;
        const sourceTagStartOffset = bodyStartOffset + sourceMatch.index;
        const sourceStartOffset = sourceTagStartOffset + sourceMatch[0].indexOf('>') + 1;
        const sourceEndOffset = sourceStartOffset + sourceRaw.length;
        const effectiveTargetMatch = targetMatch || selfClosingTargetMatch;
        const targetRaw = targetMatch ? targetMatch[2] : (selfClosingTargetMatch ? '' : undefined);
        const targetTagStartOffset = effectiveTargetMatch ? bodyStartOffset + effectiveTargetMatch.index : undefined;
        const targetStartOffset = targetMatch
            ? targetTagStartOffset + targetMatch[0].indexOf('>') + 1
            : targetTagStartOffset;
        const targetEndOffset = targetMatch
            ? targetStartOffset + targetRaw.length
            : targetStartOffset;
        const decodedTarget = effectiveTargetMatch ? decodeXmlEntities(stripXmlTags(targetRaw)) : undefined;
        const nabTarget = effectiveTargetMatch ? parseNabTargetMarker(decodedTarget) : undefined;
        const rawTargetState = effectiveTargetMatch ? getAttribute(effectiveTargetMatch[1], 'state') : undefined;
        const maxWidthAttr = getAttribute(unitAttrs, 'maxwidth');
        const maxWidth = maxWidthAttr ? parseInt(maxWidthAttr, 10) : undefined;
        units.push({
            ordinal: ordinal++,
            id: getAttribute(unitAttrs, 'id') || '',
            source: decodeXmlEntities(stripXmlTags(sourceRaw)),
            sourceRaw,
            // NAB AL Tools can encode workflow state as a textual target prefix when
            // NAB.UseTargetStates=false. Treat those prefixes as metadata rather than
            // translation text so they never leak into the editor, QA, AI context, or .lng.
            target: nabTarget ? nabTarget.text : decodedTarget,
            targetRaw,
            targetAttrs: effectiveTargetMatch ? effectiveTargetMatch[1] : '',
            targetStateRaw: rawTargetState,
            targetState: rawTargetState || (nabTarget ? nabTarget.state : undefined),
            nabMarker: nabTarget ? nabTarget.marker : '',
            nabMarkerKind: nabTarget ? nabTarget.kind : '',
            translate: getAttribute(unitAttrs, 'translate'),
            maxWidth: Number.isFinite(maxWidth) ? maxWidth : undefined,
            notes,
            noteDetails,
            startOffset: unitStartOffset,
            endOffset: unitEndOffset,
            sourceStartOffset,
            sourceEndOffset,
            targetStartOffset,
            targetEndOffset
        });
    }

    return { sourceLanguage, targetLanguage, units };
}


function getUnitRaw(text, unit) {
    const sourceText = String(text || '');
    const start = Number(unit && unit.startOffset);
    const end = Number(unit && unit.endOffset);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > sourceText.length) return '';
    return sourceText.slice(start, end);
}


function parseCommentTranslations(text, options = {}) {
    const result = new Map();
    const value = options.preserveWhitespace ? String(text || '') : String(text || '').trim();
    if (!value) return result;

    // Matches both BCP-47 keys (de-DE, en-US, pt-BR, ...) and classic
    // Business Central/NAV three-letter language identifiers (DEU, ENU, ...).
    // A semicolon only ends the value when it is followed by another language assignment.
    const languageKey = String.raw`(?:[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})+|[A-Za-z]{3})`;
    const re = new RegExp(
        String.raw`(?:^\s*|;\s*)(${languageKey})\s*=${options.preserveWhitespace ? '' : String.raw`\s*`}([\s\S]*?)(?=;\s*${languageKey}\s*=|$)`,
        'gi'
    );

    let match;
    while ((match = re.exec(value)) !== null) {
        const key = match[1].trim();
        const translation = options.preserveWhitespace ? match[2] : match[2].trim();
        if (translation) result.set(key, translation);
    }
    return result;
}

function getDeveloperCommentTranslation(unit, targetLanguage, options = {}) {
    const translations = new Set();
    const details = unit && Array.isArray(unit.noteDetails) ? unit.noteDetails : [];

    for (const note of details) {
        if (String(note.from || '').trim().toLowerCase() !== 'developer') continue;
        const parsed = parseCommentTranslations(options.preserveWhitespace && note.rawText !== undefined ? note.rawText : note.text, options);
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
    if (unit.nabMarkerKind === 'review' || unit.nabMarkerKind === 'suggestion') return true;
    const state = String(unit.targetState || '').trim().toLowerCase();
    // A persisted target without an explicit state is usable translation text,
    // but it has never been explicitly confirmed. Treat it as a review item
    // rather than as translated or missing. The visual editor's ✓ action can
    // promote it to state=translated.
    if (!state) return true;
    return REVIEW_TARGET_STATES.has(state);
}

function isMissingTranslation(unit, treatNeedsTranslationAsMissing = true) {
    if (unit && String(unit.translate || '').trim().toLowerCase() === 'no') {
        return false;
    }
    if (unit && unit.nabMarkerKind === 'not-translated') {
        return true;
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
        const provenance = entry && typeof entry === 'object' ? entry.provenance : undefined;
        const extraNotes = entry && typeof entry === 'object' && Array.isArray(entry.notes) ? entry.notes : [];

        if (typeof translation !== 'string' || translation.length === 0) {
            return unitRaw;
        }
        updatedCount++;
        const updated = setTarget(unitRaw, translation, eol, setTranslatedState && !review);
        let withState = review ? setTargetState(updated, 'needs-review-translation') : updated;
        if (note) withState = appendSyncNote(withState, note, eol);
        for (const extraNote of extraNotes) {
            if (typeof extraNote === 'string' && extraNote.trim()) withState = appendSyncNote(withState, extraNote.trim(), eol);
        }
        const provenanceNote = serializeProvenanceNote(provenance);
        if (provenanceNote) withState = appendSyncNote(withState, provenanceNote, eol);
        if (parsed.nabMarker) withState = removeNabNotes(withState);
        return withState;
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

const SYNC_NOTE_FROM = NOTE_FROM;
const SOURCE_CHANGE_NOTE_PREFIX = 'Source changed from ';
const STAGED_TRANSLATION_NOTE_PREFIX = 'Staged translation:';
const STAGED_TRANSLATION_VERSION = 1;

function sanitizeStagedTranslation(value) {
    if (!value || typeof value !== 'object') return undefined;
    const kind = String(value.kind || '').trim().toLowerCase();
    if (!['draft', 'proposal'].includes(kind)) return undefined;
    if (typeof value.text !== 'string') return undefined;
    const result = {
        v: STAGED_TRANSLATION_VERSION,
        kind,
        text: value.text,
        at: Number.isFinite(Date.parse(String(value.at || ''))) ? String(value.at) : new Date().toISOString()
    };
    if (value.source !== undefined) result.source = String(value.source);
    if (value.id !== undefined) result.id = String(value.id);
    if (value.origin) result.origin = String(value.origin);
    const provenance = sanitizeProvenance(value.provenance);
    if (provenance) result.provenance = provenance;
    return result;
}

function serializeStagedTranslationNote(value) {
    const staged = sanitizeStagedTranslation(value);
    if (!staged) return '';
    return `${STAGED_TRANSLATION_NOTE_PREFIX} ${JSON.stringify(staged)}`;
}

function parseStagedTranslationNote(text) {
    const value = String(text || '').trim();
    if (!value.startsWith(STAGED_TRANSLATION_NOTE_PREFIX)) return undefined;
    const json = value.slice(STAGED_TRANSLATION_NOTE_PREFIX.length).trim();
    if (!json) return undefined;
    try {
        return sanitizeStagedTranslation(JSON.parse(json));
    } catch (_) {
        return undefined;
    }
}

function getStagedTranslation(unit) {
    let result;
    for (const note of (unit && unit.noteDetails) || []) {
        if (!isStudioNoteFrom(note.from)) continue;
        const parsed = parseStagedTranslationNote(note.text);
        if (parsed) result = parsed;
    }
    if (!result) return undefined;
    if (result.source !== undefined && unit && result.source !== unit.source) return undefined;
    if (result.id !== undefined && unit && unit.id && result.id !== unit.id) return undefined;
    return result;
}

function isStagedTranslationNoteDetail(note) {
    return Boolean(note && isStudioNoteFrom(note.from) && parseStagedTranslationNote(note.text));
}

function setStagedTranslations(text, items) {
    const requested = new Map();
    for (const item of items || []) {
        const ordinal = Number(item && item.ordinal);
        if (!Number.isInteger(ordinal) || ordinal < 0) continue;
        requested.set(ordinal, item ? item.staged : undefined);
    }
    if (!requested.size) return { text: String(text || ''), updatedCount: 0 };

    const eol = String(text || '').includes('\r\n') ? '\r\n' : '\n';
    let currentOrdinal = 0;
    let updatedCount = 0;
    const result = String(text || '').replace(/<trans-unit\b([^>]*)>([\s\S]*?)<\/trans-unit>/gi, unitRaw => {
        const parsed = parseSingleUnit(unitRaw);
        if (!parsed) return unitRaw;
        const ordinal = currentOrdinal++;
        if (!requested.has(ordinal)) return unitRaw;

        let updated = removeMatchingStudioNotes(unitRaw, noteText => Boolean(parseStagedTranslationNote(noteText)));
        const stagedValue = requested.get(ordinal);
        if (stagedValue !== undefined && stagedValue !== null) {
            const staged = sanitizeStagedTranslation({
                ...stagedValue,
                source: parsed.source,
                id: parsed.id
            });
            if (staged) {
                // Studio staging metadata is attached to the trans-unit as a normal XLIFF note.
                // Ensure a target node exists so appendSyncNote has a stable insertion point,
                // while leaving its translation/state semantics untouched.
                if (parsed.target === undefined) updated = setTarget(updated, '', eol, false);
                const noteText = serializeStagedTranslationNote(staged);
                updated = appendSyncNote(updated, noteText, eol, 'general');
            }
        }
        if (updated !== unitRaw) updatedCount++;
        return updated;
    });
    return { text: result, updatedCount };
}

function setStagedTranslation(text, ordinal, staged) {
    return setStagedTranslations(text, [{ ordinal, staged }]);
}

function clearStagedTranslation(text, ordinal) {
    return setStagedTranslation(text, ordinal, undefined);
}

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
// The source-change note is specific. Unrelated AL.XliffStudio notes never suppress source synchronization.
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
        // A staged translation belongs to the exact source text it was created for.
        // When the generator changes that source, discard the stale staged metadata
        // rather than restoring a paid AI suggestion against a different source.
        updated = removeMatchingStudioNotes(updated, noteText => Boolean(parseStagedTranslationNote(noteText)));
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
            if (parsed.nabMarker) {
                updated = setTarget(updated, parsed.target || '', eol, false);
                updated = removeNabNotes(updated);
            }
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
function applyTranslationChangesToUnit(unitRaw, parsed, changes, eol) {
    if (String(parsed.translate || '').trim().toLowerCase() === 'no') return unitRaw;
    const hasTranslation = Object.prototype.hasOwnProperty.call(changes, 'translation');
    const hasState = Object.prototype.hasOwnProperty.call(changes, 'state');
    let updated = unitRaw;

    // Any explicit Studio edit/status action migrates a NAB text-marker unit
    // to ordinary XLIFF state semantics. The marker is metadata, not part of
    // the translation, and the corresponding NAB explanation note is stale
    // once the Studio has handled the unit.
    if (parsed.nabMarker && !hasTranslation && hasState) {
        updated = setTarget(updated, parsed.target || '', eol, false);
    }
    if (hasTranslation) {
        const translation = String(changes.translation ?? '');
        updated = setTarget(updated, translation, eol, false);
        const state = hasState
            ? changes.state
            : (translation.length ? 'translated' : 'needs-translation');
        updated = setTargetState(updated, state);
    } else if (hasState) {
        if (parsed.target === undefined) updated = setTarget(updated, '', eol, false);
        updated = setTargetState(updated, changes.state);
    }

    if (parsed.nabMarker && (hasTranslation || hasState)) updated = removeNabNotes(updated);
    if (changes.clearStaged) {
        updated = removeMatchingStudioNotes(updated, noteText => Boolean(parseStagedTranslationNote(noteText)));
    }

    const note = typeof changes.note === 'string' ? changes.note.trim() : '';
    if (note && !hasSpecificSyncNote(updated, note)) {
        updated = appendSyncNote(updated, note, eol, changes.noteAnnotates || 'general');
    }
    if (Array.isArray(changes.notes)) {
        for (const extraNote of changes.notes) {
            if (typeof extraNote === 'string' && extraNote.trim()) {
                updated = appendSyncNote(updated, extraNote.trim(), eol, 'general');
            }
        }
    }
    const provenanceNote = serializeProvenanceNote(changes.provenance);
    if (provenanceNote) updated = appendSyncNote(updated, provenanceNote, eol, 'general');
    return updated;
}

function updateTranslationUnitRaw(unitRaw, changes = {}) {
    const sourceText = String(unitRaw || '');
    const parsed = parseSingleUnit(sourceText);
    if (!parsed) return { text: sourceText, updated: false };
    const eol = sourceText.includes('\r\n') ? '\r\n' : '\n';
    const updated = applyTranslationChangesToUnit(sourceText, parsed, changes, eol);
    return { text: updated, updated: updated !== sourceText };
}

/**
 * Applies multiple ordinal-based translation-unit changes in one XLIFF pass.
 * This is the commit primitive used by Apply Drafts. It avoids reparsing and
 * rebuilding a large XLIFF once per draft.
 */
function updateTranslationUnits(text, items) {
    const requested = new Map();
    for (const item of items || []) {
        const ordinal = Number(item && item.ordinal);
        if (!Number.isInteger(ordinal) || ordinal < 0) continue;
        requested.set(ordinal, item && item.changes ? item.changes : {});
    }
    if (!requested.size) return { text: String(text || ''), updatedCount: 0, updatedOrdinals: [] };

    const sourceText = String(text || '');
    const eol = sourceText.includes('\r\n') ? '\r\n' : '\n';
    let currentOrdinal = 0;
    let updatedCount = 0;
    const updatedOrdinals = [];
    const result = sourceText.replace(/<trans-unit\b([^>]*)>([\s\S]*?)<\/trans-unit>/gi, unitRaw => {
        const parsed = parseSingleUnit(unitRaw);
        if (!parsed) return unitRaw;
        const ordinal = currentOrdinal++;
        const changes = requested.get(ordinal);
        if (!changes) return unitRaw;
        const updated = applyTranslationChangesToUnit(unitRaw, parsed, changes, eol);
        if (updated !== unitRaw) {
            updatedCount++;
            updatedOrdinals.push(ordinal);
        }
        return updated;
    });
    return { text: result, updatedCount, updatedOrdinals };
}

function updateTranslationUnit(text, ordinal, changes = {}) {
    const result = updateTranslationUnits(text, [{ ordinal, changes }]);
    return { text: result.text, updatedCount: result.updatedCount };
}

function setNoStateTargetsTranslated(text, options = {}) {
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const includeProvenance = options.provenance !== false;
    const provenance = includeProvenance ? options.provenance : undefined;
    let ordinal = 0;
    let updatedCount = 0;
    const accepted = [];
    const skipped = [];

    const result = String(text || '').replace(/<trans-unit\b([^>]*)>([\s\S]*?)<\/trans-unit>/gi, unitRaw => {
        const parsed = parseSingleUnit(unitRaw);
        if (!parsed) return unitRaw;
        const currentOrdinal = ordinal++;
        if (String(parsed.translate || '').trim().toLowerCase() === 'no') return unitRaw;
        if (String(parsed.targetState || '').trim()) return unitRaw;
        const translation = String(parsed.target == null ? '' : parsed.target);
        if (!translation.trim()) return unitRaw;
        if (!placeholdersMatch(parsed.source, translation)) {
            skipped.push({ ordinal: currentOrdinal, source: parsed.source, translation, reason: 'placeholder mismatch' });
            return unitRaw;
        }

        let updated = setTargetState(unitRaw, 'translated');
        const provenanceNote = serializeProvenanceNote(provenance);
        if (provenanceNote) updated = appendSyncNote(updated, provenanceNote, eol, 'general');
        if (updated === unitRaw) return unitRaw;

        updatedCount++;
        accepted.push({ ordinal: currentOrdinal, source: parsed.source, translation });
        return updated;
    });

    return { text: result, updatedCount, accepted, skipped };
}



function replaceTranslationUnitRaw(text, ordinal, rawUnit) {
    const requestedOrdinal = Number(ordinal);
    if (!Number.isInteger(requestedOrdinal) || requestedOrdinal < 0 || typeof rawUnit !== 'string' || !rawUnit) {
        return { text: String(text || ''), updatedCount: 0 };
    }
    let currentOrdinal = 0;
    let updatedCount = 0;
    const result = String(text || '').replace(/<trans-unit\b([^>]*)>([\s\S]*?)<\/trans-unit>/gi, unitRaw => {
        const parsed = parseSingleUnit(unitRaw);
        if (!parsed) return unitRaw;
        const current = currentOrdinal++;
        if (current !== requestedOrdinal) return unitRaw;
        if (unitRaw === rawUnit) return unitRaw;
        updatedCount = 1;
        return rawUnit;
    });
    return { text: result, updatedCount };
}

function setQualityIssueIgnored(text, ordinal, issue, ignored = true) {
    const eol = String(text || '').includes('\r\n') ? '\r\n' : '\n';
    let currentOrdinal = 0;
    let updatedCount = 0;
    const desired = {
        code: String(issue && issue.code || ''),
        source: String(issue && issue.source || ''),
        target: String(issue && issue.target || '')
    };
    if (!desired.code) return { text: String(text || ''), updatedCount: 0 };

    const result = String(text || '').replace(/<trans-unit\b([^>]*)>([\s\S]*?)<\/trans-unit>/gi, unitRaw => {
        const parsed = parseSingleUnit(unitRaw);
        if (!parsed) return unitRaw;
        const current = currentOrdinal++;
        if (current !== ordinal) return unitRaw;

        let updated = unitRaw;
        if (ignored) {
            const noteText = serializeQualityIgnoreNote(desired);
            const exists = (parsed.noteDetails || []).some(note => {
                if (!isStudioNoteFrom(note.from)) return false;
                const existing = parseQualityIgnoreText(note.text);
                return qualityIgnoreRecordMatches(existing, desired);
            });
            if (!exists) updated = appendSyncNote(updated, noteText, eol, 'general');
        } else {
            updated = removeMatchingStudioNotes(updated, noteText => {
                const existing = parseQualityIgnoreText(noteText);
                return qualityIgnoreRecordMatches(existing, desired);
            });
        }
        if (updated !== unitRaw) updatedCount++;
        return updated;
    });
    return { text: result, updatedCount };
}

function qualityIgnoreRecordMatches(existing, desired) {
    if (!existing || !desired || String(existing.code) !== String(desired.code)) return false;
    if (desired.source && String(existing.source || '') !== String(desired.source)) return false;
    if (desired.target && String(existing.target || '') !== String(desired.target)) return false;
    return true;
}

function removeMatchingStudioNotes(unitRaw, predicate) {
    const noteLineRe = /(\r?\n)?([ \t]*)<note\b([^>]*)>([\s\S]*?)<\/note>/gi;
    return String(unitRaw || '').replace(noteLineRe, (whole, leadingEol, indent, attrs, body) => {
        if (!isStudioNoteFrom(getAttribute(attrs, 'from'))) return whole;
        const text = decodeXmlEntities(stripXmlTags(body)).trim();
        if (!predicate(text)) return whole;
        return '';
    });
}

function removeNabNotes(unitRaw) {
    const noteLineRe = /(\r?\n)?([ \t]*)<note\b([^>]*)>([\s\S]*?)<\/note>/gi;
    return String(unitRaw || '').replace(noteLineRe, (whole, leadingEol, indent, attrs) => {
        return isNabNoteFrom(getAttribute(attrs, 'from')) ? '' : whole;
    });
}

function hasSpecificSyncNote(unitRaw, notePrefix) {
    const noteRe = /<note\b([^>]*)>([\s\S]*?)<\/note>/gi;
    let match;
    while ((match = noteRe.exec(unitRaw)) !== null) {
        if (!isStudioNoteFrom(getAttribute(match[1], 'from'))) continue;
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
    const matches = String(text).match(/%\d+|#\d+|\{\{?[^{}]+\}?\}/g) || [];
    return matches.sort();
}

function placeholdersMatch(source, translation) {
    const expected = new Set(String(source || '').match(/%\d+/g) || []);
    const actual = new Set(String(translation || '').match(/%\d+/g) || []);
    return [...expected].every(value => actual.has(value));
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
    parseXliff,
    getUnitRaw,
    parseNabTargetMarker,
    removeNabNotes,
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
    updateTranslationUnit,
    updateTranslationUnitRaw,
    updateTranslationUnits,
    setNoStateTargetsTranslated,
    replaceTranslationUnitRaw,
    setQualityIssueIgnored,
    STAGED_TRANSLATION_NOTE_PREFIX,
    serializeStagedTranslationNote,
    parseStagedTranslationNote,
    getStagedTranslation,
    isStagedTranslationNoteDetail,
    setStagedTranslation,
    setStagedTranslations,
    clearStagedTranslation
};
