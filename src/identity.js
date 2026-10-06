'use strict';

const BRAND_NAME = 'AL Xliff Studio';
const PACKAGE_NAME = 'al-xliff-studio';
const COMMAND_PREFIX = 'alXliffStudio';
const CONFIG_SECTION = 'alXliffStudio';
const CONFIG_AI_SECTION = `${CONFIG_SECTION}.ai`;
const LNG_EDITOR_VIEW_TYPE = `${COMMAND_PREFIX}.lngEditor`;
const XLIFF_EDITOR_VIEW_TYPE = `${COMMAND_PREFIX}.xlfEditor`;
const DASHBOARD_VIEW_TYPE = `${COMMAND_PREFIX}.translationDashboard`;
const AI_USAGE_VIEW_TYPE = `${COMMAND_PREFIX}.aiUsage`;
const GLOSSARY_EDITOR_VIEW_TYPE = `${COMMAND_PREFIX}.glossaryEditor`;
const NOTE_FROM = 'AL.XliffStudio';

function isStudioNoteFrom(value) {
    return String(value || '').trim().toLowerCase() === NOTE_FROM.toLowerCase();
}

module.exports = {
    BRAND_NAME,
    PACKAGE_NAME,
    COMMAND_PREFIX,
    CONFIG_SECTION,
    CONFIG_AI_SECTION,
    LNG_EDITOR_VIEW_TYPE,
    XLIFF_EDITOR_VIEW_TYPE,
    DASHBOARD_VIEW_TYPE,
    AI_USAGE_VIEW_TYPE,
    GLOSSARY_EDITOR_VIEW_TYPE,
    NOTE_FROM,
    isStudioNoteFrom
};
