'use strict';

// Iterative single-row Levenshtein distance (no external dependency).
function levenshteinDistance(a, b) {
    const s = String(a || '');
    const t = String(b || '');
    if (s === t) return 0;
    if (!s.length) return t.length;
    if (!t.length) return s.length;

    let previousRow = new Array(t.length + 1);
    for (let j = 0; j <= t.length; j++) previousRow[j] = j;

    for (let i = 1; i <= s.length; i++) {
        const currentRow = new Array(t.length + 1);
        currentRow[0] = i;
        for (let j = 1; j <= t.length; j++) {
            const cost = s[i - 1] === t[j - 1] ? 0 : 1;
            currentRow[j] = Math.min(
                previousRow[j] + 1,
                currentRow[j - 1] + 1,
                previousRow[j - 1] + cost
            );
        }
        previousRow = currentRow;
    }
    return previousRow[t.length];
}

// Quality score 0-100, mirrors SyncXlf2's CalculateSimilarity.
function similarity(a, b) {
    const s = String(a || '');
    const t = String(b || '');
    if (!s.length || !t.length) return 0;
    if (s === t) return 100;
    const distance = levenshteinDistance(s, t);
    return Math.round((1 - distance / Math.max(s.length, t.length)) * 100);
}

// Finds the best-scoring translation-memory entry for sourceText that is not
// an exact match, above minQuality. Entries is an iterable of {source, translation}.
function findBestFuzzyMatch(sourceText, entries, minQuality = 80) {
    let best;
    for (const entry of entries) {
        if (!entry || !entry.source || !entry.translation) continue;
        if (entry.source === sourceText) continue;
        const quality = similarity(sourceText, entry.source);
        if (quality < minQuality) continue;
        if (!best || quality > best.quality) {
            best = { source: entry.source, translation: entry.translation, quality };
        }
    }
    return best;
}

module.exports = {
    levenshteinDistance,
    similarity,
    findBestFuzzyMatch
};
