'use strict';

const path = require('path');

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getGeneratorCompanionFilename(filePath, targetLanguage) {
    const filename = path.basename(filePath || '');
    const language = String(targetLanguage || '').trim();
    if (!filename || !language) return undefined;
    const localeSuffix = new RegExp(`\\.${escapeRegExp(language)}\\.xlf$`, 'i');
    if (!localeSuffix.test(filename)) return undefined;
    return filename.replace(localeSuffix, '.g.xlf');
}

module.exports = { getGeneratorCompanionFilename };
