'use strict';
const { getUnitIndex } = require('./unitIndex');

const {
    scanAlStringLiterals,
    propertyBeforeLiteral,
    extractAlContext,
    scoreUnitForContext,
    generatorNote,
    elementNameFromArguments
 } = require('./alHoverCore');

const GENERATOR_OBJECT_TYPES = [
    'TableExtension', 'PageExtension', 'ReportExtension', 'EnumExtension', 'PermissionSetExtension',
    'Table', 'Page', 'Report', 'Codeunit', 'Query', 'XmlPort', 'Enum', 'Interface', 'Profile', 'ControlAddIn'
];
const GENERATOR_SEGMENT_TYPES = [
    'Field', 'Action', 'Control', 'Method', 'NamedType', 'Property', 'EnumValue', 'ReportDataItem', 'Change'
];
const GENERATOR_SEGMENT_PATTERN = GENERATOR_SEGMENT_TYPES.join('|');
const AL_OBJECT_DECLARATION_RE = /^\s*(tableextension|pageextension|reportextension|enumextension|permissionsetextension|table|page|report|codeunit|query|xmlport|enum|interface|profile|controladdin)\s+(?:\d+\s+)?(?:"([^"]+)"|([^\s{]+))/i;
const AL_ELEMENT_DECLARATION_RE = /^\s*(field|action|group|repeater|cuegroup|fixed|grid|part|systempart|area|column|dataitem|enumvalue|value|modify)\s*\(([^)]*)\)/i;
const AL_METHOD_DECLARATION_RE = /^\s*(?:(?:local|internal|protected)\s+)?procedure\s+(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))\s*\(|^\s*trigger\s+(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))\s*\(/i;

function findAlSourceCandidates(text, unit, matchOriginOnly = false) {
    const source = String(unit && unit.source || '');
    if (!source && !matchOriginOnly) return [];
    const input = String(text || '');
    const lines = input.split(/\r?\n/);
    const candidates = [];

    // Normal AL translatable properties and Labels are represented by single-quoted
    // string literals. Keep this exact path as the highest-confidence match.
    const encodedNeedle = `'${source.replace(/'/g, "''")}'`;
    if (matchOriginOnly || input.includes(encodedNeedle)) {
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
            const line = lines[lineIndex];
            const literals = scanAlStringLiterals(line);
            for (const literal of literals) {
                if (!matchOriginOnly && literal.value !== source) continue;
                const property = propertyBeforeLiteral(line, literal.start);
                if (!property) continue;
                const labelName = /^label$/i.test(property) ? labelNameBeforeLiteral(line, literal.start) : '';
                const context = extractAlContext(lines, lineIndex, { property, labelName });
                candidates.push({
                    line: lineIndex,
                    endLine: lineIndex,
                    startCharacter: literal.start,
                    endCharacter: literal.end,
                    score: scoreUnitForContext(unit, context),
                    property,
                    labelName,
                    context,
                    lineText: line.trim()
                });
            }
        }
    }

    // Properties named by the Xliff Generator are authoritative even when they
    // are not part of the small standard set used by hover detection (for example
    // EntityCaption, EntitySetCaption or RequestFilterHeading).
    const hintedProperty = propertyFromGeneratorNote(unit);
    if (hintedProperty) {
        for (const candidate of findHintedPropertyLiteralCandidates(input, matchOriginOnly ? undefined : source, hintedProperty, lines)) {
            candidates.push(candidate);
        }
    }

    // The AL compiler emits some list-valued source texts in XLIFF using square
    // brackets although the AL source itself is not a string literal. The most
    // common case is e.g.
    //   XLIFF: [ ,Released,Blocked]
    //   AL:    OptionMembers = " ",Released,Blocked;
    // Use the Xliff Generator property hint when available so the fallback also
    // works for equivalent list-valued properties without broad fuzzy matching.
    const expectedList = parseBracketedSourceList(source);
    if (expectedList) {
        const properties = uniqueCaseInsensitive([hintedProperty, 'OptionMembers'].filter(Boolean));
        for (const property of properties) {
            for (const assignment of findAlListAssignments(input, property)) {
                const actualList = parseAlListValue(assignment.value);
                if (!sameNormalizedList(expectedList, actualList)) continue;
                const startPos = positionAtOffset(input, assignment.valueStart);
                const endPos = positionAtOffset(input, assignment.valueEnd);
                const context = extractAlContext(lines, startPos.line, { property, labelName: '' });
                candidates.push({
                    line: startPos.line,
                    endLine: endPos.line,
                    startCharacter: startPos.character,
                    endCharacter: endPos.character,
                    score: scoreUnitForContext(unit, context) + 24,
                    property,
                    labelName: '',
                    context,
                    lineText: assignment.text.replace(/\s+/g, ' ').trim()
                });
            }
        }
    }

    return deduplicateCandidates(candidates);
}

