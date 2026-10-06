'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { whitespaceScript } = require('../src/visibleCharacters');

test('shared visible-character renderer covers whitespace and escapes document content', () => {
    const context = vm.createContext({ esc: value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;') });
    vm.runInContext(whitespaceScript, context);
    const value = ' \t\r\n\r\n\u00a0\u202f\u200b\u200c\u200d\u00ad<script>';
    context.value = value;
    const html = vm.runInContext('whitespaceDecoratedHtml(value)', context);
    for (const marker of ['space', 'tab', 'newline', 'nbsp', 'zwsp', 'zwnj', 'zwj', 'shy']) assert.ok(html.includes('ws-' + marker));
    assert.ok(html.includes('&lt;script&gt;'));
    assert.equal(context.value, value);
    assert.equal(vm.runInContext('whitespaceDecoratedHtml(null)', context), '');
});
