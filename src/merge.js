'use strict';
const { t } = require('./localization');

const { getAttribute, getUnitRaw, setAttribute, encodeXmlText, isMissingTranslation, removeNabNotes } = require('./xliff');
const { findDuplicateIds, findDuplicateGeneratorNotes } = require('./validate');
const { NOTE_FROM } = require('./identity');
const { createProvenance, serializeProvenanceNote } = require('./provenance');

const MERGE_NOTE = 'Copied from another xliff file. Please review the translation.';
const MERGE_STATE = 'needs-adaptation';
const MERGE_NOTE_FROM = NOTE_FROM;

function normalizeLanguage(value) {
    return String(value || '').trim().replace(/_/g, '-').toLowerCase();
}

function validateMergeLanguages(targetParsed, sourceParsed) {
    const sourceSourceLanguage = normalizeLanguage(sourceParsed && sourceParsed.sourceLanguage);
    const targetSourceLanguage = normalizeLanguage(targetParsed && targetParsed.sourceLanguage);
    const sourceTargetLanguage = normalizeLanguage(sourceParsed && sourceParsed.targetLanguage);
    const targetTargetLanguage = normalizeLanguage(targetParsed && targetParsed.targetLanguage);

    if (sourceSourceLanguage && targetSourceLanguage && sourceSourceLanguage !== targetSourceLanguage) {
        return {
            compatible: false,
            reason: `Source languages differ (${sourceParsed.sourceLanguage} vs ${targetParsed.sourceLanguage}).`
        };
    }
    if (!sourceTargetLanguage || !targetTargetLanguage) {
        return {
            compatible: false,
            reason: 'Both XLIFF files must define target-language before translations can be merged.'
        };
    }
    if (sourceTargetLanguage !== targetTargetLanguage) {
        return {
            compatible: false,
            reason: `Target languages differ (${sourceParsed.targetLanguage} vs ${targetParsed.targetLanguage}).`
        };
    }
    return { compatible: true };
}


function validateMergeStructure(parsed, label) {
    const duplicateIds = findDuplicateIds(parsed);
    const duplicateNotes = findDuplicateGeneratorNotes(parsed);
    if (!duplicateIds.length && !duplicateNotes.length) return { valid: true };

    const parts = [];
    if (duplicateIds.length) parts.push(`duplicate trans-unit id(s): ${duplicateIds.join(', ')}`);
    if (duplicateNotes.length) parts.push(t("{0} duplicate Xliff Generator note(s)", duplicateNotes.length));
    return { valid: false, reason: `${label} XLIFF contains ${parts.join(' and ')}.` };
}

function buildSourceLookup(sourceParsed) {
    const byId = new Map();
    const byGeneratorNoteGroups = new Map();
    const bySourceGroups = new Map();

    for (const unit of sourceParsed.units) {
        if (!unit.target) continue;
        // Empty/new/needs-translation source targets are not translations that
        // should be propagated. Review/adaptation targets remain eligible but
        // are still flagged needs-adaptation in the destination.
        if (isMissingTranslation(unit, true)) continue;

        if (unit.id) byId.set(unit.id, unit);
        const generatorNote = (unit.noteDetails || []).find(note => String(note.from || '').trim().toLowerCase() === 'xliff generator');
        if (generatorNote && generatorNote.text) {
            if (!byGeneratorNoteGroups.has(generatorNote.text)) byGeneratorNoteGroups.set(generatorNote.text, []);
            byGeneratorNoteGroups.get(generatorNote.text).push(unit);
        }
        if (unit.source) {
            if (!bySourceGroups.has(unit.source)) bySourceGroups.set(unit.source, []);
            bySourceGroups.get(unit.source).push(unit);
        }
    }

    const byGeneratorNote = new Map();
    for (const [note, units] of byGeneratorNoteGroups) {
        if (units.length === 1) byGeneratorNote.set(note, units[0]);
    }

    const byDistinctSource = new Map();
    for (const [source, units] of bySourceGroups) {
        if (units.length === 1) byDistinctSource.set(source, units[0]);
    }

    return { byId, byGeneratorNote, byDistinctSource };
}

