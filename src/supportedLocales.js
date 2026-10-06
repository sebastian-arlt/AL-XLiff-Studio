'use strict';

const path = require('path');
const { parseXliff } = require('./xliff');

function normalizeLocale(value) {
    return String(value || '').trim().replace(/_/g, '-').toLowerCase();
}

function parseAppSupportedLocales(text) {
    const raw = String(text == null ? '' : text).replace(/^\uFEFF/, '');
    const json = JSON.parse(raw || '{}');
    const seen = new Set();
    const supportedLocales = [];
    for (const item of Array.isArray(json.supportedLocales) ? json.supportedLocales : []) {
        const locale = String(item || '').trim().replace(/_/g, '-');
        const key = normalizeLocale(locale);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        supportedLocales.push(locale);
    }
    return {
        name: String(json.name || '').trim(),
        supportedLocales
    };
}

function translationFilenameForGenerator(generatorPath, targetLanguage) {
    const filename = path.basename(String(generatorPath || ''));
    const locale = String(targetLanguage || '').trim().replace(/_/g, '-');
    if (!filename || !locale || !/\.g\.xlf$/i.test(filename)) return undefined;
    return filename.replace(/\.g\.xlf$/i, `.${locale}.xlf`);
}

function createTranslationXliffFromGenerator(generatorText, targetLanguage) {
    const locale = String(targetLanguage || '').trim().replace(/_/g, '-');
    if (!locale) throw new Error('Target language must not be empty.');

    const source = String(generatorText || '');
    const parsed = parseXliff(source);
    if (!parsed.units.length) throw new Error('The generated .g.xlf contains no translation units.');
    if (normalizeLocale(parsed.sourceLanguage) === normalizeLocale(locale)) {
        throw new Error(`The requested target locale ${locale} is the XLIFF source language.`);
    }

    let result = setFileTargetLanguage(source, locale);
    const eol = result.includes('\r\n') ? '\r\n' : '\n';
    result = result.replace(/<trans-unit\b[^>]*>[\s\S]*?<\/trans-unit>/gi, unitRaw => addUntranslatedTarget(unitRaw, eol));

    const generated = parseXliff(result);
    if (normalizeLocale(generated.targetLanguage) !== normalizeLocale(locale)) {
        throw new Error(`Could not set target-language=${locale} in the generated XLIFF.`);
    }
    if (generated.units.length !== parsed.units.length) {
        throw new Error('Generated translation XLIFF does not contain the same number of translation units as the .g.xlf.');
    }
    return result;
}

function setFileTargetLanguage(text, targetLanguage) {
    let changed = false;
    const result = String(text || '').replace(/<file\b([^>]*)>/i, (raw, attrs) => {
        changed = true;
        return `<file${setAttribute(attrs, 'target-language', targetLanguage)}>`;
    });
    if (!changed) throw new Error('The generated .g.xlf does not contain a <file> element.');
    return result;
}

function setAttribute(attrs, name, value) {
    const escaped = escapeXmlAttribute(value);
    const re = new RegExp(`(\\b${escapeRegExp(name)}\\s*=\\s*)(["'])([\\s\\S]*?)\\2`, 'i');
    if (re.test(attrs)) return attrs.replace(re, `$1"${escaped}"`);
    const prefix = attrs ? (/\s$/.test(attrs) ? attrs : `${attrs} `) : ' ';
    return `${prefix}${name}="${escaped}"`;
}

function addUntranslatedTarget(unitRaw, eol) {
    let unit = String(unitRaw || '');
    // A generated .g.xlf normally has no targets, but stripping an unexpected one
    // makes creation deterministic and prevents copying stale translated content.
    unit = unit.replace(/\s*<target\b[^>]*>[\s\S]*?<\/target>\s*/i, eol);
    unit = unit.replace(/\s*<target\b[^>]*\/\s*>\s*/i, eol);

    const sourceRe = /(<source\b[^>]*>[\s\S]*?<\/source>)/i;
    const sourceMatch = unit.match(sourceRe);
    if (!sourceMatch) return unit;
    const beforeSource = unit.slice(0, sourceMatch.index);
    const lineIndentMatch = beforeSource.match(/(?:^|\r?\n)([ \t]*)$/);
    const sourceIndent = lineIndentMatch ? lineIndentMatch[1] : '  ';
    return unit.replace(sourceRe, `$1${eol}${sourceIndent}<target state="needs-translation"/>`);
}

function escapeXmlAttribute(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function escapeRegExp(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
    normalizeLocale,
    parseAppSupportedLocales,
    translationFilenameForGenerator,
    createTranslationXliffFromGenerator,
    setFileTargetLanguage,
    addUntranslatedTarget
};
