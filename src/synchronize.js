'use strict';

const { parseXliff, getUnitRaw, detectSourceChanges, flagSourceChangedUnits } = require('./xliff');
const { findDuplicateIds } = require('./validate');

function normalizeLanguage(value) {
    return String(value || '').trim().replace(/_/g, '-').toLowerCase();
}

/**
 * Synchronizes a translated XLIFF against its generated *.g.xlf companion.
 *
 * Safe/non-destructive rules:
 * - existing target texts are preserved;
 * - Developer and Xliff Generator notes are mirrored from the matching generator trans-unit while unrelated notes remain untouched;
 * - changed source text is updated from the generator and an existing target is
 *   flagged needs-l10n via flagSourceChangedUnits;
 * - generator trans-units missing in the translation file are created with an
 *   empty needs-translation target;
 * - all current trans-units are ordered exactly like the generated *.g.xlf;
 * - translation units that no longer exist in the generator are removed from
 *   the translated XLIFF. Callers can use removedUnits to preserve their
 *   confirmed translations in the companion .lng before writing the result.
 */
function synchronizeTranslationUnits(targetText, sourceText) {
    const targetParsed = parseXliff(targetText);
    const sourceParsed = parseXliff(sourceText);

    if (!targetParsed.targetLanguage) {
        throw new Error('The translation XLIFF must define target-language.');
    }

    if (normalizeLanguage(targetParsed.sourceLanguage) !== normalizeLanguage(sourceParsed.sourceLanguage)) {
        throw new Error(`Source languages differ (${targetParsed.sourceLanguage} vs ${sourceParsed.sourceLanguage}).`);
    }

    const targetDuplicateIds = findDuplicateIds(targetParsed);
    const sourceDuplicateIds = findDuplicateIds(sourceParsed);
    if (targetDuplicateIds.length) {
        throw new Error(`Translation XLIFF contains duplicate trans-unit id(s): ${targetDuplicateIds.join(', ')}`);
    }
    if (sourceDuplicateIds.length) {
        throw new Error(`Generator XLIFF contains duplicate trans-unit id(s): ${sourceDuplicateIds.join(', ')}`);
    }

    let resultText = targetText;
    const changed = detectSourceChanges(targetParsed, sourceParsed);
    let synchronizedSources = 0;
    let flaggedTargets = 0;
    if (changed.size) {
        const result = flagSourceChangedUnits(resultText, changed);
        resultText = result.text;
        synchronizedSources = result.synchronizedCount;
        flaggedTargets = result.flaggedCount;
    }

    const afterSourceSync = parseXliff(resultText);
    const targetIds = new Set(afterSourceSync.units.map(unit => unit.id).filter(Boolean));
    const sourceIds = new Set(sourceParsed.units.map(unit => unit.id).filter(Boolean));
    const missingUnits = sourceParsed.units.filter(unit => unit.id && !targetIds.has(unit.id));
    const removedUnits = afterSourceSync.units.filter(unit => unit.id && !sourceIds.has(unit.id));

    // Rebuild the trans-unit sequence in generator order.  This mirrors the
    // ordering produced by the established XLIFF synchronization workflow and
    // avoids the previous behaviour where newly discovered units were simply
    // appended to the end of the target file. Existing target units keep their
    // complete raw XML (including translations/review notes). Missing units are
    // created from the generator unit at the exact generator position.
    const eol = resultText.includes('\r\n') ? '\r\n' : '\n';
    const currentById = new Map(afterSourceSync.units.filter(unit => unit.id).map(unit => [unit.id, unit]));
    let synchronizedDeveloperNotes = 0;
    let synchronizedGeneratorNotes = 0;
    const orderedCurrentUnits = sourceParsed.units
        .filter(unit => unit.id)
        .map(unit => {
            const current = currentById.get(unit.id);
            const sourceUnitRaw = getUnitRaw(sourceText, unit);
            if (!current) return createUntranslatedUnit(sourceUnitRaw, eol);

            // Parsed units retain only XML offsets. Materialize the two trans-unit blocks
            // from their owning documents only while this synchronization step needs them.
            const currentUnitRaw = getUnitRaw(resultText, current);

            // The generated .g.xlf is authoritative for source-side metadata. Mirror
            // Developer and Xliff Generator notes independently while translations,
            // review/NAB notes, provenance and other AL.XliffStudio metadata stay intact.
            const developerNoteSync = synchronizeNotesByFrom(currentUnitRaw, sourceUnitRaw, 'Developer', eol);
            if (developerNoteSync.changed) synchronizedDeveloperNotes++;
            const generatorNoteSync = synchronizeNotesByFrom(developerNoteSync.text, sourceUnitRaw, 'Xliff Generator', eol);
            if (generatorNoteSync.changed) synchronizedGeneratorNotes++;
            return generatorNoteSync.text;
        });

    // The generator is authoritative for which trans-units still belong in a
    // translation XLIFF. Units missing from the generator (for example because
    // an AL symbol was deleted or changed to Locked = true) are therefore
    // removed here. The pre-sync XLIFF is merged into the companion .lng by the
    // callers before the synchronized XLIFF is written, so confirmed targets
    // from these removed units remain available as translation memory.
    resultText = replaceTranslationUnitSequence(resultText, orderedCurrentUnits);

    const addedUnits = missingUnits.length;

    return {
        text: resultText,
        synchronizedSources,
        flaggedTargets,
        addedUnits,
        synchronizedDeveloperNotes,
        synchronizedGeneratorNotes,
        removedUnits: removedUnits.map(unit => ({ id: unit.id, source: unit.source, target: unit.target, targetState: unit.targetState }))
    };
}

