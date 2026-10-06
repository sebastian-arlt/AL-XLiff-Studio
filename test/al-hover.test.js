'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
    extractHoverTargetFromLine,
    extractAlContext,
    scoreUnitForContext,
    selectBestUnit,
    elementNameFromArguments
} = require('../src/alHoverCore');

function unit(id, source, generatorNote) {
    return {
        id,
        source,
        ordinal: Number(id.replace(/\D/g, '')) || 0,
        noteDetails: generatorNote ? [{ from: 'Xliff Generator', text: generatorNote }] : []
    };
}

test('AL hover detects Caption, ToolTip and Label source literals', () => {
    let line = "        Caption = 'Customer No.';";
    let target = extractHoverTargetFromLine(line, line.indexOf('Customer'));
    assert.equal(target.source, 'Customer No.');
    assert.equal(target.property, 'Caption');

    line = "        ToolTip = 'Open the customer card.';";
    target = extractHoverTargetFromLine(line, line.indexOf('customer'));
    assert.equal(target.source, 'Open the customer card.');
    assert.equal(target.property, 'ToolTip');

    line = "        CustomerNoLbl: Label 'Customer No.';";
    target = extractHoverTargetFromLine(line, line.indexOf('Customer No.'));
    assert.equal(target.source, 'Customer No.');
    assert.equal(target.property, 'Label');

    target = extractHoverTargetFromLine(line, line.indexOf('CustomerNoLbl'));
    assert.equal(target.source, 'Customer No.');
    assert.equal(target.labelName, 'CustomerNoLbl');
});

test('AL hover decodes escaped single quotes', () => {
    const line = "        Caption = 'Customer''s reference';";
    const target = extractHoverTargetFromLine(line, line.indexOf('reference'));
    assert.equal(target.source, "Customer's reference");
});

test('AL hover context recognizes Business Central object, field and property', () => {
    const lines = [
        'table 50100 "DBH Account Entry"',
        '{',
        '    fields',
        '    {',
        '        field(10; "Customer No."; Code[20])',
        '        {',
        "            Caption = 'Customer No.';",
        '        }',
        '    }',
        '}'
    ];
    const target = extractHoverTargetFromLine(lines[6], lines[6].indexOf('Customer No.'));
    const context = extractAlContext(lines, 6, target);
    assert.equal(context.objectType, 'Table');
    assert.equal(context.objectName, 'DBH Account Entry');
    assert.equal(context.elementType, 'Field');
    assert.equal(context.elementName, 'Customer No.');
    assert.equal(context.property, 'Caption');
    assert.equal(elementNameFromArguments('field', '10; "Customer No."; Code[20]'), 'Customer No.');
});

test('AL hover chooses the duplicate source with matching generator context', () => {
    const units = [
        unit('1', 'Customer No.', 'Table Other Table - Field Customer No. - Property Caption'),
        unit('2', 'Customer No.', 'Table DBH Account Entry - Field Customer No. - Property Caption')
    ];
    const context = {
        objectType: 'Table',
        objectName: 'DBH Account Entry',
        elementType: 'Field',
        elementName: 'Customer No.',
        property: 'Caption'
    };
    assert.ok(scoreUnitForContext(units[1], context) > scoreUnitForContext(units[0], context));
    const selected = selectBestUnit(units, 'Customer No.', context);
    assert.equal(selected.unit.id, '2');
    assert.equal(selected.matches, 2);
    assert.equal(selected.ambiguous, false);
});

test('package enables AL translation hover and extension contains direct XLIFF navigation wiring', () => {
    const root = path.join(__dirname, '..');
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.equal(pkg.contributes.configuration.properties['alXliffStudio.hover.enabled'].default, true);
    assert.ok(pkg.activationEvents.includes('onLanguage:al'));

    const extension = fs.readFileSync(path.join(root, 'extension.js'), 'utf8');
    assert.match(extension, /registerAlTranslationHover/);
    assert.match(extension, /openTranslationUnit/);

    const editor = fs.readFileSync(path.join(root, 'src', 'xlfEditor.js'), 'utf8');
    assert.match(editor, /static async openAtUnit/);
    assert.match(editor, /message\.type === 'jumpToOrdinal'/);
    assert.match(editor, /jumpToOrdinal\(Number\(message\.ordinal\), message\.severity \|\| ''\)/);
});
