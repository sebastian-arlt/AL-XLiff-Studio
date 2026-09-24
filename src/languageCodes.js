'use strict';

// Business Central / NAV developer comments often use the classic three-letter
// Windows language identifiers (for example DEU/ENU) instead of BCP-47 tags.
// Direct BCP-47 keys are always supported; this map adds the common aliases.
const BCP47_TO_LEGACY = new Map(Object.entries({
    'ar-SA': 'ARA',
    'ca-ES': 'CAT',
    'cs-CZ': 'CSY',
    'da-DK': 'DAN',
    'de-AT': 'DEA',
    'de-CH': 'DES',
    'de-DE': 'DEU',
    'el-GR': 'ELL',
    'en-AU': 'ENA',
    'en-CA': 'ENC',
    'en-GB': 'ENG',
    'en-IE': 'ENI',
    'en-NZ': 'ENZ',
    'en-US': 'ENU',
    'es-ES': 'ESP',
    'es-MX': 'ESM',
    'fi-FI': 'FIN',
    'fr-BE': 'FRB',
    'fr-CA': 'FRC',
    'fr-CH': 'FRS',
    'fr-FR': 'FRA',
    'he-IL': 'HEB',
    'hu-HU': 'HUN',
    'is-IS': 'ISL',
    'it-IT': 'ITA',
    'ja-JP': 'JPN',
    'ko-KR': 'KOR',
    'nb-NO': 'NOR',
    'nl-BE': 'NLB',
    'nl-NL': 'NLD',
    'pl-PL': 'PLK',
    'pt-BR': 'PTB',
    'pt-PT': 'PTG',
    'ro-RO': 'ROM',
    'ru-RU': 'RUS',
    'sk-SK': 'SKY',
    'sl-SI': 'SLV',
    'sv-SE': 'SVE',
    'tr-TR': 'TRK',
    'uk-UA': 'UKR',
    'zh-CN': 'CHS',
    'zh-TW': 'CHT'
}));

function normalizeBcp47(language) {
    const raw = String(language || '').trim().replace(/_/g, '-');
    if (!raw) return '';
    const parts = raw.split('-');
    return parts.map((part, index) => {
        if (index === 0) return part.toLowerCase();
        if (part.length === 2 || /^\d{3}$/.test(part)) return part.toUpperCase();
        if (part.length === 4) return part[0].toUpperCase() + part.slice(1).toLowerCase();
        return part;
    }).join('-');
}

function getLanguageCommentKeys(language) {
    const normalized = normalizeBcp47(language);
    if (!normalized) return [];

    const keys = new Set([normalized.toLowerCase()]);
    const legacy = BCP47_TO_LEGACY.get(normalized);
    if (legacy) keys.add(legacy.toLowerCase());
    return [...keys];
}

function languageKeyMatches(key, language) {
    const normalizedKey = String(key || '').trim().replace(/_/g, '-').toLowerCase();
    return getLanguageCommentKeys(language).includes(normalizedKey);
}

module.exports = {
    BCP47_TO_LEGACY,
    normalizeBcp47,
    getLanguageCommentKeys,
    languageKeyMatches
};