function parseGeneratorOrigin(unit) {
    const note = String(generatorNote(unit) || '').trim();
    if (!note) return undefined;
    const objectTypes = GENERATOR_OBJECT_TYPES.map(escapeRegExp).join('|');
    const objectRe = new RegExp(`^(${objectTypes})\\s+([\\s\\S]+?)(?=\\s+-\\s+(?:${GENERATOR_SEGMENT_PATTERN})\\b|$)`, 'i');
    const objectMatch = note.match(objectRe);
    if (!objectMatch) return undefined;

    const origin = {
        raw: note,
        objectType: canonicalGeneratorType(objectMatch[1]),
        objectName: String(objectMatch[2] || '').trim(),
        hierarchy: [],
        property: ''
    };
    const rest = note.slice(objectMatch[0].length);
    const segmentRe = new RegExp(`\\s+-\\s+(${GENERATOR_SEGMENT_PATTERN})\\s+([\\s\\S]*?)(?=\\s+-\\s+(?:${GENERATOR_SEGMENT_PATTERN})\\b|$)`, 'gi');
    let match;
    while ((match = segmentRe.exec(rest)) !== null) {
        const type = canonicalGeneratorType(match[1]);
        const name = String(match[2] || '').trim();
        if (!name) continue;
        if (type === 'Property') origin.property = name;
        else origin.hierarchy.push({ type, name });
    }
    return origin;
}


function withGeneratorOriginFromCompanion(unit, generatorParsed) {
    if (parseGeneratorOrigin(unit)) return unit;
    const id = String(unit && unit.id || '');
    if (!id) return unit;
    const matches = generatorParsed ? (getUnitIndex(generatorParsed).byId.get(id) || []) : [];
    if (matches.length !== 1) return unit;
    const generatorUnit = matches[0];
    if (!parseGeneratorOrigin(generatorUnit)) return unit;

    const existingNotes = Array.isArray(unit && unit.noteDetails) ? unit.noteDetails : [];
    const generatorNotes = (generatorUnit.noteDetails || []).filter(note =>
        String(note && note.from || '').trim().toLowerCase() === 'xliff generator'
    );
    return {
        ...unit,
        source: String(generatorUnit.source == null ? (unit && unit.source || '') : generatorUnit.source),
        noteDetails: existingNotes
            .filter(note => String(note && note.from || '').trim().toLowerCase() !== 'xliff generator')
            .concat(generatorNotes)
    };
}

