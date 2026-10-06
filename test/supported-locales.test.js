'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseXliff } = require('../src/xliff');
const {
    normalizeLocale,
    parseAppSupportedLocales,
    translationFilenameForGenerator,
    createTranslationXliffFromGenerator
} = require('../src/supportedLocales');

test('supportedLocales parser normalizes duplicates while preserving app locale spelling', () => {
    const app = parseAppSupportedLocales(JSON.stringify({
        name: 'My App',
        supportedLocales: ['en-US', 'de-DE', 'fr-FR', 'DE-de', '', null]
    }));
    assert.equal(app.name, 'My App');
    assert.deepEqual(app.supportedLocales, ['en-US', 'de-DE', 'fr-FR']);
    assert.equal(normalizeLocale('DE_de'), 'de-de');
});

test('translation filename is derived from the generated .g.xlf companion', () => {
    assert.equal(translationFilenameForGenerator('/repo/Translations/My App.g.xlf', 'de-DE'), 'My App.de-DE.xlf');
    assert.equal(translationFilenameForGenerator('/repo/Translations/My App.G.XLF', 'fr-FR'), 'My App.fr-FR.xlf');
    assert.equal(translationFilenameForGenerator('/repo/Translations/My App.xlf', 'de-DE'), undefined);
});

test('new locale XLIFF is created from .g.xlf with empty needs-translation targets', () => {
    const generator = `<?xml version="1.0" encoding="utf-8"?>\n<xliff version="1.2"><file source-language="en-US" datatype="xml" original="My App"><body><group>\n  <trans-unit id="A"><source>Customer</source><note from="Xliff Generator">Page Customer List - Property Caption</note></trans-unit>\n  <trans-unit id="B"><source>Order %1</source><target state="translated">SHOULD NOT COPY</target><note from="Developer">%1 is order number</note></trans-unit>\n</group></body></file></xliff>`;
    const result = createTranslationXliffFromGenerator(generator, 'de-DE');
    const parsed = parseXliff(result);
    assert.equal(parsed.sourceLanguage, 'en-US');
    assert.equal(parsed.targetLanguage, 'de-DE');
    assert.equal(parsed.units.length, 2);
    assert.equal(parsed.units[0].target, '');
    assert.equal(parsed.units[0].targetState, 'needs-translation');
    assert.equal(parsed.units[1].target, '');
    assert.equal(parsed.units[1].targetState, 'needs-translation');
    assert.doesNotMatch(result, /SHOULD NOT COPY/);
    assert.match(result, /Xliff Generator/);
    assert.match(result, /Developer/);
});

test('new locale XLIFF refuses to generate a translation for the source language', () => {
    const generator = `<xliff><file source-language="en-US"><body><trans-unit id="A"><source>A</source></trans-unit></body></file></xliff>`;
    assert.throws(() => createTranslationXliffFromGenerator(generator, 'en-US'), /source language/i);
});

test('dashboard exposes supportedLocales missing-XLIFF generation workflow', () => {
    const dashboard = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8');
    assert.match(dashboard, /supportedLocales/);
    assert.match(dashboard, /generateLocale/);
    assert.match(dashboard, /Generate XLIFF/);
    assert.match(dashboard, /missing-locale/);
    assert.match(dashboard, /createTranslationXliffFromGenerator/);
    assert.match(dashboard, /Locales missing XLIFF/);
});
