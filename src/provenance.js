'use strict';
const { t } = require('./localization');

const { isStudioNoteFrom } = require('./identity');

const PROVENANCE_PREFIX = 'Provenance:';
const PROVENANCE_VERSION = 1;

const LABELS = {
    'developer-comment': 'Developer comment',
    'lng': '.lng',
    'glossary': 'Glossary',
    'fuzzy': 'Fuzzy',
    'ai': 'AI',
    'manual': 'Manual',
    'human-accepted': 'Human accepted',
    'status-confirmation': 'Status confirmation',
    'merge': 'XLIFF merge'
};

function createProvenance(origin, details = {}) {
    const normalizedOrigin = normalizeOrigin(origin);
    const event = {
        v: PROVENANCE_VERSION,
        at: details.at || new Date().toISOString(),
        origin: normalizedOrigin,
        action: details.action || 'draft'
    };

    if (details.scope) event.scope = String(details.scope);
    if (details.quality !== undefined && details.quality !== null && Number.isFinite(Number(details.quality))) {
        event.quality = Math.round(Number(details.quality));
    }
    if (details.matchedSource) event.matchedSource = String(details.matchedSource);
    if (details.term) event.term = String(details.term);
    if (details.previousState !== undefined) event.previousState = String(details.previousState || '');
    if (details.model && typeof details.model === 'object') {
        const model = compactModel(details.model);
        if (Object.keys(model).length) event.model = model;
    }
    if (details.basedOn && typeof details.basedOn === 'object') {
        event.basedOn = compactBasedOn(details.basedOn);
    }
    if (details.sourceFile) event.sourceFile = String(details.sourceFile);
    return event;
}

function normalizeOrigin(origin) {
    const value = String(origin || '').trim().toLowerCase();
    if (['comment', 'developer-comment', 'developer comment'].includes(value)) return 'developer-comment';
    if (['map', 'lng', '.lng', 'translation-memory'].includes(value)) return 'lng';
    if (value === 'glossary') return 'glossary';
    if (value === 'fuzzy') return 'fuzzy';
    if (value === 'ai') return 'ai';
    if (['human-accepted', 'accepted-existing'].includes(value)) return 'human-accepted';
    if (['status-confirmation', 'status'].includes(value)) return 'status-confirmation';
    if (value === 'merge') return 'merge';
    return 'manual';
}

function provenanceFromResolved(resolved, action = 'draft') {
    if (!resolved || !resolved.source) return createProvenance('manual', { action });
    if (resolved.source === 'comment') {
        return createProvenance('developer-comment', { action, scope: resolved.commentScope || 'unit' });
    }
    if (resolved.source === 'map') {
        return createProvenance('lng', { action });
    }
    if (resolved.source === 'glossary') {
        const entry = resolved.glossaryEntry || {};
        return createProvenance('glossary', { action, term: entry.source || entry.term || '' });
    }
    if (resolved.source === 'fuzzy') {
        return createProvenance('fuzzy', {
            action,
            quality: resolved.quality,
            matchedSource: resolved.matchedSource
        });
    }
    return createProvenance(resolved.source, { action });
}

function provenanceFromAi(model, action = 'proposal') {
    return createProvenance('ai', { action, model });
}

function withAction(provenance, action, extra = {}) {
    const source = sanitizeProvenance(provenance) || createProvenance('manual', { action });
    return {
        ...source,
        ...extra,
        v: PROVENANCE_VERSION,
        at: extra.at || new Date().toISOString(),
        action: action || source.action || 'applied'
    };
}

function manualProvenance(basedOn, action = 'draft') {
    return createProvenance('manual', {
        action,
        basedOn: basedOn ? sanitizeProvenance(basedOn) : undefined
    });
}

function serializeProvenanceNote(event) {
    const sanitized = sanitizeProvenance(event);
    if (!sanitized) return '';
    return `${PROVENANCE_PREFIX} ${JSON.stringify(sanitized)}`;
}

function parseProvenanceNote(text) {
    const value = String(text || '').trim();
    if (!value.startsWith(PROVENANCE_PREFIX)) return undefined;
    const json = value.slice(PROVENANCE_PREFIX.length).trim();
    if (!json) return undefined;
    try {
        return sanitizeProvenance(JSON.parse(json));
    } catch (_) {
        return undefined;
    }
}

function getProvenanceHistory(noteDetails) {
    const history = [];
    for (const note of noteDetails || []) {
        if (!isStudioNoteFrom(note.from)) continue;
        const parsed = parseProvenanceNote(note.text);
        if (parsed) history.push(parsed);
    }
    return history.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
}

function isProvenanceNoteDetail(note) {
    return Boolean(note && isStudioNoteFrom(note.from) && parseProvenanceNote(note.text));
}

