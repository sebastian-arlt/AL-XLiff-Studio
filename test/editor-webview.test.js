'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function loadEditorWithVscodeStub() {
    const originalLoad = Module._load;
    Module._load = function(request, parent, isMain) {
        if (request === 'vscode') return {};
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        delete require.cache[require.resolve('../src/editor')];
        return require('../src/editor');
    } finally {
        Module._load = originalLoad;
    }
}

test('generated language-map webview script is valid JavaScript', () => {
    const { LanguageMapEditorProvider } = loadEditorWithVscodeStub();
    const provider = new LanguageMapEditorProvider({});
    const html = provider.getHtml({ cspSource: 'vscode-webview://test' });
    const match = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/);
    assert.ok(match, 'webview script block not found');
    assert.doesNotThrow(() => new Function(match[1]));
});


test('language-map editor exposes same-source filter and project search button', () => {
    const { LanguageMapEditorProvider } = loadEditorWithVscodeStub();
    const provider = new LanguageMapEditorProvider({});
    const html = provider.getHtml({ cspSource: 'vscode-webview://test' });

    assert.match(html, /id="sameOnly"/);
    assert.match(html, /Source = Translation/);
    assert.match(html, /class="search-source"/);
    assert.match(html, /type:'searchSource'/);
});

test('project search uses the exact source as a plain-text workspace query', () => {
    const { createFindInFilesArgs } = loadEditorWithVscodeStub();
    assert.deepEqual(createFindInFilesArgs('Customer No.'), {
        query: 'Customer No.',
        triggerSearch: true,
        isRegex: false,
        matchWholeWord: false
    });
});
