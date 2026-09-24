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
        units.push({
            ordinal: ordinal++,
            id: getAttribute(unitAttrs, 'id') || '',
            source: decodeXmlEntities(stripXmlTags(sourceRaw)),
            sourceRaw,
            target: effectiveTargetMatch ? decodeXmlEntities(stripXmlTags(targetRaw)) : undefined,
            targetRaw,
            targetAttrs: effectiveTargetMatch ? effectiveTargetMatch[1] : '',
            targetState: effectiveTargetMatch ? getAttribute(effectiveTargetMatch[1], 'state') : undefined,
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

function isMissingTranslation(unit, treatNeedsTranslationAsMissing = true) {
    if (unit.target === undefined || unit.target.length === 0) {
        return true;
    }
    if (!treatNeedsTranslationAsMissing) {
        return false;
    }
    const state = (unit.targetState || '').toLowerCase();
    if (!state) return false;
    return !['translated', 'signed-off', 'final'].includes(state);
}

function translatedPairs(parsed, options = {}) {
    const treatNeedsTranslationAsMissing = options.treatNeedsTranslationAsMissing !== false;
    const bySource = new Map();
    const conflicts = [];

    for (const unit of parsed.units) {
        if (!unit.source || isMissingTranslation(unit, treatNeedsTranslationAsMissing) || !unit.target) {
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
        const unitTranslation = translationByOrdinal.get(ordinal);
        const sourceTranslation = translationBySource instanceof Map
            ? translationBySource.get(parsed.source)
            : undefined;
        const translation = typeof unitTranslation === 'string'
            ? unitTranslation
            : sourceTranslation;

        if (typeof translation !== 'string' || translation.length === 0) {
            return unitRaw;
        }
        updatedCount++;
        return setTarget(unitRaw, translation, eol, setTranslatedState);
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
    getDeveloperCommentTranslationForUnits
};