function findMatch(targetUnit, lookup) {
    if (targetUnit.id && lookup.byId.has(targetUnit.id)) {
        return lookup.byId.get(targetUnit.id);
    }
    const generatorNote = (targetUnit.noteDetails || []).find(note => String(note.from || '').trim().toLowerCase() === 'xliff generator');
    if (generatorNote && generatorNote.text && lookup.byGeneratorNote.has(generatorNote.text)) {
        return lookup.byGeneratorNote.get(generatorNote.text);
    }
    if (targetUnit.source && lookup.byDistinctSource.has(targetUnit.source)) {
        return lookup.byDistinctSource.get(targetUnit.source);
    }
    return undefined;
}

// Merges translations from sourceParsed into targetText.
// Matching order per trans-unit: id -> unique "Xliff Generator" note -> unique source text.
function mergeTranslationUnits(targetText, targetParsed, sourceParsed, mode, options = {}) {
    const languageCheck = validateMergeLanguages(targetParsed, sourceParsed);
    if (!languageCheck.compatible) {
        const error = new Error(languageCheck.reason);
        error.code = 'XLIFF_LANGUAGE_MISMATCH';
        throw error;
    }

    const sourceStructure = validateMergeStructure(sourceParsed, t("Source"));
    const targetStructure = validateMergeStructure(targetParsed, 'Target');
    const structuralFailure = !sourceStructure.valid ? sourceStructure : (!targetStructure.valid ? targetStructure : undefined);
    if (structuralFailure) {
        const error = new Error(structuralFailure.reason);
        error.code = 'XLIFF_STRUCTURAL_AMBIGUITY';
        throw error;
    }

    const lookup = buildSourceLookup(sourceParsed);
    const eol = targetText.includes('\r\n') ? '\r\n' : '\n';
    let updatedCount = 0;
    let addedCount = 0;
    let result = targetText;

    if (mode === 'untranslated' || mode === 'overwrite') {
        const translationById = new Map();
        for (const unit of targetParsed.units) {
            const match = findMatch(unit, lookup);
            if (!match) continue;
            if (mode === 'untranslated' && !isMissingTranslation(unit, true)) continue;
            if (match.target === unit.target && !isMissingTranslation(unit, true)) continue;
            translationById.set(unit.id, match.target);
        }

        result = targetText.replace(/<trans-unit\b([^>]*)>([\s\S]*?)<\/trans-unit>/gi, (unitRaw, unitAttrs) => {
            const id = getAttribute(unitAttrs, 'id') || '';
            const translation = translationById.get(id);
            if (translation === undefined) return unitRaw;
            updatedCount++;
            return writeMergedTarget(unitRaw, translation, eol, options);
        });
    }

    if (mode === 'add') {
        const sourceText = typeof options.sourceText === 'string' ? options.sourceText : '';
        if (!sourceText) {
            throw new Error('Merge add mode requires the source XLIFF text to materialize trans-units from XML offsets.');
        }
        const targetIds = new Set(targetParsed.units.map(unit => unit.id));
        const additions = [];
        for (const unit of sourceParsed.units) {
            if (!unit.target || isMissingTranslation(unit, true) || targetIds.has(unit.id)) continue;
            const unitRaw = getUnitRaw(sourceText, unit);
            if (!unitRaw) continue;
            additions.push(writeMergedTarget(unitRaw, unit.target, eol, options));
        }
        const groupCloseRe = /(<\/group>)/i;
        if (additions.length && groupCloseRe.test(result)) {
            addedCount = additions.length;
            result = result.replace(groupCloseRe, `${additions.join(eol)}${eol}$1`);
        }
    }

    return { text: result, updatedCount, addedCount };
}

