'use strict';
const { translationMemorySnapshots, mergeTranslationMemorySnapshots } = require('./translationMemory');

const vscode = require('vscode');
const { changedTextRange } = require('./textEditRange');
const { getUnitIndex, unitAtOrdinal } = require('./unitIndex');
const { BRAND_NAME, CONFIG_SECTION, XLIFF_EDITOR_VIEW_TYPE, COMMAND_PREFIX } = require('./identity');
const path = require('path');
const { parseLng, serializeLng, mergeEntries, entriesToMap } = require('./lng');
const {
    parseXliff,
    getUnitRaw,
    getDeveloperCommentTranslation,
    isMissingTranslation,
    isReviewTranslation,
    updateTranslationUnit,
    updateTranslationUnitRaw,
    updateTranslationUnits,
    setNoStateTargetsTranslated,
    replaceTranslationUnitRaw,
    setQualityIssueIgnored,
    flagSourceChangedUnits,
    extractPlaceholders,
    placeholdersMatch,
    getStagedTranslation,
    isStagedTranslationNoteDetail,
    setStagedTranslations
} = require('./xliff');
const { resolveKnownTranslationForUnit } = require('./resolver');
const { translateItemsByKeyDetailed } = require('./ai');
const { findDuplicateIds, findDuplicateGeneratorNotes } = require('./validate');
const { getGeneratorCompanionFilename } = require('./paths');
const { getLanguageMapUri, migrateLegacyLanguageMapIfNeeded } = require('./studioPaths');
const { readProjectGlossary, openProjectGlossary, addGlossaryEntry } = require('./glossaryEditor');
const { findRelevantGlossaryTerms, findTerminologyViolationsForTerms } = require('./glossary');
const { qualityOptionsFromConfiguration } = require('./quality');
const { createQualityPageStore, queryQualityPage } = require('./qualityPaging');
const { analyzeQualityForText, invalidateQualityAnalysis } = require('./qualityCoordinator');
const { updateTranslationUnitsAdaptive, abortError, synchronizeXliffAdaptive, parseXliffAdaptive, analyzeXliffQualityAdaptive, isWorkerCancellation, throwIfCancelled } = require('./xlfWorkerHost');
const { getDocumentSession, getParsedDocumentSession, getParsedDocumentSessionAsync, setDocumentSessionStats, retainDocumentSession, releaseDocumentSession, invalidateDocumentSession } = require('./documentSession');
const { qualityIgnoreFromNoteDetail } = require('./qualityIgnore');
const { readProjectQualityIgnores, setProjectQualityIssueIgnored } = require('./projectQualityIgnore');
const { createPerformanceTrace, appendPerformanceEvent, isPerformanceDebugEnabled, getSlowThresholdMs } = require('./performanceDebug');
const { beginQualityDiagnosticMappings, registerQualityDiagnosticMapping, clearQualityDiagnosticMappings } = require('./qualityDiagnosticNavigation');
const { createAiTranslationItem, getAiContextOptions } = require('./aiContext');
const { findExactAlOriginCandidates, parseGeneratorOrigin, withGeneratorOriginFromCompanion, createFallbackSourceSearchQuery, findXliffUnitLocation } = require('./sourceNavigation');
const {
    createProvenance,
    provenanceFromResolved,
    provenanceFromAi,
    withAction,
    manualProvenance,
    getProvenanceHistory,
    latestProvenance,
    isProvenanceNoteDetail,
    formatProvenanceLabel,
    formatProvenanceHistory,
    sanitizeProvenance
} = require('./provenance');

const ROW_PREPARE_CHUNK_SIZE = 200;
const PAGE_DETAIL_GLOSSARY_CACHE_LIMIT = 1000;
const DOCUMENT_LOADING_OVERLAY_THRESHOLD = 500;
const APPLY_DRAFTS_PROGRESS_THRESHOLD = 20;
const DEFERRED_QUALITY_CHAR_THRESHOLD = 3 * 1024 * 1024;
const DEFERRED_QUALITY_UNIT_THRESHOLD = 5000;
const DEFAULT_QUALITY_DIAGNOSTIC_LIMIT = 2000;
const MIN_QUALITY_DIAGNOSTIC_LIMIT = 100;
const MAX_QUALITY_DIAGNOSTIC_LIMIT = 50000;

function qualityDiagnosticsLimit(uri) {
    let configured = DEFAULT_QUALITY_DIAGNOSTIC_LIMIT;
    try {
        if (vscode.workspace && typeof vscode.workspace.getConfiguration === 'function') {
            configured = Number(vscode.workspace.getConfiguration(CONFIG_SECTION, uri).get('quality.maxProblemsDiagnostics', DEFAULT_QUALITY_DIAGNOSTIC_LIMIT));
        }
    } catch (_) {
        configured = DEFAULT_QUALITY_DIAGNOSTIC_LIMIT;
    }
    if (!Number.isFinite(configured)) configured = DEFAULT_QUALITY_DIAGNOSTIC_LIMIT;
    return Math.max(MIN_QUALITY_DIAGNOSTIC_LIMIT, Math.min(MAX_QUALITY_DIAGNOSTIC_LIMIT, Math.trunc(configured)));
}

function selectQualityDiagnosticIssues(report, limit) {
    const all = report && Array.isArray(report.issues) ? report.issues : [];
    const safeLimit = Math.max(0, Math.trunc(Number(limit) || 0));
    const issues = safeLimit ? all.slice(0, safeLimit) : [];
    return {
        issues,
        total: all.length,
        published: issues.length,
        limit: safeLimit,
        truncated: issues.length < all.length
    };
}

function shouldDeferInitialQuality(sourceText, parsed) {
    const chars = String(sourceText || '').length;
    const units = parsed && Array.isArray(parsed.units) ? parsed.units.length : 0;
    return chars >= DEFERRED_QUALITY_CHAR_THRESHOLD || units >= DEFERRED_QUALITY_UNIT_THRESHOLD;
}

function createEmptyQualityReport() {
    const summary = { total: 0, errors: 0, warnings: 0, infos: 0, categories: {} };
    return {
        issues: [],
        ignoredIssues: [],
        byOrdinal: new Map(),
        ignoredByOrdinal: new Map(),
        summary: { ...summary, categories: {} },
        ignoredSummary: { ...summary, categories: {} }
    };
}


function createWebviewRowIndexEntry(row) {
    // The webview no longer receives a second copy of Source/Translation/Notes for
    // every trans-unit. It only needs global membership for staged/applied rows;
    // full row data is materialized by requestViewPage for the visible page.
    const hasDraft = Boolean(row && row.hasTranslationDraft);
    const hasProposal = Boolean(row && row.proposal);
    const appliedUndo = Boolean(row && row.appliedUndo);
    if (!hasDraft && !hasProposal && !appliedUndo) return undefined;
    const entry = { ordinal: Number(row.ordinal) };
    if (hasDraft) entry.hasTranslationDraft = true;
    if (hasProposal) entry.hasProposal = true;
    if (appliedUndo) entry.appliedUndo = true;
    return entry;
}

function compactEditorRow(row) {
    if (!row) return row;
    const compact = { ...row };
    compact.qualityIssueCount = Array.isArray(row.qualityIssues)
        ? row.qualityIssues.length
        : (Number(row.qualityIssueCount) || 0);
    // These fields are display/search details. Their flattened search keys are kept
    // separately in activeViewKeyStore; the structured values are rebuilt only for
    // the current visible page.
    delete compact.notes;
    delete compact.generatorNote;
    delete compact.translationProvenance;
    delete compact.translationProvenanceLabel;
    delete compact.provenanceHistory;
    delete compact.provenanceHistoryLabels;
    delete compact.glossaryTerms;
    delete compact.qualityIssues;
    delete compact.ignoredQualityIssues;
    return compact;
}

function materializeEditorRowDetails(row, unit, options = {}) {
    if (!row) return row;
    const provenanceIsEnabled = options.provenanceEnabled !== false;
    const noteDetails = unit && Array.isArray(unit.noteDetails) ? unit.noteDetails : [];
    const visibleNotes = noteDetails.filter(note =>
        !isProvenanceNoteDetail(note) &&
        !isStagedTranslationNoteDetail(note) &&
        !qualityIgnoreFromNoteDetail(note) &&
        String(note && note.from || '').trim().toLowerCase() !== 'xliff generator'
    );
    const generatorNoteText = (noteDetails.find(note =>
        String(note && note.from || '').trim().toLowerCase() === 'xliff generator'
    ) || {}).text || '';
    const provenanceHistory = provenanceIsEnabled ? getProvenanceHistory(noteDetails) : [];
    const persistedProvenance = provenanceIsEnabled ? latestProvenance(noteDetails) : undefined;
    const glossaryTerms = Array.isArray(options.glossaryTerms) ? options.glossaryTerms : [];
    const qualityIssues = Array.isArray(options.qualityIssues) ? options.qualityIssues : [];
    const ignoredQualityIssues = Array.isArray(options.ignoredQualityIssues) ? options.ignoredQualityIssues : [];
    return {
        ...row,
        developerTranslation: getDeveloperCommentTranslation(unit, options.targetLanguage, { preserveWhitespace: true }).translation,
        generatorNote: generatorNoteText,
        notes: visibleNotes,
        translationProvenance: persistedProvenance,
        translationProvenanceLabel: provenanceIsEnabled ? formatProvenanceLabel(persistedProvenance) : '',
        provenanceHistory,
        provenanceHistoryLabels: provenanceHistory.map(formatProvenanceHistory),
        glossaryTerms: glossaryTerms.map(term => ({ source: term.source, translation: term.translation })),
        qualityIssues: qualityIssues.map(issue => ({ severity: issue.severity, code: issue.code, message: issue.message })),
        ignoredQualityIssues
    };
}


function viewLower(value) {
    return String(value == null ? '' : value).toLocaleLowerCase();
}

function viewNotesText(row) {
    return (row.notes || []).map(note =>
        [note && note.from, note && note.text, note && note.annotates, note && note.priority].filter(Boolean).join(' ')
    ).join(' | ');
}

function viewProvenanceText(row, enabled) {
    if (!enabled) return '';
    return [
        row.translationProvenanceLabel,
        row.translationDraftOrigin,
        row.proposalOrigin,
        ...(row.provenanceHistoryLabels || [])
    ].filter(Boolean).join(' | ');
}

function viewQualityText(row) {
    return (row.qualityIssues || []).map(issue => [issue && issue.code, issue && issue.message].filter(Boolean).join(' ')).join(' | ');
}

function viewGlossaryText(row) {
    return (row.glossaryTerms || []).map(term => `${term && term.source || ''} ${term && term.translation || ''}`.trim()).filter(Boolean).join(' ');
}

function noStateAcceptableForView(row) {
    const saved = String(row && (row.savedTranslation == null ? row.translation || '' : row.savedTranslation));
    return Boolean(row && !row.notTranslatable && !String(row.rawState || '').trim() && saved.trim() && !viewPlaceholderError(row, saved));
}

function createViewSearchSortKeys(row) {
    const effectiveTranslation = effectiveTranslationForView(row);
    const source = viewLower(row && row.source);
    const translation = viewLower(effectiveTranslation);
    const proposal = viewLower(row && row.proposal);
    const status = viewLower(row && row.status);
    const notes = viewLower(viewNotesText(row));
    const id = viewLower(row && row.id);
    const provenance = viewLower(viewProvenanceText(row, true));
    const quality = viewLower(viewQualityText(row));
    const glossary = viewLower(viewGlossaryText(row));
    const baseGlobalParts = [source, translation, proposal, status, notes, id];
    const tailGlobalParts = [quality, glossary];
    return {
        ordinal: Number(row && row.ordinal),
        source,
        translation,
        proposal,
        status,
        notes,
        id,
        provenance,
        quality,
        glossary,
        globalWithoutProvenance: [...baseGlobalParts, ...tailGlobalParts].join(' '),
        globalWithProvenance: [...baseGlobalParts, provenance, ...tailGlobalParts].join(' '),
        translated: Boolean(row && !row.notTranslatable && !row.missing && !row.review && effectiveTranslation),
        missing: Boolean(row && row.missing),
        review: Boolean(row && row.review),
        hasProposal: Boolean(row && row.proposal),
        hasDraft: Boolean(row && (row.translationDirty || row.hasTranslationDraft || row.proposal)),
        translationPlaceholderError: Boolean(viewPlaceholderError(row, effectiveTranslation)),
        proposalPlaceholderError: Boolean(viewPlaceholderError(row, row && row.proposal)),
        translationTerminologyError: Boolean(viewTerminologyError(row, effectiveTranslation)),
        proposalTerminologyError: Boolean(viewTerminologyError(row, row && row.proposal)),
        qualityIssueCount: Array.isArray(row && row.qualityIssues) ? row.qualityIssues.length : (Number(row && row.qualityIssueCount) || 0),
        noStateAcceptable: noStateAcceptableForView(row)
    };
}

function createViewSearchSortKeyStore(rows) {
    const result = new Map();
    const values = rows instanceof Map ? rows.values() : (Array.isArray(rows) ? rows : []);
    for (const row of values) {
        if (!row || !Number.isInteger(Number(row.ordinal))) continue;
        result.set(Number(row.ordinal), createViewSearchSortKeys(row));
    }
    return result;
}

function emptyEditorSummaryStats(qualitySummary) {
    return {
        total: 0,
        missing: 0,
        review: 0,
        proposals: 0,
        translationDrafts: 0,
        staged: 0,
        placeholderErrors: 0,
        terminologyErrors: 0,
        qualityIssues: 0,
        noState: 0,
        quality: qualitySummary || { total: 0, errors: 0, warnings: 0, infos: 0, categories: {} }
    };
}

function addRowSummaryContribution(stats, row, preparedKeys) {
    if (!stats || !row) return stats;
    const keys = preparedKeys || createViewSearchSortKeys(row);
    const hasTranslationDraft = Boolean(row.translationDirty || row.hasTranslationDraft);
    const hasProposal = Boolean(row.proposal);
    stats.total += 1;
    if (row.missing) stats.missing += 1;
    if (row.review) stats.review += 1;
    if (hasProposal) stats.proposals += 1;
    if (hasTranslationDraft) stats.translationDrafts += 1;
    if (hasTranslationDraft || hasProposal) stats.staged += 1;
    if (keys.translationPlaceholderError || keys.proposalPlaceholderError) stats.placeholderErrors += 1;
    if (keys.translationTerminologyError || keys.proposalTerminologyError) stats.terminologyErrors += 1;
    stats.qualityIssues += Number(keys.qualityIssueCount) || 0;
    if (keys.noStateAcceptable) stats.noState += 1;
    return stats;
}

function createEditorSummaryStats(rows, preparedKeyStore, qualitySummary) {
    const stats = emptyEditorSummaryStats(qualitySummary);
    const values = rows instanceof Map ? rows.values() : (Array.isArray(rows) ? rows : []);
    for (const row of values) {
        if (!row) continue;
        const keys = preparedKeyStore instanceof Map ? preparedKeyStore.get(Number(row.ordinal)) : undefined;
        addRowSummaryContribution(stats, row, keys);
    }
    return stats;
}

function effectiveTranslationForView(row) {
    if (row && row.translationDirty) return String(row.translation == null ? '' : row.translation);
    if (row && row.hasTranslationDraft) return String(row.translationDraft == null ? '' : row.translationDraft);
    return String(row && row.translation == null ? '' : row && row.translation || '');
}

function viewPlaceholderError(row, value) {
    const translation = String(value == null ? '' : value);
    if (!translation) return false;
    return !placeholdersMatch(String(row && row.source || ''), translation);
}

function viewTerminologyError(row, value) {
    const translation = viewLower(value);
    if (!translation) return false;
    const terms = Array.isArray(row && row.glossaryTerms) ? row.glossaryTerms : [];
    return terms.some(term => {
        const required = viewLower(term && term.translation);
        return required && !translation.includes(required);
    });
}

function viewFieldValue(row, field) {
    if (field === 'translation') return effectiveTranslationForView(row);
    if (field === 'notes') return viewNotesText(row);
    return String(row && row[field] == null ? '' : row && row[field] || '');
}

function mergeViewOverride(row, override) {
    if (!override || Number(override.ordinal) !== Number(row.ordinal)) return row;
    const merged = { ...row, savedTranslation: row.savedTranslation == null ? row.translation : row.savedTranslation };
    const mutableKeys = [
        'translation', 'savedTranslation', 'translationDirty', 'hasTranslationDraft', 'translationDraft',
        'translationDraftOrigin', 'translationDraftProvenance', 'proposal', 'proposalOrigin', 'proposalProvenance',
        'status', 'rawState', 'missing', 'review', 'appliedUndo', 'canAcceptTranslation',
        'translationTerminologyError', 'proposalTerminologyError'
    ];
    for (const key of mutableKeys) {
        if (Object.prototype.hasOwnProperty.call(override, key)) merged[key] = override[key];
    }
    if (merged.translationDirty) {
        merged.hasTranslationDraft = true;
        merged.translationDraft = String(merged.translation == null ? '' : merged.translation);
    }
    return merged;
}

function normalizeViewRequest(view) {
    const source = view && typeof view === 'object' ? view : {};
    const pageSize = [50, 100, 200].includes(Number(source.pageSize)) ? Number(source.pageSize) : 100;
    const sortFields = new Set(['source', 'translation', 'proposal', 'status', 'notes']);
    const filters = source.filters && typeof source.filters === 'object' ? source.filters : {};
    const quick = source.quick && typeof source.quick === 'object' ? source.quick : {};
    const globalFilter = String(source.globalFilter || '');
    const normalizedFilters = {
        source: String(filters.source || ''),
        translation: String(filters.translation || ''),
        proposal: String(filters.proposal || ''),
        status: String(filters.status || ''),
        notes: String(filters.notes || '')
    };
    return {
        page: Math.max(1, Number(source.page) || 1),
        pageSize,
        sortField: sortFields.has(String(source.sortField || '')) ? String(source.sortField) : 'source',
        sortDirection: Number(source.sortDirection) < 0 ? -1 : 1,
        navigationOrdinal: source.navigationOrdinal !== null && source.navigationOrdinal !== undefined && String(source.navigationOrdinal).trim() !== '' && Number.isInteger(Number(source.navigationOrdinal))
            ? Number(source.navigationOrdinal)
            : undefined,
        globalFilter,
        globalFilterKey: viewLower(globalFilter),
        provenanceEnabled: source.provenanceEnabled !== false,
        filters: normalizedFilters,
        filterKeys: Object.fromEntries(Object.entries(normalizedFilters).map(([field, value]) => [field, viewLower(value)])),
        quick: {
            translated: Boolean(quick.translated),
            missing: Boolean(quick.missing),
            review: Boolean(quick.review),
            proposal: Boolean(quick.proposal),
            draft: Boolean(quick.draft),
            placeholderErrors: Boolean(quick.placeholderErrors),
            terminologyErrors: Boolean(quick.terminologyErrors),
            noState: Boolean(quick.noState),
            quality: Boolean(quick.quality)
        }
    };
}

function rowMatchesView(row, view, preparedKeys) {
    if (Number.isInteger(view.navigationOrdinal) && Number(row.ordinal) === view.navigationOrdinal) return true;
    const keys = preparedKeys || createViewSearchSortKeys(row);
    if (view.globalFilterKey) {
        const globalText = view.provenanceEnabled ? keys.globalWithProvenance : keys.globalWithoutProvenance;
        if (!globalText.includes(view.globalFilterKey)) return false;
    }
    for (const field of Object.keys(view.filters)) {
        const needle = view.filterKeys[field];
        if (needle && !String(keys[field] || '').includes(needle)) return false;
    }

    const quickMatches = [];
    if (view.quick.translated) quickMatches.push(keys.translated);
    if (view.quick.missing) quickMatches.push(keys.missing);
    if (view.quick.review) quickMatches.push(keys.review);
    if (view.quick.proposal) quickMatches.push(keys.hasProposal);
    if (view.quick.draft) quickMatches.push(keys.hasDraft);
    if (view.quick.placeholderErrors) quickMatches.push(Boolean(keys.translationPlaceholderError || keys.proposalPlaceholderError));
    if (view.quick.terminologyErrors) quickMatches.push(Boolean(keys.translationTerminologyError || keys.proposalTerminologyError));
    if (view.quick.noState) quickMatches.push(keys.noStateAcceptable);
    if (view.quick.quality) quickMatches.push(Boolean(keys.qualityIssueCount || keys.translationPlaceholderError || keys.translationTerminologyError));
    if (quickMatches.length && !quickMatches.some(Boolean)) return false;
    return true;
}

const viewCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function compareViewRows(a, b, view, aKeys, bKeys) {
    const ak = aKeys || createViewSearchSortKeys(a);
    const bk = bKeys || createViewSearchSortKeys(b);
    const av = String(ak[view.sortField] || '');
    const bv = String(bk[view.sortField] || '');
    const cmp = viewCollator.compare(av, bv);
    if (cmp) return cmp * view.sortDirection;
    return Number(a.ordinal) - Number(b.ordinal);
}

function refreshViewGlobalKeys(keys) {
    if (!keys) return keys;
    const baseGlobalParts = [keys.source, keys.translation, keys.proposal, keys.status, keys.notes, keys.id];
    const tailGlobalParts = [keys.quality, keys.glossary];
    keys.globalWithoutProvenance = [...baseGlobalParts, ...tailGlobalParts].join(' ');
    keys.globalWithProvenance = [...baseGlobalParts, keys.provenance, ...tailGlobalParts].join(' ');
    return keys;
}

function createViewSearchSortKeysForOverride(baseRow, baseKeys, mergedRow) {
    // Overrides only affect a small mutable subset. Rebuilding every key from the
    // materialized row would require Notes/Glossary/Quality/Provenance details that
    // are intentionally no longer retained for every unit. Clone the prepared base
    // keys and update only the fields whose value can change in the webview.
    const keys = { ...(baseKeys || createViewSearchSortKeys(baseRow)) };
    const effectiveTranslation = effectiveTranslationForView(mergedRow);
    keys.translation = viewLower(effectiveTranslation);
    keys.proposal = viewLower(mergedRow && mergedRow.proposal);
    keys.status = viewLower(mergedRow && mergedRow.status);
    keys.translated = Boolean(mergedRow && !mergedRow.notTranslatable && !mergedRow.missing && !mergedRow.review && effectiveTranslation);
    keys.missing = Boolean(mergedRow && mergedRow.missing);
    keys.review = Boolean(mergedRow && mergedRow.review);
    keys.hasProposal = Boolean(mergedRow && mergedRow.proposal);
    keys.hasDraft = Boolean(mergedRow && (mergedRow.translationDirty || mergedRow.hasTranslationDraft || mergedRow.proposal));
    keys.translationPlaceholderError = Boolean(viewPlaceholderError(mergedRow, effectiveTranslation));
    keys.proposalPlaceholderError = Boolean(viewPlaceholderError(mergedRow, mergedRow && mergedRow.proposal));
    keys.translationTerminologyError = Object.prototype.hasOwnProperty.call(mergedRow || {}, 'translationTerminologyError')
        ? Boolean(mergedRow.translationTerminologyError)
        : Boolean(keys.translationTerminologyError);
    keys.proposalTerminologyError = Object.prototype.hasOwnProperty.call(mergedRow || {}, 'proposalTerminologyError')
        ? Boolean(mergedRow.proposalTerminologyError)
        : Boolean(keys.proposalTerminologyError);
    keys.noStateAcceptable = noStateAcceptableForView(mergedRow);
    return refreshViewGlobalKeys(keys);
}

function queryViewRows(rowStore, request, preparedKeyStore, cache) {
    const view = normalizeViewRequest(request && request.view);
    const overrides = new Map((Array.isArray(request && request.overrides) ? request.overrides : [])
        .filter(item => item && Number.isInteger(Number(item.ordinal)))
        .map(item => [Number(item.ordinal), item]));
    const rowsByOrdinal = rowStore instanceof Map
        ? rowStore
        : new Map((Array.isArray(rowStore) ? rowStore : []).filter(Boolean).map(row => [Number(row.ordinal), row]));
    const keyStore = preparedKeyStore instanceof Map ? preparedKeyStore : createViewSearchSortKeyStore(rowsByOrdinal);
    const overrideRows = new Map();
    const overrideKeys = new Map();
    const cacheKey = JSON.stringify({ ...view, page: undefined, pageSize: undefined, overrides: [...overrides.values()], documentVersion: request && request.documentVersion });
    const cached = cache && cache.get(cacheKey);
    const visibleOrdinals = cached ? cached.ordinals : [];
    if (cached) {
        for (const [ordinal, row] of cached.rows) overrideRows.set(ordinal, row);
        for (const [ordinal, keys] of cached.keys) overrideKeys.set(ordinal, keys);
    }
    if (!cached) {

    // Keep only ordinals in the transient result set. The previous implementation
    // allocated a base-row array plus one {row,keys} object per trans-unit for every
    // filter/page request, which created significant GC pressure on large XLIFFs.
    for (const [rawOrdinal, baseRow] of rowsByOrdinal.entries()) {
        if (!baseRow) continue;
        const ordinal = Number(rawOrdinal);
        const baseKeys = keyStore.get(ordinal) || createViewSearchSortKeys(baseRow);
        const override = overrides.get(ordinal);
        let row = baseRow;
        let keys = baseKeys;
        if (override) {
            row = mergeViewOverride(baseRow, override);
            keys = createViewSearchSortKeysForOverride(baseRow, baseKeys, row);
            overrideRows.set(ordinal, row);
            overrideKeys.set(ordinal, keys);
        }
        if (rowMatchesView(row, view, keys)) visibleOrdinals.push(ordinal);
    }

    visibleOrdinals.sort((leftOrdinal, rightOrdinal) => {
        const leftRow = overrideRows.get(leftOrdinal) || rowsByOrdinal.get(leftOrdinal);
        const rightRow = overrideRows.get(rightOrdinal) || rowsByOrdinal.get(rightOrdinal);
        const leftKeys = overrideKeys.get(leftOrdinal) || keyStore.get(leftOrdinal);
        const rightKeys = overrideKeys.get(rightOrdinal) || keyStore.get(rightOrdinal);
        return compareViewRows(leftRow, rightRow, view, leftKeys, rightKeys);
    });

    if (cache) {
        if (cache.size >= 8) cache.delete(cache.keys().next().value);
        cache.set(cacheKey, { ordinals: visibleOrdinals, rows: overrideRows, keys: overrideKeys });
    }
    }
    const pageCount = Math.max(1, Math.ceil(visibleOrdinals.length / view.pageSize));
    let page = Math.max(1, Math.min(view.page, pageCount));
    if (Number.isInteger(view.navigationOrdinal)) {
        const navigationIndex = visibleOrdinals.indexOf(view.navigationOrdinal);
        if (navigationIndex >= 0) page = Math.floor(navigationIndex / view.pageSize) + 1;
    }
    const start = visibleOrdinals.length ? (page - 1) * view.pageSize : 0;
    const end = Math.min(start + view.pageSize, visibleOrdinals.length);
    const pageOrdinals = visibleOrdinals.slice(start, end);
    return {
        page,
        pageSize: view.pageSize,
        pageCount,
        filteredCount: visibleOrdinals.length,
        totalCount: rowsByOrdinal.size,
        start,
        end,
        ordinals: pageOrdinals,
        rows: pageOrdinals.map(ordinal => overrideRows.get(ordinal) || rowsByOrdinal.get(ordinal))
    };
}

function documentSessionSnapshot(uri, text, version) {
    const sourceText = String(text || '');
    const session = getDocumentSession(uri, sourceText, { version });
    const parsed = getParsedDocumentSession(session, sourceText, parseXliff);
    return { session, parsed };
}

function parseWithDocumentSession(uri, text, version) {
    return documentSessionSnapshot(uri, text, version).parsed;
}

async function parseWithDocumentSessionAsync(uri, text, version, config, options = {}) {
    const sourceText = String(text || '');
    const session = getDocumentSession(uri, sourceText, { version });
    const effectiveConfig = config || vscode.workspace.getConfiguration(CONFIG_SECTION, uri);
    return getParsedDocumentSessionAsync(session, sourceText, async (value, workerOptions) => {
        const result = await parseXliffAdaptive(value, effectiveConfig, { ...options, ...workerOptions });
        return result.parsed;
    });
}

class XliffEditorProvider {
    static viewType = XLIFF_EDITOR_VIEW_TYPE;
    static panelRecords = new Map();
    static pendingFilters = new Map();
    static pendingQualityChecks = new Set();
    static pendingOrdinals = new Map();

    constructor(context) {
        this.context = context;
    }

    static async openWithFilter(uri, filter = 'all') {
        const key = uri.toString();
        XliffEditorProvider.pendingFilters.set(key, filter || 'all');
        await vscode.commands.executeCommand('vscode.openWith', uri, XliffEditorProvider.viewType);
        const records = XliffEditorProvider.panelRecords.get(key);
        if (!records) return;
        let delivered = false;
        for (const record of records) {
            if (!record.ready) continue;
            await record.panel.webview.postMessage({ type: 'dashboardFilter', filter: filter || 'all' });
            delivered = true;
        }
        if (delivered) XliffEditorProvider.pendingFilters.delete(key);
    }

    static async openWithQuality(uri) {
        const key = uri.toString();
        XliffEditorProvider.pendingQualityChecks.add(key);
        await XliffEditorProvider.openWithFilter(uri, 'quality');
        const records = XliffEditorProvider.panelRecords.get(key);
        if (!records) return;
        let delivered = false;
        for (const record of records) {
            if (!record.ready) continue;
            await record.panel.webview.postMessage({ type: 'triggerQualityCheck' });
            delivered = true;
        }
        if (delivered) XliffEditorProvider.pendingQualityChecks.delete(key);
    }

    static async openAtUnit(uri, unitId, source) {
        if (!uri) return false;
        const text = await readText(uri);
        const parsed = await parseWithDocumentSessionAsync(uri, text);
        let unit = unitId ? (getUnitIndex(parsed).byId.get(String(unitId)) || [])[0] : undefined;
        if (!unit && source) {
            const matches = getUnitIndex(parsed).bySource.get(String(source)) || [];
            if (matches.length === 1) unit = matches[0];
            else if (matches.length) unit = matches[0];
        }
        if (!unit) {
            vscode.window.showWarningMessage(`${BRAND_NAME}: translation unit was not found in ${path.basename(uri.fsPath)}.`);
            return false;
        }
        return XliffEditorProvider.openAtOrdinal(uri, unit.ordinal);
    }

    static async openAtDiagnosticTarget(uri, target) {
        if (!uri || !target) return false;
        const text = await readText(uri);
        const parsed = await parseWithDocumentSessionAsync(uri, text);
        const unitId = String(target.unitId || '');
        const source = String(target.source || '');
        const ordinal = Number(target.ordinal);
        let unit;

        // Prefer the stable trans-unit id captured when the Diagnostic was created.
        // If malformed XLIFF contains duplicate ids, use the captured source to avoid
        // jumping to an arbitrary duplicate.
        if (unitId) {
            const idMatches = getUnitIndex(parsed).byId.get(unitId) || [];
            if (source) unit = idMatches.find(item => String(item.source || '') === source);
            if (!unit && idMatches.length === 1) unit = idMatches[0];
        }

        // Ordinal is a fast fallback only while the identifying source/id still match.
        if (!unit && Number.isInteger(ordinal) && ordinal >= 0 && parsed.units[ordinal]) {
            const candidate = parsed.units[ordinal];
            const idMatches = !unitId || String(candidate.id || '') === unitId;
            const sourceMatches = !source || String(candidate.source || '') === source;
            if (idMatches && sourceMatches) unit = candidate;
        }

        // A unique source remains useful when synchronization replaced ids between
        // Diagnostic creation and the Quick Fix invocation.
        if (!unit && source) {
            const sourceMatches = getUnitIndex(parsed).bySource.get(source) || [];
            if (sourceMatches.length === 1) unit = sourceMatches[0];
        }

        if (!unit) {
            vscode.window.showWarningMessage(`${BRAND_NAME}: the translation unit for this Quality Check result has changed or no longer exists. Run Quality Check again.`);
            return false;
        }
        return XliffEditorProvider.openAtOrdinal(uri, unit.ordinal, target.severity);
    }

    static async openAtOrdinal(uri, ordinal, severity) {
        const targetOrdinal = Number(ordinal);
        if (!uri || !Number.isInteger(targetOrdinal) || targetOrdinal < 0) return false;
        const targetSeverity = ['error', 'warning', 'info'].includes(String(severity || '').toLowerCase())
            ? String(severity).toLowerCase()
            : '';
        const key = uri.toString();
        XliffEditorProvider.pendingOrdinals.set(key, { ordinal: targetOrdinal, severity: targetSeverity });
        await vscode.commands.executeCommand('vscode.openWith', uri, XliffEditorProvider.viewType);
        const records = XliffEditorProvider.panelRecords.get(key);
        if (!records) return true;
        let delivered = false;
        for (const record of records) {
            if (!record.ready) continue;
            await record.panel.webview.postMessage({ type: 'jumpToOrdinal', ordinal: targetOrdinal, severity: targetSeverity });
            delivered = true;
        }
        if (delivered) XliffEditorProvider.pendingOrdinals.delete(key);
        return true;
    }

    static register(context) {
        const provider = new XliffEditorProvider(context);
        if (!XliffEditorProvider.qualityDiagnostics && vscode.languages && typeof vscode.languages.createDiagnosticCollection === 'function') {
            XliffEditorProvider.qualityDiagnostics = vscode.languages.createDiagnosticCollection('AL Xliff Studio Quality');
            if (context && context.subscriptions) context.subscriptions.push(XliffEditorProvider.qualityDiagnostics);
        }
        return vscode.window.registerCustomEditorProvider(XliffEditorProvider.viewType, provider, {
            webviewOptions: { retainContextWhenHidden: true },
            supportsMultipleEditorsPerDocument: true
        });
    }

    static async runQualityCheckForUri(uri, text) {
        const perf = createPerformanceTrace(uri, 'quality.runForUri', { suppliedText: typeof text === 'string' });
        try {
            if (!uri || isGeneratorFilename(uri)) {
                if (uri) clearQualityDiagnostics(uri);
                return undefined;
            }
            const sourceText = typeof text === 'string' ? text : await readText(uri);
            perf.mark('read XLIFF', { chars: sourceText.length });
            const session = getDocumentSession(uri, sourceText);
            const analysis = await analyzeQualityForText(uri, sourceText, {
                session,
                onPhase: (phase, meta) => perf.mark(phase, meta)
            });
            if (!analysis.parsed || !analysis.parsed.targetLanguage) {
                clearQualityDiagnostics(uri);
                return undefined;
            }
            if (analysis.stale) {
                perf.mark('skip stale diagnostics');
                return undefined;
            }
            publishQualityDiagnosticsForText(uri, sourceText, analysis.report, analysis.parsed, undefined, perf);
            perf.mark('publish diagnostics', { issues: analysis.report && analysis.report.summary ? analysis.report.summary.total : undefined });
            return analysis.report;
        } catch (err) {
            if (isWorkerCancellation(err)) { perf.mark('quality cancelled'); return undefined; }
            perf.fail(err);
            throw err;
        } finally {
            perf.end();
        }
    }

    static invalidateQualityAnalysis(uri) {
        invalidateQualityAnalysis(uri);
    }

    static clearQualityDiagnostics(uri) {
        clearQualityDiagnostics(uri);
    }

