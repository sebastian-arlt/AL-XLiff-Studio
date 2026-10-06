'use strict';

const { isMissingTranslation, isReviewTranslation, placeholdersMatch } = require('./xliff');
const { findDuplicateIds, findDuplicateGeneratorNotes } = require('./validate');
const { analyzeXliffQuality } = require('./quality');

function calculateXliffMetrics(parsed, options = {}) {
    const treatNeedsTranslationAsMissing = options.treatNeedsTranslationAsMissing !== false;
    let total = 0;
    let translated = 0;
    let missing = 0;
    let review = 0;
    let placeholderErrors = 0;

    for (const unit of parsed.units || []) {
        if (String(unit.translate || '').trim().toLowerCase() === 'no') continue;
        total++;

        const unitMissing = isMissingTranslation(unit, treatNeedsTranslationAsMissing);
        const unitReview = isReviewTranslation(unit);
        if (unitMissing) missing++;
        else if (unitReview) review++;
        else if (unit.target) translated++;

        if (unit.target && !placeholdersMatch(unit.source, unit.target)) {
            placeholderErrors++;
        }
    }

    const duplicateIds = findDuplicateIds(parsed);
    const duplicateGeneratorNotes = findDuplicateGeneratorNotes(parsed);
    const percent = total > 0 ? Math.round((translated / total) * 100) : 100;
    const quality = options.qualitySummary || analyzeXliffQuality(parsed, {
        ...(options.qualityOptions || {}),
        glossaryEntries: options.glossaryEntries || []
    }).summary;

    return {
        total,
        translated,
        missing,
        review,
        placeholderErrors,
        percent,
        duplicateIds: duplicateIds.length,
        duplicateGeneratorNotes: duplicateGeneratorNotes.length,
        structuralWarnings: duplicateIds.length + duplicateGeneratorNotes.length,
        qualityIssues: quality.total,
        qualityErrors: quality.errors,
        qualityWarnings: quality.warnings
    };
}

function summarizeDashboardFiles(files) {
    const summary = {
        files: files.length,
        languages: 0,
        total: 0,
        translated: 0,
        missing: 0,
        review: 0,
        placeholderErrors: 0,
        structuralWarnings: 0,
        qualityIssues: 0,
        qualityErrors: 0,
        qualityWarnings: 0,
        percent: 100
    };
    const languages = new Set();

    for (const file of files) {
        if (file.targetLanguage) languages.add(String(file.targetLanguage).toLowerCase());
        const metrics = file.metrics || {};
        summary.total += Number(metrics.total) || 0;
        summary.translated += Number(metrics.translated) || 0;
        summary.missing += Number(metrics.missing) || 0;
        summary.review += Number(metrics.review) || 0;
        summary.placeholderErrors += Number(metrics.placeholderErrors) || 0;
        summary.structuralWarnings += Number(metrics.structuralWarnings) || 0;
        summary.qualityIssues += Number(metrics.qualityIssues) || 0;
        summary.qualityErrors += Number(metrics.qualityErrors) || 0;
        summary.qualityWarnings += Number(metrics.qualityWarnings) || 0;
    }

    summary.languages = languages.size;
    summary.percent = summary.total > 0 ? Math.round((summary.translated / summary.total) * 100) : 100;
    return summary;
}

module.exports = {
    calculateXliffMetrics,
    summarizeDashboardFiles
};
