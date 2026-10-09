'use strict';
const { t } = require('./localization');

const { parseNabTargetMarker, getDeveloperCommentTranslation } = require('./xliff');
const { findDuplicateIds, findDuplicateGeneratorNotes } = require('./validate');
const { findRelevantGlossaryTerms, findTerminologyViolationsForTerms } = require('./glossary');
const { qualityIgnoresFromNotes, qualityIgnoreMatches, normalizeQualityIgnoreCodes, projectQualityIgnoreMatches } = require('./qualityIgnore');

const VALID_STATES = new Set([
    '', 'new', 'needs-translation', 'needs-adaptation', 'needs-l10n',
    'needs-review-adaptation', 'needs-review-l10n', 'needs-review-translation',
    'translated', 'signed-off', 'final'
]);

const DEFAULT_ENGLISH_ALLOWLIST = new Set([
    'business', 'central', 'microsoft', 'dynamics', 'barcode', 'email', 'internet',
    'server', 'client', 'windows', 'azure', 'json', 'xml', 'http', 'https', 'api',
    'oauth', 'excel', 'word', 'pdf', 'url', 'guid', 'html', 'sql', 'power', 'apps'
]);

// A trailing period is part of these common English UI abbreviations rather than
// sentence punctuation. This avoids false positives such as Customer No. -> Debitornummer.
const PERIOD_ABBREVIATIONS = new Set([
    // English / common technical UI abbreviations
    'no.', 'nos.', 'qty.', 'amt.', 'inv.', 'doc.', 'ref.', 'dept.', 'pct.',
    'approx.', 'est.', 'temp.', 'vol.', 'wt.', 'len.', 'min.', 'max.', 'etc.',
    // German UI abbreviations
    'nr.', 'bzw.', 'ca.', 'ggf.', 'inkl.', 'zzgl.', 'bspw.', 'usw.', 'vgl.',
    // Common Romance-language UI abbreviations
    'nº.', 'n°.', 'núm.', 'num.', 'aprox.', 'env.', 'ecc.', 'es.', 'pag.', 'pág.'
]);