function synchronizeNotesByFrom(targetUnitRaw, sourceUnitRaw, fromValue, eol = String(targetUnitRaw || '').includes('\r\n') ? '\r\n' : '\n') {
    const targetRaw = String(targetUnitRaw || '');
    const sourceRaw = String(sourceUnitRaw || '');
    const wantedFrom = String(fromValue || '').trim().toLowerCase();
    if (!wantedFrom) return { text: targetRaw, changed: false };

    const desiredNotes = extractNotesByFrom(sourceRaw, wantedFrom);
    const currentNotes = extractNotesByFrom(targetRaw, wantedFrom);
    const currentSignature = currentNotes.map(note => normalizeNoteForComparison(note.raw));
    const desiredSignature = desiredNotes.map(note => normalizeNoteForComparison(note.raw));
    if (currentSignature.length === desiredSignature.length
        && currentSignature.every((value, index) => value === desiredSignature[index])) {
        return { text: targetRaw, changed: false };
    }

    if (currentNotes.length && desiredNotes.length) {
        // Retain matching notes in their slots even when the generator lists
        // them in another order. Only unmatched contents need replacement.
        const remaining = desiredNotes.slice();
        const replacements = currentNotes.map(current => {
            const index = remaining.findIndex(note => normalizeNoteForComparison(note.raw) === normalizeNoteForComparison(current.raw));
            return index < 0 ? undefined : remaining.splice(index, 1)[0];
        });
        for (let index = 0; index < replacements.length; index++) {
            if (!replacements[index]) replacements[index] = remaining.shift();
        }
        let updated = targetRaw;
        for (let index = currentNotes.length - 1; index >= 0; index--) {
            const current = currentNotes[index], desired = replacements[index];
            const linePrefix = targetRaw.slice(targetRaw.lastIndexOf('\n', current.index - 1) + 1, current.index);
            const indent = /^[ \t]*$/.test(linePrefix) ? linePrefix : detectUnitChildIndent(targetRaw);
            let replacement = desired ? reindentXmlBlock(preserveEmptyNoteForm(desired.raw, current.raw), indent, eol).slice(indent.length) : '';
            if (desired && normalizeNoteForComparison(desired.raw) === normalizeNoteForComparison(current.raw)) replacement = current.raw;
            if (index === currentNotes.length - 1 && remaining.length) {
                const multiline = /\r?\n/.test(targetRaw);
                replacement += remaining.map(note => multiline ? eol + reindentXmlBlock(note.raw, indent, eol) : note.raw).join('');
            }
            updated = updated.slice(0, current.index) + replacement + updated.slice(current.index + current.raw.length);
        }
        return { text: updated, changed: updated !== targetRaw };
    }

    let updated = removeNotesByFrom(targetRaw, wantedFrom);
    if (!desiredNotes.length) return { text: updated, changed: updated !== targetRaw };

    const childIndent = detectUnitChildIndent(updated);
    const noteBlocks = desiredNotes
        .map((note, index) => reindentXmlBlock(preserveEmptyNoteForm(note.raw, currentNotes[index] && currentNotes[index].raw), childIndent, eol))
        .join(eol);
    const closing = updated.match(/(?:\r?\n)([ \t]*)<\/trans-unit>\s*$/i);
    if (closing && Number.isInteger(closing.index)) {
        const beforeClosing = updated.slice(0, closing.index).replace(/[ \t]+$/g, '');
        const closingText = updated.slice(closing.index);
        updated = `${beforeClosing}${eol}${noteBlocks}${closingText}`;
    } else {
        updated = updated.replace(/<\/trans-unit>/i, `${eol}${noteBlocks}${eol}</trans-unit>`);
    }

    return { text: updated, changed: updated !== targetRaw };
}