function writeMergedTarget(unitRaw, translation, eol, options = {}) {
    const escaped = encodeXmlText(translation);
    const targetRe = /<target\b([^>]*)>([\s\S]*?)<\/target>/i;
    const selfClosingTargetRe = /<target\b([^>]*)\/\s*>/i;
    let updated = unitRaw;

    const targetMatch = unitRaw.match(targetRe);
    if (targetMatch) {
        const attrs = setAttribute(targetMatch[1] || '', 'state', MERGE_STATE);
        updated = unitRaw.replace(targetRe, `<target${attrs}>${escaped}</target>`);
    } else {
        const selfClosingMatch = unitRaw.match(selfClosingTargetRe);
        if (selfClosingMatch) {
            const attrs = setAttribute(selfClosingMatch[1] || '', 'state', MERGE_STATE);
            updated = unitRaw.replace(selfClosingTargetRe, `<target${attrs}>${escaped}</target>`);
        } else {
            const sourceRe = /(<source\b[^>]*>[\s\S]*?<\/source>)/i;
            const sourceMatch = unitRaw.match(sourceRe);
            if (sourceMatch) {
                const beforeSource = unitRaw.slice(0, sourceMatch.index);
                const indentMatch = beforeSource.match(/(?:^|\r?\n)([ \t]*)$/);
                const indent = indentMatch ? indentMatch[1] : '          ';
                updated = unitRaw.replace(sourceRe, `$1${eol}${indent}<target state="${MERGE_STATE}">${escaped}</target>`);
            }
        }
    }
    // A merge resolves any NAB text marker in the target. Remove the matching
    // NAB explanation note as well so stale NAB workflow metadata is not kept
    // next to the Studio's needs-adaptation state.
    updated = removeNabNotes(updated);
    updated = appendMergeNote(updated, eol);
    return options.provenanceEnabled === false ? updated : appendMergeProvenance(updated, eol);
}


function appendMergeProvenance(unitRaw, eol) {
    const noteText = serializeProvenanceNote(createProvenance('merge', { action: 'merged-for-review' }));
    if (!noteText) return unitRaw;
    const targetCloseRe = /(<target\b[^>]*>[\s\S]*?<\/target>|<target\b[^>]*\/\s*>)/i;
    const targetMatch = unitRaw.match(targetCloseRe);
    if (!targetMatch) return unitRaw;
    const beforeTarget = unitRaw.slice(0, targetMatch.index);
    const indentMatch = beforeTarget.match(/(?:^|\r?\n)([ \t]*)$/);
    const indent = indentMatch ? indentMatch[1] : '          ';
    const note = `<note from="${MERGE_NOTE_FROM}" annotates="general" priority="1">${encodeXmlText(noteText)}</note>`;
    return unitRaw.replace(targetCloseRe, `$1${eol}${indent}${note}`);
}

function appendMergeNote(unitRaw, eol) {
    if (hasMergeNote(unitRaw)) return unitRaw;
    const targetCloseRe = /(<target\b[^>]*>[\s\S]*?<\/target>|<target\b[^>]*\/\s*>)/i;
    const targetMatch = unitRaw.match(targetCloseRe);
    if (!targetMatch) return unitRaw;
    const beforeTarget = unitRaw.slice(0, targetMatch.index);
    const indentMatch = beforeTarget.match(/(?:^|\r?\n)([ \t]*)$/);
    const indent = indentMatch ? indentMatch[1] : '          ';
    const note = `<note from="${MERGE_NOTE_FROM}" annotates="general" priority="1">${encodeXmlText(MERGE_NOTE)}</note>`;
    return unitRaw.replace(targetCloseRe, `$1${eol}${indent}${note}`);
}

function hasMergeNote(unitRaw) {
    const escaped = MERGE_NOTE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const noteRe = new RegExp(`<note\\b[^>]*from\\s*=\\s*["']${MERGE_NOTE_FROM.replace('.', '\\.')}["'][^>]*>\\s*${escaped}\\s*<\\/note>`, 'i');
    return noteRe.test(unitRaw);
}

module.exports = { mergeTranslationUnits, validateMergeLanguages, validateMergeStructure };