function analyzeXliffQuality(parsed, options = {}) {
    const glossaryEntries = Array.isArray(options.glossaryEntries) ? options.glossaryEntries : [];
    const projectQualityIgnores = Array.isArray(options.projectQualityIgnores) ? options.projectQualityIgnores : [];
    const checks = {
        placeholder: options.checkPlaceholders !== false,
        maxWidth: options.checkMaxWidth !== false,
        sourceEqualsTarget: options.checkSourceEqualsTarget !== false,
        whitespace: options.checkWhitespace !== false,
        punctuation: options.checkPunctuation !== false,
        developerComment: options.checkDeveloperComment !== false,
        inconsistentTranslations: options.checkInconsistentTranslations !== false,
        sharedTargets: options.checkSharedTargets !== false,
        copiedSourceTerms: options.checkCopiedSourceTerms === true,
        terminology: options.checkTerminology !== false,
        targetState: options.checkTargetState !== false,
        repeatedWhitespace: options.checkRepeatedWhitespace !== false,
        placeholderOrder: options.checkPlaceholderOrder !== false,
        formattingSequences: options.checkFormattingSequences !== false,
        lengthDeviation: options.checkLengthDeviation !== false,
        nabResidues: options.checkNabResidues !== false
    };

    const issues = [];
    const ignoredIssues = [];
    const byOrdinal = new Map();
    const ignoredByOrdinal = new Map();
    const unitByOrdinal = new Map((parsed.units || []).map(unit => [unit.ordinal, unit]));
    // Resolve applicable glossary terms once per unit. Quality checks can emit many
    // issues for the same source; rescanning the complete glossary for every issue
    // caused multi-second stalls on large XLIFF/glossary combinations.
    const glossaryByOrdinal = new Map();
    if (glossaryEntries.length && (checks.terminology || glossaryEntries.some(entry => normalizeQualityIgnoreCodes(entry.qualityIgnore).length))) {
        const glossaryBySource = new Map();
        for (const unit of parsed.units || []) {
            let relevant = glossaryBySource.get(unit.source);
            if (!relevant) {
                relevant = findRelevantGlossaryTerms(unit.source, parsed.targetLanguage, glossaryEntries);
                glossaryBySource.set(unit.source, relevant);
            }
            glossaryByOrdinal.set(unit.ordinal, relevant);
        }
    }

    const addToMap = (map, issue) => {
        if (!Number.isInteger(issue.ordinal)) return;
        if (!map.has(issue.ordinal)) map.set(issue.ordinal, []);
        map.get(issue.ordinal).push(issue);
    };

    const add = issue => {
        const normalized = {
            severity: issue.severity || 'warning',
            code: issue.code || 'quality',
            message: String(issue.message || ''),
            ordinal: Number.isInteger(issue.ordinal) ? issue.ordinal : undefined,
            id: issue.id || '',
            source: issue.source || '',
            target: issue.target || ''
        };
        const unit = Number.isInteger(normalized.ordinal) ? unitByOrdinal.get(normalized.ordinal) : undefined;
        const ignoredBy = getIgnoreReason(unit, normalized, parsed.targetLanguage, glossaryEntries, glossaryByOrdinal.get(normalized.ordinal), projectQualityIgnores);
        if (ignoredBy) {
            const ignored = { ...normalized, ignored: true, ignoredBy };
            ignoredIssues.push(ignored);
            addToMap(ignoredByOrdinal, ignored);
            return;
        }
        issues.push(normalized);
        addToMap(byOrdinal, normalized);
    };

    for (const duplicate of findDuplicateIds(parsed)) {
        add({ severity: 'error', code: 'duplicate-id', message: t("Duplicate trans-unit id: {0}", duplicate) });
    }
    for (const duplicate of findDuplicateGeneratorNotes(parsed)) {
        add({ severity: 'error', code: 'duplicate-generator-note', message: t("Duplicate Xliff Generator note: {0}", duplicate) });
    }

    const sourceToUnits = new Map();
    const targetToUnits = new Map();
    const developerMismatchOrdinals = new Set();

    for (const unit of parsed.units || []) {
        const notTranslatable = String(unit.translate || '').trim().toLowerCase() === 'no';
        if (notTranslatable) continue;
        const target = unit.target === undefined ? '' : String(unit.target);
        const source = String(unit.source || '');
        const base = { ordinal: unit.ordinal, id: unit.id, source, target };

        if (checks.targetState) {
            const state = String(unit.targetState || '').trim().toLowerCase();
            if (!VALID_STATES.has(state)) {
                add({ ...base, severity: 'warning', code: 'unknown-state', message: t("Unknown target state: {0}", unit.targetState) });
            }
            if (['translated', 'signed-off', 'final'].includes(state) && !target) {
                add({ ...base, severity: 'error', code: 'empty-final-target', message: t("Target is empty although state is {0}.", state) });
            }
            if (!state && target) {
                add({ ...base, severity: 'warning', code: 'target-without-state', message: t("Target contains translation text but has no state. Review and accept it to set state=translated.") });
            }
        }

        if (!target) continue;

        if (checks.developerComment) {
            const suggestion = getDeveloperCommentTranslation(unit, parsed.targetLanguage, { preserveWhitespace: true });
            if (suggestion.translation && !suggestion.conflict && target.normalize('NFC') !== suggestion.translation.normalize('NFC')) {
                developerMismatchOrdinals.add(unit.ordinal);
                add({ ...base, severity: 'warning', code: 'developer-comment-mismatch',
                    message: t("Translation differs from the Developer Note suggestion for {0}: “{1}”.", parsed.targetLanguage, suggestion.translation) });
            }
        }

        if (!sourceToUnits.has(source)) sourceToUnits.set(source, []);
        sourceToUnits.get(source).push(unit);
        const normalizedTarget = normalizeComparable(target);
        if (normalizedTarget) {
            if (!targetToUnits.has(normalizedTarget)) targetToUnits.set(normalizedTarget, []);
            targetToUnits.get(normalizedTarget).push(unit);
        }

        if (checks.placeholder) {
            const expected = [...new Set(String(source).match(/%\d+/g) || [])];
            const actual = [...new Set(String(target).match(/%\d+/g) || [])];
            if (!expected.every(value => actual.includes(value))) {
                add({
                    ...base,
                    severity: 'error',
                    code: 'placeholder-mismatch',
                    message: t("Placeholder mismatch — expected: {0}; target: {1}.", expected.length ? expected.join(', ') : t("(none)"), actual.length ? actual.join(', ') : t("(none)"))
                });
            }
        }

        if (checks.formattingSequences) {
            const formattingDifference = compareFormattingSequences(source, target);
            if (formattingDifference) {
                add({
                    ...base,
                    severity: 'error',
                    code: 'formatting-sequence-mismatch',
                    message: formattingDifference
                });
            }
        }

        if (checks.maxWidth && Number.isFinite(unit.maxWidth) && target.length > unit.maxWidth) {
            add({ ...base, severity: 'warning', code: 'maxwidth', message: t("Target length {0} exceeds maxwidth {1}.", target.length, unit.maxWidth) });
        }

        if (checks.sourceEqualsTarget && !sameLanguage(parsed.sourceLanguage, parsed.targetLanguage) && isLinguistic(source) && normalizeComparable(source) === normalizeComparable(target)) {
            add({ ...base, severity: 'warning', code: 'source-equals-target', message: t("Source and target have the same text.") });
        }

        if (checks.whitespace) {
            const sourceLeading = leadingWhitespace(source);
            const targetLeading = leadingWhitespace(target);
            const sourceTrailing = trailingWhitespace(source);
            const targetTrailing = trailingWhitespace(target);
            if (sourceLeading !== targetLeading || sourceTrailing !== targetTrailing) {
                add({ ...base, severity: 'warning', code: 'whitespace', message: t("Leading or trailing whitespace differs between source and target.") });
            }
        }

        if (checks.repeatedWhitespace && hasUnexpectedRepeatedHorizontalWhitespace(source, target)) {
            add({ ...base, severity: 'warning', code: 'repeated-whitespace', message: t("Target contains repeated spaces/tabs that are not present in the source.") });
        }

        if (checks.punctuation) {
            const sourcePunctuation = terminalPunctuation(source, { language: parsed.sourceLanguage });
            const targetPunctuation = terminalPunctuation(target, { language: parsed.targetLanguage });
            const expandedAbbreviation = (sourcePunctuation === '.' && !targetPunctuation && isPeriodAbbreviation(source, parsed.sourceLanguage))
                || (targetPunctuation === '.' && !sourcePunctuation && isPeriodAbbreviation(target, parsed.targetLanguage));
            if ((sourcePunctuation || targetPunctuation) && sourcePunctuation !== targetPunctuation && !expandedAbbreviation) {
                add({
                    ...base,
                    severity: 'warning',
                    code: 'punctuation',
                    message: t("Final punctuation differs — source {0}; target {1}.", sourcePunctuation ? t("ends with “{0}”", sourcePunctuation) : t("has none"), targetPunctuation ? t("ends with “{0}”", targetPunctuation) : t("has none"))
                });
            }
        }

        if (checks.lengthDeviation) {
            const deviation = strongLengthDeviation(source, target);
            if (deviation) {
                add({ ...base, severity: 'warning', code: 'length-deviation', message: deviation });
            }
        }

        if (checks.nabResidues) {
            const nabIssue = findNabResidue(unit, target);
            if (nabIssue) add({ ...base, severity: 'warning', code: 'nab-residue', message: nabIssue });
        }

        if (checks.terminology && glossaryEntries.length) {
            const relevantTerms = glossaryByOrdinal.get(unit.ordinal) || [];
            for (const violation of findTerminologyViolationsForTerms(target, relevantTerms)) {
                add({ ...base, severity: 'warning', code: 'terminology', message: violation.message });
            }
        }

        if (checks.copiedSourceTerms && isEnglish(parsed.sourceLanguage) && !isEnglish(parsed.targetLanguage)) {
            const copied = findCopiedEnglishTerms(source, target, options.englishAllowlist);
            if (copied.length) {
                add({ ...base, severity: 'info', code: 'copied-source-term', message: t("Possible untranslated English term(s): {0}.", copied.join(', ')) });
            }
        }
    }

    if (checks.inconsistentTranslations) {
        for (const [source, units] of sourceToUnits) {
            const targets = [...new Set(units.map(unit => String(unit.target || '')).filter(Boolean))];
            if (targets.length <= 1) continue;
            const preview = targets.slice(0, 4).map(value => `“${value}”`).join(', ');
            for (const unit of units) {
                add({
                    ordinal: unit.ordinal,
                    id: unit.id,
                    source,
                    target: unit.target || '',
                    severity: 'warning',
                    code: 'inconsistent-source',
                    message: t("The same source has different targets: {0}{1}", preview, targets.length > 4 ? '…' : '')
                });
            }
        }
    }

    if (checks.sharedTargets) {
        for (const [, units] of targetToUnits) {
            const sources = [...new Set(units.map(unit => String(unit.source || '')).filter(Boolean))];
            const target = String(units[0] && units[0].target || '');
            if (sources.length <= 1 || !isMeaningfulSharedTarget(target)) continue;
            const preview = sources.slice(0, 3).map(value => `“${value}”`).join(', ');
            for (const unit of units) {
                if (developerMismatchOrdinals.has(unit.ordinal)) continue;
                add({
                    ordinal: unit.ordinal,
                    id: unit.id,
                    source: unit.source || '',
                    target,
                    severity: 'info',
                    code: 'shared-target',
                    message: t("The same target is used for different sources: {0}{1}", preview, sources.length > 3 ? '…' : '')
                });
            }
        }
    }

    // Local Developer guidance takes precedence over inferred cross-source reuse.
    const prioritize = list => {
        const ordered = list.filter(issue => issue.code === 'developer-comment-mismatch')
            .concat(list.filter(issue => issue.code !== 'developer-comment-mismatch'));
        for (let i = 0; i < ordered.length; i++) list[i] = ordered[i];
    };
    prioritize(issues);
    prioritize(ignoredIssues);
    for (const list of byOrdinal.values()) prioritize(list);
    for (const list of ignoredByOrdinal.values()) prioritize(list);
    const summary = summarizeIssues(issues);
    const ignoredSummary = summarizeIssues(ignoredIssues);
    return { issues, ignoredIssues, byOrdinal, ignoredByOrdinal, summary, ignoredSummary };
}