function extractNotesByFrom(unitRaw, wantedFrom) {
    const notes = [];
    const noteRe = /<note\b([^>]*?)(?:\/\s*>|>[\s\S]*?<\/note>)/gi;
    let match;
    while ((match = noteRe.exec(String(unitRaw || ''))) !== null) {
        if (readXmlAttribute(match[1], 'from').trim().toLowerCase() !== wantedFrom) continue;
        notes.push({ raw: match[0], index: match.index });
    }
    return notes;
}

function removeNotesByFrom(unitRaw, wantedFrom) {
    const noteRe = /(\r?\n)?([ \t]*)<note\b([^>]*?)(?:\/\s*>|>[\s\S]*?<\/note>)/gi;
    return String(unitRaw || '').replace(noteRe, (whole, leadingEol, indent, attrs) => {
        if (readXmlAttribute(attrs, 'from').trim().toLowerCase() !== wantedFrom) return whole;
        return '';
    });
}

function readXmlAttribute(attributes, name) {
    const escaped = String(name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = String(attributes || '').match(new RegExp(`\\b${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'));
    return match ? (match[1] !== undefined ? match[1] : match[2] || '') : '';
}

function emptyNoteParts(raw) {
    const match = String(raw || '').match(/^<note\b([^>]*?)(?:\/\s*>|>\s*<\/note>)$/i);
    return match ? { attributes:match[1], selfClosing:/\/\s*>$/.test(raw) } : undefined;
}

function preserveEmptyNoteForm(desiredRaw, currentRaw) {
    const desired = emptyNoteParts(desiredRaw), current = emptyNoteParts(currentRaw);
    if (!desired || !current) return desiredRaw;
    if (normalizeNoteForComparison(desiredRaw) === normalizeNoteForComparison(currentRaw)) return currentRaw;
    return `<note${desired.attributes}${current.selfClosing ? '/>' : '></note>'}`;
}

function normalizeNoteForComparison(noteRaw) {
    const empty = emptyNoteParts(noteRaw);
    if (empty) return `<note${empty.attributes.trimEnd()}></note>`;
    return String(noteRaw || '')
        .replace(/^<note\b([^>]*?)\/\s*>$/i, '<note$1></note>')
        .replace(/\r\n/g, '\n')
        .replace(/>\s+</g, '><')
        .trim();
}

function detectUnitChildIndent(unitRaw) {
    const match = String(unitRaw || '').match(/(?:^|\r?\n)([ \t]+)<(?:source|target|note)\b/i);
    return match ? match[1] : '  ';
}

function reindentXmlBlock(raw, indent, eol) {
    const lines = String(raw || '').trim().split(/\r?\n/);
    if (lines.length === 1) return `${indent}${lines[0].trimStart()}`;

    const continuation = lines.slice(1).filter(line => line.trim());
    const commonIndent = continuation.length
        ? Math.min(...continuation.map(line => (line.match(/^[ \t]*/) || [''])[0].length))
        : 0;
    return lines
        .map((line, index) => {
            const content = index === 0 ? line.trimStart() : line.slice(commonIndent);
            return `${indent}${content}`;
        })
        .join(eol);
}

function replaceTranslationUnitSequence(text, orderedUnitRaws) {
    const source = String(text || '');
    const unitRe = /<trans-unit\b[^>]*>[\s\S]*?<\/trans-unit>/gi;
    const matches = [...source.matchAll(unitRe)];
    if (!matches.length) {
        if (!orderedUnitRaws.length) return source;
        const eol = source.includes('\r\n') ? '\r\n' : '\n';
        const indent = detectTransUnitIndent(source);
        const insertion = orderedUnitRaws.map(raw => indentBlock(raw, indent, eol)).join(eol);
        if (/<\/group>/i.test(source)) {
            return source.replace(/([ \t]*)<\/group>/i, `${insertion}${eol}$1</group>`);
        }
        if (/<\/body>/i.test(source)) {
            return source.replace(/([ \t]*)<\/body>/i, `${insertion}${eol}$1</body>`);
        }
        throw new Error('Could not find </group> or </body> insertion point in translation XLIFF.');
    }

    const eol = source.includes('\r\n') ? '\r\n' : '\n';
    const indent = detectTransUnitIndent(source);
    const first = matches[0];
    const last = matches[matches.length - 1];
    const firstStart = first.index;
    const lastEnd = last.index + last[0].length;
    const firstLineStart = source.lastIndexOf('\n', Math.max(0, firstStart - 1)) + 1;
    const nextNewline = source.indexOf('\n', lastEnd);
    const lastLineEnd = nextNewline >= 0 ? nextNewline + 1 : lastEnd;

    // Only consume surrounding indentation/newlines, never inline XML wrappers.
    const beforeFirst = source.slice(firstLineStart, firstStart);
    const sequenceStart = /^[ \t]*$/.test(beforeFirst) ? firstLineStart
        : firstStart - (beforeFirst.match(/[ \t]*$/) || [''])[0].length;
    const sequenceEnd = /^[ \t\r\n]*$/.test(source.slice(lastEnd, lastLineEnd)) ? lastLineEnd : lastEnd;
    const prefix = source.slice(0, sequenceStart);
    const suffix = source.slice(sequenceEnd);
    const ordered = orderedUnitRaws
        .map(raw => indentBlock(raw, indent, eol))
        .join(eol);
    const trailingEol = ordered ? eol : '';
    return `${prefix}${ordered}${trailingEol}${suffix}`;
}

function createUntranslatedUnit(unitRaw, eol) {
    let result = String(unitRaw || '');
    result = result.replace(/\s*<target\b[^>]*>[\s\S]*?<\/target>\s*/i, eol);
    result = result.replace(/\s*<target\b[^>]*\/\s*>\s*/i, eol);

    const sourceRe = /(<source\b[^>]*>[\s\S]*?<\/source>)/i;
    const sourceMatch = result.match(sourceRe);
    if (!sourceMatch) return result;

    const beforeSource = result.slice(0, sourceMatch.index);
    const lineIndentMatch = beforeSource.match(/(?:^|\r?\n)([ \t]*)$/);
    const sourceIndent = lineIndentMatch ? lineIndentMatch[1] : '  ';
    return result.replace(sourceRe, `$1${eol}${sourceIndent}<target state="needs-translation"/>`);
}

function detectTransUnitIndent(text) {
    const match = String(text || '').match(/(?:^|\r?\n)([ \t]*)<trans-unit\b/i);
    return match ? match[1] : '        ';
}

function indentBlock(block, indent, eol) {
    return String(block || '')
        .replace(/^\s*/, '')
        .split(/\r?\n/)
        .map((line, index) => index === 0 ? `${indent}${line}` : line)
        .join(eol);
}

module.exports = {
    synchronizeTranslationUnits,
    synchronizeNotesByFrom,
    replaceTranslationUnitSequence,
    createUntranslatedUnit,
    detectTransUnitIndent
};
