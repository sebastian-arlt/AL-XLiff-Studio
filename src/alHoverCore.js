'use strict';

const TRANSLATABLE_PROPERTIES = new Set([
    'caption',
    'tooltip',
    'instructionaltext',
    'optioncaption',
    'promotedactioncategories',
    'additionalsearchterms'
]);

const OBJECT_DECLARATION_RE = /^\s*(tableextension|pageextension|reportextension|enumextension|permissionsetextension|table|page|report|codeunit|query|xmlport|enum|interface|profile|controladdin)\s+(?:\d+\s+)?(?:"([^"]+)"|([^\s{]+))/i;
const ELEMENT_DECLARATION_RE = /^\s*(field|action|group|repeater|cuegroup|fixed|grid|part|systempart|area|column|dataitem|enumvalue)\s*\(([^)]*)\)/i;

function scanAlStringLiterals(line) {
    const text = String(line || '');
    const literals = [];
    let i = 0;
    while (i < text.length) {
        if (text[i] !== "'") {
            i++;
            continue;
        }
        const start = i;
        i++;
        let value = '';
        let closed = false;
        while (i < text.length) {
            if (text[i] === "'") {
                if (text[i + 1] === "'") {
                    value += "'";
                    i += 2;
                    continue;
                }
                closed = true;
                i++;
                break;
            }
            value += text[i++];
        }
        if (closed) literals.push({ start, end: i, value, raw: text.slice(start, i) });
    }
    return literals;
}

function propertyBeforeLiteral(line, literalStart) {
    const before = String(line || '').slice(0, Math.max(0, literalStart));
    const propertyMatch = before.match(/\b(Caption|ToolTip|InstructionalText|OptionCaption|PromotedActionCategories|AdditionalSearchTerms)\s*=\s*$/i);
    if (propertyMatch) return propertyMatch[1];
    if (/\bLabel\s*$/i.test(before) || /:\s*Label\s*$/i.test(before)) return 'Label';
    return undefined;
}

function isLikelyTranslatableLiteral(line, literal) {
    if (!literal) return false;
    return Boolean(propertyBeforeLiteral(line, literal.start));
}

function wordAt(line, character) {
    const text = String(line || '');
    let start = Math.max(0, Math.min(character, text.length));
    let end = start;
    while (start > 0 && /[A-Za-z0-9_]/.test(text[start - 1])) start--;
    while (end < text.length && /[A-Za-z0-9_]/.test(text[end])) end++;
    if (start === end) return undefined;
    return { start, end, value: text.slice(start, end) };
}

function extractHoverTargetFromLine(line, character) {
    const literals = scanAlStringLiterals(line);
    const literal = literals.find(item => character >= item.start && character <= item.end);
    if (literal && isLikelyTranslatableLiteral(line, literal)) {
        return {
            source: literal.value,
            start: literal.start,
            end: literal.end,
            property: propertyBeforeLiteral(line, literal.start) || ''
        };
    }

    const word = wordAt(line, character);
    if (!word) return undefined;
    const escaped = escapeRegExp(word.value);
    const labelMatch = String(line || '').match(new RegExp(`\\b${escaped}\\b\\s*:\\s*Label\\s*('(?:''|[^'])*')`, 'i'));
    if (!labelMatch) return undefined;
    const labelLiteral = scanAlStringLiterals(labelMatch[0])[0];
    if (!labelLiteral) return undefined;
    return {
        source: labelLiteral.value,
        start: word.start,
        end: word.end,
        property: 'Label',
        labelName: word.value
    };
}

function extractAlContext(lines, currentLine, target = {}) {
    const input = Array.isArray(lines) ? lines : [];
    const context = {
        property: String(target.property || ''),
        labelName: String(target.labelName || ''),
        objectType: '',
        objectName: '',
        elementType: '',
        elementName: ''
    };

    let objectLine = -1;
    for (let i = Math.min(currentLine, input.length - 1); i >= 0; i--) {
        const match = String(input[i] || '').match(OBJECT_DECLARATION_RE);
        if (!match) continue;
        context.objectType = canonicalWord(match[1]);
        context.objectName = cleanAlName(match[2] || match[3] || '');
        objectLine = i;
        break;
    }

    const minLine = objectLine >= 0 ? objectLine + 1 : Math.max(0, currentLine - 80);
    for (let i = Math.min(currentLine, input.length - 1); i >= minLine; i--) {
        const match = String(input[i] || '').match(ELEMENT_DECLARATION_RE);
        if (!match) continue;
        context.elementType = canonicalWord(match[1]);
        context.elementName = elementNameFromArguments(match[1], match[2]);
        break;
    }

    return context;
}