function getIgnoreReason(unit, issue, targetLanguage, glossaryEntries, relevantGlossaryEntries, projectQualityIgnores) {
    // Project-level ignores are an explicit team/project decision and may suppress
    // errors, warnings or infos. They are stored outside the XLIFF so the original
    // translation unit remains untouched.
    if ((projectQualityIgnores || []).some(ignore => projectQualityIgnoreMatches(ignore, issue, targetLanguage))) return 'project';

    // Unit/glossary exceptions remain limited to non-errors. Functional errors such
    // as placeholder mismatches should only disappear through an explicit project-wide
    // exception, never through an invisible note attached to one translation unit.
    if (issue.severity === 'error' || !unit) return undefined;

    const explicit = qualityIgnoresFromNotes(unit.noteDetails).find(ignore => qualityIgnoreMatches(ignore, issue));
    if (explicit) return 'unit';

    const applicableGlossary = (Array.isArray(relevantGlossaryEntries)
        ? relevantGlossaryEntries
        : findRelevantGlossaryTerms(issue.source, targetLanguage, glossaryEntries))
        .filter(entry => normalizeQualityIgnoreCodes(entry.qualityIgnore).includes(issue.code))
        .filter(entry => glossaryTranslationSatisfied(issue.target, entry.translation));
    if (applicableGlossary.length) return 'glossary';
    return undefined;
}