function findExactAlOriginCandidates(text, unit) {
    const origin = parseGeneratorOrigin(unit);
    if (!origin) return [];
    const input = maskAlComments(String(text || ''));
    const lines = input.split(/\r?\n/);
    const objectRanges = findMatchingObjectRanges(lines, origin);
    if (!objectRanges.length) return [];

    const all = findAlSourceCandidates(input, unit, true);
    if (sameName(origin.property, 'OptionMembers')) {
        for (const assignment of findAlListAssignments(input, origin.property)) {
            const start = positionAtOffset(input, assignment.valueStart);
            const end = positionAtOffset(input, assignment.valueEnd);
            all.push({ line: start.line, endLine: end.line, startCharacter: start.character, endCharacter: end.character, property: origin.property, labelName: '', lineText: assignment.text.trim(), score: 100 });
        }
    }
    if (origin.hierarchy.some(segment => segment.type === 'NamedType')) {
        const labels = /(?:"((?:""|[^"])*)"|([A-Za-z_][A-Za-z0-9_]*))\s*:\s*Label\s*('(?:''|[^'])*')/gi;
        let match;
        while ((match = labels.exec(input))) {
            const offset = match.index + match[0].lastIndexOf(match[3]);
            const start = positionAtOffset(input, offset), end = positionAtOffset(input, offset + match[3].length);
            all.push({ line: start.line, endLine: end.line, startCharacter: start.character, endCharacter: end.character, property: 'Label', labelName: (match[1] || match[2]).replace(/""/g, '"'), lineText: match[0].trim(), score: 100 });
        }
    }
    const exact = deduplicateCandidates(all.filter(candidate => objectRanges.some(range =>
        candidate.line >= range.startLine && candidate.line <= range.endLine &&
        candidateMatchesOrigin(lines, candidate, origin, range)
    )));
    // AL also emits default captions for declarations without an explicit Caption.
    if (!exact.length && sameName(origin.property, 'Caption')) {
        for (const range of objectRanges) {
            const owners = origin.hierarchy.length ? origin.hierarchy.at(-1) : undefined;
            for (let line = range.startLine; line <= range.endLine; line++) {
                const declaration = owners ? lines[line].match(AL_ELEMENT_DECLARATION_RE) : line === range.startLine ? lines[line].match(AL_OBJECT_DECLARATION_RE) : undefined;
                if (!declaration) continue;
                if (owners && (!elementTypeMatchesOrigin(declaration[1], owners.type) || !sameName(elementNameFromArguments(declaration[1].toLowerCase() === 'value' ? 'enumvalue' : declaration[1].toLowerCase(), declaration[2]), owners.name))) continue;
                const candidate = { line, endLine: line, startCharacter: lines[line].search(/\S/), endCharacter: lines[line].length, property: 'Caption', labelName: '', lineText: lines[line].trim(), score: 100 };
                if (candidateMatchesOrigin(lines, candidate, origin, range)) exact.push(candidate);
            }
        }
    }
    return exact.map(candidate => ({ ...candidate, originExact: true, origin }));
}

// Preserve offsets/newlines while excluding commented-out declarations and properties.
function maskAlComments(text) {
    let mode = '', result = '';
    for (let i = 0; i < text.length; i++) {
        const ch = text[i], next = text[i + 1];
        if (mode === 'line' || mode === 'block') {
            if (mode === 'block' && ch === '*' && next === '/') { result += '  '; i++; mode = ''; }
            else { result += /[\r\n]/.test(ch) ? ch : ' '; if (mode === 'line' && ch === '\n') mode = ''; }
        } else if (mode === "'" || mode === '"') {
            result += ch;
            if (ch === mode) { if (next === mode) { result += next; i++; } else mode = ''; }
        } else if (ch === '/' && (next === '/' || next === '*')) { mode = next === '/' ? 'line' : 'block'; result += '  '; i++; }
        else { result += ch; if (ch === "'" || ch === '"') mode = ch; }
    }
    return result;
}

function candidateMatchesOrigin(lines, candidate, origin, objectRange) {
    if (origin.property && !sameName(candidate.property, origin.property)) return false;
    // An object Property belongs to the object itself, never to a nested field/action.
    if (!origin.hierarchy.length) {
        for (let line = objectRange.startLine + 1; line <= candidate.line; line++) {
            if (AL_ELEMENT_DECLARATION_RE.test(lines[line]) && candidate.line <= findDeclarationBlockEnd(lines, line)) return false;
        }
    }
    for (const segment of origin.hierarchy) {
        if (segment.type === 'NamedType') {
            if (!sameName(candidate.labelName, segment.name)) return false;
            continue;
        }
        if (segment.type === 'Method') {
            if (!candidateInsideNamedMethod(lines, candidate.line, objectRange, segment.name)) return false;
            continue;
        }
        if (!candidateInsideNamedElement(lines, candidate.line, objectRange, segment)) return false;
    }
    return true;
}

