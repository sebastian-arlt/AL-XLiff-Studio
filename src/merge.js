'use strict';

const { getAttribute, setAttribute, encodeXmlText } = require('./xliff');

const MERGE_NOTE = 'Copied from another xliff file. Please review the translation.';
const MERGE_STATE = 'needs-adaptation';

function buildSourceLookup(sourceParsed) {
    const byId = new Map();
    const byGeneratorNote = new Map();
    const bySourceGroups = new Map();

    for (const unit of sourceParsed.units) {
        if (!unit.target) continue;
        if (unit.id) byId.set(unit.id, unit);
        const generatorNote = (unit.noteDetails || []).find(note => String(note.from || '').trim().toLowerCase() === 'xliff generator');
        if (generatorNote && generatorNote.text && !byGeneratorNote.has(generatorNote.text)) {
            byGeneratorNote.set(generatorNote.text, unit);
        }
        if (unit.source) {
            if (!bySourceGroups.has(unit.source)) bySourceGroups.set(unit.source, []);
            bySourceGroups.get(unit.source).push(unit);
        }
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

// Merges translations from sourceParsed (another already-translated xlf file)
// into targetText. Mirrors BC.SyncXlf's three merge modes:
// - 'untranslated': fills only trans-units that currently have no target text.
// - 'overwrite': always replaces the target text of a matched trans-unit.
// - 'add': inserts whole trans-units that exist in source but not in target.
// Matching order per trans-unit: id -> "Xliff Generator" note -> unique source text.
function mergeTranslationUnits(targetText, targetParsed, sourceParsed, mode) {
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
            if (mode === 'untranslated' && unit.target) continue;
            if (match.target === unit.target) continue;
            translationById.set(unit.id, match.target);
        }

        result = targetText.replace(/<trans-unit\b([^>]*)>([\s\S]*?)<\/trans-unit>/gi, (unitRaw, unitAttrs) => {
            const id = getAttribute(unitAttrs, 'id') || '';
            const translation = translationById.get(id);
            if (translation === undefined) return unitRaw;
            updatedCount++;
            return writeMergedTarget(unitRaw, translation, eol);
        });
    }

    if (mode === 'add') {
        const targetIds = new Set(targetParsed.units.map(unit => unit.id));
        const additions = [];
        for (const unit of sourceParsed.units) {
            if (!unit.target || targetIds.has(unit.id)) continue;
            additions.push(writeMergedTarget(unit.raw, unit.target, eol));
        }
        const groupCloseRe = /(<\/group>)/i;
        if (additions.length && groupCloseRe.test(result)) {
            addedCount = additions.length;
            result = result.replace(groupCloseRe, `${additions.join(eol)}${eol}$1`);
        }
    }

    return { text: result, updatedCount, addedCount };
}

function writeMergedTarget(unitRaw, translation, eol) {
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
            // No target element at all yet: insert one right after <source>.
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
    return appendMergeNote(updated, eol);
}

function appendMergeNote(unitRaw, eol) {
    const targetCloseRe = /(<target\b[^>]*>[\s\S]*?<\/target>|<target\b[^>]*\/\s*>)/i;
    const targetMatch = unitRaw.match(targetCloseRe);
    if (!targetMatch) return unitRaw;
    const beforeTarget = unitRaw.slice(0, targetMatch.index);
    const indentMatch = beforeTarget.match(/(?:^|\r?\n)([ \t]*)$/);
    const indent = indentMatch ? indentMatch[1] : '          ';
    const note = `<note from="BC.XliffMap" annotates="general" priority="1">${encodeXmlText(MERGE_NOTE)}</note>`;
    return unitRaw.replace(targetCloseRe, `$1${eol}${indent}${note}`);
}

module.exports = { mergeTranslationUnits };
