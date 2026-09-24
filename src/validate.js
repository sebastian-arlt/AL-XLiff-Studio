'use strict';

// Duplicate trans-unit ids corrupt id-based matching (BC.SyncXlf parity check).
function findDuplicateIds(parsed) {
    const seen = new Map();
    const duplicates = new Set();
    for (const unit of parsed.units) {
        if (!unit.id) continue;
        if (seen.has(unit.id)) {
            duplicates.add(unit.id);
        } else {
            seen.set(unit.id, unit);
        }
    }
    return [...duplicates];
}

// Duplicate "Xliff Generator" notes mean two trans-units describe the same
// generated object/property; BC tooling relies on this note being unique.
function findDuplicateGeneratorNotes(parsed) {
    const seen = new Map();
    const duplicates = new Set();
    for (const unit of parsed.units) {
        const generatorNote = (unit.noteDetails || []).find(note => String(note.from || '').trim().toLowerCase() === 'xliff generator');
        if (!generatorNote || !generatorNote.text) continue;
        if (seen.has(generatorNote.text)) {
            duplicates.add(generatorNote.text);
        } else {
            seen.set(generatorNote.text, unit);
        }
    }
    return [...duplicates];
}

// Flags trans-units whose target text is longer than the declared maxwidth.
function findMaxWidthViolations(parsed) {
    const violations = [];
    for (const unit of parsed.units) {
        if (!unit.maxWidth || !unit.target) continue;
        if (unit.target.length > unit.maxWidth) {
            violations.push({ id: unit.id, source: unit.source, length: unit.target.length, maxWidth: unit.maxWidth });
        }
    }
    return violations;
}

module.exports = {
    findDuplicateIds,
    findDuplicateGeneratorNotes,
    findMaxWidthViolations
};