function findMatchingObjectRanges(lines, origin) {
    const result = [];
    for (let line = 0; line < lines.length; line++) {
        const match = String(lines[line] || '').match(AL_OBJECT_DECLARATION_RE);
        if (!match) continue;
        // Permission entries such as table "Name" = X are references, not declarations.
        if (!/^(?:\s*\{|\s*(?:extends|implements|customizes)\b|\s*$)/i.test(lines[line].slice(match[0].length))) continue;
        const type = canonicalGeneratorType(match[1]);
        const name = cleanAlIdentifier(match[2] || match[3] || '');
        if (!sameName(type, origin.objectType) || !sameName(name, origin.objectName)) continue;
        const endLine = findDeclarationBlockEnd(lines, line);
        result.push({ startLine: line, endLine });
    }
    return result;
}

function candidateInsideNamedElement(lines, candidateLine, objectRange, segment) {
    const expectedName = String(segment.name || '');
    for (let line = objectRange.startLine + 1; line <= Math.min(candidateLine, objectRange.endLine); line++) {
        const match = String(lines[line] || '').match(AL_ELEMENT_DECLARATION_RE);
        if (!match) continue;
        const alType = String(match[1] || '').toLowerCase() === 'value' ? 'enumvalue' : String(match[1] || '').toLowerCase();
        const name = elementNameFromArguments(alType, match[2]);
        if (!sameName(name, expectedName) || !elementTypeMatchesOrigin(alType, segment.type)) continue;
        const endLine = findDeclarationBlockEnd(lines, line);
        if (candidateLine >= line && candidateLine <= endLine) return true;
    }
    return false;
}

function candidateInsideNamedMethod(lines, candidateLine, objectRange, expectedName) {
    // AL procedures/triggers are delimited by begin/end rather than braces. The
    // nearest procedure/trigger declaration above the label is therefore the
    // reliable method owner; a later method declaration supersedes an earlier one.
    let nearestMethod = '';
    for (let line = objectRange.startLine + 1; line <= Math.min(candidateLine, objectRange.endLine); line++) {
        const match = String(lines[line] || '').match(AL_METHOD_DECLARATION_RE);
        if (!match) continue;
        nearestMethod = cleanAlIdentifier(match[1] || match[2] || match[3] || match[4] || '');
    }
    return sameName(nearestMethod, expectedName);
}

function elementTypeMatchesOrigin(alType, originType) {
    const expected = String(originType || '').toLowerCase();
    const actual = String(alType || '').toLowerCase();
    if (expected === 'control') return ['field', 'group', 'repeater', 'cuegroup', 'fixed', 'grid', 'part', 'systempart', 'area', 'column'].includes(actual);
    if (expected === 'reportdataitem') return actual === 'dataitem';
    if (expected === 'change') return actual === 'modify';
    if (expected === 'enumvalue') return actual === 'enumvalue';
    return actual === expected;
}

function findDeclarationBlockEnd(lines, declarationLine) {
    let depth = 0;
    let opened = false;
    let inBlockComment = false;
    for (let line = declarationLine; line < lines.length; line++) {
        const scan = braceDelta(String(lines[line] || ''), inBlockComment);
        inBlockComment = scan.inBlockComment;
        if (scan.opens > 0) opened = true;
        depth += scan.opens - scan.closes;
        if (opened && depth <= 0) return line;
    }
    return lines.length - 1;
}

function braceDelta(line, initialBlockComment) {
    let opens = 0;
    let closes = 0;
    let inString = false;
    let inQuotedIdentifier = false;
    let inBlockComment = Boolean(initialBlockComment);
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        const next = line[i + 1];
        if (inBlockComment) {
            if (ch === '*' && next === '/') { inBlockComment = false; i++; }
            continue;
        }
        if (inString) {
            if (ch === "'") {
                if (next === "'") i++;
                else inString = false;
            }
            continue;
        }
        if (inQuotedIdentifier) {
            if (ch === '"') {
                if (next === '"') i++;
                else inQuotedIdentifier = false;
            }
            continue;
        }
        if (ch === '/' && next === '/') break;
        if (ch === '/' && next === '*') { inBlockComment = true; i++; continue; }
        if (ch === "'") { inString = true; continue; }
        if (ch === '"') { inQuotedIdentifier = true; continue; }
        if (ch === '{') opens++;
        else if (ch === '}') closes++;
    }
    return { opens, closes, inBlockComment };
}

function findHintedPropertyLiteralCandidates(input, source, property, lines) {
    const escaped = escapeRegExp(property);
    const re = new RegExp(`\\b${escaped}\\s*=\\s*('(?:''|[^'])*')`, 'gi');
    const result = [];
    let match;
    while ((match = re.exec(input)) !== null) {
        const raw = match[1];
        const value = raw.slice(1, -1).replace(/''/g, "'");
        if (source !== undefined && value !== source) continue;
        const literalOffset = match.index + match[0].lastIndexOf(raw);
        const start = positionAtOffset(input, literalOffset);
        const end = positionAtOffset(input, literalOffset + raw.length);
        const context = extractAlContext(lines, start.line, { property, labelName: '' });
        result.push({
            line: start.line,
            endLine: end.line,
            startCharacter: start.character,
            endCharacter: end.character,
            score: scoreUnitForContext({ source, noteDetails: [] }, context),
            property,
            labelName: '',
            context,
            lineText: match[0].replace(/\s+/g, ' ').trim()
        });
    }
    return result;
}