function glossaryTranslationSatisfied(target, requiredTranslation) {
    const actual = normalizeComparable(target);
    const required = normalizeComparable(requiredTranslation);
    if (!actual || !required) return false;
    return actual === required || actual.includes(required);
}

function summarizeIssues(issues) {
    const summary = { total: 0, errors: 0, warnings: 0, infos: 0, categories: {} };
    for (const issue of issues || []) {
        summary.total++;
        if (issue.severity === 'error') summary.errors++;
        else if (issue.severity === 'info') summary.infos++;
        else summary.warnings++;
        summary.categories[issue.code] = (summary.categories[issue.code] || 0) + 1;
    }
    return summary;
}

function qualityOptionsFromConfiguration(config) {
    return {
        checkDeveloperComment: config.get('quality.checkDeveloperComment', true),
        checkPlaceholders: true,
        checkMaxWidth: config.get('validation.checkMaxWidth', true),
        checkSourceEqualsTarget: config.get('quality.checkSourceEqualsTarget', true),
        checkWhitespace: config.get('quality.checkWhitespace', true),
        checkPunctuation: config.get('quality.checkPunctuation', true),
        checkInconsistentTranslations: config.get('quality.checkInconsistentTranslations', true),
        checkSharedTargets: config.get('quality.checkSharedTargets', true),
        checkCopiedSourceTerms: config.get('quality.checkCopiedSourceTerms', false),
        checkRepeatedWhitespace: config.get('quality.checkRepeatedWhitespace', true),
        checkPlaceholderOrder: config.get('quality.checkPlaceholderOrder', true),
        checkFormattingSequences: config.get('quality.checkFormattingSequences', true),
        checkLengthDeviation: config.get('quality.checkLengthDeviation', true),
        checkNabResidues: config.get('quality.checkNabResidues', true),
        checkTerminology: config.get('glossary.enabled', true),
        checkTargetState: true
    };
}

