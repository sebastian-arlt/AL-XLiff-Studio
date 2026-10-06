'use strict';
const { parseXliff, translatedPairs } = require('./xliff');
const { mergeEntries } = require('./lng');

function translationMemorySnapshots(texts) {
    return texts.map(text => {
        const pairs = translatedPairs(parseXliff(String(text || '')), { treatNeedsTranslationAsMissing: true });
        return { entries: pairs.entries, conflictCount: pairs.conflicts.length };
    });
}

function mergeTranslationMemorySnapshots(existingEntries, snapshots) {
    let entries = Array.isArray(existingEntries) ? existingEntries.slice() : [];
    let pairCount = 0, conflictCount = 0;
    for (const snapshot of snapshots) {
        const merged = mergeEntries(entries, snapshot.entries, { overwrite: true });
        entries = merged.entries;
        pairCount += snapshot.entries.length;
        conflictCount += snapshot.conflictCount + merged.conflicts.length;
    }
    return { entries, pairCount, conflictCount };
}

module.exports = { translationMemorySnapshots, mergeTranslationMemorySnapshots };