function createFallbackSourceSearchQuery(unit) {
    const source = String(unit && unit.source || '').trim();
    const list = parseBracketedSourceList(source);
    if (list) {
        const originalMembers = splitCommaList(source.slice(1, -1)).map(value => normalizeSearchMember(value)).filter(Boolean);
        if (originalMembers.length) return originalMembers[0];
        const property = propertyFromGeneratorNote(unit);
        if (property) return property;
    }
    return source.replace(/'/g, "''");
}

function normalizeSearchMember(value) {
    let text = String(value == null ? '' : value).trim();
    if (text.length >= 2 && ((text[0] === '"' && text[text.length - 1] === '"') || (text[0] === "'" && text[text.length - 1] === "'"))) {
        text = text.slice(1, -1).trim();
    }
    return text;
}

function canonicalGeneratorType(value) {
    const text = String(value || '').trim().toLowerCase();
    const map = {
        tableextension: 'TableExtension', pageextension: 'PageExtension', reportextension: 'ReportExtension',
        enumextension: 'EnumExtension', permissionsetextension: 'PermissionSetExtension', controladdin: 'ControlAddIn',
        xmlport: 'XmlPort', reportdataitem: 'ReportDataItem', enumvalue: 'EnumValue', namedtype: 'NamedType'
    };
    if (map[text]) return map[text];
    return text ? text[0].toUpperCase() + text.slice(1) : '';
}

function cleanAlIdentifier(value) {
    return String(value || '').trim().replace(/^"|"$/g, '').replace(/""/g, '"').trim();
}

function sameName(a, b) {
    return String(a || '').trim().toLocaleLowerCase() === String(b || '').trim().toLocaleLowerCase();
}

function propertyFromGeneratorNote(unit) {
    const note = generatorNote(unit);
    const match = String(note || '').match(/\bProperty\s+(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/i);
    return match ? String(match[1] || match[2] || '') : '';
}

function parseBracketedSourceList(value) {
    const text = String(value || '').trim();
    if (text.length < 2 || text[0] !== '[' || text[text.length - 1] !== ']') return undefined;
    return splitCommaList(text.slice(1, -1)).map(normalizeListMember);
}

function parseAlListValue(value) {
    return splitCommaList(String(value || '')).map(normalizeListMember);
}

function splitCommaList(value) {
    const text = String(value || '');
    const items = [];
    let current = '';
    let inDouble = false;
    let inSingle = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inDouble) {
            current += ch;
            if (ch === '"') {
                if (text[i + 1] === '"') current += text[++i];
                else inDouble = false;
            }
            continue;
        }
        if (inSingle) {
            current += ch;
            if (ch === "'") {
                if (text[i + 1] === "'") current += text[++i];
                else inSingle = false;
            }
            continue;
        }
        if (ch === '"') { inDouble = true; current += ch; continue; }
        if (ch === "'") { inSingle = true; current += ch; continue; }
        if (ch === ',') { items.push(current); current = ''; continue; }
        current += ch;
    }
    items.push(current);
    return items;
}

function normalizeListMember(value) {
    let text = String(value == null ? '' : value).trim();
    if (text.length >= 2 && text[0] === '"' && text[text.length - 1] === '"') {
        text = text.slice(1, -1).replace(/""/g, '"').trim();
    } else if (text.length >= 2 && text[0] === "'" && text[text.length - 1] === "'") {
        text = text.slice(1, -1).replace(/''/g, "'").trim();
    }
    return text.toLocaleLowerCase();
}

function sameNormalizedList(expected, actual) {
    if (!Array.isArray(expected) || !Array.isArray(actual) || expected.length !== actual.length) return false;
    return expected.every((item, index) => item === actual[index]);
}