function normalizeComparable(value) {
    return String(value || '').normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

function sameLanguage(sourceLanguage, targetLanguage) {
    const source = String(sourceLanguage || '').toLowerCase().split('-')[0];
    const target = String(targetLanguage || '').toLowerCase().split('-')[0];
    return Boolean(source && target && source === target);
}

function isEnglish(language) {
    return String(language || '').toLowerCase().split('-')[0] === 'en';
}

function isLinguistic(value) {
    return /\p{L}/u.test(String(value || ''));
}

function leadingWhitespace(value) {
    const match = String(value || '').match(/^\s+/u);
    return match ? match[0] : '';
}

function trailingWhitespace(value) {
    const match = String(value || '').match(/\s+$/u);
    return match ? match[0] : '';
}

function terminalPunctuation(value, options = {}) {
    const text = String(value || '').trimEnd();
    if (!text) return '';
    if (text.endsWith('...')) return '...';
    if (text.endsWith('…')) return '…';
    // Compare the visible final mark first, including abbreviation periods.
    // Expanded abbreviations are handled separately by the comparison above.
    const match = text.match(/[.!?:;]$/u);
    return match ? match[0] : '';
}

function isPeriodAbbreviation(text, language) {
    const value = String(text || '').trim().normalize('NFC').toLocaleLowerCase();
    if (!value.endsWith('.')) return false;
    const token = value.split(/\s+/u).pop() || '';
    if (PERIOD_ABBREVIATIONS.has(token)) return true;

    // Dotted acronyms/abbreviations ("U.S.", "z.B.", "z. B.", "u. a.")
    // are abbreviations regardless of language. A single final letter such as
    // "H." is deliberately NOT treated as an abbreviation: in UI text it can
    // be a code/level/designator at the end of a normal sentence, where the
    // period is real sentence punctuation (for example "levels M and H.").
    if (/(?:^|\s)(?:\p{L}{1,3}\.\s*){2,}$/u.test(value)) return true;
    if (/^(?:\p{L}{1,3}\.){2,}$/u.test(token)) return true;

    // Language is deliberately not used to classify the final period: UI strings
    // often contain foreign/product abbreviations even in a localized target.
    void language;
    return false;
}

function isEnglishPeriodAbbreviation(text) {
    // Kept as a public compatibility helper; abbreviation recognition is now
    // language-neutral because an abbreviation period is never sentence punctuation.
    return isPeriodAbbreviation(text, 'en');
}

function extractParameterPlaceholders(value) {
    return String(value || '').match(/%\d+|#\d+|\{\{?[^{}]+\}?\}/g) || [];
}

function sameMultiset(left, right) {
    if (left.length !== right.length) return false;
    const a = [...left].sort();
    const b = [...right].sort();
    return a.every((value, index) => value === b[index]);
}

function sameSequence(left, right) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

function compareFormattingSequences(source, target) {
    // AL uses the backslash itself as a line-break marker. Do not classify the
    // following n/r/t characters as C-style escapes or compare escape spellings.
    const signature = value => {
        const text = String(value || '').replace(/\\r\\n/g, '\\');
        return {
            lineBreaks: (text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').match(/\n/g) || []).length,
            backslashes: (text.match(/\\/g) || []).length
        };
    };
    const expected = signature(source), actual = signature(target);
    if (expected.lineBreaks === actual.lineBreaks && expected.backslashes === actual.backslashes) return '';
    const describe = item => t("{0} line break(s), {1} backslash(es)", item.lineBreaks, item.backslashes);
    return t("Formatting sequences differ — source: {0}; target: {1}.", describe(expected), describe(actual));
}

function hasUnexpectedRepeatedHorizontalWhitespace(source, target) {
    const repeated = /[^\S\r\n]{2,}/u;
    return repeated.test(String(target || '')) && !repeated.test(String(source || ''));
}

function strongLengthDeviation(source, target) {
    const sourceLength = linguisticLength(source);
    const targetLength = linguisticLength(target);
    if (sourceLength < 12 || targetLength < 1) return '';
    const ratio = targetLength / sourceLength;
    if (ratio >= 0.4 && ratio <= 2.5) return '';
    return t("Target length differs unusually strongly from source ({0} → {1} characters, {2}×).", sourceLength, targetLength, ratio.toFixed(2));
}

function linguisticLength(value) {
    return String(value || '')
        .replace(/%\d+|#\d+|\{\{?[^{}]+\}?\}|\\[nrt]/g, '')
        .replace(/\s+/gu, ' ')
        .trim().length;
}

function findNabResidue(unit, target) {
    const text = String(target || '');
    if (/\[NAB\s*:/i.test(text) || (/\bNAB\s*:/i.test(text) && !parseNabTargetMarker(text))) {
        return t("Target still contains a NAB workflow marker or malformed NAB marker.");
    }
    const state = String(unit && unit.targetState || '').trim().toLowerCase();
    const completed = ['translated', 'signed-off', 'final'].includes(state);
    const hasNabNote = Boolean(unit && Array.isArray(unit.noteDetails) && unit.noteDetails.some(note => String(note.from || '').trim().toLowerCase() === 'nab al tools'));
    if (completed && !unit.nabMarker && hasNabNote) {
        return t("Completed translation still contains a NAB AL Tools workflow note.");
    }
    return '';
}

function findCopiedEnglishTerms(source, target, customAllowlist) {
    const allowlist = new Set([...DEFAULT_ENGLISH_ALLOWLIST, ...(Array.isArray(customAllowlist) ? customAllowlist.map(value => String(value).toLowerCase()) : [])]);
    const targetLower = String(target || '').toLowerCase();
    const terms = [...new Set((String(source || '').match(/[A-Za-z][A-Za-z'-]{4,}/g) || []).map(term => term.toLowerCase()))]
        .filter(term => !allowlist.has(term))
        .filter(term => new RegExp(`(?:^|[^A-Za-z])${escapeRegExp(term)}(?=$|[^A-Za-z])`, 'i').test(targetLower));
    return terms;
}

function isMeaningfulSharedTarget(target) {
    const value = String(target || '').trim();
    if (value.length < 6) return false;
    if (!/\p{L}/u.test(value)) return false;
    if (/^(yes|no|ok|true|false|ja|nein)$/iu.test(value)) return false;
    return true;
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
    VALID_STATES,
    analyzeXliffQuality,
    summarizeIssues,
    qualityOptionsFromConfiguration,
    terminalPunctuation,
    findCopiedEnglishTerms,
    normalizeComparable,
    getIgnoreReason,
    glossaryTranslationSatisfied,
    isEnglishPeriodAbbreviation,
    isPeriodAbbreviation,
    extractParameterPlaceholders,
    compareFormattingSequences,
    strongLengthDeviation,
    findNabResidue
};