    async resolveCustomTextEditor(document, webviewPanel) {
        webviewPanel.webview.options = { enableScripts: true };
        webviewPanel.webview.html = this.getHtml(webviewPanel.webview);
        let applyingFromWebview = false;
        const suppressedDocumentVersions = new Set();
        let disposed = false;
        const proposalCache = new Map();
        // Manual draft/proposal edits stay in memory until an explicit Save/Apply.
        // Writing a staging <note> into a 10+ MiB XLIFF on every blur/change caused
        // full-document scans, document saves and multi-second Extension Host stalls.
        const volatileStageCache = new Map();
        const pendingAppliedUndo = new Map();
        const rowApplyInProgress = new Set();
        const lastAppliedDraftRevision = new Map();
        let documentLoadId = 0;
        let activeRowStore = new Map();
        let activeViewKeyStore = new Map();
        const viewPageCache = new Map();
        let activeRowStoreLoadId = 0;
        let activeRowStoreVersion = 0;
        let activeDetailContext = {
            parsed: undefined,
            glossaryEntries: [],
            glossaryTermsBySource: new Map(),
            qualityReport: createEmptyQualityReport(),
            provenanceEnabled: true
        };
        let pendingDeferredQuality;
        let deferredQualityRunGeneration = 0;
        let saveQualityRunGeneration = 0;
        let qualityController;
        let loadController;
        const beginQualityRun = (force = true) => {
            if (qualityController) qualityController.abort('New Quality Check run.');
            if (force) invalidateQualityAnalysis(document.uri);
            qualityController = new AbortController();
            return qualityController.signal;
        };
        let qualityRevision = 0;
        let qualityPageStore = createQualityPageStore(createEmptyQualityReport(), 0);
        let qualityPageController = new AbortController();
        let documentMutationQueue = Promise.resolve();
        let explicitSaveInProgress = false;
        let changeObservedDuringExplicitSave = false;
        let scheduledReloadTimer;
        const documentKey = document.uri.toString();
        retainDocumentSession(document.uri);
        const panelRecord = { panel: webviewPanel, ready: false };
        if (!XliffEditorProvider.panelRecords.has(documentKey)) XliffEditorProvider.panelRecords.set(documentKey, new Set());
        XliffEditorProvider.panelRecords.get(documentKey).add(panelRecord);

        const postError = message => {
            if (!disposed) webviewPanel.webview.postMessage({ type: 'error', message: String(message || '') });
        };
        const showTransientStatus = (message, timeout = 6000) => {
            const text = String(message || '');
            if (!text) return;
            if (vscode.window && typeof vscode.window.setStatusBarMessage === 'function') {
                vscode.window.setStatusBarMessage(text, timeout);
                return;
            }
            // Test/older-host fallback only; current VS Code exposes setStatusBarMessage.
            if (vscode.window && typeof vscode.window.showInformationMessage === 'function') {
                void vscode.window.showInformationMessage(text);
            }
        };

        const postQualityReportToWebview = async (report, options = {}) => {
            if (disposed) return;
            qualityPageController.abort('Quality report replaced.');
            qualityPageController = new AbortController();
            qualityPageStore = createQualityPageStore(report, ++qualityRevision);
            await webviewPanel.webview.postMessage({
                type: 'qualityReport',
                report: qualityPageStore.metadata,
                loadId: activeRowStoreLoadId,
                documentVersion: Number(document.version),
                includesDrafts: Boolean(options.includesDrafts),
                preserveVisibility: Boolean(options.preserveVisibility),
                background: Boolean(options.background)
            });
        };

        const materializeActiveRow = row => {
            if (!row) return row;
            const ordinal = Number(row.ordinal);
            const parsed = activeDetailContext.parsed;
            let unit = parsed && Array.isArray(parsed.units) ? parsed.units[ordinal] : undefined;
            if (unit && Number(unit.ordinal) !== ordinal) {
                unit = unitAtOrdinal(parsed, ordinal);
            }
            if (!unit) return row;
            let glossaryTerms = activeDetailContext.glossaryTermsBySource.get(unit.source);
            if (!glossaryTerms) {
                glossaryTerms = findRelevantGlossaryTerms(unit.source, parsed.targetLanguage, activeDetailContext.glossaryEntries || []);
                activeDetailContext.glossaryTermsBySource.set(unit.source, glossaryTerms);
                if (activeDetailContext.glossaryTermsBySource.size > PAGE_DETAIL_GLOSSARY_CACHE_LIMIT) {
                    const oldestSource = activeDetailContext.glossaryTermsBySource.keys().next().value;
                    if (oldestSource !== undefined) activeDetailContext.glossaryTermsBySource.delete(oldestSource);
                }
            }
            const report = activeDetailContext.qualityReport || createEmptyQualityReport();
            return materializeEditorRowDetails(row, unit, {
                targetLanguage: parsed.targetLanguage,
                provenanceEnabled: activeDetailContext.provenanceEnabled,
                glossaryTerms,
                qualityIssues: report.byOrdinal instanceof Map ? (report.byOrdinal.get(ordinal) || []) : [],
                ignoredQualityIssues: report.ignoredByOrdinal instanceof Map ? (report.ignoredByOrdinal.get(ordinal) || []) : []
            });
        };

        const updateActiveRowStoreQuality = report => {
            const activeByOrdinal = new Map();
            for (const issue of (report && report.issues) || []) {
                if (!Number.isInteger(Number(issue && issue.ordinal))) continue;
                const ordinal = Number(issue.ordinal);
                if (!activeByOrdinal.has(ordinal)) activeByOrdinal.set(ordinal, []);
                activeByOrdinal.get(ordinal).push({ severity: issue.severity, code: issue.code, message: issue.message });
            }
            const previousQualityOrdinals = activeDetailContext.qualityOrdinals instanceof Set
                ? activeDetailContext.qualityOrdinals
                : new Set();
            const nextQualityOrdinals = new Set(activeByOrdinal.keys());
            const affectedOrdinals = new Set([...previousQualityOrdinals, ...nextQualityOrdinals]);
            activeDetailContext.qualityReport = report || createEmptyQualityReport();
            activeDetailContext.qualityOrdinals = nextQualityOrdinals;

            // Quality updates should not rebuild every row/key. Only units whose active
            // quality membership changed need their compact counter and flattened search
            // key updated; structured issue objects are materialized per visible page.
            for (const ordinal of affectedOrdinals) {
                const row = activeRowStore.get(ordinal);
                viewPageCache.clear();
                const keys = activeViewKeyStore.get(ordinal);
                if (!row || !keys) continue;
                const issues = activeByOrdinal.get(ordinal) || [];
                row.qualityIssueCount = issues.length;
                keys.quality = viewLower(issues.map(issue => [issue.code, issue.message].filter(Boolean).join(' ')).join(' | '));
                keys.qualityIssueCount = issues.length;
                refreshViewGlobalKeys(keys);
            }
        };

        const runDeferredQualityAfterFirstPage = async signal => {
            const pending = pendingDeferredQuality;
            if (!pending) return;
            const requestedLoadId = Number(signal && signal.loadId) || 0;
            const requestedVersion = Number(signal && signal.documentVersion) || 0;
            if (requestedLoadId !== pending.loadId || requestedVersion !== pending.documentVersion) return;
            if (requestedLoadId !== activeRowStoreLoadId || requestedVersion !== activeRowStoreVersion) return;

            pendingDeferredQuality = undefined;
            const runGeneration = ++deferredQualityRunGeneration;
            const qualitySignal = beginQualityRun(false);
            const perf = createPerformanceTrace(document.uri, 'xlfEditor.deferredQuality', {
                loadId: requestedLoadId,
                documentVersion: requestedVersion,
                units: activeRowStore.size
            });
            try {
                // The first page DOM is committed before this signal is sent. Yield once
                // more so Chromium can paint before quality analysis uses the host again.
                await yieldToEventLoop();
                if (disposed || runGeneration !== deferredQualityRunGeneration || Number(document.version) !== requestedVersion || activeRowStoreLoadId !== requestedLoadId) return;

                const sourceText = document.getText();
                const session = getDocumentSession(document.uri, sourceText, { version: requestedVersion });
                const parsed = await getParsedDocumentSessionAsync(session, sourceText, async (value, workerOptions) => {
                    const parsedResult = await parseXliffAdaptive(value, pending.config, {
                        ...workerOptions,
                        unitCount: activeRowStore.size,
                        onPhase: (phase, meta) => perf.mark(phase, meta)
                    });
                    return parsedResult.parsed;
                });
                const qualityAnalysis = await analyzeQualityForText(document.uri, sourceText, {
                    signal: qualitySignal,
                    config: pending.config,
                    session,
                    parsed,
                    glossary: pending.glossary,
                    documentVersion: requestedVersion,
                    onPhase: (phase, meta) => perf.mark(phase, meta)
                });

                if (disposed || qualityAnalysis.stale || runGeneration !== deferredQualityRunGeneration || Number(document.version) !== requestedVersion || activeRowStoreLoadId !== requestedLoadId) {
                    perf.mark('discard stale deferred quality result');
                    return;
                }

                const report = qualityAnalysis.report;
                updateActiveRowStoreQuality(report);
                publishQualityDiagnostics(document, report, parsed, perf);
                const editorStats = createEditorSummaryStats(activeRowStore, activeViewKeyStore, report.summary);
                setDocumentSessionStats(
                    session,
                    'xlfEditor',
                    `${qualityAnalysis.fingerprint}:missing=${pending.treatNeedsTranslationAsMissing ? '1' : '0'}`,
                    editorStats
                );
                await postQualityReportToWebview(report, {
                    includesDrafts: false,
                    preserveVisibility: true,
                    background: true
                });
                if (qualityAnalysis.projectIgnoreErrors && qualityAnalysis.projectIgnoreErrors.length) {
                    await webviewPanel.webview.postMessage({
                        type: 'warnings',
                        warnings: [...(pending.baseWarnings || []), `Project Quality Ignore: ${qualityAnalysis.projectIgnoreErrors.join('; ')}`]
                    });
                }
                perf.mark('publish deferred quality', { issues: report && report.summary ? report.summary.total : 0 });
            } catch (err) {
                if (isWorkerCancellation(err)) { perf.mark('deferred quality cancelled'); return; }
                perf.fail(err);
                if (!disposed && runGeneration === deferredQualityRunGeneration && Number(document.version) === requestedVersion) {
                    await webviewPanel.webview.postMessage({ type: 'qualityPending', pending: false, failed: true });
                }
            } finally {
                perf.end();
            }
        };

        let syncStatusController;
        let confirmedSyncVersion = -1;
        let confirmedSyncStatus = 'unknown';
        const refreshSyncStatus = async () => {
            if (syncStatusController) syncStatusController.abort('Sync status refreshed.');
            const controller = new AbortController();
            syncStatusController = controller;
            confirmedSyncVersion = -1;
            confirmedSyncStatus = 'unknown';
            const version = Number(document.version);
            await webviewPanel.webview.postMessage({ type:'syncStatus', status:'checking', documentVersion:version });
            if (document.isDirty || disposed) return;
            try {
                const text = document.getText();
                const parsed = await parseWithDocumentSessionAsync(document.uri, text, version);
                const sibling = await findSiblingGxlf(document.uri, parsed.targetLanguage);
                let status = 'missing-generator';
                if (sibling) {
                    const result = await synchronizeXliffAdaptive(text, await readText(sibling), vscode.workspace.getConfiguration(CONFIG_SECTION), {
                        signal:controller.signal, resourceKey:documentKey + ':sync-status', unitCount:parsed.units.length, includeMemory:false
                    });
                    status = result.text === text ? 'synced' : 'out-of-sync';
                }
                if (controller.signal.aborted || disposed || document.isDirty || Number(document.version) !== version) return;
                confirmedSyncVersion = version;
                confirmedSyncStatus = status;
                await webviewPanel.webview.postMessage({ type:'syncStatus', status, documentVersion:version });
            } catch (error) {
                if (!controller.signal.aborted && !disposed && Number(document.version) === version) {
                    await webviewPanel.webview.postMessage({ type:'syncStatus', status:'error', documentVersion:version });
                }
            }
        };
        const postSaveState = async () => {
            if (!disposed) {
                await webviewPanel.webview.postMessage({
                    type: 'saveState',
                    dirty: Boolean(document.isDirty),
                    documentVersion: Number(document.version)
                });
            }
        };

        const provenanceEnabled = () => vscode.workspace.getConfiguration(CONFIG_SECTION).get('provenance.enabled', true) !== false;

        const loadCompanionMap = async parsed => {
            const language = parsed.targetLanguage;
            if (!language) return new Map();
            const mapUri = await getMapUriForXlf(document.uri, language);
            try {
                return entriesToMap(parseLng(await readText(mapUri)).entries);
            } catch (err) {
                if (isFileNotFound(err)) return new Map();
                return new Map();
            }
        };

        const postDocument = async () => {
            if (disposed) return;
            if (scheduledReloadTimer) clearTimeout(scheduledReloadTimer);
            scheduledReloadTimer = undefined;
            if (loadController) {
                loadController.abort('New document load.');
                invalidateDocumentSession(document.uri);
            }
            const controller = new AbortController();
            loadController = controller;
            if (qualityController) qualityController.abort('Document reloaded.');
            pendingDeferredQuality = undefined;
            deferredQualityRunGeneration++;
            const loadId = ++documentLoadId;
            const snapshotVersion = Number(document.version);
            const perf = createPerformanceTrace(document.uri, 'xlfEditor.postDocument', { loadId, documentVersion: snapshotVersion, dirty: Boolean(document.isDirty) });
            try {
            const sourceText = document.getText();
            const abandonStaleSnapshot = async phase => {
                const currentVersion = Number(document.version);
                const stale = controller.signal.aborted || disposed || loadId !== documentLoadId || currentVersion !== snapshotVersion;
                if (!stale) return false;
                perf.mark('discard stale document snapshot', { phase, snapshotVersion, currentVersion, loadId, activeLoadId: documentLoadId });
                if (!disposed && loadId === documentLoadId) {
                    await webviewPanel.webview.postMessage({ type: 'loadCancelled', loadId, documentVersion: currentVersion });
                }
                return true;
            };
            const estimatedUnits = countTransUnitsFast(sourceText);
            perf.mark('read document text', { chars: sourceText.length, estimatedUnits });
            const showLoadingProgress = estimatedUnits >= DOCUMENT_LOADING_OVERLAY_THRESHOLD;
            if (showLoadingProgress) {
                await webviewPanel.webview.postMessage({
                    type: 'loadStart',
                    loadId,
                    stage: 'Reading XLIFF',
                    current: 0,
                    total: estimatedUnits
                });
                await yieldToEventLoop();
                if (await abandonStaleSnapshot('after load start')) return;
            }

            const config = vscode.workspace.getConfiguration(CONFIG_SECTION, document.uri);
            const session = getDocumentSession(document.uri, sourceText, { version: snapshotVersion });
            const reusedParsedSession = Boolean(session.parsed);
            const parsed = await getParsedDocumentSessionAsync(session, sourceText, async (value, workerOptions) => {
                const parsedResult = await parseXliffAdaptive(value, config, {
                    ...workerOptions,
                    unitCount: estimatedUnits,
                    onPhase: (phase, meta) => perf.mark(phase, meta)
                });
                return parsedResult.parsed;
            });
            perf.mark('parse XLIFF', { units: parsed.units.length, reusedSession: reusedParsedSession });
            if (await abandonStaleSnapshot('after parse XLIFF')) return;
            const readOnly = isGeneratorXliff(document.uri, parsed);
            const provenanceIsEnabled = config.get('provenance.enabled', true) !== false;
            const treatNeedsTranslationAsMissing = config.get('treatNeedsTranslationAsMissing', true);
            const glossary = config.get('glossary.enabled', true) ? await readProjectGlossary(document.uri) : { entries: [], errors: [] };
            perf.mark('read glossary', { glossaryEntries: (glossary.entries || []).length });
            if (await abandonStaleSnapshot('after glossary')) return;
            const glossaryEntries = glossary.entries || [];
            const deferInitialQuality = shouldDeferInitialQuality(sourceText, parsed);
            let qualityAnalysis;
            let qualityReport;
            if (deferInitialQuality) {
                qualityReport = createEmptyQualityReport();
                qualityAnalysis = {
                    report: qualityReport,
                    projectIgnoreErrors: [],
                    fingerprint: `deferred:${session.contentHash}`,
                    cacheHit: false,
                    sharedRun: false,
                    stale: false,
                    deferred: true
                };
                perf.mark('defer quality check until first page', { chars: sourceText.length, units: parsed.units.length });
            } else {
                qualityAnalysis = await analyzeQualityForText(document.uri, sourceText, {
                    signal: controller.signal,
                    config,
                    session,
                    parsed,
                    glossary,
                    documentVersion: snapshotVersion,
                    onPhase: (phase, meta) => {
                        if (phase === 'analyze quality' || phase === 'quality cache hit' || phase === 'await existing quality run') perf.mark(phase, meta);
                    }
                });
                if (await abandonStaleSnapshot('after quality analysis')) return;
                qualityReport = qualityAnalysis.report;
                if (!qualityAnalysis.stale) publishQualityDiagnostics(document, qualityReport, parsed, perf);
                perf.mark('quality check', { qualityIssues: qualityReport && qualityReport.summary ? qualityReport.summary.total : undefined, cacheHit: Boolean(qualityAnalysis.cacheHit), sharedRun: Boolean(qualityAnalysis.sharedRun) });
            }
            const rows = [];
            const preparedViewKeys = new Map();
            const glossaryTermsBySource = new Map();

            if (showLoadingProgress) {
                await webviewPanel.webview.postMessage({
                    type: 'loadProgress',
                    loadId,
                    stage: 'Preparing rows',
                    current: 0,
                    total: parsed.units.length
                });
                await yieldToEventLoop();
                if (await abandonStaleSnapshot('before row preparation')) return;
            }

            for (let unitIndex = 0; unitIndex < parsed.units.length; unitIndex++) {
                const unit = parsed.units[unitIndex];
                const notTranslatable = String(unit.translate || '').trim().toLowerCase() === 'no';
                const missing = !notTranslatable && isMissingTranslation(unit, treatNeedsTranslationAsMissing);
                const review = !notTranslatable && isReviewTranslation(unit);

                let persistedStage = volatileStageCache.get(unit.ordinal) || getStagedTranslation(unit);
                if (persistedStage && persistedStage.source && persistedStage.source !== unit.source) {
                    volatileStageCache.delete(unit.ordinal);
                    persistedStage = getStagedTranslation(unit);
                }
                let cached = proposalCache.get(unit.ordinal);
                if (persistedStage && persistedStage.kind === 'proposal') {
                    cached = {
                        source: unit.source,
                        text: persistedStage.text,
                        provenance: persistedStage.provenance,
                        origin: persistedStage.origin || formatProvenanceLabel(persistedStage.provenance)
                    };
                    proposalCache.set(unit.ordinal, cached);
                } else if (persistedStage && persistedStage.kind === 'draft') {
                    proposalCache.delete(unit.ordinal);
                    cached = undefined;
                } else if (cached && cached.source !== unit.source) {
                    proposalCache.delete(unit.ordinal);
                    cached = undefined;
                }

                const target = unit.target === undefined ? '' : unit.target;
                const maxWidthExceeded = Number.isFinite(unit.maxWidth) && target.length > unit.maxWidth;
                const translationPlaceholderValidation = getPlaceholderValidation(unit.source, target);
                const proposalPlaceholderValidation = getPlaceholderValidation(unit.source, cached ? cached.text : '');
                let glossaryTerms = glossaryTermsBySource.get(unit.source);
                if (!glossaryTerms) {
                    glossaryTerms = findRelevantGlossaryTerms(unit.source, parsed.targetLanguage, glossaryEntries);
                    glossaryTermsBySource.set(unit.source, glossaryTerms);
                }
                const translationTerminologyViolations = findTerminologyViolationsForTerms(target, glossaryTerms);
                const proposalTerminologyViolations = findTerminologyViolationsForTerms(cached ? cached.text : '', glossaryTerms);
                const glossaryHints = glossaryTerms.map(term => ({ source: term.source, translation: term.translation }));
                const qualityIssues = (qualityReport.byOrdinal.get(unit.ordinal) || []).map(issue => ({
                    severity: issue.severity, code: issue.code, message: issue.message
                }));
                const provenanceHistory = provenanceIsEnabled ? getProvenanceHistory(unit.noteDetails || []) : [];
                const persistedProvenance = provenanceIsEnabled ? latestProvenance(unit.noteDetails || []) : undefined;
                const persistedProvenanceLabel = provenanceIsEnabled ? formatProvenanceLabel(persistedProvenance) : '';
                // Provenance notes remain hidden from the ordinary Notes column even when
                // provenance display/recording is disabled. Existing history is preserved
                // in the XLIFF but simply not surfaced by the Studio UI.
                const visibleNotes = (unit.noteDetails || []).filter(note =>
                    !isProvenanceNoteDetail(note) &&
                    !isStagedTranslationNoteDetail(note) &&
                    !qualityIgnoreFromNoteDetail(note) &&
                    String(note && note.from || '').trim().toLowerCase() !== 'xliff generator'
                );
                const generatorNoteText = ((unit.noteDetails || []).find(note =>
                    String(note && note.from || '').trim().toLowerCase() === 'xliff generator'
                ) || {}).text || '';
                const fullRow = {
                    ordinal: unit.ordinal,
                    id: unit.id,
                    source: unit.source,
                    generatorNote: generatorNoteText,
                    translation: target,
                    targetExists: unit.target !== undefined,
                    status: displayStatus(unit),
                    rawState: unit.targetState || '',
                    translate: unit.translate || '',
                    notTranslatable,
                    missing,
                    review,
                    notes: visibleNotes,
                    hasTranslationDraft: Boolean(persistedStage && persistedStage.kind === 'draft'),
                    translationDraft: persistedStage && persistedStage.kind === 'draft' ? persistedStage.text : '',
                    translationDraftOrigin: persistedStage && persistedStage.kind === 'draft'
                        ? (persistedStage.origin || formatProvenanceLabel(persistedStage.provenance))
                        : '',
                    translationDraftProvenance: persistedStage && persistedStage.kind === 'draft'
                        ? (sanitizeProvenance(persistedStage.provenance) || undefined)
                        : undefined,
                    proposal: cached ? cached.text : '',
                    proposalOrigin: cached ? (cached.origin || formatProvenanceLabel(cached.provenance)) : '',
                    proposalProvenance: cached ? (sanitizeProvenance(cached.provenance) || undefined) : undefined,
                    translationProvenance: persistedProvenance,
                    translationProvenanceLabel: persistedProvenanceLabel,
                    provenanceHistory,
                    provenanceHistoryLabels: provenanceHistory.map(formatProvenanceHistory),
                    maxWidth: unit.maxWidth,
                    maxWidthExceeded,
                    translationPlaceholderError: translationPlaceholderValidation.error,
                    proposalPlaceholderError: proposalPlaceholderValidation.error,
                    glossaryTerms: glossaryHints,
                    translationTerminologyError: translationTerminologyViolations.length > 0,
                    proposalTerminologyError: proposalTerminologyViolations.length > 0,
                    qualityIssues,
                    ignoredQualityIssues: qualityReport.ignoredByOrdinal.get(unit.ordinal) || [],
                    canAcceptTranslation: canAcceptPersistedTranslation(unit, readOnly),
                    appliedUndo: pendingAppliedUndo.has(unit.ordinal)
                };
                preparedViewKeys.set(Number(unit.ordinal), createViewSearchSortKeys(fullRow));
                rows.push(compactEditorRow(fullRow));

                if (showLoadingProgress && ((unitIndex + 1) % ROW_PREPARE_CHUNK_SIZE === 0 || unitIndex + 1 === parsed.units.length)) {
                    await webviewPanel.webview.postMessage({
                        type: 'loadProgress',
                        loadId,
                        stage: 'Preparing rows',
                        current: unitIndex + 1,
                        total: parsed.units.length
                    });
                    await yieldToEventLoop();
                    if (await abandonStaleSnapshot('during row preparation')) return;
                }
            }

            perf.mark('prepare rows', { rows: rows.length, uniqueGlossarySources: glossaryTermsBySource.size });
            const duplicateIds = findDuplicateIds(parsed);
            const duplicateNotes = findDuplicateGeneratorNotes(parsed);
            const warnings = [];
            if (duplicateIds.length) warnings.push(`Duplicate trans-unit ids: ${duplicateIds.join(', ')}`);
            if (duplicateNotes.length) warnings.push(`${duplicateNotes.length} duplicate Xliff Generator note(s)`);
            if (glossary.errors && glossary.errors.length) warnings.push(`Glossary: ${glossary.errors.join('; ')}`);
            if (qualityAnalysis.projectIgnoreErrors && qualityAnalysis.projectIgnoreErrors.length) warnings.push(`Project Quality Ignore: ${qualityAnalysis.projectIgnoreErrors.join('; ')}`);
            if (deferInitialQuality) {
                pendingDeferredQuality = {
                    loadId,
                    documentVersion: snapshotVersion,
                    config,
                    glossary,
                    treatNeedsTranslationAsMissing,
                    baseWarnings: warnings.slice()
                };
            }

            if (await abandonStaleSnapshot('before editor update')) return;
            if (showLoadingProgress) {
                await webviewPanel.webview.postMessage({
                    type: 'loadProgress',
                    loadId,
                    stage: 'Updating editor',
                    current: parsed.units.length,
                    total: parsed.units.length
                });
                await yieldToEventLoop();
                if (await abandonStaleSnapshot('after editor update yield')) return;
            }

            // Keep full row objects in the extension host. The search/sort key store
            // and summary counters are both prepared once for this DocumentSession.
            // updateSummary() in the webview can then remain O(1) instead of repeatedly
            // scanning every translation unit.
            activeRowStore = new Map(rows.map(row => [Number(row.ordinal), row]));
            viewPageCache.clear();
            activeViewKeyStore = preparedViewKeys;
            activeDetailContext = {
                parsed,
                glossaryEntries,
                glossaryTermsBySource: new Map(),
                qualityReport,
                qualityOrdinals: qualityReport && qualityReport.byOrdinal instanceof Map ? new Set(qualityReport.byOrdinal.keys()) : new Set(),
                provenanceEnabled: provenanceIsEnabled
            };
            const editorStats = createEditorSummaryStats(activeRowStore, activeViewKeyStore, qualityReport.summary);
            setDocumentSessionStats(
                session,
                'xlfEditor',
                `${qualityAnalysis.fingerprint}:missing=${treatNeedsTranslationAsMissing ? '1' : '0'}`,
                editorStats
            );
            activeRowStoreLoadId = loadId;
            activeRowStoreVersion = snapshotVersion;
            const rowStateIndex = rows.map(createWebviewRowIndexEntry).filter(Boolean);

            await webviewPanel.webview.postMessage({
                type: 'document',
                loadId,
                documentVersion: snapshotVersion,
                largeDocument: showLoadingProgress,
                qualityPending: deferInitialQuality,
                rowStateIndex,
                sourceLanguage: parsed.sourceLanguage || '',
                targetLanguage: parsed.targetLanguage || '',
                readOnly,
                generated: isGeneratorFilename(document.uri),
                dirty: Boolean(document.isDirty),
                provenanceEnabled: provenanceIsEnabled,
                stats: editorStats,
                warnings,
                performanceDebugEnabled: isPerformanceDebugEnabled(config),
                performanceDebugSlowThresholdMs: getSlowThresholdMs(config)
            });
            if (!deferInitialQuality) await postQualityReportToWebview(qualityReport, { preserveVisibility: true, background: true });
            perf.mark('post document payload', { rows: rows.length, compactStatesSent: rowStateIndex.length, fullRowsSent: 0 });
            } catch (err) {
                if (isWorkerCancellation(err)) {
                    perf.mark('document load cancelled');
                    if (!disposed && loadId === documentLoadId) await webviewPanel.webview.postMessage({ type: 'loadCancelled', loadId, documentVersion: Number(document.version) });
                    return;
                }
                perf.fail(err);
                throw err;
            } finally {
                if (loadController === controller) loadController = undefined;
                perf.end({ loadId });
            }
        };

        // External document changes can arrive in bursts (format-on-save, source-control
        // integrations, other XLIFF extensions). Collapse those events into one reload so a
        // large XLIFF is never reparsed/prepared repeatedly for the same user action.
        const scheduleDocumentReload = (delay = 90) => {
            if (disposed) return;
            if (scheduledReloadTimer) clearTimeout(scheduledReloadTimer);
            scheduledReloadTimer = setTimeout(() => {
                scheduledReloadTimer = undefined;
                void postDocument();
            }, Math.max(0, Number(delay) || 0));
        };

        const applyText = async newText => {
            const oldText = document.getText();
            if (oldText === newText) return false;

            // Apply only the smallest changed range instead of replacing the entire XLIFF.
            // For large translation files a one-attribute state change should remain a tiny
            // document edit and must not make VS Code reprocess thousands of unchanged lines.
            const editVersion = Number(document.version);
            const { prefix: prefixLength, oldEnd: oldSuffix, newEnd: newSuffix } = await changedTextRange(oldText, newText);
            if (disposed || Number(document.version) !== editVersion) throw abortError('Document changed while preparing the text edit.');

            const changedRange = new vscode.Range(document.positionAt(prefixLength), document.positionAt(oldSuffix));
            const replacement = newText.slice(prefixLength, newSuffix);
            const edit = new vscode.WorkspaceEdit();
            edit.replace(document.uri, changedRange, replacement);
            applyingFromWebview = true;
            const expectedDocumentVersion = Number(document.version) + 1;
            suppressedDocumentVersions.add(expectedDocumentVersion);
            try {
                const applied = await vscode.workspace.applyEdit(edit);
                if (!applied) suppressedDocumentVersions.delete(expectedDocumentVersion);
                if (applied) {
                    invalidateQualityAnalysis(document.uri);
                    clearQualityDiagnostics(document.uri);
                    await postSaveState();
                }
                return applied;
            } finally {
                applyingFromWebview = false;
            }
        };

        const applyUnitRawReplacement = async (unit, replacement) => {
            if (!unit || !Number.isInteger(Number(unit.startOffset)) || !Number.isInteger(Number(unit.endOffset))) return false;
            const currentRaw = document.getText().slice(Number(unit.startOffset), Number(unit.endOffset));
            if (currentRaw === replacement) return false;
            const edit = new vscode.WorkspaceEdit();
            edit.replace(
                document.uri,
                new vscode.Range(document.positionAt(Number(unit.startOffset)), document.positionAt(Number(unit.endOffset))),
                replacement
            );
            applyingFromWebview = true;
            const expectedDocumentVersion = Number(document.version) + 1;
            suppressedDocumentVersions.add(expectedDocumentVersion);
            try {
                const applied = await vscode.workspace.applyEdit(edit);
                if (!applied) suppressedDocumentVersions.delete(expectedDocumentVersion);
                if (applied) {
                    invalidateQualityAnalysis(document.uri);
                    clearQualityDiagnostics(document.uri);
                    await postSaveState();
                }
                return applied;
            } finally {
                applyingFromWebview = false;
            }
        };

        const persistStagedItemsNow = async items => {
            const requested = Array.isArray(items) ? items : [];
            if (!requested.length) return false;
            const perf = createPerformanceTrace(document.uri, 'xlfEditor.persistStagedItems', { items: requested.length, documentVersion: Number(document.version) });
            try {
            const includeProvenance = provenanceEnabled();
            const persistenceItems = requested.map(item => {
                if (!item || !item.staged) return item;
                return {
                    ...item,
                    staged: {
                        ...item.staged,
                        provenance: includeProvenance ? item.staged.provenance : undefined,
                        origin: includeProvenance ? item.staged.origin : ''
                    }
                };
            });
            const result = setStagedTranslations(document.getText(), persistenceItems);
            perf.mark('set staged translations', { updated: result.updatedCount });
            if (!result.updatedCount) return false;
            const applied = await applyText(result.text);
            perf.mark('apply text', { applied });
            if (!applied) return false;

            // Never auto-save the backing XLIFF for staging metadata. Auto-saving a large
            // XLIFF from a blur/change event can block VS Code for seconds. The editor is
            // marked dirty and the normal explicit Save persists the metadata to disk.
            await postSaveState();
            perf.mark('post save state');
            return true;
            } catch (err) {
                perf.fail(err);
                throw err;
            } finally {
                perf.end();
            }
        };

        const enqueueDocumentMutation = operation => {
            const run = documentMutationQueue.then(operation, operation);
            // Keep the queue alive after a failed mutation; the caller still receives the error.
            documentMutationQueue = run.catch(() => undefined);
            return run;
        };

        const waitForDocumentMutations = () => documentMutationQueue.catch(() => undefined);

        const persistStagedItems = items => enqueueDocumentMutation(() => persistStagedItemsNow(items));

        const persistStagedItem = (ordinal, staged) => persistStagedItems([{ ordinal, staged }]);

        const writeAcceptedToMap = async (accepted, knownTargetLanguage) => {
            const targetLanguage = knownTargetLanguage || (await parseWithDocumentSessionAsync(document.uri, document.getText(), Number(document.version))).targetLanguage;
            if (!targetLanguage || !accepted.length) return;
            const candidates = new Map();
            for (const item of accepted) {
                if (!item.source || !item.translation) continue;
                if (!candidates.has(item.source)) candidates.set(item.source, new Set());
                candidates.get(item.source).add(item.translation);
            }
            const additions = [];
            for (const [source, translations] of candidates) {
                if (translations.size === 1) additions.push({ source, translation: [...translations][0] });
            }
            if (!additions.length) return;

            const mapUri = await getMapUriForXlf(document.uri, targetLanguage);
            let existing = { entries: [] };
            try {
                existing = parseLng(await readText(mapUri));
            } catch (err) {
                if (!isFileNotFound(err)) throw err;
            }
            const merged = mergeEntries(existing.entries, additions, { overwrite: true });
            await writeText(mapUri, serializeLng(merged.entries, targetLanguage));
        };

        const updateCompanionMapFromXliffTexts = async (xlfTexts, memorySnapshots) => {
            const parsedCurrent = await parseWithDocumentSessionAsync(document.uri, document.getText(), Number(document.version));
            if (!parsedCurrent.targetLanguage) return { pairCount: 0, conflictCount: 0 };

            const mapUri = await getMapUriForXlf(document.uri, parsedCurrent.targetLanguage);
            let existing = { entries: [] };
            try {
                existing = parseLng(await readText(mapUri));
            } catch (err) {
                if (!isFileNotFound(err)) throw err;
            }

            const result = memorySnapshots ? mergeTranslationMemorySnapshots(existing.entries, memorySnapshots) : mergeTranslationMemoryFromXliffTexts(existing.entries, xlfTexts);
            await writeText(mapUri, serializeLng(result.entries, parsedCurrent.targetLanguage));
            return result;
        };

        const changeSubscription = vscode.workspace.onDidChangeTextDocument(event => {
            if (event.document.uri.toString() !== document.uri.toString()) return;
            if (Array.isArray(event.contentChanges) && !event.contentChanges.length) { void postSaveState(); return; }
            if (syncStatusController) syncStatusController.abort('Document changed.');
            confirmedSyncVersion = -1;
            confirmedSyncStatus = 'unknown';
            void webviewPanel.webview.postMessage({type:'syncStatus',status:'unknown',documentVersion:Number(document.version)});
            if (qualityController) qualityController.abort('Document changed.');
            if (loadController) loadController.abort('Document changed.');
            qualityPageController.abort('Document changed.');
            void webviewPanel.webview.postMessage({ type: 'qualityInvalidated' });
            invalidateQualityAnalysis(document.uri);
            invalidateDocumentSession(document.uri);
            if (suppressedDocumentVersions.delete(Number(event.document.version))) return;
            if (applyingFromWebview) return;
            clearQualityDiagnostics(document.uri);
            if (explicitSaveInProgress) {
                changeObservedDuringExplicitSave = true;
                return;
            }
            scheduleDocumentReload();
        });

        const saveSubscription = vscode.workspace.onDidSaveTextDocument(event => {
            if (event.uri.toString() !== document.uri.toString()) return;
            pendingAppliedUndo.clear();
            void postSaveState();
        });

        webviewPanel.onDidDispose(() => {
            disposed = true;
            if (qualityController) qualityController.abort('Editor closed.');
            if (loadController) loadController.abort('Editor closed.');
            qualityPageController.abort('Editor closed.');
            if (syncStatusController) syncStatusController.abort('Editor closed.');
            pendingDeferredQuality = undefined;
            deferredQualityRunGeneration++;
            releaseDocumentSession(document.uri);
            if (scheduledReloadTimer) clearTimeout(scheduledReloadTimer);
            scheduledReloadTimer = undefined;
            changeSubscription.dispose();
            saveSubscription.dispose();
            const records = XliffEditorProvider.panelRecords.get(documentKey);
            if (records) {
                records.delete(panelRecord);
                if (!records.size) {
                    XliffEditorProvider.panelRecords.delete(documentKey);
                    invalidateQualityAnalysis(document.uri);
                    invalidateDocumentSession(document.uri);
                }
            }
        });

        webviewPanel.webview.onDidReceiveMessage(async message => {
            if (message && message.type === 'requestQualityPage') {
                const store = qualityPageStore;
                if (disposed || Number(message.revision) !== store.revision || Number(message.loadId) !== activeRowStoreLoadId || Number(message.documentVersion) !== Number(document.version)) return;
                const perf = createPerformanceTrace(document.uri, 'xlfEditor.qualityPage', { revision: store.revision });
                try {
                    const result = await queryQualityPage(store, message, { signal: qualityPageController.signal });
                    if (disposed || store !== qualityPageStore || Number(message.documentVersion) !== Number(document.version)) return;
                    await webviewPanel.webview.postMessage({ type: 'qualityPage', ...result, requestId: Number(message.requestId), loadId: activeRowStoreLoadId, documentVersion: Number(document.version) });
                    perf.mark('post quality page', { items: result.items.length, filteredCount: result.filteredCount, cacheHit: result.cacheHit });
                } catch (error) {
                    if (!isWorkerCancellation(error)) { perf.fail(error); postError(formatError(error)); }
                } finally { perf.end(); }
                return;
            }
            if (message && message.type === 'requestViewPage') {
                const requestId = Number(message.requestId) || 0;
                const requestedLoadId = Number(message.loadId) || 0;
                if (requestedLoadId !== activeRowStoreLoadId) {
                    await webviewPanel.webview.postMessage({
                        type: 'viewPage', requestId, loadId: activeRowStoreLoadId,
                        documentVersion: activeRowStoreVersion, stale: true,
                        page: 1, pageCount: 1, filteredCount: 0, totalCount: activeRowStore.size,
                        start: 0, end: 0, rows: []
                    });
                    return;
                }
                const result = queryViewRows(activeRowStore, { ...message, documentVersion: Number(document.version) }, activeViewKeyStore, viewPageCache);
                const pageRows = result.rows.map(materializeActiveRow);
                await webviewPanel.webview.postMessage({
                    type: 'viewPage', requestId, loadId: activeRowStoreLoadId,
                    documentVersion: activeRowStoreVersion,
                    page: result.page,
                    pageSize: result.pageSize,
                    pageCount: result.pageCount,
                    filteredCount: result.filteredCount,
                    totalCount: result.totalCount,
                    start: result.start,
                    end: result.end,
                    rows: pageRows
                });
                return;
            }
            if (message && message.type === 'initialPageRendered') {
                void runDeferredQualityAfterFirstPage(message);
                return;
            }
            if (message && message.type === 'performanceTrace') {
                void appendPerformanceEvent(document.uri, {
                    traceId: String(message.traceId || 'webview'),
                    operation: String(message.operation || 'xlfEditor.webview'),
                    event: Number(message.durationMs) >= getSlowThresholdMs(document.uri) ? 'WEBVIEW-SLOW' : 'WEBVIEW',
                    phase: String(message.phase || ''),
                    elapsedMs: Number(message.durationMs) || 0,
                    deltaMs: Number(message.durationMs) || 0,
                    thresholdMs: getSlowThresholdMs(document.uri),
                    slow: Number(message.durationMs) >= getSlowThresholdMs(document.uri),
                    meta: message.meta && typeof message.meta === 'object' ? message.meta : {}
                });
                return;
            }
            const messagePerf = createPerformanceTrace(document.uri, `xlfEditor.message.${String(message && message.type || 'unknown')}`, { documentVersion: Number(document.version), dirty: Boolean(document.isDirty) });
            try {
                if (message.type === 'ready' || message.type === 'refresh') {
                    if (message.type === 'ready') panelRecord.ready = true;
                    await postDocument();
                    await refreshSyncStatus();
                    if (message.type === 'ready') {
                        const pendingFilter = XliffEditorProvider.pendingFilters.get(documentKey);
                        if (pendingFilter) {
                            await webviewPanel.webview.postMessage({ type: 'dashboardFilter', filter: pendingFilter });
                            XliffEditorProvider.pendingFilters.delete(documentKey);
                        }
                        if (XliffEditorProvider.pendingQualityChecks.has(documentKey)) {
                            await webviewPanel.webview.postMessage({ type: 'triggerQualityCheck' });
                            XliffEditorProvider.pendingQualityChecks.delete(documentKey);
                        }
                        if (XliffEditorProvider.pendingOrdinals.has(documentKey)) {
                            const pendingNavigation = XliffEditorProvider.pendingOrdinals.get(documentKey);
                            const pendingOrdinal = pendingNavigation && typeof pendingNavigation === 'object'
                                ? Number(pendingNavigation.ordinal)
                                : Number(pendingNavigation);
                            const pendingSeverity = pendingNavigation && typeof pendingNavigation === 'object'
                                ? String(pendingNavigation.severity || '')
                                : '';
                            await webviewPanel.webview.postMessage({ type: 'jumpToOrdinal', ordinal: pendingOrdinal, severity: pendingSeverity });
                            XliffEditorProvider.pendingOrdinals.delete(documentKey);
                        }
                    }
                    return;
                }
                if (message.type === 'goToSourceDefinition') {
                    const parsed = await parseWithDocumentSessionAsync(document.uri, document.getText(), Number(document.version));
                    const unit = unitAtOrdinal(parsed, Number(message.ordinal));
                    if (!unit) {
                        postError('The selected translation unit could not be found.');
                        return;
                    }
                    await openAlSourceDefinition(document.uri, unit, parsed.targetLanguage);
                    return;
                }
                if (message.type === 'openXliffUnitSource') {
                    await openXliffUnitSource(document, Number(message.ordinal));
                    return;
                }
                if (message.type === 'openText') {
                    await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
                    return;
                }
                if (message.type === 'saveDocument') {
                    // Saving must stay on the short UI-critical path. In particular, do not
                    // await a full Quality Check here: on a large XLIFF that can keep the
                    // extension host/webview busy long enough for VS Code to mark the window
                    // unresponsive immediately after the user clicks Save.
                    await waitForDocumentMutations();
                    messagePerf.mark('wait for pending document mutations');

                    const requestedStages = Array.isArray(message.items) ? message.items : [];
                    if (requestedStages.length) {
                        await enqueueDocumentMutation(async () => {
                            const stageChanges = requestedStages
                                .filter(item => item && Number.isInteger(Number(item.ordinal)) && typeof item.translation === 'string')
                                .map(item => ({
                                    ordinal: Number(item.ordinal),
                                    staged: {
                                        kind: item.kind === 'proposal' ? 'proposal' : 'draft',
                                        text: item.translation,
                                        provenance: provenanceEnabled() ? item.provenance : undefined,
                                        origin: provenanceEnabled() ? String(item.origin || '') : ''
                                    }
                                }));
                            if (!stageChanges.length) return;
                            const stagedResult = setStagedTranslations(document.getText(), stageChanges);
                            if (stagedResult.updatedCount) await applyText(stagedResult.text);
                        });
                    }

                    messagePerf.mark('persist requested stages', { stages: requestedStages.length });
                    const beforeSaveText = document.getText();
                    const beforeSaveVersion = Number(document.version);
                    let saved = true;
                    changeObservedDuringExplicitSave = false;
                    explicitSaveInProgress = true;
                    try {
                        if (document.isDirty) saved = await document.save();
                    } finally {
                        explicitSaveInProgress = false;
                    }
                    if (!saved) {
                        postError('The XLIFF file could not be saved.');
                        await postSaveState();
                        return;
                    }
                    await postSaveState();
                    messagePerf.mark('document save', { saved, documentVersion: Number(document.version) });

                    const finalText = document.getText();
                    const finalVersion = Number(document.version);
                    const saveParticipantChangedDocument = changeObservedDuringExplicitSave || finalText !== beforeSaveText || finalVersion !== beforeSaveVersion;
                    if (saveParticipantChangedDocument) {
                        // Never reconcile tens of thousands of rows synchronously inside Save.
                        // A save participant changed the document, so let the normal asynchronous
                        // reload rebuild the row store after Save has already returned to the UI.
                        scheduleDocumentReload(0);
                    }
                    for (const item of requestedStages) {
                        const itemOrdinal = Number(item && item.ordinal);
                        if (Number.isInteger(itemOrdinal)) volatileStageCache.delete(itemOrdinal);
                    }

                    // Quality and parsing are maintenance work. They start only after the Save
                    // handler has yielded back to VS Code; no full XLIFF parse belongs on the
                    // user-visible Save critical path.
                    const qualityGeneration = ++saveQualityRunGeneration;
                    pendingDeferredQuality = undefined;
                    deferredQualityRunGeneration++;
                    const qualitySignal = beginQualityRun(false);
                    const qualityVersion = finalVersion;
                    const qualityText = finalText;
                    const qualityDraftItems = requestedStages
                        .filter(item => item && Number.isInteger(Number(item.ordinal)) && typeof item.translation === 'string')
                        .map(item => ({ ordinal: Number(item.ordinal), translation: item.translation }));
                    void webviewPanel.webview.postMessage({ type: 'qualityPending', pending: true });
                    void (async () => {
                        await yieldToEventLoop();
                        await yieldToEventLoop();
                        if (qualitySignal.aborted || disposed || qualityGeneration !== saveQualityRunGeneration || Number(document.version) !== qualityVersion) return;
                        const qualityPerf = createPerformanceTrace(document.uri, 'xlfEditor.saveQuality', {
                            documentVersion: qualityVersion,
                            drafts: qualityDraftItems.length
                        });
                        try {
                            const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
                            const qualityParsed = await parseWithDocumentSessionAsync(document.uri, qualityText, qualityVersion, config);
                            throwIfCancelled(qualitySignal);
                            if (disposed || qualityGeneration !== saveQualityRunGeneration || Number(document.version) !== qualityVersion) return;
                            const glossary = config.get('glossary.enabled', true) ? await readProjectGlossary(document.uri) : { entries: [] };
                            const projectQualityIgnores = (await readProjectQualityIgnores(document.uri)).ignores || [];
                            let report;
                            if (qualityDraftItems.length) {
                                const draftsByOrdinal = new Map(qualityDraftItems.map(item => [item.ordinal, item.translation]));
                                const effectiveParsed = {
                                    ...qualityParsed,
                                    units: qualityParsed.units.map(unit => draftsByOrdinal.has(unit.ordinal)
                                        ? { ...unit, target: draftsByOrdinal.get(unit.ordinal), targetState: 'translated' }
                                        : unit)
                                };
                                const qualityResult = await analyzeXliffQualityAdaptive(effectiveParsed, {
                                    ...qualityOptionsFromConfiguration(config),
                                    glossaryEntries: glossary.entries || [],
                                    projectQualityIgnores
                                }, qualityText, config, {
                                    signal: qualitySignal,
                                    resourceKey: documentKey,
                                    unitCount: effectiveParsed.units.length,
                                    unitOverrides: qualityDraftItems.map(item => ({ ordinal: item.ordinal, target: item.translation, targetState: 'translated' })),
                                    onPhase: (phase, meta) => qualityPerf.mark(phase, meta)
                                });
                                report = qualityResult.report;
                            } else {
                                const qualityAnalysis = await analyzeQualityForText(document.uri, qualityText, {
                                    signal: qualitySignal,
                                    config,
                                    parsed: qualityParsed,
                                    glossary,
                                    documentVersion: qualityVersion,
                                    onPhase: (phase, meta) => qualityPerf.mark(phase, meta)
                                });
                                if (qualityAnalysis.stale) return;
                                report = qualityAnalysis.report;
                            }
                            if (qualitySignal.aborted || disposed || qualityGeneration !== saveQualityRunGeneration || Number(document.version) !== qualityVersion) {
                                qualityPerf.mark('discard stale save quality result');
                                return;
                            }
                            updateActiveRowStoreQuality(report);
                            publishQualityDiagnostics(document, report, qualityParsed, qualityPerf);
                            qualityPerf.mark('publish save quality', { issues: report && report.summary ? report.summary.total : undefined });
                            await postQualityReportToWebview(report, {
                                includesDrafts: qualityDraftItems.length > 0,
                                preserveVisibility: true,
                                background: true
                            });
                        } catch (err) {
                            if (isWorkerCancellation(err)) { qualityPerf.mark('save quality cancelled'); return; }
                            qualityPerf.fail(err);
                            if (!disposed && qualityGeneration === saveQualityRunGeneration) {
                                await webviewPanel.webview.postMessage({ type: 'qualityPending', pending: false });
                            }
                        } finally {
                            qualityPerf.end();
                        }
                    })();
                    return;
                }
                if (message.type === 'openDashboard') {
                    await vscode.commands.executeCommand(`${COMMAND_PREFIX}.openDashboard`);
                    return;
                }
                if (message.type === 'openGlossary') {
                    await openProjectGlossary(document.uri);
                    return;
                }
                if (message.type === 'openProblems') {
                    await vscode.commands.executeCommand('workbench.actions.view.problems');
                    return;
                }
                if (message.type === 'validateQuality') {
                    pendingDeferredQuality = undefined;
                    deferredQualityRunGeneration++;
                    const qualitySignal = beginQualityRun();
                    const qualityVersion = Number(document.version);
                    const qualityText = document.getText();
                    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
                    const parsedForQuality = await parseWithDocumentSessionAsync(document.uri, qualityText, qualityVersion, config);
                    throwIfCancelled(qualitySignal);
                    const draftItems = Array.isArray(message.items) ? message.items : [];
                    const draftsByOrdinal = new Map();
                    for (const item of draftItems) {
                        const itemOrdinal = Number(item && item.ordinal);
                        if (!Number.isInteger(itemOrdinal)) continue;
                        if (typeof item.translation === 'string') {
                            draftsByOrdinal.set(itemOrdinal, item.translation);
                            continue;
                        }
                        const unitForStage = parsedForQuality.units[itemOrdinal];
                        const staged = unitForStage ? (volatileStageCache.get(itemOrdinal) || getStagedTranslation(unitForStage)) : undefined;
                        if (staged && typeof staged.text === 'string') draftsByOrdinal.set(itemOrdinal, staged.text);
                    }
                    const effectiveParsed = {
                        ...parsedForQuality,
                        units: parsedForQuality.units.map(unit => draftsByOrdinal.has(unit.ordinal)
                            ? { ...unit, target: draftsByOrdinal.get(unit.ordinal), targetState: 'translated' }
                            : unit)
                    };
                    const glossary = config.get('glossary.enabled', true) ? await readProjectGlossary(document.uri) : { entries: [] };
                    const projectQualityIgnores = (await readProjectQualityIgnores(document.uri)).ignores || [];
                    let report;
                    if (draftsByOrdinal.size) {
                        const qualityResult = await analyzeXliffQualityAdaptive(effectiveParsed, {
                            ...qualityOptionsFromConfiguration(config),
                            glossaryEntries: glossary.entries || [],
                            projectQualityIgnores
                        }, qualityText, config, {
                            signal: qualitySignal,
                            resourceKey: documentKey,
                            unitCount: effectiveParsed.units.length,
                            unitOverrides: Array.from(draftsByOrdinal.entries()).map(([ordinal, target]) => ({ ordinal, target, targetState: 'translated' })),
                            onPhase: (phase, meta) => messagePerf.mark(`quality ${phase}`, meta)
                        });
                        report = qualityResult.report;
                    } else {
                        const qualityAnalysis = await analyzeQualityForText(document.uri, qualityText, {
                            signal: qualitySignal,
                            config,
                            parsed: parsedForQuality,
                            glossary
                        });
                        if (qualityAnalysis.stale) return;
                        report = qualityAnalysis.report;
                    }
                    throwIfCancelled(qualitySignal);
                    if (disposed || Number(document.version) !== qualityVersion) return;
                    updateActiveRowStoreQuality(report);
                    publishQualityDiagnostics(document, report, parsedForQuality, messagePerf);
                    await postQualityReportToWebview(report, { includesDrafts: draftsByOrdinal.size > 0 });
                    return;
                }

                if (message.type === 'setQualityIgnored') {
                    if (Number(message.qualityRevision) !== qualityPageStore.revision || Number(message.documentVersion) !== Number(document.version)) return;
                    if (isGeneratorFilename(document.uri)) {
                        postError('Generated/source XLIFF files are read-only in the AL Xliff Studio XLIFF Editor.');
                        return;
                    }
                    const ordinal = Number(message.ordinal);
                    const issue = message.issue || {};
                    if (!Number.isInteger(ordinal) || !issue.code) return;
                    if (String(issue.severity || '').toLowerCase() === 'error') {
                        postError('Quality errors cannot be ignored. Fix the underlying XLIFF data instead.');
                        return;
                    }
                    const result = setQualityIssueIgnored(document.getText(), ordinal, {
                        code: String(issue.code),
                        source: String(issue.source || ''),
                        target: String(issue.target || '')
                    }, Boolean(message.ignored));
                    if (!result.updatedCount) return;
                    const applied = await applyText(result.text);
                    if (!applied) return;

                    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
                    const currentText = document.getText();
                    const parsedForQuality = await parseWithDocumentSessionAsync(document.uri, currentText, Number(document.version), config);
                    const glossary = config.get('glossary.enabled', true) ? await readProjectGlossary(document.uri) : { entries: [] };
                    const qualityAnalysis = await analyzeQualityForText(document.uri, currentText, { config, parsed: parsedForQuality, glossary });
                    const report = qualityAnalysis.report;
                    updateActiveRowStoreQuality(report);
                    if (!qualityAnalysis.stale) publishQualityDiagnostics(document, report, parsedForQuality, messagePerf);
                    await postQualityReportToWebview(report, { includesDrafts: false });
                    return;
                }

                if (message.type === 'setProjectQualityIgnored') {
                    if (Number(message.qualityRevision) !== qualityPageStore.revision || Number(message.documentVersion) !== Number(document.version)) return;
                    const issue = message.issue || {};
                    if (!issue.code) return;
                    try {
                        const changed = await setProjectQualityIssueIgnored(
                            document.uri,
                            { code: String(issue.code || '') },
                            String(message.targetLanguage || (await parseWithDocumentSessionAsync(document.uri, document.getText(), Number(document.version))).targetLanguage || ''),
                            Boolean(message.ignored)
                        );
                        if (!changed.updated) return;
                        // The exception file affects every XLIFF in the AL project. Drop all
                        // cached project snapshots; the automatic dependency watcher refreshes
                        // background diagnostics for sibling XLIFFs, while this editor refreshes
                        // itself immediately.
                        invalidateQualityAnalysis();
                        const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
                        const currentText = document.getText();
                        const parsedForQuality = await parseWithDocumentSessionAsync(document.uri, currentText, Number(document.version), config);
                        const glossary = config.get('glossary.enabled', true) ? await readProjectGlossary(document.uri) : { entries: [] };
                        const qualityAnalysis = await analyzeQualityForText(document.uri, currentText, { config, parsed: parsedForQuality, glossary });
                        const report = qualityAnalysis.report;
                        updateActiveRowStoreQuality(report);
                        if (!qualityAnalysis.stale) publishQualityDiagnostics(document, report, parsedForQuality, messagePerf);
                        await postQualityReportToWebview(report, { includesDrafts: false });
                    } catch (err) {
                        postError(`Project Quality Ignore could not be updated: ${formatError(err)}`);
                    }
                    return;
                }

                if (message.type === 'acceptAllNoState') {
                    if (isGeneratorFilename(document.uri) || message.readOnly) {
                        postError('Generated/source XLIFF files are read-only in the AL Xliff Studio XLIFF Editor.');
                        return;
                    }

                    messagePerf.mark('prepare no-state acceptance');
                    const provenance = provenanceEnabled()
                        ? createProvenance('status-confirmation', { action: 'accepted', previousState: '', bulk: true })
                        : undefined;
                    const result = setNoStateTargetsTranslated(document.getText(), { provenance });
                    const eligibleCount = result.accepted.length;
                    const skippedCount = result.skipped.length;
                    messagePerf.mark('calculate no-state changes', { eligible: eligibleCount, skipped: skippedCount });

                    if (!eligibleCount) {
                        const detail = skippedCount
                            ? ` ${skippedCount} no-state translation(s) have placeholder errors and were not eligible.`
                            : '';
                        showTransientStatus(`AL Xliff Studio: No non-empty no-state translations can be accepted.${detail}`);
                        return;
                    }

                    const skippedText = skippedCount
                        ? `\n\n${skippedCount} additional no-state translation(s) contain placeholder errors and will be skipped.`
                        : '';
                    messagePerf.mark('await confirmation', { humanInteraction: true });
                    const confirm = await vscode.window.showWarningMessage(
                        `Set ${eligibleCount} existing no-state translation(s) to translated?${skippedText}\n\nTranslation text will not be changed.`,
                        { modal: true },
                        'Set to translated'
                    );
                    messagePerf.mark('confirmation received', { confirmed: confirm === 'Set to translated', humanInteraction: true });
                    if (confirm !== 'Set to translated') return;

                    const applied = await applyText(result.text);
                    messagePerf.mark('apply no-state changes', { applied });
                    if (!applied) return;
                    for (const item of result.accepted) {
                        const ordinal = Number(item.ordinal);
                        const row = activeRowStore.get(ordinal);
                        if (!row) continue;
                        row.rawState = 'translated';
                        row.status = 'translated';
                        row.missing = false;
                        row.review = false;
                        row.canAcceptTranslation = false;
                        const keys = activeViewKeyStore.get(ordinal);
                        activeViewKeyStore.set(ordinal, createViewSearchSortKeysForOverride(row, keys, row));
                    }
                    viewPageCache.clear();
                    const targetLanguage = typeof message.targetLanguage === 'string' && message.targetLanguage
                        ? message.targetLanguage
                        : (await parseWithDocumentSessionAsync(document.uri, result.text, Number(document.version))).targetLanguage;
                    await writeAcceptedToMap(result.accepted, targetLanguage);
                    messagePerf.mark('update language map', { accepted: result.accepted.length });
                    await webviewPanel.webview.postMessage({
                        type: 'allNoStateAccepted',
                        items: result.accepted.map(item => ({
                            ...item,
                            state: 'translated',
                            provenance,
                            provenanceLabel: provenance ? formatProvenanceLabel(provenance) : '',
                            provenanceHistoryLabel: provenance ? formatProvenanceHistory(provenance) : ''
                        })),
                        skipped: result.skipped,
                        noStateCount: 0
                    });
                    messagePerf.mark('update no-state webview', { accepted: eligibleCount, skipped: skippedCount });
                    if (skippedCount) {
                        void vscode.window.showWarningMessage(`AL Xliff Studio: ${eligibleCount} no-state translation(s) accepted; ${skippedCount} skipped because of placeholder errors.`);
                    }
                    return;
                }

                if (message.type === 'acceptTranslation') {
                    const ordinal = Number(message.ordinal);
                    const requestedSource = typeof message.source === 'string' ? message.source : '';
                    const translation = typeof message.translation === 'string' ? message.translation : '';
                    const requestedState = String(message.state || '').trim().toLowerCase();
                    const requestedTargetLanguage = typeof message.targetLanguage === 'string' ? message.targetLanguage : '';
                    const translationDirty = Boolean(message.translationDirty);
                    const draftRevision = Number.isFinite(Number(message.revision)) ? Number(message.revision) : 0;
                    if (!Number.isInteger(ordinal)) return;
                    rowApplyInProgress.add(ordinal);
                    await webviewPanel.webview.postMessage({ type: 'translationApplyBusy', ordinal, busy: true });
                    try {
                        if (isGeneratorFilename(document.uri) || message.readOnly) {
                            postError('Generated/source XLIFF files are read-only in the AL Xliff Studio XLIFF Editor.');
                            return;
                        }
                        if (!translation) {
                            postError(`Cannot accept an empty translation for: ${requestedSource}`);
                            return;
                        }

                        const committed = await enqueueDocumentMutation(async () => {
                            const latestText = document.getText();
                            const latestParsed = await parseWithDocumentSessionAsync(document.uri, latestText, Number(document.version));
                            const latestUnit = latestParsed.units[ordinal];
                            if (!latestUnit) return { error: 'The translation unit no longer exists. Refresh the editor and try again.' };
                            if (requestedSource && latestUnit.source !== requestedSource) {
                                return { error: 'The source text changed while this draft was open. Refresh the editor before applying it.' };
                            }
                            if (String(latestUnit.translate || '').trim().toLowerCase() === 'no' || message.notTranslatable) {
                                return { error: 'This translation unit has translate=no and cannot be accepted.' };
                            }
                            if (!placeholdersMatch(latestUnit.source, translation)) {
                                return { error: `Placeholders do not match for: ${latestUnit.source}` };
                            }

                            const currentState = String(latestUnit.targetState || requestedState || '').trim().toLowerCase();
                            // A translated/signed-off/final target normally needs no acceptance, but a
                            // locally edited Translation draft must still be applicable row-by-row.
                            if (!translationDirty && ['translated', 'signed-off', 'final'].includes(currentState)) {
                                return { noChange: true };
                            }

                            let provenance;
                            if (provenanceEnabled()) {
                                if (translationDirty) {
                                    const supplied = sanitizeProvenance(message.provenance);
                                    provenance = withAction(
                                        supplied || manualProvenance(undefined, 'draft'),
                                        'applied',
                                        { previousState: currentState }
                                    );
                                } else {
                                    provenance = createProvenance('human-accepted', {
                                        action: 'accepted',
                                        previousState: currentState
                                    });
                                }
                            }
                            const existingUndo = pendingAppliedUndo.get(ordinal);
                            const undoSnapshot = existingUndo || {
                                rawUnit: getUnitRaw(latestText, latestUnit),
                                source: latestUnit.source,
                                previousTranslation: latestUnit.target === undefined ? '' : String(latestUnit.target),
                                previousState: String(latestUnit.targetState || ''),
                                previousMissing: isMissingTranslation(latestUnit, vscode.workspace.getConfiguration(CONFIG_SECTION).get('treatNeedsTranslationAsMissing', true)),
                                previousReview: isReviewTranslation(latestUnit),
                                previousCanAccept: canAcceptPersistedTranslation(latestUnit, false),
                                previousStatus: displayStatus(latestUnit)
                            };
                            undoSnapshot.draft = translationDirty ? {
                                text: translation,
                                provenance: provenanceEnabled() ? sanitizeProvenance(message.provenance) : undefined,
                                origin: provenanceEnabled() ? String(message.origin || '') : ''
                            } : undefined;

                            const changes = translationDirty
                                ? { translation, state: 'translated', provenance, clearStaged: true }
                                : { state: 'translated', provenance, clearStaged: true };
                            const unitRaw = getUnitRaw(latestText, latestUnit);
                            const updated = updateTranslationUnitRaw(unitRaw, changes);
                            if (!updated.updated) return { noChange: true };
                            const applied = await applyUnitRawReplacement(latestUnit, updated.text);
                            if (!applied) return { error: 'The XLIFF change could not be applied.' };
                            pendingAppliedUndo.set(ordinal, undoSnapshot);
                            lastAppliedDraftRevision.set(ordinal, draftRevision);
                            proposalCache.delete(ordinal);
                            volatileStageCache.delete(ordinal);
                            return {
                                unit: latestUnit,
                                provenance,
                                targetLanguage: requestedTargetLanguage || latestParsed.targetLanguage || ''
                            };
                        });

                        if (committed && committed.error) {
                            postError(committed.error);
                            return;
                        }
                        if (!committed || committed.noChange) return;

                        // Update the row immediately after the XLIFF commit. Companion-memory
                        // maintenance is secondary and must not make the editor appear frozen.
                        await webviewPanel.webview.postMessage({
                            type: 'translationAccepted',
                            ordinal,
                            translation,
                            state: 'translated',
                            wasMissing: Boolean(message.wasMissing),
                            wasReview: Boolean(message.wasReview),
                            wasDirty: translationDirty,
                            canUndoApply: true,
                            documentVersion: Number(document.version),
                            provenance: committed.provenance,
                            provenanceLabel: committed.provenance ? formatProvenanceLabel(committed.provenance) : '',
                            provenanceHistoryLabel: committed.provenance ? formatProvenanceHistory(committed.provenance) : ''
                        });
                        void writeAcceptedToMap([{ source: committed.unit.source, translation }], committed.targetLanguage)
                            .catch(err => postError(`Translation was applied, but the companion .lng could not be updated: ${formatError(err)}`));
                        const qualityVersion = Number(document.version);
                        void XliffEditorProvider.runQualityCheckForUri(document.uri, document.getText())
                            .then(report => {
                                if (!report || disposed || Number(document.version) !== qualityVersion) return;
                                updateActiveRowStoreQuality(report);
                                return postQualityReportToWebview(report, { includesDrafts: false, preserveVisibility: true, background: true });
                            }).catch(() => undefined);
                    } finally {
                        rowApplyInProgress.delete(ordinal);
                        await webviewPanel.webview.postMessage({ type: 'translationApplyBusy', ordinal, busy: false });
                    }
                    return;
                }


                if (message.type === 'revertAppliedTranslation') {
                    const ordinal = Number(message.ordinal);
                    if (!Number.isInteger(ordinal)) return;
                    await webviewPanel.webview.postMessage({ type: 'translationApplyBusy', ordinal, busy: true });
                    try {
                        const undo = pendingAppliedUndo.get(ordinal);
                        if (!undo) {
                            postError('This applied translation can no longer be undone because the document was already saved or refreshed.');
                            return;
                        }
                        const reverted = await enqueueDocumentMutation(async () => {
                            const latestParsed = await parseWithDocumentSessionAsync(document.uri, document.getText(), Number(document.version));
                            const latestUnit = latestParsed.units[ordinal];
                            if (!latestUnit || latestUnit.source !== undo.source) {
                                return { error: 'The translation unit changed after Apply. Refresh the editor before continuing.' };
                            }
                            const restored = replaceTranslationUnitRaw(document.getText(), ordinal, undo.rawUnit);
                            if (!restored.updatedCount) return { error: 'The previous XLIFF translation unit could not be restored.' };
                            let restoredText = restored.text;
                            if (undo.draft && undo.draft.text) {
                                restoredText = setStagedTranslations(restoredText, [{
                                    ordinal,
                                    staged: {
                                        kind: 'draft',
                                        text: undo.draft.text,
                                        provenance: undo.draft.provenance,
                                        origin: undo.draft.origin || ''
                                    }
                                }]).text;
                            }
                            const applied = await applyText(restoredText);
                            if (!applied) return { error: 'The Apply operation could not be undone.' };
                            pendingAppliedUndo.delete(ordinal);
                            return { undo };
                        });
                        if (reverted && reverted.error) {
                            postError(reverted.error);
                            return;
                        }
                        if (!reverted || !reverted.undo) return;
                        await webviewPanel.webview.postMessage({
                            type: 'translationApplyReverted',
                            ordinal,
                            savedTranslation: reverted.undo.previousTranslation,
                            translation: reverted.undo.draft ? reverted.undo.draft.text : reverted.undo.previousTranslation,
                            state: reverted.undo.previousState,
                            missing: Boolean(reverted.undo.previousMissing),
                            review: Boolean(reverted.undo.previousReview),
                            canAcceptTranslation: Boolean(reverted.undo.previousCanAccept),
                            status: reverted.undo.previousStatus || '',
                            draftProvenance: reverted.undo.draft && reverted.undo.draft.provenance,
                            draftOrigin: reverted.undo.draft && reverted.undo.draft.origin || ''
                        });
                    } finally {
                        await webviewPanel.webview.postMessage({ type: 'translationApplyBusy', ordinal, busy: false });
                    }
                    return;
                }


                const parsed = await parseWithDocumentSessionAsync(document.uri, document.getText(), Number(document.version));
                const readOnly = isGeneratorXliff(document.uri, parsed);
                if (readOnly) {
                    postError('Generated/source XLIFF files are read-only in the AL Xliff Studio XLIFF Editor.');
                    return;
                }

                if (message.type === 'synchronizeFile') {
                    if (document.isDirty || volatileStageCache.size || proposalCache.size || pendingAppliedUndo.size) return;
                    if (confirmedSyncStatus !== 'out-of-sync' || confirmedSyncVersion !== Number(document.version)) return;
                    webviewPanel.webview.postMessage({ type: 'syncBusy', busy: true });
                    const syncController = new AbortController();
                    const syncSubscriptions = [];
                    try {
                        const siblingUri = await findSiblingGxlf(document.uri, parsed.targetLanguage);
                        if (!siblingUri) {
                            postError('No unambiguous matching *.g.xlf file was found next to this translation XLIFF.');
                            return;
                        }
                        const beforeSyncText = document.getText();
                        const syncVersion = Number(document.version);
                        const generatorText = await readText(siblingUri);
                        const cancelChangedSyncResource = changedDocument => {
                            const key = changedDocument && changedDocument.uri.toString();
                            if (key === documentKey || key === siblingUri.toString()) syncController.abort('Sync resource changed or closed.');
                        };
                        syncSubscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
                            if (!Array.isArray(event.contentChanges) || event.contentChanges.length) cancelChangedSyncResource(event.document);
                        }));
                        if (vscode.workspace.onDidCloseTextDocument) syncSubscriptions.push(vscode.workspace.onDidCloseTextDocument(cancelChangedSyncResource));
                        const result = await synchronizeXliffAdaptive(beforeSyncText, generatorText, vscode.workspace.getConfiguration(CONFIG_SECTION, document.uri), {
                            signal: syncController.signal,
                            resourceKey: documentKey,
                            unitCount: parsed.units.length,
                            onPhase: (phase, meta) => messagePerf.mark(phase, meta)
                        });
                        if (syncController.signal.aborted || disposed || Number(document.version) !== syncVersion || await readText(siblingUri) !== generatorText) return;

                        // Preserve confirmed translations from the pre-sync source text before
                        // changed sources are rewritten/flagged. This gives fuzzy matching a
                        // stable old-source -> translation basis even when the .lng did not
                        // exist before synchronization. Afterwards merge the synchronized file
                        // as well, so the companion .lng is created/updated in the same action.
                        const mapResult = await updateCompanionMapFromXliffTexts([beforeSyncText, result.text], result.memorySnapshots);
                        if (syncController.signal.aborted || disposed || Number(document.version) !== syncVersion) return;

                        if (result.text !== beforeSyncText) {
                            await applyText(result.text);
                        }
                        // Synchronization can add units and therefore changes ordinal-based
                        // proposal identities. Clearing proposals is safer than attaching a
                        // proposal to the wrong trans-unit afterwards.
                        proposalCache.clear();
                        await postDocument();
                        const removedSuffix = result.removedUnits.length
                            ? ` ${result.removedUnits.length} obsolete translation unit(s) removed from the XLIFF; existing confirmed translation(s) were preserved in the companion .lng.`
                            : '';
                        const mapSuffix = ` Companion .lng updated from ${mapResult.pairCount} confirmed translation pair(s).`;
                        showTransientStatus(`AL Xliff Studio: synchronized ${result.synchronizedSources} changed source(s), synchronized ${result.synchronizedDeveloperNotes || 0} Developer note set(s), synchronized ${result.synchronizedGeneratorNotes || 0} Xliff Generator note set(s), added ${result.addedUnits} missing unit(s), flagged ${result.flaggedTargets} existing target(s) for review.${removedSuffix}${mapSuffix}`, 9000);
                    } finally {
                        for (const subscription of syncSubscriptions) subscription.dispose();
                        webviewPanel.webview.postMessage({ type: 'syncBusy', busy: false });
                    }
                    return;
                }

                if (message.type === 'tryFile') {
                    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
                    const treatNeedsTranslationAsMissing = config.get('treatNeedsTranslationAsMissing', true);
                    const missingUnits = parsed.units.filter(unit => isMissingTranslation(unit, treatNeedsTranslationAsMissing));
                    if (!missingUnits.length) {
                        showTransientStatus('AL Xliff Studio: no missing translations in this XLIFF.');
                        return;
                    }

                    webviewPanel.webview.postMessage({ type: 'tryBusy', all: true, busy: true });
                    try {
                        const companionMap = await loadCompanionMap(parsed);
                        const glossary = config.get('glossary.enabled', true) ? await readProjectGlossary(document.uri) : { entries: [] };
                        const glossaryEntries = glossary.entries || [];
                        const fuzzyOptions = {
                            enabled: config.get('fuzzyMatch.enabled', false),
                            minimumQuality: config.get('fuzzyMatch.minimumQuality', 80)
                        };
                        const bySource = new Map();
                        for (const candidate of missingUnits) {
                            if (!bySource.has(candidate.source)) bySource.set(candidate.source, []);
                            bySource.get(candidate.source).push(candidate);
                        }

                        const stagedTranslations = [];
                        const stagedPersistence = [];
                        const unresolved = [];
                        let fuzzyProposals = 0;

                        for (const candidate of missingUnits) {
                            const resolved = resolveKnownTranslationForUnit(
                                candidate,
                                bySource.get(candidate.source) || [candidate],
                                parsed.targetLanguage,
                                companionMap,
                                fuzzyOptions,
                                glossaryEntries
                            );
                            if (!resolved.translation) {
                                unresolved.push(candidate);
                                continue;
                            }

                            if (resolved.source === 'fuzzy') {
                                const provenance = provenanceFromResolved(resolved, 'proposal');
                                const origin = formatProvenanceLabel(provenance);
                                proposalCache.set(candidate.ordinal, {
                                    source: candidate.source,
                                    text: resolved.translation,
                                    provenance,
                                    origin
                                });
                                stagedPersistence.push({
                                    ordinal: candidate.ordinal,
                                    staged: { kind: 'proposal', text: resolved.translation, provenance, origin }
                                });
                                fuzzyProposals++;
                                continue;
                            }

                            const provenance = provenanceFromResolved(resolved, 'draft');
                            const origin = formatProvenanceLabel(provenance);
                            stagedTranslations.push({
                                ordinal: candidate.ordinal,
                                source: candidate.source,
                                translation: resolved.translation,
                                provenance,
                                origin
                            });
                            stagedPersistence.push({
                                ordinal: candidate.ordinal,
                                staged: { kind: 'draft', text: resolved.translation, provenance, origin }
                            });
                            proposalCache.delete(candidate.ordinal);
                        }

                        let aiProposals = 0;
                        if (unresolved.length && config.get('ai.enabled', true) !== false) {
                            const choice = await vscode.window.showWarningMessage(
                                `${unresolved.length} open translation${unresolved.length === 1 ? '' : 's'}`,
                                { modal: true },
                                'Use AI',
                                'Continue without AI'
                            );
                            if (choice === 'Use AI') {
                                await vscode.window.withProgress({
                                    location: vscode.ProgressLocation.Notification,
                                    title: 'AL Xliff Studio: creating AI drafts',
                                    cancellable: true
                                }, async (progress, token) => {
                                    progress.report({ message: `0 / ${unresolved.length}` });
                                    const aiContextOptions = getAiContextOptions(config);
                                    const aiItems = unresolved.map(candidate =>
                                        createAiTranslationItem(candidate, parsed, companionMap, glossaryEntries, aiContextOptions)
                                    );
                                    let lastAiProgressCompleted = 0;
                                    const aiDetailed = await translateItemsByKeyDetailed(
                                        aiItems,
                                        parsed.sourceLanguage,
                                        parsed.targetLanguage,
                                        token,
                                        (completed, total) => {
                                            const delta = Math.max(0, completed - lastAiProgressCompleted);
                                            lastAiProgressCompleted = completed;
                                            progress.report({
                                                message: `${completed} / ${total}`,
                                                increment: total ? (100 * delta / total) : 0
                                            });
                                        },
                                        document.uri
                                    );
                                    const aiItemsByOrdinal = new Map(aiItems.map(item => [item.ordinal, item]));
                                    for (const candidate of unresolved) {
                                        const item = aiItemsByOrdinal.get(candidate.ordinal);
                                        const suggestion = item ? aiDetailed.translations.get(item.key) : undefined;
                                        if (!suggestion) continue;
                                        const provenance = provenanceFromAi(aiDetailed.model, 'proposal');
                                        const origin = formatProvenanceLabel(provenance);
                                        proposalCache.set(candidate.ordinal, {
                                            source: candidate.source,
                                            text: suggestion,
                                            provenance,
                                            origin
                                        });
                                        stagedPersistence.push({
                                            ordinal: candidate.ordinal,
                                            staged: { kind: 'proposal', text: suggestion, provenance, origin }
                                        });
                                        aiProposals++;
                                    }
                                });
                            }
                        }

                        if (stagedPersistence.length) await persistStagedItems(stagedPersistence);
                        await postDocument();
                        if (stagedTranslations.length) {
                            await webviewPanel.webview.postMessage({
                                type: 'stageTranslationDrafts',
                                items: stagedTranslations
                            });
                        }
                        const unresolvedAfter = unresolved.length - aiProposals;
                        showTransientStatus(`AL Xliff Studio: ${stagedTranslations.length} direct translation draft(s), ${fuzzyProposals} fuzzy proposal draft(s), ${aiProposals} AI proposal draft(s)${unresolvedAfter > 0 ? `, ${unresolvedAfter} still open` : ''}. Use Apply Drafts to write staged changes as translated.`, 9000);
                    } finally {
                        webviewPanel.webview.postMessage({ type: 'tryBusy', all: true, busy: false });
                    }
                    return;
                }

                const ordinal = Number(message.ordinal);
                const unit = Number.isInteger(ordinal) ? parsed.units[ordinal] : undefined;

                if (message.type === 'proposalChanged') {
                    if (!unit) return;
                    const text = typeof message.text === 'string' ? message.text : '';
                    if (text) {
                        const previous = proposalCache.get(ordinal);
                        const supplied = provenanceEnabled() ? sanitizeProvenance(message.provenance) : undefined;
                        const provenance = provenanceEnabled()
                            ? (supplied || manualProvenance(previous && previous.provenance, 'proposal'))
                            : undefined;
                        const origin = provenanceEnabled()
                            ? (String(message.origin || '') || formatProvenanceLabel(provenance))
                            : '';
                        proposalCache.set(ordinal, { source: unit.source, text, provenance, origin });
                        volatileStageCache.set(ordinal, { kind: 'proposal', text, provenance, origin, source: unit.source, id: unit.id });
                    } else {
                        proposalCache.delete(ordinal);
                        volatileStageCache.delete(ordinal);
                    }
                    return;
                }

                if (message.type === 'translationDraftChanged') {
                    if (!unit) return;
                    const incomingRevision = Number.isFinite(Number(message.revision)) ? Number(message.revision) : 0;
                    const appliedRevision = lastAppliedDraftRevision.get(ordinal);
                    // A blur/change message can already be in the webview -> extension queue
                    // when the row-level Apply action is clicked. Never let that stale staging
                    // message recreate the draft note after the target was committed.
                    if (rowApplyInProgress.has(ordinal) || (appliedRevision !== undefined && incomingRevision <= appliedRevision)) return;
                    const hasDraft = Boolean(message.hasDraft);
                    if (!hasDraft) {
                        volatileStageCache.delete(ordinal);
                        return;
                    }
                    const text = typeof message.text === 'string' ? message.text : '';
                    const provenance = provenanceEnabled() ? sanitizeProvenance(message.provenance) : undefined;
                    const origin = provenanceEnabled() ? String(message.origin || '') : '';
                    proposalCache.delete(ordinal);
                    volatileStageCache.set(ordinal, { kind: 'draft', text, provenance, origin, source: unit.source, id: unit.id });
                    return;
                }

                if (message.type === 'saveManyDrafts') {
                    const requested = Array.isArray(message.items) ? message.items : [];
                    messagePerf.mark('collect draft request', { drafts: requested.length });
                    if (!requested.length) {
                        await webviewPanel.webview.postMessage({ type: 'draftsSaved', items: [], skipped: [], fullReload: false });
                        return;
                    }
                    const showApplyDraftsProgress = requested.length >= APPLY_DRAFTS_PROGRESS_THRESHOLD;
                    if (showApplyDraftsProgress) {
                        await webviewPanel.webview.postMessage({
                            type: 'applyDraftsProgress',
                            current: 0,
                            total: requested.length,
                            stage: 'Applying drafts'
                        });
                    }

                    const commit = await enqueueDocumentMutation(async () => {
                        const latestText = document.getText();
                        const applyVersion = Number(document.version);
                        const latestParsed = await parseWithDocumentSessionAsync(document.uri, latestText, applyVersion);
                        messagePerf.mark('parse XLIFF for draft apply', { units: latestParsed.units.length });
                        const treatNeedsTranslationAsMissing = vscode.workspace.getConfiguration(CONFIG_SECTION).get('treatNeedsTranslationAsMissing', true);
                        const accepted = [];
                        const saved = [];
                        const skipped = [];
                        const batchChanges = [];
                        const undoSnapshots = new Map();

                        let preparedDrafts = 0;
                        for (const requestedItem of requested) {
                            if (++preparedDrafts % ROW_PREPARE_CHUNK_SIZE === 0) {
                                await new Promise(resolve => setImmediate(resolve));
                            }
                            if (disposed || Number(document.version) !== applyVersion) throw abortError('Document changed during draft preparation.');
                            const itemOrdinal = Number(requestedItem.ordinal);
                            const itemUnit = latestParsed.units[itemOrdinal];
                            const requestedSource = typeof requestedItem.source === 'string' ? requestedItem.source : '';
                            const stagedFallback = itemUnit ? (volatileStageCache.get(itemOrdinal) || getStagedTranslation(itemUnit)) : undefined;
                            const translation = typeof requestedItem.translation === 'string'
                                ? requestedItem.translation
                                : (stagedFallback && stagedFallback.kind === 'draft' ? String(stagedFallback.text || '') : '');
                            if (!itemUnit) {
                                skipped.push({ ordinal: itemOrdinal, reason: 'translation unit no longer exists' });
                                continue;
                            }
                            if (requestedSource && requestedSource !== itemUnit.source) {
                                skipped.push({ ordinal: itemOrdinal, reason: 'source changed' });
                                continue;
                            }
                            if (String(itemUnit.translate || '').trim().toLowerCase() === 'no') {
                                skipped.push({ ordinal: itemOrdinal, reason: 'translate=no' });
                                continue;
                            }
                            if (!translation) {
                                skipped.push({ ordinal: itemOrdinal, reason: 'empty translation' });
                                continue;
                            }
                            if (!placeholdersMatch(itemUnit.source, translation)) {
                                skipped.push({ ordinal: itemOrdinal, reason: 'placeholder mismatch' });
                                continue;
                            }
                            const suppliedProvenance = provenanceEnabled() ? sanitizeProvenance(requestedItem.provenance) : undefined;
                            const appliedProvenance = provenanceEnabled()
                                ? withAction(suppliedProvenance || manualProvenance(undefined, 'draft'), 'applied')
                                : undefined;
                            const existingUndo = pendingAppliedUndo.get(itemOrdinal);
                            undoSnapshots.set(itemOrdinal, existingUndo || {
                                rawUnit: getUnitRaw(latestText, itemUnit),
                                source: itemUnit.source,
                                previousTranslation: itemUnit.target === undefined ? '' : String(itemUnit.target),
                                previousState: String(itemUnit.targetState || ''),
                                previousMissing: isMissingTranslation(itemUnit, treatNeedsTranslationAsMissing),
                                previousReview: isReviewTranslation(itemUnit),
                                previousCanAccept: canAcceptPersistedTranslation(itemUnit, false),
                                previousStatus: displayStatus(itemUnit),
                                draft: {
                                    text: translation,
                                    provenance: suppliedProvenance,
                                    origin: String(requestedItem.origin || '')
                                }
                            });
                            batchChanges.push({
                                ordinal: itemOrdinal,
                                changes: {
                                    translation,
                                    state: 'translated',
                                    provenance: appliedProvenance,
                                    clearStaged: true
                                }
                            });
                            accepted.push({ source: itemUnit.source, translation });
                            saved.push({
                                ordinal: itemOrdinal,
                                translation,
                                state: 'translated',
                                wasMissing: isMissingTranslation(itemUnit, treatNeedsTranslationAsMissing),
                                wasReview: isReviewTranslation(itemUnit),
                                provenance: appliedProvenance,
                                provenanceLabel: formatProvenanceLabel(appliedProvenance),
                                provenanceHistoryLabel: formatProvenanceHistory(appliedProvenance)
                            });
                        }

                        if (!batchChanges.length) return { accepted: [], saved: [], skipped };
                        const updated = await updateTranslationUnitsAdaptive(latestText, batchChanges, vscode.workspace.getConfiguration(CONFIG_SECTION), { resourceKey: document.uri.toString(), unitCount: latestParsed.units.length, onPhase: (phase, detail) => messagePerf.mark(phase, detail) });
                        if (disposed || Number(document.version) !== applyVersion) throw abortError('Document changed during draft apply.');
                        messagePerf.mark('update translation units', { requested: requested.length, batchChanges: batchChanges.length, updated: updated.updatedCount });
                        if (!updated.updatedCount) {
                            return { accepted: [], saved: [], skipped: skipped.concat(saved.map(item => ({ ordinal: item.ordinal, reason: 'no XLIFF change was necessary' }))) };
                        }
                        const updatedSet = new Set(updated.updatedOrdinals || []);
                        const actuallySaved = saved.filter(item => updatedSet.has(item.ordinal));
                        const actuallyAccepted = accepted.filter((item, index) => updatedSet.has(saved[index] && saved[index].ordinal));
                        const applied = await applyText(updated.text);
                        messagePerf.mark('apply draft text edit', { applied, updated: updated.updatedCount });
                        if (!applied) throw new Error('The XLIFF draft changes could not be applied.');
                        for (const item of actuallySaved) {
                            const snapshot = undoSnapshots.get(item.ordinal);
                            if (snapshot) {
                                snapshot.draft = {
                                    text: item.translation,
                                    provenance: snapshot.draft && snapshot.draft.provenance,
                                    origin: snapshot.draft && snapshot.draft.origin || ''
                                };
                                pendingAppliedUndo.set(item.ordinal, snapshot);
                            }
                            proposalCache.delete(item.ordinal);
                            volatileStageCache.delete(item.ordinal);
                            item.canUndoApply = true;
                        }
                        return { accepted: actuallyAccepted, saved: actuallySaved, skipped };
                    }).catch(error => {
                        if (!isWorkerCancellation(error)) postError(`Drafts could not be applied: ${formatError(error)}`);
                        return { accepted: [], saved: [], skipped: [] };
                    });

                    // Finish the user-visible action as soon as the XLIFF document itself is
                    // committed. Translation-memory and quality maintenance continue after
                    // the UI has acknowledged the apply operation.
                    await webviewPanel.webview.postMessage({
                        type: 'draftsSaved',
                        items: commit.saved || [],
                        skipped: commit.skipped || [],
                        fullReload: false
                    });
                    messagePerf.mark('acknowledge applied drafts', { saved: (commit.saved || []).length, skipped: (commit.skipped || []).length });
                    if (showApplyDraftsProgress) {
                        await webviewPanel.webview.postMessage({
                            type: 'applyDraftsProgressDone',
                            current: requested.length,
                            total: requested.length
                        });
                    }
                    if (commit.skipped && commit.skipped.length) {
                        postError(`${commit.skipped.length} draft(s) were not applied. Check empty text, placeholders, translate=no, or source changes.`);
                    }

                    const qualityVersion = Number(document.version);
                    if (commit.accepted && commit.accepted.length) {
                        void writeAcceptedToMap(commit.accepted).catch(err =>
                            postError(`Drafts were applied, but the companion .lng could not be updated: ${formatError(err)}`)
                        );
                        void XliffEditorProvider.runQualityCheckForUri(document.uri, document.getText())
                            .then(report => {
                                if (!report || disposed || Number(document.version) !== qualityVersion) return;
                                updateActiveRowStoreQuality(report);
                                return postQualityReportToWebview(report, { includesDrafts: false, preserveVisibility: true });
                            })
                            .catch(() => undefined);
                    }
                    return;
                }


                if (message.type === 'acceptMany') {
                    const requested = Array.isArray(message.items) ? message.items : [];
                    const staged = [];
                    for (const requestedItem of requested) {
                        const itemOrdinal = Number(requestedItem.ordinal);
                        const itemUnit = parsed.units[itemOrdinal];
                        const translation = typeof requestedItem.translation === 'string' ? requestedItem.translation : '';
                        if (!itemUnit || !translation || String(itemUnit.translate || '').trim().toLowerCase() === 'no') continue;
                        if (!placeholdersMatch(itemUnit.source, translation)) continue;
                        const cached = proposalCache.get(itemOrdinal);
                        proposalCache.delete(itemOrdinal);
                        const supplied = provenanceEnabled() ? sanitizeProvenance(requestedItem.provenance) : undefined;
                        const provenance = provenanceEnabled()
                            ? (supplied || (cached && cached.provenance ? cached.provenance : manualProvenance(undefined, 'draft')))
                            : undefined;
                        const origin = provenanceEnabled()
                            ? (String(requestedItem.origin || '') || (cached ? (cached.origin || formatProvenanceLabel(cached.provenance)) : 'Manual'))
                            : '';
                        staged.push({
                            ordinal: itemOrdinal,
                            translation,
                            provenance,
                            origin
                        });
                    }
                    if (staged.length) {
                        await persistStagedItems(staged.map(item => ({
                            ordinal: item.ordinal,
                            staged: { kind: 'draft', text: item.translation, provenance: item.provenance, origin: item.origin }
                        })));
                        await webviewPanel.webview.postMessage({ type: 'proposalsAcceptedAsDrafts', items: staged });
                    }
                    return;
                }

                if (message.type === 'clearProposals' || message.type === 'clearStaged') {
                    const ordinals = Array.isArray(message.ordinals) ? message.ordinals.map(Number).filter(Number.isInteger) : [];
                    for (const itemOrdinal of ordinals) proposalCache.delete(itemOrdinal);
                    if (ordinals.length) {
                        await persistStagedItems(ordinals.map(itemOrdinal => ({ ordinal: itemOrdinal, staged: undefined })));
                    }
                    return;
                }


                if (!unit) return;
                if (String(unit.translate || '').trim().toLowerCase() === 'no') {
                    postError('This trans-unit has translate="no" and is not editable.');
                    return;
                }

                if (message.type === 'tryUnit') {
                    const requestedOrdinal = Number(message.ordinal);
                    const requestedId = String(message.id || '');
                    const requestedSource = String(message.source || '');
                    webviewPanel.webview.postMessage({ type: 'tryBusy', ordinal: requestedOrdinal, busy: true });
                    try {
                        // Status changes and staging operations are document mutations. A row-level
                        // Try must always observe the newest in-memory TextDocument, even when the
                        // user has deliberately changed translated -> needs-translation without
                        // saving the XLIFF to disk first.
                        await waitForDocumentMutations();
                        const snapshotVersion = Number(document.version);
                        const currentText = document.getText();
                        const currentParsed = await parseWithDocumentSessionAsync(document.uri, currentText, Number(document.version));
                        const currentUnit = Number.isInteger(requestedOrdinal) ? currentParsed.units[requestedOrdinal] : undefined;
                        const identityMatches = currentUnit
                            && (!requestedId || String(currentUnit.id || '') === requestedId)
                            && (!requestedSource || String(currentUnit.source || '') === requestedSource);
                        if (!identityMatches) {
                            postError('This translation unit changed while the editor was open. Refresh the XLIFF Editor and try again.');
                            await postDocument();
                            return;
                        }
                        if (String(currentUnit.translate || '').trim().toLowerCase() === 'no') {
                            postError('This trans-unit has translate="no" and is not editable.');
                            return;
                        }

                        const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
                        const treatNeedsTranslationAsMissing = config.get('treatNeedsTranslationAsMissing', true);
                        if (!isMissingTranslation(currentUnit, treatNeedsTranslationAsMissing)) {
                            postError('This row is not missing a translation.');
                            return;
                        }

                        const existingTranslation = currentUnit.target === undefined ? '' : String(currentUnit.target);
                        const companionMap = await loadCompanionMap(currentParsed);
                        const glossary = config.get('glossary.enabled', true) ? await readProjectGlossary(document.uri) : { entries: [] };
                        const glossaryEntries = glossary.entries || [];
                        const fuzzyOptions = {
                            enabled: config.get('fuzzyMatch.enabled', false),
                            minimumQuality: config.get('fuzzyMatch.minimumQuality', 80)
                        };
                        const sameSourceUnits = (getUnitIndex(currentParsed).bySource.get(String(currentUnit.source)) || []).filter(candidate =>
                            isMissingTranslation(candidate, treatNeedsTranslationAsMissing)
                        );
                        // For a non-empty target that was deliberately moved back to
                        // needs-translation, an identical Developer/.lng/glossary/fuzzy result is
                        // not a useful retry result. Skip it and continue down the resolver chain,
                        // allowing a changed Developer note or ultimately AI to produce a new draft.
                        const resolved = resolveKnownTranslationForUnit(
                            currentUnit,
                            sameSourceUnits.length ? sameSourceUnits : [currentUnit],
                            currentParsed.targetLanguage,
                            companionMap,
                            fuzzyOptions,
                            glossaryEntries,
                            { excludeTranslation: existingTranslation }
                        );

                        // Do not attach a result calculated for an obsolete in-memory snapshot.
                        if (Number(document.version) !== snapshotVersion) {
                            postError('The XLIFF changed while Try Translation was resolving local suggestions. Try again with the current row.');
                            return;
                        }

                        if (resolved.translation) {
                            if (resolved.source === 'fuzzy') {
                                const provenance = provenanceFromResolved(resolved, 'proposal');
                                const origin = formatProvenanceLabel(provenance);
                                proposalCache.set(requestedOrdinal, {
                                    source: currentUnit.source,
                                    text: resolved.translation,
                                    provenance,
                                    origin
                                });
                                await persistStagedItem(requestedOrdinal, { kind: 'proposal', text: resolved.translation, provenance, origin });
                                await webviewPanel.webview.postMessage({
                                    type: 'proposalUpdated',
                                    ordinal: requestedOrdinal,
                                    proposal: resolved.translation,
                                    provenance,
                                    origin
                                });
                            } else {
                                const provenance = provenanceFromResolved(resolved, 'draft');
                                const origin = formatProvenanceLabel(provenance);
                                proposalCache.delete(requestedOrdinal);
                                await persistStagedItem(requestedOrdinal, { kind: 'draft', text: resolved.translation, provenance, origin });
                                await webviewPanel.webview.postMessage({
                                    type: 'stageTranslationDrafts',
                                    items: [{
                                        ordinal: requestedOrdinal,
                                        source: currentUnit.source,
                                        translation: resolved.translation,
                                        provenance,
                                        origin
                                    }]
                                });
                            }
                            return;
                        }

                        if (config.get('ai.enabled', true) === false) {
                            postError('No changed Developer comment, .lng, glossary, or fuzzy suggestion was found, and AI is disabled.');
                            return;
                        }

                        const choice = await vscode.window.showWarningMessage(
                            '1 open translation',
                            { modal: true },
                            'Use AI',
                            'Continue without AI'
                        );
                        if (choice !== 'Use AI') return;

                        let suggestion;
                        let aiModel;
                        await vscode.window.withProgress({
                            location: vscode.ProgressLocation.Notification,
                            title: 'AL Xliff Studio: creating AI draft',
                            cancellable: true
                        }, async (progress, token) => {
                            progress.report({ message: '0 / 1' });
                            const aiItem = createAiTranslationItem(
                                currentUnit,
                                currentParsed,
                                companionMap,
                                glossaryEntries,
                                getAiContextOptions(config)
                            );
                            const aiDetailed = await translateItemsByKeyDetailed([aiItem], currentParsed.sourceLanguage, currentParsed.targetLanguage, token, undefined, document.uri);
                            suggestion = aiDetailed.translations.get(aiItem.key);
                            aiModel = aiDetailed.model;
                            if (suggestion) progress.report({ message: '1 / 1', increment: 100 });
                        });
                        if (!suggestion) {
                            postError('The AI did not return a usable translation. Check placeholders or model availability.');
                            return;
                        }

                        // AI can take long enough for the document to change. Revalidate the exact
                        // unit before persisting the proposal, but a normal Save is harmless because
                        // it does not alter the TextDocument content/version.
                        await waitForDocumentMutations();
                        const latestParsed = await parseWithDocumentSessionAsync(document.uri, document.getText(), Number(document.version));
                        const latestUnit = latestParsed.units[requestedOrdinal];
                        const latestIdentityMatches = latestUnit
                            && (!requestedId || String(latestUnit.id || '') === requestedId)
                            && (!requestedSource || String(latestUnit.source || '') === requestedSource);
                        if (!latestIdentityMatches || !isMissingTranslation(latestUnit, treatNeedsTranslationAsMissing)) {
                            postError('This translation unit changed while AI was running. Refresh the row before applying the AI proposal.');
                            return;
                        }
                        const latestTranslation = latestUnit.target === undefined ? '' : String(latestUnit.target);
                        if (suggestion === latestTranslation) {
                            showTransientStatus('AL Xliff Studio: the new AI suggestion is identical to the current translation; no proposal was staged.');
                            return;
                        }

                        const provenance = provenanceFromAi(aiModel, 'proposal');
                        const origin = formatProvenanceLabel(provenance);
                        proposalCache.set(requestedOrdinal, {
                            source: latestUnit.source,
                            text: suggestion,
                            provenance,
                            origin
                        });
                        await persistStagedItem(requestedOrdinal, { kind: 'proposal', text: suggestion, provenance, origin });
                        await webviewPanel.webview.postMessage({
                            type: 'proposalUpdated',
                            ordinal: requestedOrdinal,
                            proposal: suggestion,
                            provenance,
                            origin
                        });
                    } finally {
                        webviewPanel.webview.postMessage({ type: 'tryBusy', ordinal: requestedOrdinal, busy: false });
                    }
                    return;
                }


                if (message.type === 'addGlossaryTerm') {
                    const suggested = typeof message.translation === 'string' ? message.translation : (unit.target || '');
                    const sourceTerm = await vscode.window.showInputBox({
                        title: 'Add terminology',
                        prompt: 'Source term or phrase',
                        value: unit.source || ''
                    });
                    if (!sourceTerm) return;
                    const translation = await vscode.window.showInputBox({
                        title: 'Add terminology',
                        prompt: `Required ${parsed.targetLanguage || 'target'} translation`,
                        value: suggested || ''
                    });
                    if (!translation) return;
                    await addGlossaryEntry(document.uri, {
                        source: sourceTerm,
                        targetLanguage: parsed.targetLanguage,
                        translation,
                        match: sourceTerm === unit.source ? 'word' : 'word',
                        caseSensitive: false,
                        note: ''
                    });
                    showTransientStatus(`AL Xliff Studio: terminology added: ${sourceTerm} → ${translation}`);
                    await postDocument();
                    return;
                }

                if (message.type === 'updateStatus') {
                    const requestedState = message.state === '__none__' ? '' : String(message.state || '');
                    const result = await enqueueDocumentMutation(async () => {
                        const latestParsed = await parseWithDocumentSessionAsync(document.uri, document.getText(), Number(document.version));
                        const latestUnit = latestParsed.units[ordinal];
                        if (!latestUnit) return { error: 'The translation unit no longer exists. Refresh the editor and try again.' };
                        const completedState = ['translated', 'signed-off', 'final'].includes(requestedState.toLowerCase());
                        if (completedState) {
                            if (!latestUnit.target) return { error: `Cannot mark an empty translation as ${requestedState}: ${latestUnit.source}` };
                            if (!placeholdersMatch(latestUnit.source, latestUnit.target)) {
                                return { error: `Placeholders do not match for: ${latestUnit.source}` };
                            }
                        }
                        const statusProvenance = completedState && provenanceEnabled()
                            ? createProvenance('status-confirmation', { action: 'accepted', previousState: latestUnit.targetState || '' })
                            : undefined;
                        const updated = updateTranslationUnit(document.getText(), ordinal, { state: requestedState, provenance: statusProvenance });
                        if (!updated.updatedCount) return { noChange: true };
                        const applied = await applyText(updated.text);
                        if (!applied) return { error: 'The XLIFF status change could not be applied.' };
                        const treatNeedsTranslationAsMissing = vscode.workspace.getConfiguration(CONFIG_SECTION).get('treatNeedsTranslationAsMissing', true);
                        const effectiveUnit = { ...latestUnit, targetState: requestedState };
                        return {
                            source: latestUnit.source,
                            translation: latestUnit.target || '',
                            state: requestedState,
                            missing: isMissingTranslation(effectiveUnit, treatNeedsTranslationAsMissing),
                            review: isReviewTranslation(effectiveUnit),
                            canAcceptTranslation: canAcceptPersistedTranslation(effectiveUnit, false),
                            completedState,
                            provenance: statusProvenance
                        };
                    });
                    if (result && result.error) {
                        postError(result.error);
                        await webviewPanel.webview.postMessage({ type: 'statusUpdateRejected', ordinal });
                        return;
                    }
                    if (!result || result.noChange) return;
                    await webviewPanel.webview.postMessage({
                        type: 'statusUpdated',
                        ordinal,
                        state: result.state,
                        missing: result.missing,
                        review: result.review,
                        canAcceptTranslation: result.canAcceptTranslation,
                        provenance: result.provenance,
                        provenanceLabel: result.provenance ? formatProvenanceLabel(result.provenance) : '',
                        provenanceHistoryLabel: result.provenance ? formatProvenanceHistory(result.provenance) : '',
                        documentVersion: Number(document.version)
                    });
                    if (result.completedState) {
                        void writeAcceptedToMap([{ source: result.source, translation: result.translation }])
                            .catch(err => postError(`Status was updated, but the companion .lng could not be updated: ${formatError(err)}`));
                    }
                    const qualityVersion = Number(document.version);
                    void XliffEditorProvider.runQualityCheckForUri(document.uri, document.getText())
                        .then(report => {
                            if (!report || disposed || Number(document.version) !== qualityVersion) return;
                            updateActiveRowStoreQuality(report);
                            return postQualityReportToWebview(report, { includesDrafts: false, preserveVisibility: true });
                        })
                        .catch(() => undefined);
                    return;
                }


                if (message.type === 'aiTranslate') {
                    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
                    if (config.get('ai.enabled', true) === false) {
                        postError('AI translation is disabled in AL Xliff Studio settings.');
                        return;
                    }
                    webviewPanel.webview.postMessage({ type: 'aiBusy', ordinal, busy: true });
                    try {
                        const glossary = config.get('glossary.enabled', true) ? await readProjectGlossary(document.uri) : { entries: [] };
                        const glossaryEntries = glossary.entries || [];
                        const companionMap = await loadCompanionMap(parsed);
                        const aiItem = createAiTranslationItem(
                            unit,
                            parsed,
                            companionMap,
                            glossaryEntries,
                            getAiContextOptions(config)
                        );
                        const aiDetailed = await translateItemsByKeyDetailed([aiItem], parsed.sourceLanguage, parsed.targetLanguage, undefined, undefined, document.uri);
                        const suggestion = aiDetailed.translations.get(aiItem.key);
                        if (!suggestion) {
                            postError('The AI did not return a usable translation. Check placeholders or model availability.');
                            return;
                        }
                        const provenance = provenanceEnabled() ? provenanceFromAi(aiDetailed.model, 'proposal') : undefined;
                        const origin = provenance ? formatProvenanceLabel(provenance) : '';
                        proposalCache.set(ordinal, {
                            source: unit.source,
                            text: suggestion,
                            provenance,
                            origin
                        });
                        await persistStagedItem(ordinal, { kind: 'proposal', text: suggestion, provenance, origin });
                        await webviewPanel.webview.postMessage({
                            type: 'proposalUpdated',
                            ordinal,
                            proposal: suggestion,
                            provenance,
                            origin
                        });
                    } finally {
                        webviewPanel.webview.postMessage({ type: 'aiBusy', ordinal, busy: false });
                    }
                    return;
                }

                if (message.type === 'acceptProposal') {
                    const translation = typeof message.translation === 'string' ? message.translation : '';
                    if (!translation) return;
                    if (!placeholdersMatch(unit.source, translation)) {
                        postError(`Placeholders do not match for: ${unit.source}`);
                        return;
                    }
                    const cached = proposalCache.get(ordinal);
                    proposalCache.delete(ordinal);
                    const supplied = provenanceEnabled() ? sanitizeProvenance(message.provenance) : undefined;
                    const provenance = provenanceEnabled()
                        ? (supplied || (cached && cached.provenance ? cached.provenance : manualProvenance(undefined, 'draft')))
                        : undefined;
                    const origin = provenanceEnabled()
                        ? (String(message.origin || '') || (cached ? (cached.origin || formatProvenanceLabel(cached.provenance)) : 'Manual'))
                        : '';
                    await persistStagedItem(ordinal, { kind: 'draft', text: translation, provenance, origin });
                    await webviewPanel.webview.postMessage({
                        type: 'proposalAcceptedAsDraft',
                        ordinal,
                        translation,
                        provenance,
                        origin
                    });
                    return;
                }


            } catch (err) {
                if (isWorkerCancellation(err)) { messagePerf.mark('operation cancelled'); return; }
                messagePerf.fail(err);
                postError(formatError(err));
            } finally {
                messagePerf.end();
            }
        });
    }

    getHtml(webview) {
        const nonce = String(Date.now());
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>AL Xliff Studio — XLIFF Editor</title>
<style>
:root { --row-border: var(--vscode-panel-border); }
* { box-sizing:border-box; }
html, body { width:100%; height:100%; overflow:hidden; }
body { padding:0; margin:0; color:var(--vscode-foreground); background:var(--vscode-editor-background); font-family:var(--vscode-font-family); display:flex; flex-direction:column; }
.chrome { flex:0 0 auto; z-index:7; background:var(--vscode-editor-background); border-bottom:1px solid var(--row-border); box-shadow:0 1px 3px rgba(0,0,0,.08); }
.editor-workspace { flex:1 1 auto; min-height:0; display:flex; flex-direction:column; overflow:hidden; }
.translation-scroll { flex:1 1 auto; min-height:0; overflow:auto; position:relative; }
.mainbar { display:flex; gap:12px; align-items:center; padding:9px 10px 7px; }
.identity { min-width:190px; flex:1; }
.title { font-size:1.05em; font-weight:600; line-height:1.35; }
.meta { margin-top:2px; color:var(--vscode-descriptionForeground); font-size:.88em; white-space:normal; }
.workflow-hint { margin-top:3px; color:var(--vscode-descriptionForeground); font-size:.78em; white-space:normal; }
.workflow { display:flex; flex-wrap:wrap; gap:5px; justify-content:flex-end; align-items:center; }
.workflow-group { display:flex; gap:5px; align-items:center; }
.workflow button { height:32px; min-height:32px; display:inline-flex; align-items:center; justify-content:center; padding-top:0; padding-bottom:0; line-height:1; }
.workflow-separator { width:1px; height:24px; background:var(--row-border); margin:0 3px; flex:0 0 auto; align-self:center; }
.filterbar { display:flex; flex-wrap:wrap; gap:8px; align-items:center; padding:7px 10px 9px; background:var(--vscode-sideBar-background); border-top:1px solid color-mix(in srgb, var(--row-border) 55%, transparent); }
.filterbar .grow { flex:1; min-width:250px; }
.quick-filters { display:flex; flex-wrap:wrap; gap:5px; align-items:center; }
.pager { display:flex; flex-wrap:wrap; gap:5px; align-items:center; margin-left:auto; }
.pager select { min-width:68px; }
.pager button { min-width:30px; padding-left:7px; padding-right:7px; }
.page-info { min-width:88px; text-align:center; color:var(--vscode-descriptionForeground); font-size:.86em; font-variant-numeric:tabular-nums; white-space:nowrap; }
input, textarea, select, button { font:inherit; color:var(--vscode-input-foreground); background:var(--vscode-input-background); border:1px solid var(--vscode-input-border, var(--row-border)); border-radius:2px; }
input, select { padding:4px 6px; }
textarea { width:100%; min-height:68px; resize:vertical; padding:5px 6px; line-height:1.35; }
button { cursor:pointer; padding:5px 8px; color:var(--vscode-button-secondaryForeground, var(--vscode-foreground)); background:var(--vscode-button-secondaryBackground, var(--vscode-input-background)); border-color:var(--vscode-button-border, var(--row-border)); }
button:hover:not(:disabled) { background:var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground)); }
button:disabled { opacity:.45; cursor:default; }
button.primary-action { color:var(--vscode-button-foreground); background:var(--vscode-button-background); border-color:var(--vscode-button-background); font-weight:600; }
button.primary-action:hover:not(:disabled) { background:var(--vscode-button-hoverBackground); }
button.icon-only { min-width:31px; padding-left:7px; padding-right:7px; font-weight:600; }
button.icon-only .toolbar-icon { width:16px; height:16px; display:block; margin:auto; fill:none; stroke:currentColor; stroke-width:1.35; stroke-linejoin:round; }
#showInvisibles { font-family:Georgia, 'Times New Roman', serif; font-size:18px; line-height:1; }
#showInvisibles[aria-pressed="true"] { color:var(--vscode-button-foreground); background:var(--vscode-button-background); border-color:var(--vscode-button-background); }
#showInvisibles[aria-pressed="true"]:hover { background:var(--vscode-button-hoverBackground); }
#tryGet { min-width:148px; }
#saveDrafts { min-width:132px; }
#acceptAllNoState { min-width:100px; }
.toggle { display:flex; align-items:center; gap:4px; white-space:nowrap; color:var(--vscode-descriptionForeground); padding:3px 6px; border:1px solid transparent; border-radius:3px; }
.toggle:hover { background:var(--vscode-list-hoverBackground); }
.banner { display:none; margin:8px 10px; padding:8px 10px; border:1px solid var(--vscode-inputValidation-warningBorder); background:var(--vscode-inputValidation-warningBackground); white-space:pre-wrap; }
.error { border-color:var(--vscode-inputValidation-errorBorder); background:var(--vscode-inputValidation-errorBackground); }
.error.dismissible { align-items:flex-start; gap:10px; }
.banner-message { flex:1; min-width:0; }
.banner-close { flex:0 0 auto; min-width:24px; padding:0 5px; border:0; background:transparent; color:var(--vscode-foreground); font-size:18px; line-height:20px; opacity:.8; }
.banner-close:hover:not(:disabled) { background:var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); opacity:1; }
table { width:100%; border-collapse:collapse; table-layout:fixed; }
thead { position:sticky; top:0; z-index:5; background:var(--vscode-editor-background); box-shadow:0 1px 0 var(--row-border); }
th { vertical-align:top; border-bottom:1px solid var(--row-border); padding:6px; background:var(--vscode-editor-background); }
.sort { width:100%; border:0; background:transparent; color:var(--vscode-foreground); text-align:left; padding:2px 0 5px; font-weight:600; }
th input { width:100%; min-width:0; }
td { vertical-align:top; border-bottom:1px solid var(--row-border); padding:7px 6px; }
tbody tr:hover { background:var(--vscode-list-hoverBackground); }
tr.row-missing td:first-child { border-left:3px solid var(--vscode-editorWarning-foreground); }
tr.row-review td:first-child { border-left:3px solid var(--vscode-charts-blue); }
tr.row-error td:first-child { border-left:3px solid var(--vscode-editorError-foreground); }
tr.row-terminology td:first-child { border-left:3px solid var(--vscode-editorWarning-foreground); }
tr.row-quality td:first-child { border-left:3px solid var(--vscode-editorWarning-foreground); }
tr.row-quality-error td:first-child { border-left:3px solid var(--vscode-editorError-foreground); }
tr.row-draft td:first-child { box-shadow:inset 3px 0 0 var(--vscode-descriptionForeground); }
.col-source { width:20%; }.col-translation { width:22%; }.col-transfer { width:46px; }.col-proposal { width:22%; }.col-status { width:12%; }.col-notes { width:15%; }.col-actions { width:9%; min-width:112px; }
.source-text { white-space:pre-wrap; word-break:break-word; font-weight:500; }
.unit-id { margin-top:5px; color:var(--vscode-descriptionForeground); font-size:.78em; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.generator-note { margin-top:3px; color:var(--vscode-descriptionForeground); font-size:.76em; line-height:1.3; white-space:normal; word-break:break-word; opacity:.9; }
.notes { white-space:pre-wrap; word-break:break-word; font-size:.9em; }
.note { margin-bottom:6px; }.note-from { color:var(--vscode-descriptionForeground); font-weight:600; }
.printable-text { display:inline; }
.whitespace-text { display:none; white-space:inherit; tab-size:4; }
body.show-invisibles .printable-text { display:none; }
body.show-invisibles .whitespace-text { display:inline; }
.ws-char { position:relative; }
.ws-char::after { position:absolute; left:0; top:0; color:var(--vscode-descriptionForeground); opacity:.9; pointer-events:none; user-select:none; font-weight:500; }
.ws-space::after { content:'·'; width:100%; text-align:center; }
.ws-tab::after { content:'→'; }
.ws-newline::after, .ws-cr::after { content:'¶'; }
.ws-nbsp::after { content:'⍽'; }
.ws-zwsp::after { content:'ZWSP'; font-size:.65em; padding:0 1px; background:var(--vscode-editorHoverWidget-background, var(--vscode-editor-background)); outline:1px solid var(--vscode-descriptionForeground); }
.ws-zwnj::after { content:'ZWNJ'; font-size:.65em; padding:0 1px; background:var(--vscode-editorHoverWidget-background, var(--vscode-editor-background)); outline:1px solid var(--vscode-descriptionForeground); }
.ws-zwj::after { content:'ZWJ'; font-size:.65em; padding:0 1px; background:var(--vscode-editorHoverWidget-background, var(--vscode-editor-background)); outline:1px solid var(--vscode-descriptionForeground); }
.ws-shy::after { content:'SHY'; font-size:.65em; padding:0 1px; background:var(--vscode-editorHoverWidget-background, var(--vscode-editor-background)); outline:1px solid var(--vscode-descriptionForeground); }
.whitespace-editor { position:relative; width:100%; min-height:68px; background:var(--vscode-input-background); }
.whitespace-editor textarea { position:relative; z-index:2; margin:0; tab-size:4; }
.whitespace-overlay { display:none; position:absolute; inset:0; z-index:1; overflow:hidden; pointer-events:none; padding:6px 7px; line-height:1.35; color:var(--vscode-input-foreground); white-space:pre-wrap; overflow-wrap:break-word; tab-size:4; }
.whitespace-overlay-content { position:relative; min-width:100%; min-height:100%; white-space:pre-wrap; overflow-wrap:break-word; tab-size:4; }
body.show-invisibles .whitespace-editor .whitespace-overlay { display:block; }
body.show-invisibles .whitespace-editor textarea { color:transparent; caret-color:var(--vscode-input-foreground); background:transparent; }
body.show-invisibles .whitespace-editor textarea::selection { color:var(--vscode-input-foreground, #fff); background-color:var(--vscode-editor-selectionBackground, #264f78); }
.origin { display:inline-block; margin-top:4px; padding:1px 6px; color:var(--vscode-badge-foreground); background:var(--vscode-badge-background); border-radius:9px; font-size:.78em; }
.provenance-line { display:flex; flex-wrap:wrap; align-items:center; gap:5px; margin-top:4px; }
.provenance-history { margin-top:4px; color:var(--vscode-descriptionForeground); font-size:.78em; }
.provenance-history summary { cursor:pointer; user-select:none; }
.provenance-history div { margin-top:2px; padding-left:8px; border-left:2px solid var(--vscode-panel-border); }
.origin.draft-origin { outline:1px dashed var(--vscode-descriptionForeground); outline-offset:1px; }
.status-stack { display:flex; flex-direction:column; gap:5px; }.status-select { width:100%; }
.status-text { word-break:break-word; }
.warn { color:var(--vscode-editorWarning-foreground); margin-top:4px; font-size:.82em; }
.placeholder-error { margin-top:4px; color:var(--vscode-editorError-foreground); font-weight:600; font-size:.82em; white-space:pre-wrap; }
.terminology-warning { margin-top:4px; color:var(--vscode-editorWarning-foreground); font-weight:600; font-size:.82em; white-space:pre-wrap; }
.maxwidth { margin-top:4px; color:var(--vscode-descriptionForeground); font-size:.82em; }.maxwidth.exceeded { color:var(--vscode-editorError-foreground); font-weight:600; }
.field-actions { display:flex; gap:4px; align-items:center; margin-top:4px; min-height:25px; }
.field-actions button { padding:3px 6px; }
.draft-label { color:var(--vscode-descriptionForeground); font-size:.8em; margin-left:auto; }
.filter-caption { color:var(--vscode-descriptionForeground); font-size:.85em; align-self:center; }
.transfer-cell { vertical-align:top; text-align:center; padding-left:3px; padding-right:3px; }
.transfer-button { display:block; margin-left:auto; margin-right:auto; width:34px; height:34px; padding:0; font-size:1.15em; font-weight:700; }
.actions { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:4px; align-items:start; }
.actions button { min-width:0; padding:5px 5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.developer-transfer { display:block; margin-top:4px; }
.developer-transfer.hidden { display:none; }
.actions button[data-action="search"] { font-size:18px; line-height:1; }
.actions .wide { grid-column:1 / -1; }
.loading-overlay { position:fixed; top:0; left:0; right:0; z-index:20; display:block; pointer-events:none; background:transparent; }
.loading-card { pointer-events:none; display:grid; grid-template-columns:minmax(0,1fr) auto; gap:2px 10px; width:100%; padding:3px 10px 4px; border:0; border-bottom:1px solid color-mix(in srgb, var(--row-border) 55%, transparent); background:color-mix(in srgb, var(--vscode-editor-background) 88%, transparent); box-shadow:none; }
.loading-title { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:11px; line-height:1.2; font-weight:500; color:var(--vscode-descriptionForeground); }
.loading-track { position:relative; grid-column:1 / -1; height:2px; overflow:hidden; background:color-mix(in srgb, var(--vscode-progressBar-background) 22%, transparent); }
.loading-bar { height:100%; width:0%; background:var(--vscode-progressBar-background); opacity:1; transition:width .12s linear; transform:translateX(0); }
.loading-overlay.indeterminate .loading-bar { width:28% !important; animation:xliff-progress-indeterminate 1.05s ease-in-out infinite; transition:none; }
.loading-count { margin:0; white-space:nowrap; font-size:11px; line-height:1.2; color:var(--vscode-descriptionForeground); font-variant-numeric:tabular-nums; }
@keyframes xliff-progress-indeterminate { from { transform:translateX(-120%); } to { transform:translateX(460%); } }
.hidden { display:none !important; }
.readonly-row { opacity:.78; }
.translate-no { opacity:.62; }
.busy { outline:1px solid var(--vscode-progressBar-background); outline-offset:-1px; }
tr.saved-flash { --xliff-navigation-highlight:var(--vscode-testing-iconPassed); outline:1px solid var(--xliff-navigation-highlight); outline-offset:-1px; }
tr.saved-flash.saved-flash-warning { --xliff-navigation-highlight:var(--vscode-editorWarning-foreground); }
tr.saved-flash.saved-flash-error { --xliff-navigation-highlight:var(--vscode-editorError-foreground); }
tr.saved-flash.saved-flash-info { --xliff-navigation-highlight:var(--vscode-charts-blue); }
tr.saved-flash > td { background:color-mix(in srgb, var(--xliff-navigation-highlight) 14%, var(--vscode-editor-background)); }
tbody tr.saved-flash:hover > td { background:color-mix(in srgb, var(--xliff-navigation-highlight) 18%, var(--vscode-editor-background)); }
.quality-inline { margin-top:5px; display:grid; gap:3px; }
.quality-item { font-size:.78em; line-height:1.3; color:var(--vscode-editorWarning-foreground); }
.quality-item.error { color:var(--vscode-editorError-foreground); }
.quality-item.info { color:var(--vscode-descriptionForeground); }
.quality-panel { flex:0 0 auto; margin:8px 10px 6px; border:1px solid var(--row-border); background:var(--vscode-sideBar-background); min-height:0; }
.quality-panel.hidden { display:none; }
.quality-header { display:flex; flex-wrap:wrap; align-items:center; gap:8px; padding:8px 10px; border-bottom:1px solid var(--row-border); }
.quality-panel.collapsed .quality-header { border-bottom:0; }
.quality-header strong { margin-right:auto; }
.quality-summary { color:var(--vscode-descriptionForeground); font-size:.86em; }
.quality-severity-filters { display:flex; flex-wrap:wrap; align-items:center; gap:6px; }
.quality-severity-filters .toggle { font-size:.82em; white-space:nowrap; }
.quality-toggle { min-width:31px; font-weight:700; }
.quality-body { max-height:min(34vh, 360px); min-height:100px; overflow:hidden; display:flex; flex-direction:column; }
.quality-panel.collapsed .quality-body { display:none; }
.quality-list { flex:1 1 auto; min-height:0; overflow:auto; overscroll-behavior:contain; }
.quality-pager { flex-wrap:wrap; flex:0 0 auto; display:flex; align-items:center; justify-content:flex-end; gap:6px; padding:6px 10px; border-top:1px solid var(--row-border); background:var(--vscode-sideBar-background); }
.quality-pager select { width:auto; min-width:58px; }
.quality-page-info { min-width:72px; text-align:center; color:var(--vscode-descriptionForeground); font-variant-numeric:tabular-nums; }
.quality-row { display:grid; grid-template-columns:26px minmax(120px,180px) 1fr auto; gap:8px; align-items:start; padding:6px 10px; border-bottom:1px solid color-mix(in srgb, var(--row-border) 55%, transparent); }
.quality-row:last-child { border-bottom:0; }
.quality-severity { font-weight:700; text-align:center; }
.quality-severity.error { color:var(--vscode-editorError-foreground); }
.quality-severity.warning { color:var(--vscode-editorWarning-foreground); }
.quality-severity.info { color:var(--vscode-descriptionForeground); }
.quality-code { color:var(--vscode-descriptionForeground); font-size:.82em; }
.quality-message { min-width:0; }
.quality-source { color:var(--vscode-descriptionForeground); font-size:.8em; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.quality-row .quality-actions { display:flex; grid-template-columns:none; align-items:center; justify-content:flex-end; gap:4px; white-space:nowrap; }
.quality-ignore-actions { display:inline-flex; align-items:center; gap:4px; white-space:nowrap; }
.quality-ignore-actions button { flex:0 0 auto; }
.quality-global-ignore { width:30px; min-width:30px !important; height:28px; padding:4px 6px !important; display:inline-flex; align-items:center; justify-content:center; color:var(--vscode-foreground); }
.quality-action-icon { width:16px; height:16px; display:block; fill:none; stroke:currentColor; }
.quality-action-icon .quality-ignore-slash { stroke-width:1.75; }
@media (max-width:1180px) {
  .mainbar { align-items:flex-start; }
  .workflow { max-width:62%; }
  .col-notes { width:13%; }.col-actions { width:11%; }
}
</style>
</head>
<body>
<div class="chrome" id="chrome">
  <div class="mainbar">
    <div class="identity">
      <div class="title">AL Xliff Studio — XLIFF Editor</div>
      <div class="meta" id="meta">Loading…</div>
      <div class="workflow-hint">⇄ Sync → ? Try Translation / AI → review proposals → ← Proposals to Drafts → ✓ Apply Drafts → translated</div>
    </div>
    <div class="workflow">
      <div class="workflow-group">
        <button id="sync" title="Synchronize translation units with the matching generated .g.xlf file and create/update the companion .lng translation memory. This never creates proposals.">⇄ Sync</button>
        <button id="tryGet" class="primary-action" title="Stage missing translations without accepting them as targets. Drafts and proposals are persisted as AL Xliff Studio notes in the XLIFF; Developer comments, exact .lng matches, and exact glossary matches become Translation drafts; fuzzy and AI matches become Proposal drafts.">? Try Translation</button>
        <button id="acceptVisible" title="Move all valid visible proposals into editable Translation drafts. The staged value remains metadata only and is persisted as an AL Xliff Studio note until applied.">← Proposals to Drafts</button>
        <button id="saveDrafts" title="Apply all Translation drafts as target translations and set them to state=translated. Proposal drafts stay proposals until moved with Proposals to Drafts.">✓ Apply Drafts</button>
        <button id="discardDrafts" title="Discard all staged Translation drafts and Proposal drafts and remove their persisted staging notes from the XLIFF.">↶ Discard Drafts</button>
      </div>
      <span class="workflow-separator" aria-hidden="true"></span>
      <div class="workflow-group">
        <button id="acceptAllNoState" title="Set all existing non-empty no-state translations to translated after a confirmation prompt. Translation text is not changed.">✓ No State</button>
        <button id="qualityCheck" title="Run the XLIFF quality check. Persisted staged drafts are included without being applied as target translations.">! Quality Check</button>
      </div>
      <span class="workflow-separator" aria-hidden="true"></span>
      <div class="workflow-group">
        <button id="showInvisibles" class="icon-only" title="Show non-printing characters in Source, Translation, Proposed translation and Developer notes" aria-label="Show non-printing characters" aria-pressed="false">¶</button>
      </div>
      <span class="workflow-separator" aria-hidden="true"></span>
      <div class="workflow-group">
        <button id="dashboard" class="icon-only" title="Open project-wide Translation Dashboard" aria-label="Open project-wide Translation Dashboard"><svg class="toolbar-icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2" width="5" height="5" rx="0.5"></rect><rect x="9" y="2" width="5" height="5" rx="0.5"></rect><rect x="2" y="9" width="5" height="5" rx="0.5"></rect><rect x="9" y="9" width="5" height="5" rx="0.5"></rect></svg></button>
        <button id="glossary" class="icon-only" title="Open project terminology glossary">T</button>
        <button id="refresh" class="icon-only" title="Refresh editor view">↻</button>
        <button id="openText" class="icon-only" title="Open raw XLIFF/XML">&lt;/&gt;</button>
      </div>
      <span class="workflow-separator" aria-hidden="true"></span>
      <div class="workflow-group">
        <button id="saveFile" class="primary-action" title="Save the XLIFF file. Staged Translation/Proposal drafts remain staged until Apply Drafts.">Save</button>
      </div>
    </div>
  </div>
<div class="quality-panel hidden" id="qualityPanel">
  <div class="quality-header"><strong>Quality Check</strong><span class="quality-summary" id="qualitySummary"></span><div class="quality-severity-filters" title="Severity filters are OR-combined. With none selected, all severities are shown."><span class="filter-caption">Any:</span><label class="toggle"><input id="qualityFilterInfo" type="checkbox"> Info</label><label class="toggle"><input id="qualityFilterWarning" type="checkbox"> Warning</label><label class="toggle"><input id="qualityFilterError" type="checkbox"> Error</label></div><button id="qualityRefresh" class="icon-only" title="Run the quality check again">↻</button><button id="qualityProblems" title="Open the VS Code Problems view. For large XLIFF files the published diagnostics can be capped by alXliffStudio.quality.maxProblemsDiagnostics; all findings remain available here.">Problems</button><button id="qualityIgnored" title="Show ignored Quality Check findings">Ignored (0)</button><button id="qualityToggle" class="quality-toggle icon-only" title="Collapse quality results" aria-expanded="true">⌃</button></div>
  <div class="quality-body" id="qualityBody"><div class="quality-list" id="qualityList"></div><div class="quality-pager" id="qualityPager" aria-label="Quality result pagination"><label class="filter-caption" for="qualitySort">Sort:</label><select id="qualitySort" title="Sort all filtered Quality findings"><option value="report">Rule priority</option><option value="severity">Severity</option><option value="ordinal">Entry number</option><option value="code">Rule</option><option value="source">Source</option><option value="target">Translation</option></select><select id="qualitySortDirection" aria-label="Quality sort direction"><option value="asc">Ascending ↑</option><option value="desc">Descending ↓</option></select><span class="filter-caption">Page size:</span><select id="qualityPageSize" title="Quality findings per page"><option value="50">50</option><option value="100" selected>100</option><option value="200">200</option></select><button id="qualityFirstPage" class="icon-only" title="First quality page">«</button><button id="qualityPrevPage" class="icon-only" title="Previous quality page">‹</button><span class="quality-page-info" id="qualityPageInfo">0 / 0</span><button id="qualityNextPage" class="icon-only" title="Next quality page">›</button><button id="qualityLastPage" class="icon-only" title="Last quality page">»</button></div></div>
</div>
  <div class="filterbar">
    <input class="grow" id="globalFilter" type="search" placeholder="Search source, translation, proposal, status, notes or id…">
    <div class="quick-filters" title="Quick filters are OR-combined: a row is shown when it matches any selected category.">
      <span class="filter-caption">Any:</span>
      <label class="toggle"><input id="translatedOnly" type="checkbox"> Translated</label>
      <label class="toggle"><input id="missingOnly" type="checkbox"> Missing</label>
      <label class="toggle"><input id="reviewOnly" type="checkbox"> Review</label>
      <label class="toggle"><input id="proposalOnly" type="checkbox"> Proposals</label>
      <label class="toggle"><input id="draftOnly" type="checkbox"> Drafts</label>
      <label class="toggle"><input id="placeholderErrorsOnly" type="checkbox"> Placeholder errors</label>
      <label class="toggle"><input id="terminologyErrorsOnly" type="checkbox"> Terminology</label>
      <label class="toggle"><input id="noStateOnly" type="checkbox"> No State</label>
      <label class="toggle"><input id="qualityOnly" type="checkbox"> Quality</label>
    </div>
    <div class="pager" aria-label="Pagination">
      <span class="filter-caption">Page size:</span>
      <select id="pageSize" title="Entries per page">
        <option value="50">50</option>
        <option value="100" selected>100</option>
        <option value="200">200</option>
      </select>
      <button id="firstPage" class="icon-only" title="First page">«</button>
      <button id="prevPage" class="icon-only" title="Previous page">‹</button>
      <span class="page-info" id="pageInfo">1 / 1</span>
      <button id="nextPage" class="icon-only" title="Next page">›</button>
      <button id="lastPage" class="icon-only" title="Last page">»</button>
    </div>
    <button id="clearFilters" title="Clear all filters">Reset</button>
  </div>
</div>
<div class="editor-workspace" id="editorWorkspace">
<div class="banner error dismissible" id="error"><span class="banner-message" id="errorMessage"></span><button class="banner-close" id="errorClose" type="button" title="Close error message" aria-label="Close error message">×</button></div>
<div class="banner" id="warning"></div>
<div class="translation-scroll" id="translationScroll">
<table>
<thead>
<tr>
  <th class="col-source"><button class="sort" data-sort="source">Source</button><input id="filter-source" placeholder="Filter source"></th>
  <th class="col-translation"><button class="sort" data-sort="translation">Translation</button><input id="filter-translation" placeholder="Filter translation"></th>
  <th class="col-transfer" title="Move proposal into Translation draft"></th>
  <th class="col-proposal"><button class="sort" data-sort="proposal">Proposed translation</button><input id="filter-proposal" placeholder="Filter proposal"></th>
  <th class="col-status"><button class="sort" data-sort="status">Status</button><input id="filter-status" placeholder="Filter status"></th>
  <th class="col-notes"><button class="sort" data-sort="notes">Notes</button><input id="filter-notes" placeholder="Filter notes"></th>
  <th class="col-actions">Actions</th>
</tr>
</thead>
<tbody id="rows"></tbody>
</table>
</div>
</div>
<div class="loading-overlay hidden" id="loadingOverlay" role="status" aria-live="polite" aria-label="Background activity">
  <div class="loading-card">
    <div class="loading-title" id="loadingTitle">Loading XLIFF…</div>
    <div class="loading-track"><div class="loading-bar" id="loadingBar"></div></div>
    <div class="loading-count" id="loadingCount">0 / 0 units</div>
  </div>
</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
let model = { sourceLanguage:'', targetLanguage:'', readOnly:false, generated:false, dirty:false, stats:{}, performanceDebugEnabled:false, performanceDebugSlowThresholdMs:250 };
// Only mutable/staged state lives globally in the webview. Full row content is
// page-scoped and stays in pageRowCache. This avoids retaining Source/Translation
// strings twice for tens of thousands of units.
const rowStateByOrdinal = new Map();
const dirtyOrdinals = new Set();
const proposalOrdinals = new Set();
const appliedUndoOrdinals = new Set();
const viewOverrideOrdinals = new Set();
const summaryTouchedRows = new Set();
const pageRowCache = new Map();
let pageRowCacheKey = '';
let pageRequestSequence = 0;
let activePageRequestId = 0;
let activePageRequestKey = '';
let pendingPageRenderOptions = null;
let pendingViewRenderContext = null;
let webviewPerfSequence = 0;
function postWebviewPerformance(operation, startedAt, meta, phase) {
  if (!model.performanceDebugEnabled) return;
  const durationMs = Math.max(0, performance.now() - startedAt);
  vscode.postMessage({
    type:'performanceTrace',
    traceId:'webview-' + (++webviewPerfSequence),
    operation:operation,
    phase:phase || '',
    durationMs:durationMs,
    meta:meta || {}
  });
}

let sortField = 'source';
let sortDirection = 1;
const busyAi = new Set();
const busyTry = new Set();
const busyStatusRows = new Set();
const busyApplyRows = new Set();
const stagePersistTimers = new Map();
const pendingStagePersistence = new Map();
let stageRevisionCounter = 0;
let latestDocumentVersion = 0;
let pendingRenderOptions = null;
let tryAllBusy = false;
let syncBusy = false;
let applyDraftsBusy = false;
let applyDraftsOverlayVisible = false;
let activeLoadId = 0;
let renderGeneration = 0;
let renderOverlayGeneration = 0;
const persistedState = vscode.getState() || {};
let pageSize = [50,100,200].includes(Number(persistedState.pageSize)) ? Number(persistedState.pageSize) : 100;
let showInvisibles = Boolean(persistedState.showInvisibles);
let currentPage = Math.max(1, Number(persistedState.currentPage) || 1);
let qualityPageSize = 100;
let qualityPage = 1;
let lastKnownScrollTop = Math.max(0, Number(persistedState.scrollTop) || 0);
let suppressScrollTracking = false;
let scrollRestoreGeneration = 0;
let hasRenderedRows = false;
let lastPageState = null;
let navigationOrdinal = null;
let pendingNavigationOrdinal = null;
let navigationSeverity = '';
let pendingNavigationSeverity = '';
const RENDER_CHUNK_SIZE = 50;
const RENDER_OVERLAY_UNIT_THRESHOLD = 500;
const APPLY_DRAFTS_OVERLAY_THRESHOLD = 20;
const LOADING_OVERLAY_DELAY_MS = 300;
const FILTER_RENDER_DEBOUNCE_MS = 120;
const rowsElement = document.getElementById('rows');
const metaElement = document.getElementById('meta');
const errorElement = document.getElementById('error');
const errorMessageElement = document.getElementById('errorMessage');
const errorCloseButton = document.getElementById('errorClose');
const warningElement = document.getElementById('warning');
const globalFilter = document.getElementById('globalFilter');
const filters = {
  source: document.getElementById('filter-source'),
  translation: document.getElementById('filter-translation'),
  proposal: document.getElementById('filter-proposal'),
  status: document.getElementById('filter-status'),
  notes: document.getElementById('filter-notes')
};
const translatedOnly = document.getElementById('translatedOnly');
const missingOnly = document.getElementById('missingOnly');
const reviewOnly = document.getElementById('reviewOnly');
const proposalOnly = document.getElementById('proposalOnly');
const draftOnly = document.getElementById('draftOnly');
const placeholderErrorsOnly = document.getElementById('placeholderErrorsOnly');
const terminologyErrorsOnly = document.getElementById('terminologyErrorsOnly');
const noStateOnly = document.getElementById('noStateOnly');
const qualityOnly = document.getElementById('qualityOnly');
const saveFileButton = document.getElementById('saveFile');
const syncButton = document.getElementById('sync');
const tryGetButton = document.getElementById('tryGet');
const saveDraftsButton = document.getElementById('saveDrafts');
const acceptAllNoStateButton = document.getElementById('acceptAllNoState');
const discardDraftsButton = document.getElementById('discardDrafts');
const acceptVisibleButton = document.getElementById('acceptVisible');
const qualityCheckButton = document.getElementById('qualityCheck');
const showInvisiblesButton = document.getElementById('showInvisibles');
const qualityPanel = document.getElementById('qualityPanel');
const qualitySummary = document.getElementById('qualitySummary');
const qualityList = document.getElementById('qualityList');
const qualityBody = document.getElementById('qualityBody');
const qualityToggle = document.getElementById('qualityToggle');
const qualityRefresh = document.getElementById('qualityRefresh');
const qualityIgnoredButton = document.getElementById('qualityIgnored');
const qualityFilterInfo = document.getElementById('qualityFilterInfo');
const qualityFilterWarning = document.getElementById('qualityFilterWarning');
const qualityFilterError = document.getElementById('qualityFilterError');
const qualitySeverityFilters = [qualityFilterInfo, qualityFilterWarning, qualityFilterError];
const qualityPageSizeSelect = document.getElementById('qualityPageSize');
const qualityFirstPageButton = document.getElementById('qualityFirstPage');
const qualityPrevPageButton = document.getElementById('qualityPrevPage');
const qualityNextPageButton = document.getElementById('qualityNextPage');
const qualityLastPageButton = document.getElementById('qualityLastPage');
const qualityPageInfo = document.getElementById('qualityPageInfo');
qualityPageSizeSelect.value = String(qualityPageSize);
const qualitySortSelect = document.getElementById('qualitySort');
const qualitySortDirectionSelect = document.getElementById('qualitySortDirection');
let qualitySortColumn = ['report','severity','ordinal','code','source','target'].includes(persistedState.qualitySortColumn) ? persistedState.qualitySortColumn : 'report';
let qualitySortDirection = persistedState.qualitySortDirection === 'desc' ? 'desc' : 'asc';
qualitySortSelect.value = qualitySortColumn;
qualitySortDirectionSelect.value = qualitySortDirection;
let qualityView = 'active';
let paintedQualityQueryKey = '';
let qualityReportAvailable = false;
let currentQualityReport = null;
let currentQualityPage = null;
let qualityRequestSequence = 0;
let activeQualityRequestId = 0;
let deferredQualityNotifiedLoadId = 0;
let currentQualityIncludesDrafts = false;
const translationScroll = document.getElementById('translationScroll');
const chromeElement = document.getElementById('chrome');
const loadingOverlay = document.getElementById('loadingOverlay');
const loadingTitle = document.getElementById('loadingTitle');
const loadingBar = document.getElementById('loadingBar');
const loadingCount = document.getElementById('loadingCount');
const pageSizeSelect = document.getElementById('pageSize');
const firstPageButton = document.getElementById('firstPage');
const prevPageButton = document.getElementById('prevPage');
const nextPageButton = document.getElementById('nextPage');
const lastPageButton = document.getElementById('lastPage');
const pageInfo = document.getElementById('pageInfo');
pageSizeSelect.value = String(pageSize);
applyShowInvisiblesState();
let loadingShowTimer = null;
let loadingRequested = false;
function setLoading(stage, current, total, visible, itemLabel) {
  const safeTotal = Math.max(0, Number(total) || 0);
  const safeCurrent = Math.min(safeTotal || Number(current) || 0, Math.max(0, Number(current) || 0));
  const percent = safeTotal > 0 ? Math.max(0, Math.min(100, Math.round((safeCurrent / safeTotal) * 100))) : 0;
  const label = itemLabel || 'units';
  loadingTitle.textContent = stage || 'Loading XLIFF';
  loadingCount.textContent = safeTotal > 0 ? (safeCurrent.toLocaleString() + ' / ' + safeTotal.toLocaleString() + ' ' + label) : 'Working…';
  loadingOverlay.classList.toggle('indeterminate', safeTotal <= 0);
  loadingBar.style.width = percent + '%';
  if (!visible) {
    hideLoading();
    return;
  }
  loadingRequested = true;
  if (!loadingOverlay.classList.contains('hidden') || loadingShowTimer) return;
  loadingShowTimer = setTimeout(function() {
    loadingShowTimer = null;
    if (loadingRequested) loadingOverlay.classList.remove('hidden');
  }, LOADING_OVERLAY_DELAY_MS);
}
function hideLoading() {
  loadingRequested = false;
  if (loadingShowTimer) {
    clearTimeout(loadingShowTimer);
    loadingShowTimer = null;
  }
  loadingOverlay.classList.add('hidden');
  loadingOverlay.classList.remove('indeterminate');
}
function esc(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function(c) { return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
function whitespaceDecoratedHtml(value) {
  const text = String(value == null ? '' : value);
  let html = '';
  for (let index = 0; index < text.length; index++) {
    const ch = text[index];
    if (ch === ' ') { html += '<span class="ws-char ws-space"> </span>'; continue; }
    if (ch === '\\t') { html += '<span class="ws-char ws-tab">\\t</span>'; continue; }
    if (ch === '\\r') {
      if (text[index + 1] === '\\n') continue;
      html += '<span class="ws-char ws-cr"></span>\\r';
      continue;
    }
    if (ch === '\\n') { html += '<span class="ws-char ws-newline"></span>\\n'; continue; }
    if (ch === '\\u00a0' || ch === '\\u202f') { html += '<span class="ws-char ws-nbsp">' + ch + '</span>'; continue; }
    if (ch === '\\u200b') { html += '<span class="ws-char ws-zwsp">' + ch + '</span>'; continue; }
    if (ch === '\\u200c') { html += '<span class="ws-char ws-zwnj">' + ch + '</span>'; continue; }
    if (ch === '\\u200d') { html += '<span class="ws-char ws-zwj">' + ch + '</span>'; continue; }
    if (ch === '\\u00ad') { html += '<span class="ws-char ws-shy">' + ch + '</span>'; continue; }
    html += esc(ch);
  }
  return html;
}
function whitespaceStaticHtml(value) {
  return '<span class="printable-text">' + esc(value) + '</span><span class="whitespace-text" aria-hidden="true">' + whitespaceDecoratedHtml(value) + '</span>';
}
function whitespaceEditorHtml(action, ordinal, value, disabled) {
  return '<div class="whitespace-editor"><textarea data-action="' + action + '" data-ordinal="' + ordinal + '"' + (disabled ? ' disabled' : '') + '>' + esc(value) + '</textarea><div class="whitespace-overlay" aria-hidden="true"><div class="whitespace-overlay-content">' + whitespaceDecoratedHtml(value) + '</div></div></div>';
}
function updateWhitespaceOverlay(editor) {
  if (!editor || !editor.closest) return;
  const wrapper = editor.closest('.whitespace-editor');
  if (!wrapper) return;
  const content = wrapper.querySelector('.whitespace-overlay-content');
  if (!content) return;
  content.innerHTML = whitespaceDecoratedHtml(editor.value);
  content.style.transform = 'translate(' + (-Number(editor.scrollLeft || 0)) + 'px,' + (-Number(editor.scrollTop || 0)) + 'px)';
}
function refreshVisibleWhitespaceEditors() {
  rowsElement.querySelectorAll('.whitespace-editor textarea').forEach(updateWhitespaceOverlay);
}
function applyShowInvisiblesState() {
  document.body.classList.toggle('show-invisibles', showInvisibles);
  showInvisiblesButton.setAttribute('aria-pressed', showInvisibles ? 'true' : 'false');
  showInvisiblesButton.title = showInvisibles ? 'Hide non-printing characters' : 'Show non-printing characters in Source, Translation, Proposed translation and Developer notes';
  if (showInvisibles) refreshVisibleWhitespaceEditors();
}
function lower(value) { return String(value == null ? '' : value).toLocaleLowerCase(); }
function extractPlaceholders(value) { return (String(value == null ? '' : value).match(/%\\d+|#\\d+|\\{\\{?[^{}]+\\}?\\}/g) || []).sort(); }
function placeholderError(source, translation) {
  if (!String(translation == null ? '' : translation).length) return '';
  const expected = [...new Set(extractPlaceholders(source).filter(function(value) { return /^%[0-9]+$/.test(value); }))];
  const actual = [...new Set(extractPlaceholders(translation).filter(function(value) { return /^%[0-9]+$/.test(value); }))];
  if (!expected.length && !actual.length) return '';
  if (expected.every(function(value) { return actual.includes(value); })) return '';
  return 'Placeholder mismatch — expected: ' + (expected.length ? expected.join(', ') : '(none)') + '; translation: ' + (actual.length ? actual.join(', ') : '(none)');
}
function terminologyError(row, translation) {
  const text = String(translation == null ? '' : translation);
  if (!text || !row.glossaryTerms || !row.glossaryTerms.length) return '';
  const missing = row.glossaryTerms.filter(function(term) { return !lower(text).includes(lower(term.translation)); });
  if (!missing.length) return '';
  return missing.map(function(term) { return 'Terminology: “' + term.source + '” should use “' + term.translation + '”.'; }).join(String.fromCharCode(10));
}
function hasTranslationTerminologyError(row) {
  if (!Array.isArray(row.glossaryTerms)) return Boolean(row.translationTerminologyError);
  return Boolean(terminologyError(row, row.translation));
}
function hasTerminologyError(row) {
  if (!Array.isArray(row.glossaryTerms)) return Boolean(row.translationTerminologyError || row.proposalTerminologyError);
  return Boolean(terminologyError(row, row.translation) || terminologyError(row, row.proposal));
}
function noStateAcceptable(row) {
  if (row.notTranslatable || String(row.rawState || "").trim()) return false;
  if (typeof row.noStateAcceptable === 'boolean' && !pageRowCache.has(Number(row.ordinal))) return row.noStateAcceptable;
  return Boolean(!row.notTranslatable && !row.rawState && String(row.savedTranslation == null ? row.translation || '' : row.savedTranslation).trim().length > 0 && !placeholderError(row.source, row.savedTranslation == null ? row.translation : row.savedTranslation));
}
function qualityIssueCount(row) { return Array.isArray(row.qualityIssues) ? row.qualityIssues.length : (Number(row.qualityIssueCount) || 0); }
// Quality issue totals come from the Quality report itself. Do not include them in
// per-row delta accounting; large reports are delivered asynchronously/chunked.
const summaryCounterNames = ['total','missing','review','proposals','translationDrafts','staged','placeholderErrors','terminologyErrors','noState','appliedUndo'];
function rowSummaryContribution(row) {
  if (!row) return {total:0,missing:0,review:0,proposals:0,translationDrafts:0,staged:0,placeholderErrors:0,terminologyErrors:0,qualityIssues:0,noState:0,appliedUndo:0};
  const fullRow = Array.isArray(row.glossaryTerms);
  const hasDraft = Boolean(row.translationDirty || row.hasTranslationDraft);
  const hasProposal = Boolean(row.proposal);
  const translationPlaceholder = fullRow ? Boolean(placeholderError(row.source, row.translation)) : Boolean(row.translationPlaceholderError);
  const proposalPlaceholder = fullRow ? Boolean(placeholderError(row.source, row.proposal)) : Boolean(row.proposalPlaceholderError);
  const terminology = fullRow ? hasTerminologyError(row) : Boolean(row.translationTerminologyError || row.proposalTerminologyError);
  const noState = noStateAcceptable(row);
  return {
    total:1,
    missing:row.missing ? 1 : 0,
    review:row.review ? 1 : 0,
    proposals:hasProposal ? 1 : 0,
    translationDrafts:hasDraft ? 1 : 0,
    staged:(hasDraft || hasProposal) ? 1 : 0,
    placeholderErrors:(translationPlaceholder || proposalPlaceholder) ? 1 : 0,
    terminologyErrors:terminology ? 1 : 0,
    qualityIssues:qualityIssueCount(row),
    noState:noState ? 1 : 0,
    appliedUndo:row.appliedUndo ? 1 : 0
  };
}
function setRowSummarySnapshot(row, contribution) {
  if (!row) return;
  Object.defineProperty(row, '__summarySnapshot', { value:contribution || rowSummaryContribution(row), writable:true, configurable:true, enumerable:false });
}
function ensureRowSummarySnapshot(row) {
  if (!row) return undefined;
  if (!row.__summarySnapshot) setRowSummarySnapshot(row);
  return row.__summarySnapshot;
}
function applySummaryContributionDelta(before, after) {
  if (!model.stats) model.stats = {};
  summaryCounterNames.forEach(function(name) {
    const delta = Number(after && after[name] || 0) - Number(before && before[name] || 0);
    if (!delta) return;
    model.stats[name] = Math.max(0, Number(model.stats[name] || 0) + delta);
  });
}
function markSummaryRowTouched(row) {
  if (!row) return row;
  ensureRowSummarySnapshot(row);
  summaryTouchedRows.add(row);
  return row;
}
function reconcileSummaryStatsForRow(row) {
  if (!row) return;
  const before = ensureRowSummarySnapshot(row);
  const after = rowSummaryContribution(row);
  applySummaryContributionDelta(before, after);
  setRowSummarySnapshot(row, after);
  summaryTouchedRows.delete(row);
}
function flushSummaryStats() {
  if (!summaryTouchedRows.size) return;
  Array.from(summaryTouchedRows).forEach(reconcileSummaryStatsForRow);
}
function draftProvenance(origin, basedOn) {
  if (!model.provenanceEnabled) return undefined;
  const event = { v:1, at:new Date().toISOString(), origin:origin || 'manual', action:'draft' };
  if (basedOn && typeof basedOn === 'object') event.basedOn = basedOn;
  return event;
}
function translationProvenanceInnerHtml(row) {
  if (!model.provenanceEnabled) return '';
  const draftOrigin = row.translationDirty ? (row.translationDraftOrigin || 'Manual') : '';
  const savedOrigin = row.translationProvenanceLabel || '';
  const latest = draftOrigin || savedOrigin;
  const badge = '<div class="provenance-line"><span data-role="translation-origin" data-ordinal="' + row.ordinal + '" class="origin' + (draftOrigin ? ' draft-origin' : '') + (latest ? '' : ' hidden') + '">' + esc((draftOrigin ? 'Draft · ' : '') + latest) + '</span></div>';
  const history = (row.provenanceHistoryLabels || []).filter(Boolean);
  const historyHtml = history.length ? '<details class="provenance-history"><summary>History ' + history.length + '</summary>' + history.slice().reverse().map(function(item) { return '<div>' + esc(item) + '</div>'; }).join('') + '</details>' : '';
  return badge + historyHtml;
}
function translationProvenanceHtml(row) {
  return '<div data-role="translation-provenance-block" data-ordinal="' + row.ordinal + '">' + translationProvenanceInnerHtml(row) + '</div>';
}
function fieldValue(row, field) { if (field === 'notes') return notesText(row); return String(row[field] == null ? '' : row[field]); }
function draftCount() { return dirtyOrdinals.size; }
function stagedCount() {
  let count = dirtyOrdinals.size;
  proposalOrdinals.forEach(function(ordinal) { if (!dirtyOrdinals.has(ordinal)) count++; });
  return count;
}
function rowStateForStage(ordinal) {
  const numeric = Number(ordinal);
  return pageRowCache.get(numeric) || rowStateByOrdinal.get(numeric) || { ordinal:numeric };
}
function dirtyRows() { return Array.from(dirtyOrdinals).map(rowStateForStage); }
function stagedRows() {
  const ordinals = new Set();
  dirtyOrdinals.forEach(function(ordinal) { ordinals.add(ordinal); });
  proposalOrdinals.forEach(function(ordinal) { ordinals.add(ordinal); });
  return Array.from(ordinals).map(rowStateForStage);
}
function isRowTextEditor(element) {
  return Boolean(element && element.matches && element.matches('textarea[data-action="translation"], textarea[data-action="proposal"]'));
}
function isRowTextEditingActive() {
  return isRowTextEditor(document.activeElement);
}
function cancelStagePersistence(ordinal) {
  const key = String(ordinal);
  const timer = stagePersistTimers.get(key);
  if (timer) clearTimeout(timer);
  stagePersistTimers.delete(key);
  pendingStagePersistence.delete(key);
}
function cancelAllStagePersistence() {
  stagePersistTimers.forEach(function(timer) { clearTimeout(timer); });
  stagePersistTimers.clear();
  pendingStagePersistence.clear();
}
function persistStageNow(row, kind) {
  cancelStagePersistence(row.ordinal);
  if (kind === 'draft') {
    vscode.postMessage({
      type:'translationDraftChanged',
      ordinal:row.ordinal,
      hasDraft:Boolean(row.translationDirty),
      text:row.translation,
      provenance:row.translationDraftProvenance,
      origin:row.translationDraftOrigin,
      revision:Number(row.translationEditRevision) || 0
    });
    return;
  }
  vscode.postMessage({
    type:'proposalChanged',
    ordinal:row.ordinal,
    text:row.proposal || '',
    provenance:row.proposalProvenance,
    origin:row.proposalOrigin
  });
}
function queueStagePersistence(row, kind) {
  const key = String(row.ordinal);
  const timer = stagePersistTimers.get(key);
  if (timer) clearTimeout(timer);
  stagePersistTimers.delete(key);
  pendingStagePersistence.set(key, { ordinal:row.ordinal, kind:kind });
  // Manual text editing must remain entirely local while a Translation/Proposal
  // textarea owns focus. Persisting staging notes edits/saves the backing XLIFF and
  // can make VS Code refresh the custom editor, which interrupts typing.
  if (isRowTextEditingActive()) return;
  stagePersistTimers.set(key, setTimeout(function() {
    stagePersistTimers.delete(key);
    const pending = pendingStagePersistence.get(key);
    if (!pending) return;
    const current = rowByOrdinal(pending.ordinal);
    if (current) persistStageNow(current, pending.kind);
  }, 450));
}
function flushPendingStagePersistence() {
  if (isRowTextEditingActive() || !pendingStagePersistence.size) return;
  const pending = Array.from(pendingStagePersistence.values());
  pendingStagePersistence.clear();
  pending.forEach(function(item) {
    const current = rowByOrdinal(Number(item.ordinal));
    if (current) persistStageNow(current, item.kind);
  });
}
function flushDeferredRender() {
  if (isRowTextEditingActive() || !pendingRenderOptions) return;
  const options = pendingRenderOptions;
  pendingRenderOptions = null;
  render(options);
}
function settleTextEditing() {
  setTimeout(function() {
    if (isRowTextEditingActive()) return;
    flushPendingStagePersistence();
    flushDeferredRender();
  }, 0);
}
function statusOptions(row) {
  const values = ['translated','signed-off','final','needs-translation','needs-adaptation','needs-l10n','needs-review-translation','needs-review-adaptation','needs-review-l10n','new','__none__'];
  const current = row.status === 'missing' ? 'missing' : (row.rawState || '__none__');
  if (row.status === 'missing' && !values.includes('missing')) values.unshift('missing');
  return values.map(function(value) {
    const label = value === '__none__' ? '(no state)' : value;
    const selected = (value === current || (value === 'missing' && row.status === 'missing')) ? ' selected' : '';
    const disabled = value === 'missing' ? ' disabled' : '';
    return '<option value="' + esc(value) + '"' + selected + disabled + '>' + esc(label) + '</option>';
  }).join('');
}
function noteHtml(row) {
  if (!row.notes || !row.notes.length) return '<span class="meta">—</span>';
  return row.notes.map(function(note) {
    const from = note.from ? '<span class="note-from">' + esc(note.from) + ':</span> ' : '';
    const text = note.from === 'Developer' ? whitespaceStaticHtml(note.text) : esc(note.text);
    return '<div class="note">' + from + text + '</div>';
  }).join('');
}
function rowClass(row) {
  const translationError = placeholderError(row.source, row.translation);
  const proposalError = placeholderError(row.source, row.proposal);
  const terminologyWarning = terminologyError(row, row.translation) || terminologyError(row, row.proposal);
  const qualityIssues = row.qualityIssues || [];
  const qualityError = qualityIssues.some(function(issue) { return issue.severity === 'error'; });
  return (model.readOnly ? ' readonly-row' : '') +
    (row.notTranslatable ? ' translate-no' : '') +
    ((busyAi.has(row.ordinal) || busyTry.has(row.ordinal) || busyStatusRows.has(row.ordinal)) ? ' busy' : '') +
    ((row.translationDirty || row.proposal || row.appliedUndo) ? ' row-draft' : '') +
    (translationError || proposalError || qualityError ? ' row-error row-quality-error' : (terminologyWarning ? ' row-terminology' : (qualityIssues.length ? ' row-quality' : (row.missing ? ' row-missing' : (row.review ? ' row-review' : '')))));
}
function qualityInlineHtml(row) {
  return (row.qualityIssues || []).filter(function(issue) { return issue.code !== 'placeholder-mismatch' && issue.code !== 'terminology'; }).slice(0, 4).map(function(issue) { return '<div class="quality-item ' + esc(issue.severity) + '">' + esc(issue.message) + '</div>'; }).join('');
}
function updateQualityInline(row) {
  const notesCell = rowsElement.querySelector('tr[data-ordinal="' + row.ordinal + '"] td.notes');
  if (!notesCell) return;
  const html = qualityInlineHtml(row);
  let container = notesCell.querySelector('.quality-inline');
  if (!html) {
    if (container) container.remove();
    return;
  }
  if (!container) {
    container = document.createElement('div');
    container.className = 'quality-inline';
    notesCell.appendChild(container);
  }
  container.innerHTML = html;
}
function rowHtml(row) {
  const disabled = model.readOnly || row.notTranslatable;
  const busy = busyAi.has(row.ordinal);
  const trying = busyTry.has(row.ordinal);
  const statusBusy = busyStatusRows.has(row.ordinal);
  const translationErrorForRow = placeholderError(row.source, row.translation);
  const proposalErrorForRow = placeholderError(row.source, row.proposal);
  const translationTerminologyForRow = terminologyError(row, row.translation);
  const proposalTerminologyForRow = terminologyError(row, row.proposal);
  const origin = '<span data-role="proposal-origin" data-ordinal="' + row.ordinal + '" class="origin' + ((model.provenanceEnabled && row.proposalOrigin) ? '' : ' hidden') + '">' + esc(model.provenanceEnabled ? (row.proposalOrigin || '') : '') + '</span>';
  const translationOrigin = translationProvenanceHtml(row);
  const maxWidth = row.maxWidth == null ? '' : '<div data-role="maxwidth" data-ordinal="' + row.ordinal + '" class="maxwidth' + (row.maxWidthExceeded ? ' exceeded' : '') + '">' + row.translation.length + ' / ' + row.maxWidth + '</div>';
  const translationPlaceholderHtml = '<div data-role="translation-placeholder-error" data-ordinal="' + row.ordinal + '" class="placeholder-error' + (translationErrorForRow ? '' : ' hidden') + '">' + esc(translationErrorForRow) + '</div>';
  const proposalPlaceholderHtml = '<div data-role="proposal-placeholder-error" data-ordinal="' + row.ordinal + '" class="placeholder-error' + (proposalErrorForRow ? '' : ' hidden') + '">' + esc(proposalErrorForRow) + '</div>';
  const translationTerminologyHtml = '<div data-role="translation-terminology-error" data-ordinal="' + row.ordinal + '" class="terminology-warning' + (translationTerminologyForRow ? '' : ' hidden') + '">' + esc(translationTerminologyForRow) + '</div>';
  const proposalTerminologyHtml = '<div data-role="proposal-terminology-error" data-ordinal="' + row.ordinal + '" class="terminology-warning' + (proposalTerminologyForRow ? '' : ' hidden') + '">' + esc(proposalTerminologyForRow) + '</div>';
  const qualityInline = qualityInlineHtml(row);
  const statusDisabled = disabled || row.translationDirty || Boolean(row.proposal) || Boolean(row.appliedUndo) || statusBusy ? ' disabled' : '';
  const status = disabled
    ? '<div class="status-text">' + esc(row.notTranslatable ? 'translate=no' : row.status) + '</div>'
    : '<div class="status-stack"><select class="status-select" data-action="status" data-ordinal="' + row.ordinal + '"' + statusDisabled + '>' + statusOptions(row) + '</select></div>';
  const revertHidden = (row.translationDirty || row.appliedUndo) ? '' : ' hidden';
  const draftLabelText = row.translationDirty ? 'staged draft' : (row.appliedUndo ? 'applied · unsaved' : 'staged draft');
  const revertTitle = row.translationDirty ? 'Discard this Translation draft' : 'Undo this applied translation before the XLIFF is saved';
  const acceptDisabled = disabled || !row.proposal || proposalErrorForRow || row.translationDirty || trying || tryAllBusy;
  return '<tr class="' + rowClass(row) + '" data-ordinal="' + row.ordinal + '">' +
    '<td><div class="source-text">' + whitespaceStaticHtml(row.source) + '</div><div class="unit-id" title="' + esc(row.id) + '">' + esc(row.id) + '</div>' + (row.generatorNote ? '<div class="generator-note" title="Xliff Generator">' + esc(row.generatorNote) + '</div>' : '') + '</td>' +
    '<td>' + whitespaceEditorHtml('translation', row.ordinal, row.translation, disabled) + maxWidth + translationPlaceholderHtml + translationTerminologyHtml + translationOrigin +
      '<div class="field-actions">' +
      '<button data-action="acceptTranslation" data-ordinal="' + row.ordinal + '" class="' + ((row.canAcceptTranslation || row.translationDirty) ? '' : 'hidden') + '" title="' + esc(row.translationDirty ? 'Apply this Translation draft and set state to translated' : 'Accept the current saved translation and set state to translated') + '"' + (translationErrorForRow ? ' disabled' : '') + '>✓</button>' +
      '<button data-action="revertTranslation" data-ordinal="' + row.ordinal + '" class="' + revertHidden + '" title="' + esc(revertTitle) + '">↶</button>' +
      '<span data-role="draft-label" data-ordinal="' + row.ordinal + '" class="draft-label' + revertHidden + '">' + esc(draftLabelText) + '</span></div></td>' +
    '<td class="transfer-cell"><button class="transfer-button" data-action="accept" data-ordinal="' + row.ordinal + '" title="Move proposal into Translation draft; Apply Drafts writes it later"' + (acceptDisabled ? ' disabled' : '') + '>←</button><button class="transfer-button developer-transfer ' + (developerTranslationDiffers(row) ? '' : 'hidden') + '" data-action="useDeveloperTranslation" data-ordinal="' + row.ordinal + '" title="Use Developer Note translation as a draft" aria-label="Use Developer Note translation as a draft"' + (disabled ? ' disabled' : '') + '>↤</button></td>' +
    '<td>' + whitespaceEditorHtml('proposal', row.ordinal, row.proposal, disabled) + origin + proposalPlaceholderHtml + proposalTerminologyHtml + '</td>' +
    '<td>' + status + (row.maxWidthExceeded ? '<div class="warn">maxwidth exceeded</div>' : '') + '</td>' +
    '<td class="notes">' + noteHtml(row) + (qualityInline ? '<div class="quality-inline">' + qualityInline + '</div>' : '') + '</td>' +
    '<td><div class="actions">' +
      '<button class="wide" data-action="try" data-ordinal="' + row.ordinal + '" title="Stage this row: Developer comment / exact .lng / exact glossary → Translation draft; fuzzy / AI → Proposal draft. Staging metadata is persisted in the XLIFF, but target text/status are unchanged until Apply."' + (disabled || !row.missing || row.translationDirty || row.proposal || trying || statusBusy || tryAllBusy ? ' disabled' : '') + '>' + (trying ? '…' : '? Try') + '</button>' +
      '<button data-action="ai" data-ordinal="' + row.ordinal + '" title="Create an AI Proposal draft only; nothing is written to the XLIFF"' + (disabled || row.translationDirty || row.proposal || busy || trying || statusBusy || tryAllBusy ? ' disabled' : '') + '>' + (busy ? '…' : 'AI') + '</button>' +
      '<button data-action="search" data-ordinal="' + row.ordinal + '" title="Jump to the AL Label, Caption, ToolTip or other source definition">⌕</button>' +
      '<button data-action="addGlossary" data-ordinal="' + row.ordinal + '" title="Add a terminology rule based on this row"' + (model.readOnly ? ' disabled' : '') + '>T+</button>' +
      '<button data-action="openXliffSource" data-ordinal="' + row.ordinal + '" title="Open this trans-unit in the XLIFF source">&lt;/&gt;</button>' +
    '</div></td></tr>';
}
function updateSortLabels() {
  document.querySelectorAll('.sort').forEach(function(button) {
    const labels = {source:'Source',translation:'Translation',proposal:'Proposed translation',status:'Status',notes:'Notes'};
    button.textContent = labels[button.dataset.sort] + (sortField === button.dataset.sort ? (sortDirection > 0 ? ' ↑' : ' ↓') : '');
  });
}
function getPageState() {
  if (lastPageState) return lastPageState;
  const total = Number(model.stats && model.stats.total) || 0;
  return { filteredCount:total, totalCount:total, pageCount:Math.max(1, Math.ceil(total / pageSize)), start:0, end:0, pageRows:[] };
}
function pageKeyForRows(rows) { return (rows || []).map(function(row) { return row.ordinal; }).join(','); }
function indexRowByOrdinal(ordinal) { return rowStateByOrdinal.get(Number(ordinal)); }
function updateOrdinalMembership(row) {
  if (!row || !Number.isInteger(Number(row.ordinal))) return;
  const ordinal = Number(row.ordinal);
  if (row.translationDirty || row.hasTranslationDraft) dirtyOrdinals.add(ordinal); else dirtyOrdinals.delete(ordinal);
  if (row.proposal || row.hasProposal) proposalOrdinals.add(ordinal); else proposalOrdinals.delete(ordinal);
  if (row.appliedUndo) appliedUndoOrdinals.add(ordinal); else appliedUndoOrdinals.delete(ordinal);
}
function compactStateMarker(row) {
  if (!row || !Number.isInteger(Number(row.ordinal))) return undefined;
  const marker = { ordinal:Number(row.ordinal) };
  if (row.translationDirty || row.hasTranslationDraft) marker.hasTranslationDraft = true;
  if (row.proposal || row.hasProposal) marker.hasProposal = true;
  if (row.appliedUndo) marker.appliedUndo = true;
  return marker.hasTranslationDraft || marker.hasProposal || marker.appliedUndo ? marker : undefined;
}
function initializeRowStateIndex(entries) {
  rowStateByOrdinal.clear();
  dirtyOrdinals.clear();
  proposalOrdinals.clear();
  appliedUndoOrdinals.clear();
  viewOverrideOrdinals.clear();
  (entries || []).forEach(function(entry) {
    if (!entry || !Number.isInteger(Number(entry.ordinal))) return;
    const ordinal = Number(entry.ordinal);
    const marker = { ordinal:ordinal };
    if (entry.hasTranslationDraft) { marker.hasTranslationDraft = true; dirtyOrdinals.add(ordinal); }
    if (entry.hasProposal) { marker.hasProposal = true; proposalOrdinals.add(ordinal); }
    if (entry.appliedUndo) { marker.appliedUndo = true; appliedUndoOrdinals.add(ordinal); }
    rowStateByOrdinal.set(ordinal, marker);
  });
}
function mergePartialRowOverride(ordinal, patch) {
  const numeric = Number(ordinal);
  if (!Number.isInteger(numeric)) return undefined;
  const current = rowStateByOrdinal.get(numeric) || { ordinal:numeric };
  const next = Object.assign({}, current, patch || {}, { ordinal:numeric });
  rowStateByOrdinal.set(numeric, next);
  viewOverrideOrdinals.add(numeric);
  updateOrdinalMembership(next);
  return next;
}
function viewOverrideFromRow(row) {
  return {
    ordinal:row.ordinal,
    translation:row.translation,
    savedTranslation:row.savedTranslation,
    translationDirty:Boolean(row.translationDirty),
    hasTranslationDraft:Boolean(row.translationDirty),
    translationDraftOrigin:row.translationDraftOrigin || '',
    translationDraftProvenance:row.translationDraftProvenance,
    proposal:row.proposal || '',
    proposalOrigin:row.proposalOrigin || '',
    proposalProvenance:row.proposalProvenance,
    status:row.status || '',
    rawState:row.rawState || '',
    missing:Boolean(row.missing),
    review:Boolean(row.review),
    appliedUndo:Boolean(row.appliedUndo),
    canAcceptTranslation:Boolean(row.canAcceptTranslation),
    translationTerminologyError:Boolean(row.translationTerminologyError),
    proposalTerminologyError:Boolean(row.proposalTerminologyError)
  };
}
function viewOverrideSignature(value) {
  if (!value) return '';
  return JSON.stringify([
    value.translation,value.savedTranslation,Boolean(value.translationDirty),value.translationDraftOrigin || '',
    value.proposal || '',value.proposalOrigin || '',value.status || '',value.rawState || '',Boolean(value.missing),
    Boolean(value.review),Boolean(value.appliedUndo),Boolean(value.canAcceptTranslation),
    Boolean(value.translationTerminologyError),Boolean(value.proposalTerminologyError),
    value.translationDraftProvenance || null,value.proposalProvenance || null
  ]);
}
function prepareFullRowFromHost(fullRow) {
  if (!fullRow) return fullRow;
  if (typeof fullRow.savedTranslation !== 'string') fullRow.savedTranslation = String(fullRow.translation == null ? '' : fullRow.translation);
  if (fullRow.hasTranslationDraft) {
    fullRow.translation = typeof fullRow.translationDraft === 'string' ? fullRow.translationDraft : fullRow.translation;
    fullRow.translationDirty = true;
  } else {
    fullRow.translationDirty = false;
  }
  fullRow.translationEditRevision = Number(fullRow.translationEditRevision) || 0;
  Object.defineProperty(fullRow, '__hostViewState', { value:viewOverrideFromRow(fullRow), writable:true, configurable:true, enumerable:false });
  updateOrdinalMembership(fullRow);
  return fullRow;
}
function copyIndexStateToFullRow(fullRow) {
  prepareFullRowFromHost(fullRow);
  const ordinal = Number(fullRow && fullRow.ordinal);
  if (!viewOverrideOrdinals.has(ordinal)) return fullRow;
  const indexRow = indexRowByOrdinal(ordinal);
  if (!indexRow) return fullRow;
  const mutableKeys = [
    'translation','savedTranslation','translationDirty','translationEditRevision','translationDraftProvenance','translationDraftOrigin',
    'proposal','proposalOrigin','proposalProvenance','status','rawState','missing','review','appliedUndo','canAcceptTranslation',
    'translationTerminologyError','proposalTerminologyError'
  ];
  mutableKeys.forEach(function(key) {
    if (Object.prototype.hasOwnProperty.call(indexRow, key)) fullRow[key] = indexRow[key];
  });
  fullRow.hasTranslationDraft = Boolean(fullRow.translationDirty);
  updateOrdinalMembership(fullRow);
  return fullRow;
}
function syncIndexFromFullRow(row) {
  if (!row || !Number.isInteger(Number(row.ordinal))) return;
  const ordinal = Number(row.ordinal);
  row.hasTranslationDraft = Boolean(row.translationDirty);
  row.hasProposal = Boolean(row.proposal);
  reconcileSummaryStatsForRow(row);
  updateOrdinalMembership(row);
  const override = viewOverrideFromRow(row);
  const hostState = row.__hostViewState;
  if (hostState && viewOverrideSignature(override) === viewOverrideSignature(hostState)) {
    viewOverrideOrdinals.delete(ordinal);
    const marker = compactStateMarker(row);
    if (marker) rowStateByOrdinal.set(ordinal, marker); else rowStateByOrdinal.delete(ordinal);
    return;
  }
  rowStateByOrdinal.set(ordinal, override);
  viewOverrideOrdinals.add(ordinal);
}
function currentViewDefinition() {
  return {
    page:currentPage,
    pageSize:pageSize,
    sortField:sortField,
    sortDirection:sortDirection,
    navigationOrdinal:Number.isInteger(navigationOrdinal) ? navigationOrdinal : null,
    globalFilter:globalFilter.value || '',
    provenanceEnabled:model.provenanceEnabled !== false,
    filters:{
      source:filters.source.value || '',
      translation:filters.translation.value || '',
      proposal:filters.proposal.value || '',
      status:filters.status.value || '',
      notes:filters.notes.value || ''
    },
    quick:{
      translated:translatedOnly.checked,
      missing:missingOnly.checked,
      review:reviewOnly.checked,
      proposal:proposalOnly.checked,
      draft:draftOnly.checked,
      placeholderErrors:placeholderErrorsOnly.checked,
      terminologyErrors:terminologyErrorsOnly.checked,
      noState:noStateOnly.checked,
      quality:qualityOnly.checked
    }
  };
}
function collectViewOverrides() {
  const result = [];
  viewOverrideOrdinals.forEach(function(ordinal) {
    const row = rowStateByOrdinal.get(Number(ordinal));
    if (row) result.push(row);
  });
  return result;
}
function viewRequestKey(overrides) {
  const effectiveOverrides = overrides || collectViewOverrides();
  return JSON.stringify({ view:currentViewDefinition(), overrides:effectiveOverrides.map(function(row) {
    return [row.ordinal,row.translation,row.translationDirty,row.proposal,row.status,row.rawState,row.missing,row.review,row.appliedUndo];
  }) });
}
function requestViewPage(options) {
  const overrides = collectViewOverrides();
  const key = viewRequestKey(overrides);
  pendingPageRenderOptions = options || {};
  if (activePageRequestId && activePageRequestKey === key) return;
  const requestId = ++pageRequestSequence;
  activePageRequestId = requestId;
  activePageRequestKey = key;
  vscode.postMessage({
    type:'requestViewPage',
    requestId:requestId,
    loadId:activeLoadId,
    documentVersion:latestDocumentVersion,
    view:currentViewDefinition(),
    overrides:overrides
  });
}
function persistPageState() {
  vscode.setState({ pageSize:pageSize, currentPage:currentPage, scrollTop:lastKnownScrollTop, showInvisibles:showInvisibles, qualitySortColumn:qualitySortColumn, qualitySortDirection:qualitySortDirection });
}
function captureScrollPosition() {
  if (!suppressScrollTracking) lastKnownScrollTop = Math.max(0, Number(translationScroll.scrollTop) || 0);
  persistPageState();
  return lastKnownScrollTop;
}
function restoreScrollPosition(scrollTop) {
  const desired = Math.max(0, Number(scrollTop) || 0);
  const restoreGeneration = ++scrollRestoreGeneration;
  requestAnimationFrame(function() {
    if (restoreGeneration !== scrollRestoreGeneration) return;
    translationScroll.scrollTop = desired;
    requestAnimationFrame(function() {
      if (restoreGeneration !== scrollRestoreGeneration) return;
      lastKnownScrollTop = Math.max(0, Number(translationScroll.scrollTop) || 0);
      suppressScrollTracking = false;
      persistPageState();
    });
  });
}
translationScroll.addEventListener('scroll', function() {
  if (suppressScrollTracking) return;
  lastKnownScrollTop = Math.max(0, Number(translationScroll.scrollTop) || 0);
  persistPageState();
}, { passive:true });
function updatePager(pageState) {
  const state = pageState || getPageState();
  const filteredCount = Number(state.filteredCount) || 0;
  pageSizeSelect.value = String(pageSize);
  pageInfo.textContent = filteredCount ? (currentPage + ' / ' + state.pageCount) : '0 / 0';
  firstPageButton.disabled = currentPage <= 1 || !filteredCount;
  prevPageButton.disabled = currentPage <= 1 || !filteredCount;
  nextPageButton.disabled = currentPage >= state.pageCount || !filteredCount;
  lastPageButton.disabled = currentPage >= state.pageCount || !filteredCount;
  persistPageState();
}
function clearQuickFilters() {
  translatedOnly.checked = false;
  missingOnly.checked = false;
  reviewOnly.checked = false;
  proposalOnly.checked = false;
  draftOnly.checked = false;
  placeholderErrorsOnly.checked = false;
  terminologyErrorsOnly.checked = false;
  qualityOnly.checked = false;
  noStateOnly.checked = false;
}
function normalizeNavigationSeverity(severity) {
  const value = String(severity || '').toLowerCase();
  return value === 'error' || value === 'warning' || value === 'info' ? value : '';
}
function clearNavigationTarget() {
  navigationOrdinal = null;
  pendingNavigationOrdinal = null;
  navigationSeverity = '';
  pendingNavigationSeverity = '';
}
function revealOrdinalNow(ordinal, flash, severity) {
  const element = rowsElement.querySelector('tr[data-ordinal="' + ordinal + '"]');
  if (!element) return false;

  // Explicit navigation owns the viewport. Cancel every queued restore before
  // moving the scroll container and persist the resulting position immediately.
  scrollRestoreGeneration++;
  suppressScrollTracking = true;
  const rowRect = element.getBoundingClientRect();
  const viewportRect = translationScroll.getBoundingClientRect();
  const delta = rowRect.top - viewportRect.top - Math.max(0, (viewportRect.height - rowRect.height) / 2);
  translationScroll.scrollTop += delta;
  lastKnownScrollTop = Math.max(0, Number(translationScroll.scrollTop) || 0);
  pendingNavigationOrdinal = null;
  pendingNavigationSeverity = '';
  persistPageState();
  requestAnimationFrame(function() {
    lastKnownScrollTop = Math.max(0, Number(translationScroll.scrollTop) || 0);
    suppressScrollTracking = false;
    persistPageState();
  });
  if (flash !== false) {
    const navigationHighlightMs = 5200;
    const navigationSeverityClass = normalizeNavigationSeverity(severity);
    element.classList.remove('saved-flash-warning', 'saved-flash-error', 'saved-flash-info');
    if (navigationSeverityClass) element.classList.add('saved-flash-' + navigationSeverityClass);
    element.classList.add('saved-flash');
    if (element._xliffHighlightTimer) clearTimeout(element._xliffHighlightTimer);
    element._xliffHighlightTimer = setTimeout(function(){
      element.classList.remove('saved-flash', 'saved-flash-warning', 'saved-flash-error', 'saved-flash-info');
      element._xliffHighlightTimer = null;
    }, navigationHighlightMs);
  }
  return true;
}
function jumpToOrdinal(ordinal, severity) {
  if (!Number.isInteger(ordinal)) return false;
  const normalizedSeverity = normalizeNavigationSeverity(severity);
  pendingNavigationOrdinal = ordinal;
  navigationOrdinal = ordinal;
  pendingNavigationSeverity = normalizedSeverity;
  navigationSeverity = normalizedSeverity;

  if (revealOrdinalNow(ordinal, true, normalizedSeverity)) return true;

  // The extension host owns filtering and sorting. It resolves the ordinal's
  // position in the filtered/sorted result and returns the containing page.
  render({ loading:false, stage:'Opening translation unit', preserveScroll:false, jumpOrdinal:ordinal, jumpSeverity:normalizedSeverity });
  return true;
}
function setQualityExpanded(expanded) {
  const isExpanded = Boolean(expanded);
  qualityPanel.classList.toggle('collapsed', !isExpanded);
  qualityToggle.textContent = isExpanded ? '⌃' : '⌄';
  qualityToggle.title = isExpanded ? 'Collapse quality results' : 'Expand quality results';
  qualityToggle.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
}
function setQualityVisible(visible) {
  const isVisible = Boolean(visible);
  qualityPanel.classList.toggle('hidden', !isVisible);
  qualityCheckButton.setAttribute('aria-pressed', isVisible ? 'true' : 'false');
  if (isVisible) setQualityExpanded(true);
}
function showQualityPendingPanel(received, total) {
  const safeReceived = Math.max(0, Number(received) || 0);
  const safeTotal = Math.max(0, Number(total) || 0);
  const suffix = safeTotal > 0 ? (' · receiving ' + Math.min(safeReceived, safeTotal).toLocaleString() + ' / ' + safeTotal.toLocaleString()) : '';
  qualitySummary.textContent = 'Quality Check running…' + suffix;
  qualityList.innerHTML = '<div class="quality-row"><div class="quality-severity info">…</div><div class="quality-code">running</div><div class="quality-message">Quality results are being calculated in the background. The editor remains usable.</div><div></div></div>';
  qualityPageInfo.textContent = '…';
  qualityFirstPageButton.disabled = true;
  qualityPrevPageButton.disabled = true;
  qualityNextPageButton.disabled = true;
  qualityLastPageButton.disabled = true;
  setQualityVisible(true);
}
function showCurrentQualityReport() {
  if (!qualityReportAvailable || !currentQualityReport) return false;
  paintQualityReport(currentQualityReport, currentQualityIncludesDrafts);
  setQualityVisible(true);
  return true;
}

function selectedQualitySeverities() {
  const selected = [];
  if (qualityFilterInfo.checked) selected.push('info');
  if (qualityFilterWarning.checked) selected.push('warning');
  if (qualityFilterError.checked) selected.push('error');
  return selected;
}
function projectQualityGlobeSvg(withSlash) {
  const slash = withSlash ? '<path class="quality-ignore-slash" d="M2.65 13.35 13.35 2.65"></path>' : '';
  return '<svg class="quality-action-icon" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="5.25"></circle><path d="M2.75 8h10.5M8 2.75c1.45 1.45 2.2 3.2 2.2 5.25S9.45 11.8 8 13.25M8 2.75C6.55 4.2 5.8 5.95 5.8 8s.75 3.8 2.2 5.25"></path>' + slash + '</svg>';
}
function projectQualityIgnoreIcon() { return projectQualityGlobeSvg(true); }
function projectQualityRestoreIcon() { return projectQualityGlobeSvg(false); }
function requestQualityPage() {
  if (!currentQualityReport) return;
  activeQualityRequestId = ++qualityRequestSequence;
  currentQualityPage = null;
  vscode.postMessage({ type:'requestQualityPage', requestId:activeQualityRequestId,
    revision:currentQualityReport.revision, loadId:activeLoadId, documentVersion:currentQualityReport.documentVersion,
    view:qualityView, severities:selectedQualitySeverities(), page:qualityPage, pageSize:qualityPageSize,
    sortColumn:qualitySortColumn, sortDirection:qualitySortDirection });
}
function paintQualityReport(report, includesDrafts) {
  requestQualityPage();
}
function paintQualityPage(page) {
  const queryKey = JSON.stringify([qualityView, page.page, qualityPageSize, selectedQualitySeverities(), qualitySortColumn, qualitySortDirection]);
  const previousScrollTop = queryKey === paintedQualityQueryKey ? qualityList.scrollTop : 0;
  paintedQualityQueryKey = queryKey;
  qualityList.setAttribute('aria-busy', 'false');
  const report = currentQualityReport;
  const includesDrafts = currentQualityIncludesDrafts;
  const summary = report.summary || {total:0,errors:0,warnings:0,infos:0};
  const ignoredSummary = report.ignoredSummary || {total:0,errors:0,warnings:0,infos:0};
  const projectIgnoredCount = Number(report.projectIgnoredCount) || 0;
  const showingIgnored = page.view === 'ignored';
  const severityFilterActive = selectedQualitySeverities().length > 0;
  const filteredCount = page.filteredCount;
  const pageCount = page.pageCount;
  qualityPage = page.page;
  const pageStart = page.start;
  const pageEnd = page.end;
  const pageItems = page.items || [];
  const visibleRange = filteredCount ? ' · showing ' + (pageStart + 1) + '–' + pageEnd + ' of ' + filteredCount : '';
  qualitySummary.textContent = summary.total + ' issue' + (summary.total === 1 ? '' : 's') + ' · ' + summary.errors + ' error · ' + summary.warnings + ' warning · ' + summary.infos + ' info · ' + ignoredSummary.total + ' ignored' + (projectIgnoredCount ? ' · ' + projectIgnoredCount + ' project' : '') + visibleRange + (includesDrafts ? ' · staged drafts included' : '');
  qualityIgnoredButton.textContent = (showingIgnored ? 'Problems (' + summary.total + ')' : 'Ignored (' + ignoredSummary.total + ')');
  qualityIgnoredButton.title = showingIgnored ? 'Show active Quality Check problems' : 'Show ignored Quality Check findings, including project-wide ignores';
  qualityPageSizeSelect.value = String(qualityPageSize);
  qualityPageInfo.textContent = filteredCount ? (qualityPage + ' / ' + pageCount) : '0 / 0';
  qualityFirstPageButton.disabled = qualityPage <= 1 || !filteredCount;
  qualityPrevPageButton.disabled = qualityPage <= 1 || !filteredCount;
  qualityNextPageButton.disabled = qualityPage >= pageCount || !filteredCount;
  qualityLastPageButton.disabled = qualityPage >= pageCount || !filteredCount;
  qualityList.innerHTML = pageItems.length ? pageItems.map(function(item) {
    const issue = item.issue;
    const issueIndex = item.sourceIndex;
    const marker = issue.severity === 'error' ? 'E' : (issue.severity === 'info' ? 'I' : 'W');
    const source = issue.source ? '<div class="quality-source">' + esc(issue.source) + '</div>' : '';
    const go = Number.isInteger(issue.ordinal) ? '<button data-quality-action="go" data-quality-ordinal="' + issue.ordinal + '" data-quality-severity="' + esc(issue.severity || '') + '" title="Show this translation unit">Go</button>' : '';
    let qualityAction = '';
    const issueRef = ' data-quality-index="' + issueIndex + '" data-quality-code="' + esc(issue.code) + '"' + (Number.isInteger(issue.ordinal) ? ' data-quality-ordinal="' + issue.ordinal + '"' : '');
    if (!includesDrafts) {
      if (showingIgnored && issue.ignoredBy === 'unit') qualityAction = '<span class="quality-ignore-actions"><button data-quality-action="restore"' + issueRef + ' title="Restore this per-translation Quality Check exception">Restore</button></span>';
      else if (showingIgnored && issue.ignoredBy === 'glossary') qualityAction = '<span class="quality-code" title="This warning is suppressed by a matching glossary rule">Glossary</span>';
      else if (showingIgnored && issue.ignoredBy === 'project') qualityAction = '<span class="quality-ignore-actions"><button class="quality-global-ignore" data-quality-action="projectRestore"' + issueRef + ' title="Restore this globally ignored Quality Check rule">' + projectQualityRestoreIcon() + '</button></span>';
      else if (!showingIgnored) {
        const localIgnore = Number.isInteger(issue.ordinal) && issue.severity !== 'error' ? '<button class="quality-local-ignore" data-quality-action="ignore"' + issueRef + ' title="Ignore this warning/info only for the current translation unit">⊘</button>' : '';
        const projectIgnore = '<button class="quality-global-ignore" data-quality-action="projectIgnore"' + issueRef + ' title="Ignore this Quality Check rule for the whole AL project">' + projectQualityIgnoreIcon() + '</button>';
        qualityAction = '<span class="quality-ignore-actions">' + localIgnore + projectIgnore + '</span>';
      }
    }
    const ignoredBy = showingIgnored && issue.ignoredBy ? '<div class="quality-source">ignored by ' + esc(issue.ignoredBy) + '</div>' : '';
    return '<div class="quality-row"><div class="quality-severity ' + esc(issue.severity) + '">' + marker + '</div><div><div class="quality-code">' + esc(issue.code) + '</div>' + source + ignoredBy + '</div><div class="quality-message">' + esc(issue.message) + '</div><div class="actions quality-actions">' + go + qualityAction + '</div></div>';
  }).join('') : '<div class="quality-row"><div class="quality-severity info">✓</div><div class="quality-code">' + (severityFilterActive && page.totalCount ? 'filtered' : 'clean') + '</div><div class="quality-message">' + (severityFilterActive && page.totalCount ? 'No quality issues match the selected severity filters.' : (showingIgnored ? 'No ignored quality findings.' : 'No quality issues found.')) + '</div><div></div></div>';
  qualityList.scrollTop = previousScrollTop;
  persistPageState();
}
function syncRowQualityFromReport(report) {
  if (!model.stats) model.stats = {};
  model.stats.qualityIssues = report && report.summary ? Number(report.summary.total) || 0 : 0;
  // Inline findings arrive with the next materialized translation page.
  pageRowCache.forEach(function(row){ row.qualityIssues = []; row.ignoredQualityIssues = []; updateQualityInline(row); });
  pageRowCacheKey = '';
}
function renderQualityReport(report, includesDrafts, showPanel) {
  currentQualityReport = report;
  currentQualityPage = null;
  activeQualityRequestId = 0;
  if (!model.stats) model.stats = {};
  model.stats.quality = report.summary;
  model.stats.qualityIssues = report.summary ? report.summary.total : 0;
  currentQualityIncludesDrafts = Boolean(includesDrafts);
  qualityReportAvailable = true;
  syncRowQualityFromReport(report);
  if (showPanel !== false) {
    paintQualityReport(report, currentQualityIncludesDrafts);
    setQualityVisible(true);
  }
}
function removeResolvedAcceptQualityIssues(ordinal) {
  // Host maintenance publishes a revised summary/page after acceptance.
  if (currentQualityReport && !qualityPanel.classList.contains('hidden')) requestQualityPage();
}

function refreshFilteredMembershipAfterAccept(row) {
  syncIndexFromFullRow(row);
  // Membership may have changed (missing/review/translated/proposal filters), so
  // let the extension host recompute the current result set and page.
  render({ loading:false, preserveScroll:true });
}


function notifyInitialPageRenderedForDeferredQuality() {
  if (!model.qualityPending || !activeLoadId || deferredQualityNotifiedLoadId === activeLoadId) return;
  const loadId = activeLoadId;
  const documentVersion = latestDocumentVersion;
  deferredQualityNotifiedLoadId = loadId;
  // Wait through two animation frames so the first page has a real paint
  // opportunity before the extension host starts deferred Quality Check work.
  requestAnimationFrame(function() {
    requestAnimationFrame(function() {
      if (activeLoadId !== loadId || !model.qualityPending) return;
      vscode.postMessage({ type:'initialPageRendered', loadId:loadId, documentVersion:documentVersion });
    });
  });
}

function render(options) {
  if (isRowTextEditingActive()) {
    pendingRenderOptions = options || {};
    return;
  }
  pendingRenderOptions = null;
  const renderStartedAt = performance.now();
  const generation = ++renderGeneration;
  const stage = options && options.stage ? options.stage : 'Loading page';
  const loadingAllowed = !options || options.loading !== false;
  const preserveScroll = !options || options.preserveScroll !== false;
  const jumpOrdinal = options && Number.isInteger(options.jumpOrdinal) ? options.jumpOrdinal : null;
  const jumpSeverity = normalizeNavigationSeverity(options && options.jumpSeverity);
  const desiredScrollTop = preserveScroll
    ? (hasRenderedRows ? Math.max(0, Number(translationScroll.scrollTop) || 0) : lastKnownScrollTop)
    : 0;
  lastKnownScrollTop = desiredScrollTop;
  suppressScrollTracking = true;

  const totalRows = Number(model.stats && model.stats.total) || 0;
  const showOverlay = loadingAllowed && totalRows >= RENDER_OVERLAY_UNIT_THRESHOLD;
  if (showOverlay) {
    renderOverlayGeneration = generation;
    setLoading(stage, 0, 0, true, 'entries');
  }

  pendingViewRenderContext = {
    generation:generation,
    renderStartedAt:renderStartedAt,
    stage:stage,
    showOverlay:showOverlay,
    desiredScrollTop:desiredScrollTop,
    jumpOrdinal:jumpOrdinal,
    jumpSeverity:jumpSeverity
  };
  requestViewPage(options);
}

function renderViewPage(message) {
  const context = pendingViewRenderContext;
  if (!context || context.generation !== renderGeneration) return;
  const generation = context.generation;
  currentPage = Math.max(1, Number(message.page) || 1);
  if ([50,100,200].includes(Number(message.pageSize))) pageSize = Number(message.pageSize);
  const rows = Array.isArray(message.rows) ? message.rows : [];
  pageRowCache.clear();
  rows.forEach(function(row) {
    copyIndexStateToFullRow(row);
    pageRowCache.set(Number(row.ordinal), row);
    setRowSummarySnapshot(row, rowSummaryContribution(row));
  });
  pageRowCacheKey = pageKeyForRows(rows);
  const state = {
    filteredCount:Number(message.filteredCount) || 0,
    totalCount:Number(message.totalCount) || Number(model.stats && model.stats.total) || 0,
    pageCount:Math.max(1, Number(message.pageCount) || 1),
    start:Math.max(0, Number(message.start) || 0),
    end:Math.max(0, Number(message.end) || 0),
    pageRows:rows
  };
  lastPageState = state;
  updatePager(state);
  updateSortLabels();
  updateSummary(state);

  function finishRender() {
    if (generation !== renderGeneration) return;
    hasRenderedRows = true;
    updateSummary(state);
    if (renderOverlayGeneration && renderOverlayGeneration <= generation && !applyDraftsOverlayVisible) {
      hideLoading();
      renderOverlayGeneration = 0;
    }
    notifyInitialPageRenderedForDeferredQuality();
    postWebviewPerformance('xlfEditor.webview.render', context.renderStartedAt, {
      totalRows:state.totalCount,
      filteredRows:state.filteredCount,
      pageRows:state.pageRows.length,
      page:currentPage,
      overlay:context.showOverlay,
      stage:context.stage,
      hostFiltered:true
    }, 'finish render');
    const requestedJump = Number.isInteger(context.jumpOrdinal) ? context.jumpOrdinal : pendingNavigationOrdinal;
    const requestedSeverity = Number.isInteger(context.jumpOrdinal) ? context.jumpSeverity : pendingNavigationSeverity;
    if (Number.isInteger(requestedJump) && revealOrdinalNow(requestedJump, true, requestedSeverity)) return;
    restoreScrollPosition(context.desiredScrollTop);
  }

  if (!state.pageRows.length) {
    rowsElement.innerHTML = '';
    finishRender();
    return;
  }
  if (!context.showOverlay) {
    rowsElement.innerHTML = state.pageRows.map(rowHtml).join('');
    finishRender();
    return;
  }

  setLoading('Rendering page ' + currentPage + ' / ' + state.pageCount, 0, state.pageRows.length, true, 'entries');
  rowsElement.innerHTML = '';
  let index = 0;
  function appendChunk() {
    if (generation !== renderGeneration) return;
    const end = Math.min(index + RENDER_CHUNK_SIZE, state.pageRows.length);
    rowsElement.insertAdjacentHTML('beforeend', state.pageRows.slice(index, end).map(rowHtml).join(''));
    index = end;
    setLoading('Rendering page ' + currentPage + ' / ' + state.pageCount, index, state.pageRows.length, true, 'entries');
    if (index < state.pageRows.length) {
      requestAnimationFrame(appendChunk);
      return;
    }
    finishRender();
  }
  requestAnimationFrame(appendChunk);
}

function updateSummary(pageState) {
  flushSummaryStats();
  const state = pageState || lastPageState || getPageState();
  const filteredCount = Number(state.filteredCount) || 0;
  const totalCount = Number(state.totalCount) || Number(model.stats && model.stats.total) || 0;
  const stats = model.stats || {};
   const drafts = draftCount();
   const staged = stagedCount();
   const proposals = proposalOrdinals.size;
  const placeholderErrorCount = Number(stats.placeholderErrors) || 0;
  const terminologyErrorCount = Number(stats.terminologyErrors) || 0;
  const qualityCount = Number(stats.qualityIssues) || 0;
  const languageLabel = model.targetLanguage ? ((model.sourceLanguage || '?') + ' → ' + model.targetLanguage) : (model.sourceLanguage || 'XLIFF');
  const rangeLabel = filteredCount ? ((state.start + 1) + '–' + state.end + ' of ' + filteredCount + ' filtered') : '0 filtered';
  const qualityLabel = model.qualityPending ? 'quality pending…' : ('quality ' + qualityCount);
  metaElement.textContent = languageLabel + ' · ' + rangeLabel + ' · ' + totalCount + ' total · page ' + (filteredCount ? currentPage + ' / ' + state.pageCount : '0 / 0') + ' · missing ' + (stats.missing || 0) + ' · review ' + (stats.review || 0) + ' · proposals ' + proposals + ' · translation drafts ' + drafts + ' · staged ' + staged + ' · errors ' + placeholderErrorCount + ' · terminology ' + terminologyErrorCount + ' · ' + qualityLabel + (model.readOnly ? ' · read-only' : '') + (model.dirty ? ' · unsaved' : '');
  saveFileButton.disabled = model.readOnly || !model.dirty;
  syncButton.disabled = model.readOnly || model.dirty || syncBusy || tryAllBusy || staged > 0 || model.syncStatus !== 'out-of-sync';
  syncButton.title = model.dirty || staged > 0 ? 'Save changes before synchronizing' : (model.syncStatus === 'out-of-sync' ? 'Synchronize with the generator XLIFF' : 'Refresh to check for differences from the generator XLIFF');
  tryGetButton.textContent = tryAllBusy ? 'Trying…' : ('? Try Translation' + ((stats.missing || 0) ? ' (' + stats.missing + ')' : ''));
  tryGetButton.disabled = model.readOnly || syncBusy || tryAllBusy || staged > 0 || !(stats.missing || 0);
  saveDraftsButton.textContent = (applyDraftsBusy ? '… Applying Drafts' : '✓ Apply Drafts') + (drafts ? ' (' + drafts + ')' : '');
  saveDraftsButton.disabled = model.readOnly || drafts === 0 || applyDraftsBusy;
  const noStateCount = Number(stats.noState) || 0;
  acceptAllNoStateButton.textContent = '✓ No State' + (noStateCount ? ' (' + noStateCount + ')' : '');
  acceptAllNoStateButton.disabled = model.readOnly || syncBusy || tryAllBusy || staged > 0 || noStateCount === 0;
  discardDraftsButton.disabled = staged === 0;
  const acceptable = state.pageRows.some(function(row) { return row.proposal && !row.notTranslatable && !row.translationDirty && !placeholderError(row.source, row.proposal); });
  acceptVisibleButton.disabled = model.readOnly || tryAllBusy || !acceptable;
}
function updateVisibleRowControls() {
  const state = lastPageState || getPageState();
  state.pageRows.forEach(function(row) { updateRowControls(row); });
  updateSummary(state);
}
function showError(message) {
  errorMessageElement.textContent = message || '';
  errorElement.style.display = message ? 'flex' : 'none';
}
errorCloseButton.addEventListener('click', function() { showError(''); });
function showWarning(messages) { const text = (messages || []).join(String.fromCharCode(10)); warningElement.textContent = text; warningElement.style.display = text ? 'block' : 'none'; }
function rowByOrdinal(ordinal) { const numeric = Number(ordinal); const fullRow = pageRowCache.get(numeric); return fullRow ? markSummaryRowTouched(fullRow) : indexRowByOrdinal(numeric); }
function updateInlineValidation(row, kind, value) {
  const error = placeholderError(row.source, value);
  const errorElementForRow = rowsElement.querySelector('[data-role="' + kind + '-placeholder-error"][data-ordinal="' + row.ordinal + '"]');
  if (errorElementForRow) {
    errorElementForRow.textContent = error;
    errorElementForRow.classList.toggle('hidden', !error);
  }
  if (kind === 'translation') row.translationPlaceholderError = Boolean(error);
  else if (kind === 'proposal') row.proposalPlaceholderError = Boolean(error);
  const terminologyElement = rowsElement.querySelector('[data-role="' + kind + '-terminology-error"][data-ordinal="' + row.ordinal + '"]');
  const terminology = terminologyError(row, value);
  if (kind === 'translation') row.translationTerminologyError = Boolean(terminology);
  else if (kind === 'proposal') row.proposalTerminologyError = Boolean(terminology);
  if (terminologyElement) {
    terminologyElement.textContent = terminology;
    terminologyElement.classList.toggle('hidden', !terminology);
  }
  if (kind === 'translation') {
    const maxWidthElement = rowsElement.querySelector('[data-role="maxwidth"][data-ordinal="' + row.ordinal + '"]');
    if (maxWidthElement && row.maxWidth != null) {
      maxWidthElement.textContent = value.length + ' / ' + row.maxWidth;
      maxWidthElement.classList.toggle('exceeded', value.length > row.maxWidth);
    }
  }
}
function updateRowControls(row) {
  const dirty = Boolean(row.translationDirty);
  const appliedUndo = Boolean(row.appliedUndo);
  const developerButton = rowsElement.querySelector('button[data-action="useDeveloperTranslation"][data-ordinal="' + row.ordinal + '"]');
  if (developerButton) { developerButton.classList.toggle('hidden', !developerTranslationDiffers(row)); developerButton.disabled = model.readOnly || row.notTranslatable || busyApplyRows.has(row.ordinal) || syncBusy || tryAllBusy; }
  const revertButton = rowsElement.querySelector('button[data-action="revertTranslation"][data-ordinal="' + row.ordinal + '"]');
  if (revertButton) {
    revertButton.classList.toggle('hidden', !dirty && !appliedUndo);
    revertButton.title = dirty ? 'Discard this Translation draft' : 'Undo this applied translation before the XLIFF is saved';
  }
  const draftLabel = rowsElement.querySelector('[data-role="draft-label"][data-ordinal="' + row.ordinal + '"]');
  if (draftLabel) {
    draftLabel.classList.toggle('hidden', !dirty && !appliedUndo);
    draftLabel.textContent = dirty ? 'staged draft' : (appliedUndo ? 'applied · unsaved' : 'staged draft');
  }
  const statusSelect = rowsElement.querySelector('select[data-action="status"][data-ordinal="' + row.ordinal + '"]');
  if (statusSelect) statusSelect.disabled = dirty || appliedUndo || Boolean(row.proposal) || model.readOnly || row.notTranslatable || busyStatusRows.has(row.ordinal);
  const acceptButton = rowsElement.querySelector('button[data-action="accept"][data-ordinal="' + row.ordinal + '"]');
  if (acceptButton) acceptButton.disabled = model.readOnly || row.notTranslatable || dirty || !row.proposal || Boolean(placeholderError(row.source, row.proposal));
  const tryButton = rowsElement.querySelector('button[data-action="try"][data-ordinal="' + row.ordinal + '"]');
  if (tryButton) tryButton.disabled = model.readOnly || row.notTranslatable || dirty || Boolean(row.proposal) || !row.missing || tryAllBusy || busyStatusRows.has(row.ordinal);
  const aiButton = rowsElement.querySelector('button[data-action="ai"][data-ordinal="' + row.ordinal + '"]');
  if (aiButton) {
    const aiBusy = busyAi.has(row.ordinal);
    aiButton.disabled = model.readOnly || row.notTranslatable || dirty || Boolean(row.proposal) || tryAllBusy || aiBusy || busyStatusRows.has(row.ordinal);
    aiButton.textContent = aiBusy ? '…' : 'AI';
  }
  const acceptTranslationButton = rowsElement.querySelector('button[data-action="acceptTranslation"][data-ordinal="' + row.ordinal + '"]');
  if (acceptTranslationButton) {
    const canAcceptRow = Boolean(row.canAcceptTranslation || dirty);
    const applying = busyApplyRows.has(row.ordinal);
    acceptTranslationButton.classList.toggle('hidden', !canAcceptRow && !applying);
    acceptTranslationButton.disabled = applying || !canAcceptRow || Boolean(placeholderError(row.source, row.translation)) || model.readOnly || row.notTranslatable;
    acceptTranslationButton.textContent = applying ? '…' : '✓';
    acceptTranslationButton.title = applying ? 'Applying this Translation draft…' : (dirty ? 'Apply this Translation draft and set state to translated' : 'Accept the current saved translation and set state to translated');
  }
  const provenanceBlock = rowsElement.querySelector('[data-role="translation-provenance-block"][data-ordinal="' + row.ordinal + '"]');
  if (provenanceBlock) provenanceBlock.innerHTML = translationProvenanceInnerHtml(row);
  const proposalOrigin = rowsElement.querySelector('[data-role="proposal-origin"][data-ordinal="' + row.ordinal + '"]');
  if (proposalOrigin) {
    proposalOrigin.textContent = model.provenanceEnabled ? (row.proposalOrigin || '') : '';
    proposalOrigin.classList.toggle('hidden', !model.provenanceEnabled || !row.proposalOrigin);
  }
  const tr = rowsElement.querySelector('tr[data-ordinal="' + row.ordinal + '"]');
  if (tr) tr.className = rowClass(row);
  syncIndexFromFullRow(row);
  updateSummary();
}
function developerTranslationDiffers(row) {
  return typeof row.developerTranslation === 'string' && row.developerTranslation.length > 0 && String(row.translation || '').normalize('NFC') !== row.developerTranslation.normalize('NFC');
}
function useDeveloperTranslation(row) {
  if (!developerTranslationDiffers(row) || model.readOnly || row.notTranslatable || busyApplyRows.has(row.ordinal) || syncBusy || tryAllBusy) return;
  markSummaryRowTouched(row);
  row.translation = row.developerTranslation;
  row.translationDirty = true;
  row.translationEditRevision = ++stageRevisionCounter;
  row.translationDraftProvenance = draftProvenance('comment', row.translationProvenance);
  row.translationDraftOrigin = model.provenanceEnabled ? 'Developer Note' : '';
  const editor = rowsElement.querySelector('textarea[data-action="translation"][data-ordinal="' + row.ordinal + '"]');
  if (editor) { editor.value = row.translation; updateWhitespaceOverlay(editor); }
  row.maxWidthExceeded = row.maxWidth != null && row.translation.length > row.maxWidth;
  updateInlineValidation(row, 'translation', row.translation);
  persistStageNow(row, 'draft');
  updateRowControls(row);
}
function revertRowDraft(row) {
  cancelStagePersistence(row.ordinal);
  const hadDraft = Boolean(row.translationDirty);
  row.translation = row.savedTranslation;
  row.translationDirty = false;
  row.translationDraftProvenance = undefined;
  row.translationDraftOrigin = '';
  row.maxWidthExceeded = row.maxWidth != null && row.translation.length > row.maxWidth;
  const editor = rowsElement.querySelector('textarea[data-action="translation"][data-ordinal="' + row.ordinal + '"]');
  if (editor) { editor.value = row.translation; updateWhitespaceOverlay(editor); }
  updateInlineValidation(row, 'translation', row.translation);
  updateRowControls(row);
  if (hadDraft) vscode.postMessage({ type:'clearStaged', ordinals:[row.ordinal] });
}
function ensureNoDrafts(actionName) {
  flushSummaryStats();
  if (Number(model.stats && model.stats.appliedUndo) > 0) {
    showError('Save or undo applied translations before ' + actionName + '.');
    return false;
  }
  if (!stagedCount()) return true;
  showError('Resolve staged items before ' + actionName + ': move proposals to drafts and apply them, or discard the staged items.');
  return false;
}

rowsElement.addEventListener('input', function(event) {
  const ordinal = Number(event.target.dataset.ordinal);
  if (!Number.isInteger(ordinal)) return;
  const row = rowByOrdinal(ordinal); if (!row) return;
  if (event.target.matches && event.target.matches('.whitespace-editor textarea')) updateWhitespaceOverlay(event.target);
  if (event.target.dataset.action === 'translation') {
    const wasDirty = Boolean(row.translationDirty);
    const previousProvenance = row.translationDraftProvenance || row.translationProvenance;
    row.translation = event.target.value;
    row.translationEditRevision = ++stageRevisionCounter;
    row.translationDirty = row.translation !== row.savedTranslation;
    if (row.translationDirty) {
      if (!wasDirty || !row.translationDraftProvenance || row.translationDraftProvenance.origin !== 'manual') {
        const basedOnLabel = row.translationDraftOrigin || row.translationProvenanceLabel || '';
        row.translationDraftProvenance = draftProvenance('manual', previousProvenance);
        row.translationDraftOrigin = model.provenanceEnabled ? (basedOnLabel ? ('Manual · based on ' + basedOnLabel) : 'Manual') : '';
      }
    } else {
      row.translationDraftProvenance = undefined;
      row.translationDraftOrigin = '';
    }
    row.maxWidthExceeded = row.maxWidth != null && row.translation.length > row.maxWidth;
    updateInlineValidation(row, 'translation', row.translation);
    queueStagePersistence(row, 'draft');
    updateRowControls(row);
  } else if (event.target.dataset.action === 'proposal') {
    const previousProvenance = row.proposalProvenance;
    const previousOrigin = row.proposalOrigin || '';
    row.proposal = event.target.value;
    row.proposalOrigin = row.proposal ? (previousOrigin && !previousOrigin.startsWith('Manual') ? ('Manual · based on ' + previousOrigin) : (previousOrigin || 'Manual')) : '';
    row.proposalProvenance = row.proposal ? draftProvenance('manual', previousProvenance) : undefined;
    updateInlineValidation(row, 'proposal', row.proposal);
    queueStagePersistence(row, 'proposal');
    updateRowControls(row);
  }
});

rowsElement.addEventListener('focusin', function(event) {
  if (!isRowTextEditor(event.target)) return;
  const ordinal = Number(event.target.dataset.ordinal);
  if (Number.isInteger(ordinal)) {
    const key = String(ordinal);
    const timer = stagePersistTimers.get(key);
    if (timer) clearTimeout(timer);
    stagePersistTimers.delete(key);
  }
});
rowsElement.addEventListener('focusout', function(event) {
  if (!isRowTextEditor(event.target)) return;
  settleTextEditing();
});
rowsElement.addEventListener('scroll', function(event) {
  if (event.target && event.target.matches && event.target.matches('.whitespace-editor textarea')) updateWhitespaceOverlay(event.target);
}, true);

rowsElement.addEventListener('change', function(event) {
  const ordinal = Number(event.target.dataset.ordinal);
  if (!Number.isInteger(ordinal)) return;
  const row = rowByOrdinal(ordinal);
  if (row && event.target.dataset.action === 'translation') { queueStagePersistence(row, 'draft'); return; }
  if (row && event.target.dataset.action === 'proposal') { queueStagePersistence(row, 'proposal'); return; }
  if (event.target.dataset.action === 'status') {
    captureScrollPosition();
    const row = rowByOrdinal(ordinal);
    if (row && row.translationDirty) {
      showError('Save or discard the translation draft before changing status.');
      event.target.value = row.rawState || '__none__';
      return;
    }
    busyStatusRows.add(ordinal);
    updateRowControls(row);
    vscode.postMessage({ type:'updateStatus', ordinal:ordinal, id:row ? row.id : '', source:row ? row.source : '', state:event.target.value });
  }
});

rowsElement.addEventListener('keydown', function(event) {
  const ordinal = Number(event.target.dataset.ordinal);
  if (!Number.isInteger(ordinal)) return;
  const row = rowByOrdinal(ordinal); if (!row) return;
  if (event.target.dataset.action === 'translation') {
    if (event.key === 'Escape' && row.translationDirty) {
      event.preventDefault();
      revertRowDraft(row);
    }
  } else if (event.target.dataset.action === 'proposal') {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && row.proposal && !row.translationDirty && !placeholderError(row.source, row.proposal)) {
      event.preventDefault();
      captureScrollPosition();
      cancelStagePersistence(ordinal);
      vscode.postMessage({ type:'acceptProposal', ordinal:ordinal, translation:row.proposal, provenance:row.proposalProvenance, origin:row.proposalOrigin });
    }
  }
});

rowsElement.addEventListener('click', function(event) {
  const button = event.target.closest('button[data-action]'); if (!button) return;
  const ordinal = Number(button.dataset.ordinal); const row = rowByOrdinal(ordinal); if (!row) return;
  captureScrollPosition();
  const action = button.dataset.action;
  if (action === 'try') vscode.postMessage({ type:'tryUnit', ordinal:ordinal, id:row.id || '', source:row.source || '' });
  else if (action === 'addGlossary') vscode.postMessage({ type:'addGlossaryTerm', ordinal:ordinal, translation:row.translation || row.proposal || '' });
  if (action === 'search') vscode.postMessage({ type:'goToSourceDefinition', ordinal:ordinal });
  if (action === 'openXliffSource') vscode.postMessage({ type:'openXliffUnitSource', ordinal:ordinal });
  if (action === 'ai') vscode.postMessage({ type:'aiTranslate', ordinal:ordinal });
  if (action === 'useDeveloperTranslation') useDeveloperTranslation(row);
  if (action === 'accept') {
    cancelStagePersistence(ordinal);
    vscode.postMessage({ type:'acceptProposal', ordinal:ordinal, translation:row.proposal, provenance:row.proposalProvenance, origin:row.proposalOrigin });
  }
  if (action === 'acceptTranslation') {
    if (busyApplyRows.has(ordinal)) return;
    cancelStagePersistence(ordinal);
    busyApplyRows.add(ordinal);
    updateRowControls(row);
    vscode.postMessage({
    type:'acceptTranslation',
    ordinal:ordinal,
    source:row.source,
    translation:row.translation,
    state:row.rawState,
    targetLanguage:model.targetLanguage,
    notTranslatable:row.notTranslatable,
    readOnly:model.readOnly,
    wasMissing:row.missing,
    wasReview:row.review,
    translationDirty:row.translationDirty,
    provenance:row.translationDraftProvenance,
    origin:row.translationDraftOrigin,
    revision:Number(row.translationEditRevision) || 0
    });
  }
  if (action === 'revertTranslation') {
    if (row.translationDirty) { revertRowDraft(row); return; }
    if (row.appliedUndo && !busyApplyRows.has(ordinal)) {
      busyApplyRows.add(ordinal);
      updateRowControls(row);
      vscode.postMessage({ type:'revertAppliedTranslation', ordinal:ordinal });
    }
  }
});

document.querySelectorAll('.sort').forEach(function(button) {
  button.addEventListener('click', function() {
    clearNavigationTarget();
    const field = button.dataset.sort;
    if (sortField === field) sortDirection *= -1; else { sortField = field; sortDirection = 1; }
    currentPage = 1;
    render({ loading:true, stage:'Sorting entries', preserveScroll:false });
  });
});
let filterRenderTimer = null;
function applyFilterRender() {
  if (filterRenderTimer) {
    clearTimeout(filterRenderTimer);
    filterRenderTimer = null;
  }
  clearNavigationTarget();
  currentPage = 1;
  render({ loading:true, stage:'Filtering entries', preserveScroll:false });
}
[globalFilter, translatedOnly, missingOnly, reviewOnly, proposalOnly, draftOnly, placeholderErrorsOnly, terminologyErrorsOnly, qualityOnly, noStateOnly].concat(Object.values(filters)).forEach(function(control) {
  control.addEventListener(control.type === 'checkbox' ? 'change' : 'input', function() {
    if (control.type === 'checkbox') {
      applyFilterRender();
      return;
    }
    if (filterRenderTimer) clearTimeout(filterRenderTimer);
    filterRenderTimer = setTimeout(applyFilterRender, FILTER_RENDER_DEBOUNCE_MS);
  });
});
document.getElementById('clearFilters').addEventListener('click', function() {
  clearNavigationTarget();
  globalFilter.value = ''; clearQuickFilters();
  Object.values(filters).forEach(function(control) { control.value = ''; });
  currentPage = 1;
  render({ loading:true, stage:'Resetting filters', preserveScroll:false });
});
pageSizeSelect.addEventListener('change', function() {
  clearNavigationTarget();
  const requested = Number(pageSizeSelect.value);
  pageSize = [50,100,200].includes(requested) ? requested : 100;
  currentPage = 1;
  render({ loading:true, stage:'Loading page', preserveScroll:false });
});
firstPageButton.addEventListener('click', function() {
  clearNavigationTarget();
  if (currentPage === 1) return;
  currentPage = 1;
  render({ loading:true, stage:'Loading first page', preserveScroll:false });
});
prevPageButton.addEventListener('click', function() {
  clearNavigationTarget();
  if (currentPage <= 1) return;
  currentPage--;
  render({ loading:true, stage:'Loading previous page', preserveScroll:false });
});
nextPageButton.addEventListener('click', function() {
  clearNavigationTarget();
  const state = getPageState();
  if (currentPage >= state.pageCount) return;
  currentPage++;
  render({ loading:true, stage:'Loading next page', preserveScroll:false });
});
lastPageButton.addEventListener('click', function() {
  clearNavigationTarget();
  const state = getPageState();
  if (currentPage >= state.pageCount) return;
  currentPage = state.pageCount;
  render({ loading:true, stage:'Loading last page', preserveScroll:false });
});
function runQualityCheck() {
  const items = stagedRows().map(function(row) {
    const isDraft = Boolean(row.translationDirty || row.hasTranslationDraft);
    const item = { ordinal:row.ordinal, kind:isDraft ? 'draft' : 'proposal' };
    const text = isDraft ? row.translation : row.proposal;
    if (typeof text === 'string') item.translation = text;
    return item;
  });
  vscode.postMessage({ type:'validateQuality', items:items });
}
showInvisiblesButton.addEventListener('click', function() {
  showInvisibles = !showInvisibles;
  applyShowInvisiblesState();
  persistPageState();
});
qualityCheckButton.addEventListener('click', function() {
  if (!qualityPanel.classList.contains('hidden')) {
    setQualityVisible(false);
    return;
  }
  if (showCurrentQualityReport()) return;
  if (model.qualityPending) {
    showQualityPendingPanel(0, 0);
    return;
  }
  showQualityPendingPanel(0, 0);
  runQualityCheck();
});
qualityRefresh.addEventListener('click', function() { runQualityCheck(); });
qualityToggle.addEventListener('click', function() { setQualityExpanded(qualityPanel.classList.contains('collapsed')); });
document.getElementById('qualityProblems').addEventListener('click', function() { vscode.postMessage({ type:'openProblems' }); });
qualityIgnoredButton.addEventListener('click', function() {
  qualityView = qualityView === 'ignored' ? 'active' : 'ignored';
  qualityPage = 1;
  if (currentQualityReport) paintQualityReport(currentQualityReport, currentQualityIncludesDrafts);
});
qualitySeverityFilters.forEach(function(control) {
  control.addEventListener('change', function() {
    qualityPage = 1;
    if (currentQualityReport) paintQualityReport(currentQualityReport, currentQualityIncludesDrafts);
  });
});
[qualitySortSelect, qualitySortDirectionSelect].forEach(function(control) {
  control.addEventListener('change', function() {
    qualitySortColumn = qualitySortSelect.value;
    qualitySortDirection = qualitySortDirectionSelect.value;
    qualityPage = 1;
    persistPageState();
    if (currentQualityReport) requestQualityPage();
  });
});
qualityPageSizeSelect.addEventListener('change', function() {
  const requested = Number(qualityPageSizeSelect.value);
  qualityPageSize = [50,100,200].includes(requested) ? requested : 100;
  qualityPage = 1;
  if (currentQualityReport) paintQualityReport(currentQualityReport, currentQualityIncludesDrafts);
  else persistPageState();
});
qualityFirstPageButton.addEventListener('click', function() {
  if (qualityPage <= 1) return;
  qualityPage = 1;
  if (currentQualityReport) paintQualityReport(currentQualityReport, currentQualityIncludesDrafts);
});
qualityPrevPageButton.addEventListener('click', function() {
  if (qualityPage <= 1) return;
  qualityPage--;
  if (currentQualityReport) paintQualityReport(currentQualityReport, currentQualityIncludesDrafts);
});
qualityNextPageButton.addEventListener('click', function() {
  qualityPage++;
  if (currentQualityReport) paintQualityReport(currentQualityReport, currentQualityIncludesDrafts);
});
qualityLastPageButton.addEventListener('click', function() {
  if (!currentQualityReport) return;
  qualityPage = Number.MAX_SAFE_INTEGER;
  requestQualityPage();
});
qualityList.addEventListener('click', function(event) {
  const button = event.target.closest('[data-quality-action]');
  if (!button) return;
  const action = button.dataset.qualityAction || 'go';
  const ordinal = Number(button.dataset.qualityOrdinal);
  if (action === 'go') { if (Number.isInteger(ordinal)) jumpToOrdinal(ordinal, button.dataset.qualitySeverity || ''); return; }
  if (!currentQualityReport || !currentQualityPage || currentQualityPage.view !== qualityView) return;
  const issueIndex = Number(button.dataset.qualityIndex);
  const item = (currentQualityPage.items || []).find(function(item){ return item.sourceIndex === issueIndex; });
  const issue = item && item.issue;
  if (!issue) return;
  if (action === 'projectIgnore' || action === 'projectRestore') {
    vscode.postMessage({ type:'setProjectQualityIgnored', ignored:action==='projectIgnore', targetLanguage:model.targetLanguage, qualityRevision:currentQualityReport.revision, documentVersion:currentQualityReport.documentVersion, issue:issue });
    return;
  }
  if (!Number.isInteger(ordinal)) return;
  vscode.postMessage({ type:'setQualityIgnored', ordinal:ordinal, ignored:action==='ignore', qualityRevision:currentQualityReport.revision, documentVersion:currentQualityReport.documentVersion, issue:issue });
});

saveFileButton.addEventListener('click', function() {
  if (saveFileButton.disabled) return;
  // The explicit Save owns staging persistence for this action. Cancelling the
  // debounced row writers avoids a race where blur -> stage persistence and Save
  // both edit the same backing document and trigger duplicate row reloads.
  cancelAllStagePersistence();
  const items = stagedRows().map(function(row) {
    const isDraft = Boolean(row.translationDirty || row.hasTranslationDraft);
    const item = {
      ordinal:row.ordinal,
      kind:isDraft ? 'draft' : 'proposal',
      provenance:isDraft ? row.translationDraftProvenance : row.proposalProvenance,
      origin:isDraft ? row.translationDraftOrigin : row.proposalOrigin
    };
    const text = isDraft ? row.translation : row.proposal;
    if (typeof text === 'string') item.translation = text;
    return item;
  });
  vscode.postMessage({ type:'saveDocument', items:items });
});
syncButton.addEventListener('click', function() {
  if (syncButton.disabled) return;
  if (!ensureNoDrafts('synchronizing')) return;
  vscode.postMessage({ type:'synchronizeFile' });
});
tryGetButton.addEventListener('click', function() {
  if (!ensureNoDrafts('trying translations')) return;
  vscode.postMessage({ type:'tryFile' });
});
saveDraftsButton.addEventListener('click', function() {
  cancelAllStagePersistence();
  const items = dirtyRows().map(function(row) {
    const item = {
      ordinal:row.ordinal,
      provenance:row.translationDraftProvenance,
      origin:row.translationDraftOrigin
    };
    if (typeof row.source === 'string') item.source = row.source;
    if (typeof row.translation === 'string') item.translation = row.translation;
    return item;
  });
  if (!items.length) return;
  applyDraftsBusy = true;
  applyDraftsOverlayVisible = items.length >= APPLY_DRAFTS_OVERLAY_THRESHOLD;
  updateSummary();
  if (applyDraftsOverlayVisible) {
    setLoading('Applying drafts', 0, items.length, true, 'drafts');
    requestAnimationFrame(function() {
      vscode.postMessage({ type:'saveManyDrafts', items:items });
    });
  } else {
    vscode.postMessage({ type:'saveManyDrafts', items:items });
  }
});
acceptAllNoStateButton.addEventListener('click', function() {
  if (!ensureNoDrafts('accepting all no-state translations')) return;
  vscode.postMessage({
    type:'acceptAllNoState',
    targetLanguage:model.targetLanguage,
    readOnly:model.readOnly
  });
});
discardDraftsButton.addEventListener('click', function() {
  cancelAllStagePersistence();
  const stagedOrdinals = stagedRows().map(function(row) { return Number(row.ordinal); }).filter(Number.isInteger);
  stagedOrdinals.forEach(function(ordinal) {
    const row = pageRowCache.get(ordinal);
    if (row) {
      markSummaryRowTouched(row);
      if (row.translationDirty) {
        row.translation = row.savedTranslation;
        row.translationDirty = false;
        row.maxWidthExceeded = row.maxWidth != null && row.translation.length > row.maxWidth;
      }
      row.proposal = '';
      row.proposalOrigin = '';
      row.proposalProvenance = undefined;
      row.translationDraftProvenance = undefined;
      row.translationDraftOrigin = '';
      syncIndexFromFullRow(row);
    }
    rowStateByOrdinal.delete(ordinal);
    viewOverrideOrdinals.delete(ordinal);
  });
  dirtyOrdinals.clear();
  proposalOrdinals.clear();
  if (model.stats) {
    model.stats.translationDrafts = 0;
    model.stats.proposals = 0;
    model.stats.staged = 0;
  }
  flushSummaryStats();
  if (stagedOrdinals.length) vscode.postMessage({ type:'clearStaged', ordinals:stagedOrdinals });
  render({ loading:stagedOrdinals.length >= APPLY_DRAFTS_OVERLAY_THRESHOLD });
});
document.getElementById('dashboard').addEventListener('click', function() { vscode.postMessage({ type:'openDashboard' }); });
document.getElementById('glossary').addEventListener('click', function() { vscode.postMessage({ type:'openGlossary' }); });
document.getElementById('refresh').addEventListener('click', function() { vscode.postMessage({ type:'refresh' }); });
document.getElementById('openText').addEventListener('click', function() {
  if (!ensureNoDrafts('opening the raw XML editor')) return;
  vscode.postMessage({ type:'openText' });
});
acceptVisibleButton.addEventListener('click', function() {
  const items = ((lastPageState && lastPageState.pageRows) || []).filter(function(row) {
    return row.proposal && !row.notTranslatable && !row.translationDirty && !placeholderError(row.source, row.proposal);
  }).map(function(row) {
    cancelStagePersistence(row.ordinal);
    return { ordinal:row.ordinal, translation:row.proposal, provenance:row.proposalProvenance, origin:row.proposalOrigin };
  });
  if (items.length) vscode.postMessage({ type:'acceptMany', items:items });
});
window.addEventListener('blur', function() {
  settleTextEditing();
});

window.addEventListener('message', function(event) {
  const message = event.data;
  if (message.type === 'saveState') {
    const saveVersion = Number(message.documentVersion) || 0;
    if (saveVersion) latestDocumentVersion = Math.max(latestDocumentVersion, saveVersion);
    model.dirty = Boolean(message.dirty);
    if (!model.dirty) {
      appliedUndoOrdinals.forEach(function(ordinal) {
        const state = rowStateByOrdinal.get(Number(ordinal));
        if (state) {
          delete state.appliedUndo;
          if (!state.hasTranslationDraft && !state.hasProposal && !viewOverrideOrdinals.has(Number(ordinal))) rowStateByOrdinal.delete(Number(ordinal));
        }
      });
      appliedUndoOrdinals.clear();
      pageRowCache.forEach(function(row) { row.appliedUndo = false; });
      updateVisibleRowControls();
    }
    updateSummary();
  } else if (message.type === 'loadStart') {
    const incomingLoadId = Number(message.loadId) || 0;
    if (activeLoadId && incomingLoadId && incomingLoadId < activeLoadId) return;
    activeLoadId = incomingLoadId;
    setLoading(message.stage || 'Loading XLIFF', message.current || 0, message.total || 0, true);
  } else if (message.type === 'loadProgress') {
    if (activeLoadId && Number(message.loadId) !== activeLoadId) return;
    setLoading(message.stage || 'Loading XLIFF', message.current || 0, message.total || 0, true);
  } else if (message.type === 'loadCancelled') {
    const cancelledLoadId = Number(message.loadId) || 0;
    if (!cancelledLoadId || cancelledLoadId === activeLoadId) hideLoading();
    const cancelledVersion = Number(message.documentVersion) || 0;
    if (cancelledVersion) latestDocumentVersion = Math.max(latestDocumentVersion, cancelledVersion);
  } else if (message.type === 'dashboardFilter') {
    clearNavigationTarget();
    globalFilter.value = '';
    Object.values(filters).forEach(function(control) { control.value = ''; });
    clearQuickFilters();
    const dashboardFilter = String(message.filter || 'all').toLowerCase();
    if (dashboardFilter === 'missing') missingOnly.checked = true;
    else if (dashboardFilter === 'review') reviewOnly.checked = true;
    else if (dashboardFilter === 'errors') placeholderErrorsOnly.checked = true;
    else if (dashboardFilter === 'translated') translatedOnly.checked = true;
    else if (dashboardFilter === 'quality') qualityOnly.checked = true;
    currentPage = 1;
    render({ loading:true, stage:'Applying dashboard filter', preserveScroll:false });
  } else if (message.type === 'document') {
    const documentPayloadStartedAt = performance.now();
    const incomingLoadId = Number(message.loadId) || 0;
    const incomingDocumentVersion = Number(message.documentVersion) || 0;
    if (activeLoadId && incomingLoadId && incomingLoadId < activeLoadId) return;
    // An async postDocument() may have started from an older XLIFF version before
    // a row-level Apply committed its draft. Never let that stale payload restore
    // the already-cleared draft/checkmark in the webview.
    if (incomingDocumentVersion && latestDocumentVersion && incomingDocumentVersion < latestDocumentVersion) {
      if (!incomingLoadId || incomingLoadId === activeLoadId) hideLoading();
      return;
    }
    if (incomingLoadId) activeLoadId = incomingLoadId;
    if (incomingDocumentVersion) latestDocumentVersion = Math.max(latestDocumentVersion, incomingDocumentVersion);
    const previousOverrides = new Map();
    viewOverrideOrdinals.forEach(function(ordinal) {
      const state = rowStateByOrdinal.get(Number(ordinal));
      if (state) previousOverrides.set(Number(ordinal), state);
    });
    initializeRowStateIndex(message.rowStateIndex || []);
    previousOverrides.forEach(function(state, ordinal) {
      // Preserve unsent/local webview edits across an asynchronous document refresh.
      // The extension host owns canonical staged state, but this keeps the latest
      // textarea value when a refresh raced a blur/debounce notification.
      rowStateByOrdinal.set(ordinal, state);
      viewOverrideOrdinals.add(ordinal);
      updateOrdinalMembership(state);
    });
    delete message.rowStateIndex;
    model = message;
    if (model.qualityPending) {
      qualityReportAvailable = false;
      currentQualityReport = null;
      currentQualityIncludesDrafts = false;
      deferredQualityNotifiedLoadId = 0;
      setQualityVisible(false);
    }
    summaryTouchedRows.clear();
    pageRowCache.clear();
    pageRowCacheKey = '';
    activePageRequestId = 0;
    activePageRequestKey = '';
    rowsElement.innerHTML = '';
    showError('');
    showWarning(message.warnings || []);
    render({ loading:true, stage:'Loading page', preserveScroll:!Number.isInteger(pendingNavigationOrdinal), jumpOrdinal:pendingNavigationOrdinal });
    postWebviewPerformance('xlfEditor.webview.documentPayload', documentPayloadStartedAt, { compactStates:rowStateByOrdinal.size, overrides:viewOverrideOrdinals.size, fullRows:0, loadId:incomingLoadId }, 'process document payload');
  } else if (message.type === 'viewPage') {
    const requestId = Number(message.requestId) || 0;
    if (!requestId || requestId !== activePageRequestId) return;
    if (message.stale || Number(message.loadId) !== activeLoadId) {
      activePageRequestId = 0;
      activePageRequestKey = '';
      pendingPageRenderOptions = null;
      pendingViewRenderContext = null;
      return;
    }
    activePageRequestId = 0;
    activePageRequestKey = '';
    pendingPageRenderOptions = null;
    renderViewPage(message);
  } else if (message.type === 'saveReconcile') {
    const items = Array.isArray(message.items) ? message.items : [];
    let membershipChanged = false;
    items.forEach(function(item) {
      const row = rowByOrdinal(Number(item.ordinal));
      if (!row || row.id !== item.id || row.source !== item.source) return;
      const wasMissing = Boolean(row.missing);
      const wasReview = Boolean(row.review);
      row.savedTranslation = typeof item.translation === 'string' ? item.translation : row.savedTranslation;
      if (!row.translationDirty) row.translation = row.savedTranslation;
      row.rawState = item.state || '';
      row.status = item.status || item.state || '';
      row.missing = Boolean(item.missing);
      row.review = Boolean(item.review);
      if (item.staged && item.staged.kind === 'draft') {
        row.translation = item.staged.text || row.translation;
        row.translationDirty = true;
        row.translationDraftProvenance = item.staged.provenance;
        row.translationDraftOrigin = item.staged.origin || '';
      } else if (item.staged && item.staged.kind === 'proposal') {
        row.proposal = item.staged.text || '';
        row.proposalProvenance = item.staged.provenance;
        row.proposalOrigin = item.staged.origin || '';
      }
      if (wasMissing !== row.missing || wasReview !== row.review) membershipChanged = true;
      updateInlineValidation(row, 'translation', row.translation);
      updateRowControls(row);
    });
    if (membershipChanged && (missingOnly.checked || reviewOnly.checked || translatedOnly.checked)) render({ loading:false });
    else updateSummary();
  } else if (message.type === 'stageTranslationDrafts') {
    (message.items || []).forEach(function(item) {
      const ordinal = Number(item.ordinal);
      const row = pageRowCache.get(ordinal);
      if (row) {
        row.translation = typeof item.translation === 'string' ? item.translation : row.translation;
        row.translationDirty = true;
        row.translationDraftProvenance = item.provenance;
        row.translationDraftOrigin = item.origin || '';
        row.proposal = '';
        row.proposalOrigin = '';
        row.proposalProvenance = undefined;
        row.maxWidthExceeded = row.maxWidth != null && row.translation.length > row.maxWidth;
        syncIndexFromFullRow(row);
      } else {
        mergePartialRowOverride(ordinal, {
          translation:typeof item.translation === 'string' ? item.translation : undefined,
          translationDirty:true,
          hasTranslationDraft:true,
          translationDraft:typeof item.translation === 'string' ? item.translation : undefined,
          translationDraftProvenance:item.provenance,
          translationDraftOrigin:item.origin || '',
          proposal:'',
          hasProposal:false,
          proposalOrigin:'',
          proposalProvenance:undefined
        });
      }
    });
    render({ loading:(message.items || []).length >= APPLY_DRAFTS_OVERLAY_THRESHOLD });
  } else if (message.type === 'proposalAcceptedAsDraft') {
    const ordinal = Number(message.ordinal);
    const row = pageRowCache.get(ordinal);
    if (row) {
      row.translation = typeof message.translation === 'string' ? message.translation : row.translation;
      row.translationDirty = row.translation !== row.savedTranslation;
      row.translationDraftProvenance = message.provenance;
      row.translationDraftOrigin = message.origin || '';
      row.proposal = '';
      row.proposalOrigin = '';
      row.proposalProvenance = undefined;
      row.maxWidthExceeded = row.maxWidth != null && row.translation.length > row.maxWidth;
      syncIndexFromFullRow(row);
    } else {
      mergePartialRowOverride(ordinal, {
        translation:typeof message.translation === 'string' ? message.translation : undefined,
        translationDirty:true,
        hasTranslationDraft:true,
        translationDraft:typeof message.translation === 'string' ? message.translation : undefined,
        translationDraftProvenance:message.provenance,
        translationDraftOrigin:message.origin || '',
        proposal:'',hasProposal:false,proposalOrigin:'',proposalProvenance:undefined
      });
    }
    render({ loading:false });
  } else if (message.type === 'proposalsAcceptedAsDrafts') {
    (message.items || []).forEach(function(item) {
      const ordinal = Number(item.ordinal);
      const row = pageRowCache.get(ordinal);
      if (row) {
        row.translation = typeof item.translation === 'string' ? item.translation : row.translation;
        row.translationDirty = row.translation !== row.savedTranslation;
        row.translationDraftProvenance = item.provenance;
        row.translationDraftOrigin = item.origin || '';
        row.proposal = '';
        row.proposalOrigin = '';
        row.proposalProvenance = undefined;
        row.maxWidthExceeded = row.maxWidth != null && row.translation.length > row.maxWidth;
        syncIndexFromFullRow(row);
      } else {
        mergePartialRowOverride(ordinal, {
          translation:typeof item.translation === 'string' ? item.translation : undefined,
          translationDirty:true,hasTranslationDraft:true,
          translationDraft:typeof item.translation === 'string' ? item.translation : undefined,
          translationDraftProvenance:item.provenance,translationDraftOrigin:item.origin || '',
          proposal:'',hasProposal:false,proposalOrigin:'',proposalProvenance:undefined
        });
      }
    });
    render({ loading:(message.items || []).length >= APPLY_DRAFTS_OVERLAY_THRESHOLD });
  } else if (message.type === 'jumpToOrdinal') {
    jumpToOrdinal(Number(message.ordinal), message.severity || '');
  } else if (message.type === 'triggerQualityCheck') {
    qualityCheckButton.click();
  } else if (message.type === 'qualityInvalidated') {
    const hadQualityPage = Boolean(currentQualityPage);
    qualityReportAvailable = false;
    currentQualityReport = null;
    currentQualityPage = null;
    activeQualityRequestId = 0;
    qualityList.setAttribute('aria-busy', 'true');
    if (!hadQualityPage && !qualityPanel.classList.contains('hidden')) showQualityPendingPanel(0, 0);
  } else if (message.type === 'qualityPage') {
    if (!currentQualityReport || Number(message.requestId) !== activeQualityRequestId || Number(message.revision) !== currentQualityReport.revision || Number(message.loadId) !== activeLoadId || Number(message.documentVersion) !== currentQualityReport.documentVersion) return;
    currentQualityPage = message;
    paintQualityPage(message);
  } else if (message.type === 'qualityReport') {
    if (Number(message.loadId) !== activeLoadId || Number(message.documentVersion) < latestDocumentVersion) return;
    const wasVisible = !qualityPanel.classList.contains('hidden');
    model.qualityPending = false;
    renderQualityReport({ ...message.report, documentVersion:Number(message.documentVersion) }, Boolean(message.includesDrafts), message.preserveVisibility ? wasVisible : true);
    render({ loading:false, stage:'Applying quality results', preserveScroll:true });
  } else if (message.type === 'qualityPending') {
    model.qualityPending = Boolean(message.pending);
    updateSummary();
  } else if (message.type === 'warnings') {
    showWarning(message.warnings || []);
  } else if (message.type === 'applyDraftsProgress') {
    applyDraftsBusy = true;
    applyDraftsOverlayVisible = Number(message.total) >= APPLY_DRAFTS_OVERLAY_THRESHOLD;
    if (applyDraftsOverlayVisible) {
      setLoading(message.stage || 'Applying drafts', message.current || 0, message.total || 0, true, 'drafts');
    }
    updateSummary();
  } else if (message.type === 'applyDraftsProgressDone') {
    applyDraftsBusy = false;
    if (applyDraftsOverlayVisible) hideLoading();
    applyDraftsOverlayVisible = false;
    updateSummary();
  } else if (message.type === 'error') {
    if (busyApplyRows.size) {
      busyApplyRows.clear();
      updateVisibleRowControls();
    }
    if (applyDraftsBusy) {
      applyDraftsBusy = false;
      if (applyDraftsOverlayVisible) hideLoading();
      applyDraftsOverlayVisible = false;
      updateSummary();
    }
    showError(message.message || 'XLIFF editor error.');
  } else if (message.type === 'proposalUpdated') {
    const ordinal = Number(message.ordinal);
    const row = rowByOrdinal(ordinal);
    if (row) {
      row.proposal = typeof message.proposal === 'string' ? message.proposal : '';
      row.proposalOrigin = typeof message.origin === 'string' ? message.origin : '';
      row.proposalProvenance = message.provenance;
      const proposalEditor = rowsElement.querySelector('textarea[data-action="proposal"][data-ordinal="' + ordinal + '"]');
      if (proposalEditor) { proposalEditor.value = row.proposal; updateWhitespaceOverlay(proposalEditor); }
      const originElement = rowsElement.querySelector('[data-role="proposal-origin"][data-ordinal="' + ordinal + '"]');
      if (originElement) {
        originElement.textContent = model.provenanceEnabled ? row.proposalOrigin : '';
        originElement.classList.toggle('hidden', !model.provenanceEnabled || !row.proposalOrigin);
      }
      updateInlineValidation(row, 'proposal', row.proposal);
      updateRowControls(row);
    }
  } else if (message.type === 'statusUpdated') {
    const ordinal = Number(message.ordinal);
    busyStatusRows.delete(ordinal);
    const statusVersion = Number(message.documentVersion) || 0;
    if (statusVersion) latestDocumentVersion = Math.max(latestDocumentVersion, statusVersion);
    const row = rowByOrdinal(ordinal);
    if (row) {
      const wasMissing = Boolean(row.missing);
      const wasReview = Boolean(row.review);
      row.rawState = message.state || '';
      row.status = message.state || 'no state';
      row.missing = Boolean(message.missing);
      row.review = Boolean(message.review);
      row.canAcceptTranslation = Boolean(message.canAcceptTranslation);
      if (message.provenance) {
        row.translationProvenance = message.provenance;
        row.translationProvenanceLabel = message.provenanceLabel || '';
        row.provenanceHistory = (row.provenanceHistory || []).concat([message.provenance]);
        row.provenanceHistoryLabels = (row.provenanceHistoryLabels || []).concat([message.provenanceHistoryLabel || message.provenanceLabel || '']);
      }
      const statusSelect = rowsElement.querySelector('select[data-action="status"][data-ordinal="' + ordinal + '"]');
      if (statusSelect) statusSelect.value = row.rawState || '__none__';
      updateRowControls(row);
      refreshFilteredMembershipAfterAccept(row);
    }
  } else if (message.type === 'statusUpdateRejected') {
    const ordinal = Number(message.ordinal);
    busyStatusRows.delete(ordinal);
    const row = rowByOrdinal(ordinal);
    const statusSelect = rowsElement.querySelector('select[data-action="status"][data-ordinal="' + ordinal + '"]');
    if (row && statusSelect) statusSelect.value = row.rawState || '__none__';
    if (row) updateRowControls(row);
  } else if (message.type === 'translationApplyBusy') {
    const ordinal = Number(message.ordinal);
    if (message.busy) busyApplyRows.add(ordinal); else busyApplyRows.delete(ordinal);
    const row = rowByOrdinal(ordinal);
    if (row) updateRowControls(row);
  } else if (message.type === 'translationAccepted') {
    const acceptedVersion = Number(message.documentVersion) || 0;
    if (acceptedVersion) latestDocumentVersion = Math.max(latestDocumentVersion, acceptedVersion);
    const ordinal = Number(message.ordinal);
    busyApplyRows.delete(ordinal);
    const row = rowByOrdinal(ordinal);
    if (row) {
      row.translation = typeof message.translation === 'string' ? message.translation : row.translation;
      row.savedTranslation = row.translation;
      row.translationDirty = false;
      row.rawState = message.state || 'translated';
      row.status = message.state || 'translated';
      row.missing = false;
      row.review = false;
      row.canAcceptTranslation = false;
      row.appliedUndo = Boolean(message.canUndoApply);
      row.proposal = '';
      row.proposalOrigin = '';
      row.proposalProvenance = undefined;
      row.translationDraftProvenance = undefined;
      row.translationDraftOrigin = '';
      if (message.provenance) {
        row.translationProvenance = message.provenance;
        row.translationProvenanceLabel = message.provenanceLabel || '';
        row.provenanceHistory = (row.provenanceHistory || []).concat([message.provenance]);
        row.provenanceHistoryLabels = (row.provenanceHistoryLabels || []).concat([message.provenanceHistoryLabel || message.provenanceLabel || '']);
      }
      row.qualityIssues = (row.qualityIssues || []).filter(function(issue) {
        return issue.code !== 'target-without-state' && issue.code !== 'unknown-state';
      });
      updateQualityInline(row);
      removeResolvedAcceptQualityIssues(ordinal);
      const statusSelect = rowsElement.querySelector('select[data-action="status"][data-ordinal="' + ordinal + '"]');
      if (statusSelect) statusSelect.value = 'translated';
      updateInlineValidation(row, 'translation', row.translation);
      updateRowControls(row);
      if (navigationOrdinal === ordinal) navigationOrdinal = null;
      updateSummary();
      // If the accepted row no longer belongs to the active filter set (for
      // example Review after no-state -> translated), remove it from the current
      // page immediately and update pagination from the in-memory model only.
      refreshFilteredMembershipAfterAccept(row);
    }
  } else if (message.type === 'translationApplyReverted') {
    const ordinal = Number(message.ordinal);
    busyApplyRows.delete(ordinal);
    const row = rowByOrdinal(ordinal);
    if (row) {
      const wasMissing = Boolean(row.missing);
      const wasReview = Boolean(row.review);
      row.savedTranslation = typeof message.savedTranslation === 'string' ? message.savedTranslation : row.savedTranslation;
      row.translation = typeof message.translation === 'string' ? message.translation : row.savedTranslation;
      row.translationDirty = row.translation !== row.savedTranslation;
      row.translationDraftProvenance = message.draftProvenance;
      row.translationDraftOrigin = message.draftOrigin || '';
      row.appliedUndo = false;
      row.rawState = message.state || '';
      row.status = message.status || message.state || (row.savedTranslation ? 'no-state' : 'missing');
      row.missing = Boolean(message.missing);
      row.review = Boolean(message.review);
      row.canAcceptTranslation = Boolean(message.canAcceptTranslation);
      const editor = rowsElement.querySelector('textarea[data-action="translation"][data-ordinal="' + ordinal + '"]');
      if (editor) { editor.value = row.translation; updateWhitespaceOverlay(editor); }
      const statusSelect = rowsElement.querySelector('select[data-action="status"][data-ordinal="' + ordinal + '"]');
      if (statusSelect) statusSelect.value = row.rawState || '__none__';
      updateInlineValidation(row, 'translation', row.translation);
      updateRowControls(row);
      updateSummary();
    }
  } else if (message.type === 'aiBusy') {
    const ordinal = Number(message.ordinal);
    if (message.busy) busyAi.add(ordinal); else busyAi.delete(ordinal);
    const row = rowByOrdinal(ordinal);
    if (row) updateRowControls(row);
  } else if (message.type === 'tryBusy') {
    if (message.all) tryAllBusy = Boolean(message.busy);
    else if (message.busy) busyTry.add(Number(message.ordinal));
    else busyTry.delete(Number(message.ordinal));
    updateVisibleRowControls();
  } else if (message.type === 'syncStatus') {
    if (Number(message.documentVersion) < latestDocumentVersion) return;
    model.syncStatus = message.status;
    updateSummary();
  } else if (message.type === 'syncBusy') {
    syncBusy = Boolean(message.busy);
    updateSummary();

  } else if (message.type === 'allNoStateAccepted') {
    const items = Array.isArray(message.items) ? message.items : [];
    items.forEach(function(item) {
      const ordinal = Number(item.ordinal);
      const row = pageRowCache.get(ordinal);
      if (row) {
        row.rawState = 'translated';
        row.status = 'translated';
        row.missing = false;
        row.review = false;
        row.canAcceptTranslation = false;
        if (item.provenance) {
          row.translationProvenance = item.provenance;
          row.translationProvenanceLabel = item.provenanceLabel || '';
          row.provenanceHistory = (row.provenanceHistory || []).concat([item.provenance]);
          row.provenanceHistoryLabels = (row.provenanceHistoryLabels || []).concat([item.provenanceHistoryLabel || item.provenanceLabel || '']);
        }
        row.qualityIssues = (row.qualityIssues || []).filter(function(issue) {
          return issue.code !== 'target-without-state' && issue.code !== 'unknown-state';
        });
        syncIndexFromFullRow(row);
      } else {
        mergePartialRowOverride(ordinal, { rawState:'translated', status:'translated', missing:false, review:false, canAcceptTranslation:false });
      }
      removeResolvedAcceptQualityIssues(ordinal);
    });
    clearNavigationTarget();
    flushSummaryStats();
    if (Number.isFinite(message.noStateCount)) model.stats.noState = message.noStateCount;
    updateSummary();
    render({ loading:false });
  } else if (message.type === 'draftsSaved') {
    applyDraftsBusy = false;
    if (applyDraftsOverlayVisible) hideLoading();
    applyDraftsOverlayVisible = false;
    (message.items || []).forEach(function(item) {
      const ordinal = Number(item.ordinal);
      dirtyOrdinals.delete(ordinal);
      proposalOrdinals.delete(ordinal);
      if (item.canUndoApply) appliedUndoOrdinals.add(ordinal); else appliedUndoOrdinals.delete(ordinal);
      const row = pageRowCache.get(ordinal);
      if (row) {
        row.savedTranslation = typeof item.translation === 'string' ? item.translation : row.savedTranslation;
        row.translation = row.savedTranslation;
        row.translationDirty = false;
        row.hasTranslationDraft = false;
        row.translationDraftProvenance = undefined;
        row.translationDraftOrigin = '';
        row.proposal = '';
        row.proposalOrigin = '';
        row.proposalProvenance = undefined;
        if (item.provenance) {
          row.translationProvenance = item.provenance;
          row.translationProvenanceLabel = item.provenanceLabel || '';
          row.provenanceHistory = (row.provenanceHistory || []).concat([item.provenance]);
          row.provenanceHistoryLabels = (row.provenanceHistoryLabels || []).concat([item.provenanceHistoryLabel || item.provenanceLabel || '']);
        }
        row.rawState = item.state || 'translated';
        row.status = item.state || 'translated';
        row.missing = false;
        row.review = false;
        row.canAcceptTranslation = false;
        row.appliedUndo = Boolean(item.canUndoApply);
        updateInlineValidation(row, 'translation', row.translation);
        updateRowControls(row);
      } else {
        mergePartialRowOverride(ordinal, {
          translation:typeof item.translation === 'string' ? item.translation : undefined,
          savedTranslation:typeof item.translation === 'string' ? item.translation : undefined,
          translationDirty:false,hasTranslationDraft:false,proposal:'',hasProposal:false,
          rawState:item.state || 'translated',status:item.state || 'translated',missing:false,review:false,
          canAcceptTranslation:false,appliedUndo:Boolean(item.canUndoApply)
        });
      }
    });
    if (message.qualityReport) {
      const qualityWasVisible = !qualityPanel.classList.contains('hidden');
      renderQualityReport(message.qualityReport, false, qualityWasVisible);
      if (model.stats) {
        model.stats.quality = message.qualityReport.summary || summarizeQualityIssuesClient(message.qualityReport.issues || []);
        model.stats.qualityIssues = Number(model.stats.quality.total) || 0;
      }
    }
    if (!message.fullReload && qualityOnly.checked) render({ loading:false });
    else updateSummary();
  }
});
vscode.postMessage({ type:'ready' });
</script>
</body>
</html>`;

    }
}



function hasStructuralUnitChange(beforeParsed, afterParsed) {
    const beforeUnits = beforeParsed && Array.isArray(beforeParsed.units) ? beforeParsed.units : [];
    const afterUnits = afterParsed && Array.isArray(afterParsed.units) ? afterParsed.units : [];
    if (beforeUnits.length !== afterUnits.length) return true;
    for (let index = 0; index < beforeUnits.length; index++) {
        const before = beforeUnits[index] || {};
        const after = afterUnits[index] || {};
        if (String(before.id || '') !== String(after.id || '')) return true;
        if (String(before.source || '') !== String(after.source || '')) return true;
        if (String(before.translate || '') !== String(after.translate || '')) return true;
    }
    return false;
}


function clearQualityDiagnostics(uri) {
    clearQualityDiagnosticMappings(uri);
    const collection = XliffEditorProvider.qualityDiagnostics;
    if (!uri || !collection || typeof collection.delete !== 'function') return;
    collection.delete(uri);
}

function publishQualityDiagnostics(document, report, parsed, perf) {
    publishQualityDiagnosticsForText(document.uri, document.getText(), report, parsed, offset => document.positionAt(offset), perf);
}

function publishQualityDiagnosticsForText(uri, text, report, parsed, positionAt, perf) {
    const collection = XliffEditorProvider.qualityDiagnostics;
    if (!collection || !vscode.Diagnostic || !vscode.Range || !vscode.DiagnosticSeverity) return;
    const sourceText = String(text || '');
    const units = parsed && Array.isArray(parsed.units) ? parsed.units : [];
    if (perf) perf.mark('diagnostics use parsed unit offsets', { units: units.length });

    let lineStarts;
    let toPosition;
    if (typeof positionAt === 'function') {
        toPosition = positionAt;
    } else {
        lineStarts = buildLineStarts(sourceText);
        toPosition = offset => positionAtText(sourceText, offset, lineStarts);
    }
    if (perf) perf.mark('diagnostics build line index', { lines: lineStarts ? lineStarts.length : undefined, nativeDocumentPositions: !lineStarts });

    const diagnosticSelection = selectQualityDiagnosticIssues(report, qualityDiagnosticsLimit(uri));
    beginQualityDiagnosticMappings(uri);
    const positionCache = new Map();
    const diagnostics = diagnosticSelection.issues.map(issue => {
        const ordinal = Number.isInteger(issue.ordinal) ? issue.ordinal : undefined;
        const offset = diagnosticOffsetForOrdinal(units, ordinal);
        let rangePositions = positionCache.get(offset);
        if (!rangePositions) {
            rangePositions = {
                start: toPosition(offset),
                end: toPosition(Math.min(sourceText.length, offset + 1))
            };
            positionCache.set(offset, rangePositions);
        }
        const { start, end } = rangePositions;
        const severity = issue.severity === 'error'
            ? vscode.DiagnosticSeverity.Error
            : (issue.severity === 'info' ? vscode.DiagnosticSeverity.Information : vscode.DiagnosticSeverity.Warning);
        const diagnostic = new vscode.Diagnostic(new vscode.Range(start, end), issue.message, severity);
        diagnostic.source = BRAND_NAME;
        diagnostic.code = issue.code;
        registerQualityDiagnosticMapping(uri, diagnostic, issue);
        return diagnostic;
    });
    if (perf) perf.mark('diagnostics create objects', {
        diagnostics: diagnostics.length,
        totalIssues: diagnosticSelection.total,
        diagnosticsLimit: diagnosticSelection.limit,
        truncated: diagnosticSelection.truncated,
        uniqueRanges: positionCache.size
    });
    // Publish diagnostics on the real XLIFF resource. The Problems view remains a
    // standard VS Code diagnostics list; AL Xliff Studio deliberately does not hook
    // editor-selection events or redirect a Problems click into the visual editor.
    // This keeps raw-XLIFF navigation (especially the per-row </> action) independent.
    collection.set(uri, diagnostics);
    if (perf) perf.mark('diagnostics collection set', {
        diagnostics: diagnostics.length,
        totalIssues: diagnosticSelection.total,
        truncated: diagnosticSelection.truncated
    });
    return diagnosticSelection;
}

function buildLineStarts(text) {
    const sourceText = String(text || '');
    const starts = [0];
    for (let index = 0; index < sourceText.length; index++) {
        const code = sourceText.charCodeAt(index);
        if (code === 13) {
            if (sourceText.charCodeAt(index + 1) === 10) index++;
            starts.push(index + 1);
        } else if (code === 10) {
            starts.push(index + 1);
        }
    }
    return starts;
}

function positionAtText(text, offset, lineStarts) {
    const sourceText = String(text || '');
    const clamped = Math.max(0, Math.min(sourceText.length, Number(offset) || 0));
    const starts = Array.isArray(lineStarts) && lineStarts.length ? lineStarts : buildLineStarts(sourceText);
    let low = 0;
    let high = starts.length - 1;
    while (low <= high) {
        const mid = (low + high) >>> 1;
        if (starts[mid] <= clamped) low = mid + 1;
        else high = mid - 1;
    }
    const line = Math.max(0, high);
    return new vscode.Position(line, clamped - starts[line]);
}

function diagnosticOffsetForOrdinal(units, ordinal) {
    if (!Number.isInteger(ordinal) || ordinal < 0 || !Array.isArray(units)) return 0;
    const direct = units[ordinal];
    if (direct && Number(direct.ordinal) === ordinal && Number.isInteger(Number(direct.startOffset))) {
        return Math.max(0, Number(direct.startOffset));
    }
    for (const unit of units) {
        if (Number(unit && unit.ordinal) !== ordinal) continue;
        const offset = Number(unit && unit.startOffset);
        return Number.isInteger(offset) && offset >= 0 ? offset : 0;
    }
    return 0;
}

function determineManualTranslationState(unit) {
    // Manual text editing must never change workflow state implicitly. Status is
    // changed only by an explicit status action or by accepting a proposal.
    return String(unit && unit.targetState || '');
}

function canAcceptPersistedTranslation(unit, readOnly = false) {
    if (readOnly || !unit || String(unit.translate || '').trim().toLowerCase() === 'no') return false;
    const translation = String(unit.target == null ? '' : unit.target);
    if (!translation) return false;
    const state = String(unit.targetState || '').trim().toLowerCase();
    return !['translated', 'signed-off', 'final'].includes(state);
}


function countTransUnitsFast(text) {
    const matches = String(text || '').match(/<trans-unit\b/gi);
    return matches ? matches.length : 0;
}

function yieldToEventLoop() {
    return new Promise(resolve => setTimeout(resolve, 0));
}

function getPlaceholderValidation(source, translation) {
    if (!String(translation == null ? '' : translation).length) {
        return { error: '', expected: extractPlaceholders(source), actual: [] };
    }
    const expected = extractPlaceholders(source);
    const actual = extractPlaceholders(translation);
    if (!expected.length && !actual.length) {
        return { error: '', expected, actual };
    }
    const matches = expected.length === actual.length && expected.every((value, index) => value === actual[index]);
    return {
        error: matches
            ? ''
            : `Placeholder mismatch — expected: ${expected.length ? expected.join(', ') : '(none)'}; translation: ${actual.length ? actual.join(', ') : '(none)'}`,
        expected,
        actual
    };
}

function displayStatus(unit) {
    if (String(unit.translate || '').trim().toLowerCase() === 'no') return 'translate=no';
    if (unit.targetState) return unit.targetState;
    if (unit.target === undefined || unit.target.length === 0) return 'missing';
    return 'no-state';
}


function isGeneratorFilename(uri) {
    return path.basename(uri.fsPath || uri.path || '').toLowerCase().endsWith('.g.xlf');
}

function isGeneratorXliff(uri, parsed) {
    return isGeneratorFilename(uri) || !parsed.targetLanguage;
}

async function getMapUriForXlf(xlfUri, language) {
    return await migrateLegacyLanguageMapIfNeeded(xlfUri, language) || await getLanguageMapUri(xlfUri, language);
}

async function findSiblingGxlf(uri, targetLanguage) {
    const folder = path.dirname(uri.fsPath);
    if (targetLanguage) {
        const exactName = getGeneratorCompanionFilename(uri.fsPath, targetLanguage);
        if (exactName) {
            const exactUri = vscode.Uri.file(path.join(folder, exactName));
            try {
                await vscode.workspace.fs.stat(exactUri);
                return exactUri;
            } catch (_) {
                // Fall through to the unambiguous single-file fallback.
            }
        }
    }
    const found = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '*.g.xlf'));
    return found.length === 1 ? found[0] : undefined;
}

async function openXliffUnitSource(document, ordinal) {
    const location = findXliffUnitLocation(document.getText(), ordinal);
    if (!location) {
        vscode.window.showWarningMessage(`${BRAND_NAME}: the selected trans-unit could not be located in the XLIFF source.`);
        return false;
    }
    const editor = await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
    const range = new vscode.Range(document.positionAt(location.start), document.positionAt(location.end));
    editor.selection = new vscode.Selection(range.start, range.end);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    return true;
}

async function openAlSourceDefinition(xlfUri, unit, targetLanguage) {
    const projectRoot = await findAlProjectRoot(xlfUri);
    if (!projectRoot) {
        vscode.window.showWarningMessage(`${BRAND_NAME}: no workspace/project root was found for this XLIFF.`);
        return false;
    }

    let navigationUnit = unit;
    if (!parseGeneratorOrigin(navigationUnit)) {
        try {
            const siblingUri = await findSiblingGxlf(xlfUri, targetLanguage);
            if (siblingUri) {
                const generatorText = await readText(siblingUri);
                const generatorParsed = await parseWithDocumentSessionAsync(siblingUri, generatorText);
                navigationUnit = withGeneratorOriginFromCompanion(unit, generatorParsed);
            }
        } catch (_) {
            // A missing/unreadable generator must not block the project-search fallback.
        }
    }

    const origin = parseGeneratorOrigin(navigationUnit);
    if (origin) {
        const alFiles = await vscode.workspace.findFiles(
            new vscode.RelativePattern(projectRoot.fsPath, '**/*.al'),
            '**/{.alpackages,node_modules,.git}/**'
        );
        const exactCandidates = [];
        for (const uri of alFiles) {
            const text = await readText(uri);
            for (const candidate of findExactAlOriginCandidates(text, navigationUnit)) {
                exactCandidates.push({ ...candidate, uri, filePath: uri.fsPath });
            }
        }

        // Structural origin is intentionally strict. Only one exact object / element /
        // property definition is opened automatically. Duplicate or stale origin data
        // falls back to VS Code's project search instead of asking the user to choose
        // among text candidates.
        if (exactCandidates.length === 1) {
            return openResolvedAlSourceCandidate(exactCandidates[0]);
        }
    }

    await openProjectSourceSearch(projectRoot, navigationUnit);
    return false;
}

async function openResolvedAlSourceCandidate(selected) {
    const sourceDocument = await vscode.workspace.openTextDocument(selected.uri);
    const editor = await vscode.window.showTextDocument(sourceDocument, { preview: false, preserveFocus: false });
    const start = new vscode.Position(selected.line, selected.startCharacter);
    const end = new vscode.Position(Number.isInteger(selected.endLine) ? selected.endLine : selected.line, selected.endCharacter);
    const range = new vscode.Range(start, end);
    editor.selection = new vscode.Selection(start, end);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    return true;
}

async function openProjectSourceSearch(projectRoot, unit) {
    const query = createFallbackSourceSearchQuery(unit);
    if (!query) return false;
    const relativeRoot = formatRelativePath(projectRoot).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
    const filesToInclude = relativeRoot && relativeRoot !== '.' ? `${relativeRoot}/**/*.al` : '**/*.al';
    await vscode.commands.executeCommand('workbench.action.findInFiles', {
        query,
        filesToInclude,
        triggerSearch: true,
        isRegex: false,
        matchWholeWord: false
    });
    return true;
}

async function findAlProjectRoot(uri) {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) return undefined;
    const boundary = path.resolve(folder.uri.fsPath);
    let current = path.resolve(path.dirname(uri.fsPath));
    while (current === boundary || current.startsWith(boundary + path.sep)) {
        try {
            await vscode.workspace.fs.stat(vscode.Uri.file(path.join(current, 'app.json')));
            return vscode.Uri.file(current);
        } catch (_) {
            // Keep walking towards the workspace root.
        }
        if (current === boundary) break;
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }
    return folder.uri;
}

function formatRelativePath(uri) {
    if (vscode.workspace && typeof vscode.workspace.asRelativePath === 'function') {
        return vscode.workspace.asRelativePath(uri, false);
    }
    return uri && uri.fsPath ? uri.fsPath : '';
}

function formatCandidateContext(candidate) {
    const context = candidate && candidate.context || {};
    const object = [context.objectType, context.objectName].filter(Boolean).join(' ');
    const element = [context.elementType, context.elementName].filter(Boolean).join(' ');
    const parts = [object, element, candidate && candidate.property].filter(Boolean);
    return parts.length ? ` · ${parts.join(' · ')}` : '';
}

function shortMessageText(value) {
    const text = String(value || '').replace(/[\r\n\t]+/g, ' ').trim();
    return text.length > 100 ? `${text.slice(0, 97)}…` : text;
}

function normalizeLanguageCode(value) {
    return String(value || '').trim().replace(/_/g, '-').toLowerCase();
}

async function readText(uri) {
    const openDocument = vscode.workspace.textDocuments.find(document => document.uri.toString() === uri.toString());
    if (openDocument) return openDocument.getText();
    return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
}

async function writeText(uri, text) {
    const openDocument = vscode.workspace.textDocuments.find(document => document.uri.toString() === uri.toString());
    if (!openDocument) {
        const parent = vscode.Uri.joinPath(uri, '..');
        if (vscode.workspace.fs.createDirectory) await vscode.workspace.fs.createDirectory(parent);
        await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
        return;
    }
    if (openDocument.getText() === text) return;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(openDocument.positionAt(0), openDocument.positionAt(openDocument.getText().length)), text);
    await vscode.workspace.applyEdit(edit);
}

function isFileNotFound(err) {
    return err && (err.code === 'FileNotFound' || err.code === 'ENOENT');
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatError(err) {
    return err instanceof Error ? err.message : String(err);
}

function mergeTranslationMemoryFromXliffTexts(existingEntries, xlfTexts) {
    return mergeTranslationMemorySnapshots(existingEntries, translationMemorySnapshots(Array.isArray(xlfTexts) ? xlfTexts : []));
}

module.exports = {
    XliffEditorProvider,
    countTransUnitsFast,
    getPlaceholderValidation,
    mergeTranslationMemoryFromXliffTexts,
    mergeTranslationMemorySnapshots,
    determineManualTranslationState,
    canAcceptPersistedTranslation,
    displayStatus,
    getMapUriForXlf,
    isGeneratorXliff,
    queryViewRows,
    normalizeViewRequest,
    createViewSearchSortKeys,
    createViewSearchSortKeyStore,
    createViewSearchSortKeysForOverride,
    compactEditorRow,
    materializeEditorRowDetails,
    createEditorSummaryStats,
    addRowSummaryContribution,
    diagnosticOffsetForOrdinal,
    shouldDeferInitialQuality,
    createEmptyQualityReport,
    selectQualityDiagnosticIssues,
    qualityDiagnosticsLimit,
    DEFAULT_QUALITY_DIAGNOSTIC_LIMIT,
    DEFERRED_QUALITY_CHAR_THRESHOLD,
    DEFERRED_QUALITY_UNIT_THRESHOLD
};