function findAlListAssignments(text, property) {
    const input = String(text || '');
    const escaped = escapeRegExp(property);
    const re = new RegExp(`\\b${escaped}\\s*=`, 'gi');
    const result = [];
    let match;
    while ((match = re.exec(input)) !== null) {
        let valueStart = re.lastIndex;
        while (valueStart < input.length && /\s/.test(input[valueStart])) valueStart++;
        let i = valueStart;
        let inDouble = false;
        let inSingle = false;
        for (; i < input.length; i++) {
            const ch = input[i];
            if (inDouble) {
                if (ch === '"') {
                    if (input[i + 1] === '"') i++;
                    else inDouble = false;
                }
                continue;
            }
            if (inSingle) {
                if (ch === "'") {
                    if (input[i + 1] === "'") i++;
                    else inSingle = false;
                }
                continue;
            }
            if (ch === '"') { inDouble = true; continue; }
            if (ch === "'") { inSingle = true; continue; }
            if (ch === ';') break;
        }
        if (i >= input.length) break;
        let valueEnd = i;
        while (valueEnd > valueStart && /\s/.test(input[valueEnd - 1])) valueEnd--;
        result.push({
            property,
            valueStart,
            valueEnd,
            value: input.slice(valueStart, valueEnd),
            text: input.slice(match.index, i + 1)
        });
        re.lastIndex = i + 1;
    }
    return result;
}

function positionAtOffset(text, offset) {
    const input = String(text || '');
    const safe = Math.max(0, Math.min(Number(offset) || 0, input.length));
    let line = 0;
    let lineStart = 0;
    for (let i = 0; i < safe; i++) {
        if (input.charCodeAt(i) === 10) { line++; lineStart = i + 1; }
    }
    return { line, character: safe - lineStart };
}

function uniqueCaseInsensitive(values) {
    const seen = new Set();
    return values.filter(value => {
        const key = String(value || '').toLocaleLowerCase();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function deduplicateCandidates(candidates) {
    const seen = new Set();
    return candidates.filter(candidate => {
        const key = [candidate.line, candidate.endLine, candidate.startCharacter, candidate.endCharacter, String(candidate.property || '').toLocaleLowerCase()].join(':');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function escapeRegExp(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function labelNameBeforeLiteral(line, literalStart) {
    const before = String(line || '').slice(0, Math.max(0, literalStart));
    const match = before.match(/(?:^|\b)("[^"]+"|[A-Za-z_][A-Za-z0-9_]*)\s*:\s*Label\s*$/i);
    return match ? String(match[1] || '').replace(/^"|"$/g, '') : '';
}

function findXliffUnitLocation(text, ordinal) {
    if (!Number.isInteger(ordinal) || ordinal < 0) return undefined;
    const input = String(text || '');
    const unitRe = /<trans-unit\b[^>]*>[\s\S]*?<\/trans-unit>/gi;
    let parsedOrdinal = 0;
    let match;
    while ((match = unitRe.exec(input)) !== null) {
        if (!/<source\b[^>]*>[\s\S]*?<\/source>/i.test(match[0])) continue;
        if (parsedOrdinal++ !== ordinal) continue;
        const openTag = match[0].match(/^<trans-unit\b[^>]*>/i);
        const start = match.index;
        const end = start + (openTag ? openTag[0].length : '<trans-unit'.length);
        return { start, end };
    }
    return undefined;
}

function compareSourceCandidates(a, b) {
    return Number(b && b.score || 0) - Number(a && a.score || 0) ||
        String(a && a.filePath || '').localeCompare(String(b && b.filePath || '')) ||
        Number(a && a.line || 0) - Number(b && b.line || 0) ||
        Number(a && a.startCharacter || 0) - Number(b && b.startCharacter || 0);
}

function hasUniqueBestCandidate(candidates) {
    const sorted = (Array.isArray(candidates) ? candidates.slice() : []).sort(compareSourceCandidates);
    if (!sorted.length) return false;
    if (sorted.length === 1) return true;
    return Number(sorted[0].score || 0) > Number(sorted[1].score || 0);
}

module.exports = {
    findAlSourceCandidates,
    findExactAlOriginCandidates,
    parseGeneratorOrigin,
    withGeneratorOriginFromCompanion,
    createFallbackSourceSearchQuery,
    findXliffUnitLocation,
    compareSourceCandidates,
    hasUniqueBestCandidate,
    labelNameBeforeLiteral
};