function latestProvenance(noteDetails) {
    const history = getProvenanceHistory(noteDetails);
    return history.length ? history[history.length - 1] : undefined;
}

function formatProvenanceLabel(event) {
    const value = sanitizeProvenance(event);
    if (!value) return '';
    let label = LABELS[value.origin] ? t(LABELS[value.origin]) : value.origin || t("Unknown");
    if (value.origin === 'fuzzy' && Number.isFinite(Number(value.quality))) label += ` ${Math.round(Number(value.quality))}%`;
    if (value.origin === 'ai' && value.model) {
        const modelLabel = value.model.name || value.model.id || value.model.family;
        if (modelLabel) label += ` · ${modelLabel}`;
    }
    if (value.origin === 'glossary' && value.term) label += ` · ${value.term}`;
    if (value.origin === 'lng' && value.matchedSource) label += ` · ${value.matchedSource}`;
    if (value.origin === 'manual' && value.basedOn && value.basedOn.origin) {
        let basedOn = LABELS[value.basedOn.origin] || value.basedOn.origin;
        if (value.basedOn.origin === 'fuzzy' && Number.isFinite(Number(value.basedOn.quality))) basedOn += ` ${Math.round(Number(value.basedOn.quality))}%`;
        if (value.basedOn.origin === 'ai' && value.basedOn.model) {
            const modelLabel = value.basedOn.model.name || value.basedOn.model.id || value.basedOn.model.family;
            if (modelLabel) basedOn += ` · ${modelLabel}`;
        }
        label += t(" · based on {0}", basedOn);
    }
    return label;
}

function formatProvenanceHistory(event) {
    const value = sanitizeProvenance(event);
    if (!value) return '';
    const parts = [formatProvenanceLabel(value)];
    if (value.action) parts.push(value.action);
    if (value.matchedSource) parts.push(t("from “{0}”", value.matchedSource));
    if (value.scope === 'same-source') parts.push('reused from same source');
    if (value.previousState !== undefined) parts.push(`previous state: ${value.previousState || '(no state)'}`);
    if (value.sourceFile) parts.push(value.sourceFile);
    if (value.at) parts.push(formatTimestamp(value.at));
    return parts.filter(Boolean).join(' · ');
}

function sanitizeProvenance(value) {
    if (!value || typeof value !== 'object') return undefined;
    const origin = normalizeOrigin(value.origin);
    const result = {
        v: PROVENANCE_VERSION,
        at: isValidTimestamp(value.at) ? String(value.at) : new Date().toISOString(),
        origin,
        action: String(value.action || 'draft')
    };
    if (value.scope) result.scope = String(value.scope);
    if (value.quality !== undefined && Number.isFinite(Number(value.quality))) result.quality = Math.round(Number(value.quality));
    if (value.matchedSource) result.matchedSource = String(value.matchedSource);
    if (value.term) result.term = String(value.term);
    if (value.previousState !== undefined) result.previousState = String(value.previousState || '');
    if (value.sourceFile) result.sourceFile = String(value.sourceFile);
    if (value.model && typeof value.model === 'object') {
        const model = compactModel(value.model);
        if (Object.keys(model).length) result.model = model;
    }
    if (value.basedOn && typeof value.basedOn === 'object') result.basedOn = compactBasedOn(value.basedOn);
    return result;
}

function compactModel(model) {
    const result = {};
    for (const key of ['id', 'name', 'vendor', 'family', 'version']) {
        if (model[key]) result[key] = String(model[key]);
    }
    return result;
}

function compactBasedOn(value) {
    const result = {};
    if (value.origin) result.origin = normalizeOrigin(value.origin);
    if (value.quality !== undefined && Number.isFinite(Number(value.quality))) result.quality = Math.round(Number(value.quality));
    if (value.matchedSource) result.matchedSource = String(value.matchedSource);
    if (value.model && typeof value.model === 'object') {
        const model = compactModel(value.model);
        if (Object.keys(model).length) result.model = model;
    }
    return result;
}

function isValidTimestamp(value) {
    if (!value) return false;
    return Number.isFinite(Date.parse(String(value)));
}

function formatTimestamp(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return String(value || '');
    return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, 'Z');
}

module.exports = {
    PROVENANCE_PREFIX,
    PROVENANCE_VERSION,
    createProvenance,
    provenanceFromResolved,
    provenanceFromAi,
    withAction,
    manualProvenance,
    serializeProvenanceNote,
    parseProvenanceNote,
    getProvenanceHistory,
    latestProvenance,
    isProvenanceNoteDetail,
    formatProvenanceLabel,
    formatProvenanceHistory,
    sanitizeProvenance
};