function elementNameFromArguments(elementType, argsText) {
    const args = splitAlArguments(argsText);
    if (!args.length) return '';
    const type = String(elementType || '').trim().toLowerCase();
    if ((type === 'field' || type === 'enumvalue') && /^\d+$/.test(String(args[0] || '').trim()) && args.length > 1) {
        return cleanAlName(args[1]);
    }
    return cleanAlName(args[0]);
}

function splitAlArguments(value) {
    const text = String(value || '');
    const result = [];
    let current = '';
    let inString = false;
    let inQuotedIdentifier = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            current += ch;
            if (ch === "'") {
                if (text[i + 1] === "'") current += text[++i];
                else inString = false;
            }
            continue;
        }
        if (inQuotedIdentifier) {
            current += ch;
            if (ch === '"') inQuotedIdentifier = false;
            continue;
        }
        if (ch === "'") { inString = true; current += ch; continue; }
        if (ch === '"') { inQuotedIdentifier = true; current += ch; continue; }
        if (ch === ';') { result.push(current.trim()); current = ''; continue; }
        current += ch;
    }
    result.push(current.trim());
    return result.filter(Boolean);
}

function cleanAlName(value) {
    return String(value || '').trim().replace(/^"|"$/g, '').trim();
}

function canonicalWord(value) {
    const text = String(value || '').trim().toLowerCase();
    return text ? text[0].toUpperCase() + text.slice(1) : '';
}

function normalizeForMatch(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/["'`]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function generatorNote(unit) {
    const details = unit && Array.isArray(unit.noteDetails) ? unit.noteDetails : [];
    const note = details.find(item => String(item.from || '').trim().toLowerCase() === 'xliff generator');
    return note ? String(note.text || '') : '';
}

function scoreUnitForContext(unit, context = {}) {
    const note = generatorNote(unit);
    if (!note) return 0;
    const normalizedNote = normalizeForMatch(note);
    let score = 0;

    const objectName = normalizeForMatch(context.objectName);
    const objectType = normalizeForMatch(context.objectType);
    const elementName = normalizeForMatch(context.elementName);
    const elementType = normalizeForMatch(context.elementType);
    const property = normalizeForMatch(context.property);
    const labelName = normalizeForMatch(context.labelName);

    if (objectName && normalizedNote.includes(objectName)) score += 40;
    if (objectType && normalizedNote.includes(objectType)) score += 8;
    if (elementName && normalizedNote.includes(elementName)) score += 22;
    if (elementType && normalizedNote.includes(elementType)) score += 6;
    if (property && normalizedNote.includes(`property ${property}`)) score += 18;
    else if (property && normalizedNote.includes(property)) score += 5;
    if (labelName && normalizedNote.includes(labelName)) score += 12;

    return score;
}

function selectBestUnit(units, source, context = {}) {
    const candidates = (Array.isArray(units) ? units : []).filter(unit => unit && unit.source === source);
    if (!candidates.length) return { unit: undefined, matches: 0, ambiguous: false, score: 0 };
    if (candidates.length === 1) return { unit: candidates[0], matches: 1, ambiguous: false, score: scoreUnitForContext(candidates[0], context) };

    const scored = candidates.map(unit => ({ unit, score: scoreUnitForContext(unit, context) }))
        .sort((a, b) => b.score - a.score || Number(a.unit.ordinal || 0) - Number(b.unit.ordinal || 0));
    const best = scored[0];
    const second = scored[1];
    const ambiguous = best.score === second.score;
    return { unit: best.unit, matches: candidates.length, ambiguous, score: best.score };
}

function formatHoverTranslation(target, state) {
    const text = String(target || '');
    const normalizedState = String(state || '').trim();
    if (!text) return normalizedState ? `missing · ${normalizedState}` : 'missing';
    return normalizedState ? `${text} · ${normalizedState}` : text;
}

function escapeRegExp(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
    scanAlStringLiterals,
    propertyBeforeLiteral,
    extractHoverTargetFromLine,
    extractAlContext,
    normalizeForMatch,
    generatorNote,
    scoreUnitForContext,
    selectBestUnit,
    formatHoverTranslation,
    elementNameFromArguments
};
