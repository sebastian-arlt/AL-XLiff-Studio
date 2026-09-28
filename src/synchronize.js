'use strict';

const { parseXliff, detectSourceChanges, flagSourceChangedUnits } = require('./xliff');
const { findDuplicateIds } = require('./validate');

function normalizeLanguage(value) {
    return String(value || '').trim().replace(/_/g, '-').toLowerCase();
}

/**
 * Synchronizes a translated XLIFF against its generated *.g.xlf companion.
 *
 * Safe/non-destructive rules:
 * - existing target texts are preserved;
 * - changed source text is updated from the generator and an existing target is
 *   flagged needs-l10n via flagSourceChangedUnits;
 * - generator trans-units missing in the translation file are created with an
 *   empty needs-translation target;
 * - all current trans-units are ordered exactly like the generated *.g.xlf;
 * - translation units that no longer exist in the generator are reported and
 *   kept after the current generator units, preserving their relative order.
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
    const obsoleteUnits = afterSourceSync.units.filter(unit => unit.id && !sourceIds.has(unit.id));

    // Rebuild the trans-unit sequence in generator order.  This mirrors the
    // ordering produced by the established XLIFF synchronization workflow and
    // avoids the previous behaviour where newly discovered units were simply
    // appended to the end of the target file. Existing target units keep their
    // complete raw XML (including translations/review notes). Missing units are
    // created from the generator unit at the exact generator position.
    const eol = resultText.includes('\r\n') ? '\r\n' : '\n';
    const currentById = new Map(afterSourceSync.units.filter(unit => unit.id).map(unit => [unit.id, unit]));
    const orderedCurrentUnits = sourceParsed.units
        .filter(unit => unit.id)
        .map(unit => {
            const current = currentById.get(unit.id);
            return current ? current.raw : createUntranslatedUnit(unit.raw, eol);
        });

    // Keep obsolete units for the extension's existing non-destructive sync
    // semantics, but move them behind all current generator units. Their
    // relative order in the translation file is preserved.
    const orderedObsoleteUnits = obsoleteUnits.map(unit => unit.raw);
    resultText = replaceTranslationUnitSequence(resultText, [...orderedCurrentUnits, ...orderedObsoleteUnits]);

    const addedUnits = missingUnits.length;

    return {
        text: resultText,
        synchronizedSources,
        flaggedTargets,
        addedUnits,
        obsoleteUnits: obsoleteUnits.map(unit => ({ id: unit.id, source: unit.source }))
    };
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

    const prefix = source.slice(0, firstLineStart);
    const suffix = source.slice(lastLineEnd);
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
    replaceTranslationUnitSequence,
    createUntranslatedUnit,
    detectTransUnitIndent
};
