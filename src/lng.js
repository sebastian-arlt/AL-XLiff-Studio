'use strict';

const HEADER = '# BC XLIFF Language Map v1';

function parseLng(text) {
    const entries = [];
    const seen = new Map();
    const errors = [];
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const trimmed = raw.trim();
        if (!trimmed || trimmed.startsWith('#')) {
            continue;
        }

        const tab = raw.indexOf('\t');
        if (tab < 0) {
            errors.push(`Line ${i + 1}: expected a TAB between source and translation.`);
            continue;
        }

        const left = raw.slice(0, tab).trim();
        const right = raw.slice(tab + 1).trim();
        try {
            const source = JSON.parse(left);
            const translation = JSON.parse(right);
            if (typeof source !== 'string' || typeof translation !== 'string') {
                throw new Error('both columns must be JSON strings');
            }
            if (!source) {
                errors.push(`Line ${i + 1}: source must not be empty.`);
                continue;
            }
            if (seen.has(source)) {
                errors.push(`Line ${i + 1}: duplicate source text: ${source}`);
                continue;
            }
            const entry = { source, translation };
            entries.push(entry);
            seen.set(source, entry);
        } catch (err) {
            errors.push(`Line ${i + 1}: ${err.message}`);
        }
    }

    return { entries, errors };
}

function serializeLng(entries, language) {
    const map = new Map();
    for (const entry of entries) {
        if (!entry || typeof entry.source !== 'string' || !entry.source) {
            continue;
        }
        if (!map.has(entry.source)) {
            map.set(entry.source, typeof entry.translation === 'string' ? entry.translation : '');
        }
    }

    const sorted = [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], 'en', { sensitivity: 'base' }));
    const lines = [
        HEADER,
        `# Language: ${language || 'unknown'}`,
        '# Format: JSON-escaped English source<TAB>JSON-escaped translation',
        '# The English source is the unique lookup key.',
        ''
    ];

    for (const [source, translation] of sorted) {
        lines.push(`${JSON.stringify(source)}\t${JSON.stringify(translation)}`);
    }
    lines.push('');
    return lines.join('\n');
}

function entriesToMap(entries) {
    const map = new Map();
    for (const entry of entries) {
        if (entry.source && !map.has(entry.source)) {
            map.set(entry.source, entry.translation || '');
        }
    }
    return map;
}

function mergeEntries(baseEntries, incomingEntries, options = {}) {
    const overwrite = options.overwrite !== false;
    const map = entriesToMap(baseEntries);
    const conflicts = [];

    for (const entry of incomingEntries) {
        if (!entry.source || !entry.translation) {
            continue;
        }
        if (map.has(entry.source) && map.get(entry.source) !== entry.translation) {
            conflicts.push({ source: entry.source, existing: map.get(entry.source), incoming: entry.translation });
            if (!overwrite) {
                continue;
            }
        }
        map.set(entry.source, entry.translation);
    }

    return {
        entries: [...map.entries()].map(([source, translation]) => ({ source, translation })),
        conflicts
    };
}

module.exports = {
    HEADER,
    parseLng,
    serializeLng,
    entriesToMap,
    mergeEntries
};
