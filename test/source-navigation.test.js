'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    findAlSourceCandidates,
    findExactAlOriginCandidates,
    withGeneratorOriginFromCompanion,
    parseGeneratorOrigin,
    createFallbackSourceSearchQuery,
    findXliffUnitLocation,
    hasUniqueBestCandidate,
    labelNameBeforeLiteral
} = require('../src/sourceNavigation');

test('generator origin navigates changed Caption, ToolTip and OptionCaption without source equality', () => {
    const al = `table 50005 "SPFB ABS Failed Sync List"
{
    Caption = 'New object caption';
    fields
    {
        field(2; "Item No."; Code[20])
        {
            Caption = 'New Blob Name';
            ToolTip = 'New tooltip';
            OptionCaption = 'New,Options';
        }
    }
}`;
    for (const property of ['Caption', 'ToolTip', 'OptionCaption']) {
        const candidates = findExactAlOriginCandidates(al, { source: 'Obsolete text', noteDetails: [{ from: 'Xliff Generator', text: `Table SPFB ABS Failed Sync List - Field Item No. - Property ${property}` }] });
        assert.equal(candidates.length, 1);
        assert.match(candidates[0].lineText, new RegExp(property + ' ='));
    }
    assert.equal(findExactAlOriginCandidates(al, { source: 'Old', noteDetails: [{ from: 'Xliff Generator', text: 'Table SPFB ABS Failed Sync List - Property Caption' }] })[0].line, 2);
});

test('generator default Caption navigates directly to its object or field declaration', () => {
    const al = `table 50005 "SPFB ABS Failed Sync List"
{
    fields
    {
        field(1; No; Integer)
        {
            DataClassification = CustomerContent;
        }
    }
}`;
    for (const [note, line] of [['Table SPFB ABS Failed Sync List - Property Caption', 0], ['Table SPFB ABS Failed Sync List - Field No - Property Caption', 4]]) {
        const candidates = findExactAlOriginCandidates(al, { source: 'Old', noteDetails: [{ from: 'Xliff Generator', text: note }] });
        assert.equal(candidates.length, 1);
        assert.equal(candidates[0].line, line);
    }
});

test('generator label origin ignores obsolete source and commented-out duplicate definitions', () => {
    const al = `codeunit 50000 Demo
{
    /* var WarningLbl: Label 'Obsolete'; */
    var
        WarningLbl: Label 'Current // text';
}`;
    const candidates = findExactAlOriginCandidates(al, { source: 'Obsolete', noteDetails: [{ from: 'Xliff Generator', text: 'Codeunit Demo - NamedType WarningLbl' }] });
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].line, 4);
});

test('permission object references are never resolved as default caption declarations', () => {
    assert.deepEqual(findExactAlOriginCandidates('permissionset 50000 Demo\n{\n    Permissions =\n        table "SPFB ABS Failed Sync List" = X;\n}', { source: 'SPFB ABS Failed Sync List', noteDetails: [{ from: 'Xliff Generator', text: 'Table SPFB ABS Failed Sync List - Property Caption' }] }), []);
});

test('EnumValue generator segments resolve AL value declarations', () => {
    const matches = findExactAlOriginCandidates('enum 50000 Demo\n{\n    value(1; Released)\n    {\n        Caption = \'Current\';\n    }\n}', { source: 'Old', noteDetails: [{ from: 'Xliff Generator', text: 'Enum Demo - EnumValue Released - Property Caption' }] });
    assert.equal(matches.length, 1);
    assert.equal(matches[0].line, 4);
});

test('origin resolves multiline labels and changed nonliteral OptionMembers', () => {
    const label = findExactAlOriginCandidates('codeunit 50000 Demo\n{\n    var\n        WarningLbl: Label\n            \'Current\';\n}', { source: 'Old', noteDetails: [{ from: 'Xliff Generator', text: 'Codeunit Demo - NamedType WarningLbl' }] });
    assert.equal(label.length, 1);
    assert.equal(label[0].line, 4);
    const members = findExactAlOriginCandidates('table 50000 Demo\n{\n    fields\n    {\n        field(1; Status; Option)\n        {\n            OptionMembers = New,Options;\n        }\n    }\n}', { source: '[Old,List]', noteDetails: [{ from: 'Xliff Generator', text: 'Table Demo - Field Status - Property OptionMembers' }] });
    assert.equal(members.length, 1);
    assert.equal(members[0].line, 6);
});

test('AL source navigation resolves a generated page caption to the matching AL definition', () => {
    const al = `page 50100 "Customer Demo"
{
    layout
    {
        area(Content)
        {
            field(CustomerNo; Rec."No.")
            {
                Caption = 'Customer No.';
            }
        }
    }
}`;
    const unit = {
        source: 'Customer No.',
        noteDetails: [{ from: 'Xliff Generator', text: 'Page Customer Demo - Field CustomerNo - Property Caption' }]
    };
    const candidates = findAlSourceCandidates(al, unit);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].property, 'Caption');
    assert.equal(candidates[0].context.objectName, 'Customer Demo');
    assert.equal(candidates[0].context.elementName, 'CustomerNo');
    assert.ok(candidates[0].score > 0);
});

test('AL source navigation resolves NamedType labels and escaped apostrophes', () => {
    const al = `codeunit 50100 "Demo Codeunit"
{
    var
        WarningLbl: Label 'Customer''s value';
}`;
    const unit = {
        source: "Customer's value",
        noteDetails: [{ from: 'Xliff Generator', text: 'Codeunit Demo Codeunit - NamedType WarningLbl' }]
    };
    const candidates = findAlSourceCandidates(al, unit);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].labelName, 'WarningLbl');
    assert.equal(labelNameBeforeLiteral("        WarningLbl: Label 'Customer''s value';", 26), 'WarningLbl');
});

test('AL source navigation can identify a unique context-best match for duplicate source text', () => {
    const unit = {
        source: 'Open',
        noteDetails: [{ from: 'Xliff Generator', text: 'Page Customer Demo - Action OpenCustomer - Property Caption' }]
    };
    const candidates = [
        { score: 94, filePath: '/p/CustomerDemo.Page.al', line: 10, startCharacter: 20 },
        { score: 48, filePath: '/p/Other.Page.al', line: 5, startCharacter: 20 }
    ];
    assert.equal(hasUniqueBestCandidate(candidates), true);
    assert.equal(hasUniqueBestCandidate([{ score: 48 }, { score: 48 }]), false);
});

test('XLIFF source navigation locates the parsed trans-unit ordinal', () => {
    const xlf = `<xliff><file><body>
<trans-unit id="A"><source>One</source><target>En</target></trans-unit>
<trans-unit id="ignored"><target>No source</target></trans-unit>
<trans-unit id="B"><source>Two</source><target>To</target></trans-unit>
</body></file></xliff>`;
    const location = findXliffUnitLocation(xlf, 1);
    assert.ok(location);
    assert.equal(xlf.slice(location.start, location.end), '<trans-unit id="B">');
});

test('AL source navigation resolves bracketed XLIFF OptionMembers to the AL list assignment', () => {
    const al = `table 50100 "Demo"
{
    fields
    {
        field(1; Status; Option)
        {
            OptionMembers = " ",Freigegeben,Gesperrt;
        }
    }
}`;
    const unit = {
        source: '[ ,Freigegeben,Gesperrt]',
        noteDetails: [{ from: 'Xliff Generator', text: 'Table Demo - Field Status - Property OptionMembers' }]
    };
    const candidates = findAlSourceCandidates(al, unit);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].property, 'OptionMembers');
    assert.equal(candidates[0].context.objectName, 'Demo');
    assert.equal(candidates[0].context.elementName, 'Status');
    assert.equal(candidates[0].line, 6);
    assert.ok(candidates[0].lineText.includes('OptionMembers = " ",Freigegeben,Gesperrt;'));
});

test('AL source navigation resolves multiline list-valued properties using the Xliff Generator property hint', () => {
    const al = `table 50100 "Demo"
{
    fields
    {
        field(1; Status; Option)
        {
            OptionMembers = " ",
                "In Progress",
                Gesperrt;
        }
    }
}`;
    const unit = {
        source: '[ ,In Progress,Gesperrt]',
        noteDetails: [{ from: 'Xliff Generator', text: 'Table Demo - Field Status - Property OptionMembers' }]
    };
    const candidates = findAlSourceCandidates(al, unit);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].line, 6);
    assert.equal(candidates[0].endLine, 8);
    assert.ok(candidates[0].endCharacter > 0);
});

test('AL source navigation does not match a different OptionMembers list', () => {
    const al = `table 50100 "Demo"
{
    fields
    {
        field(1; Status; Option)
        {
            OptionMembers = " ",Offen,Gesperrt;
        }
    }
}`;
    const unit = {
        source: '[ ,Freigegeben,Gesperrt]',
        noteDetails: [{ from: 'Xliff Generator', text: 'Table Demo - Field Status - Property OptionMembers' }]
    };
    assert.equal(findAlSourceCandidates(al, unit).length, 0);
});


test('generator origin parser preserves object names containing delimiter-like hyphens', () => {
    const origin = parseGeneratorOrigin({
        noteDetails: [{ from: 'Xliff Generator', text: 'Page DBH APIV2 - CE Integration - Control id - Property Caption' }]
    });
    assert.ok(origin);
    assert.equal(origin.objectType, 'Page');
    assert.equal(origin.objectName, 'DBH APIV2 - CE Integration');
    assert.deepEqual(origin.hierarchy, [{ type: 'Control', name: 'id' }]);
    assert.equal(origin.property, 'Caption');
});

test('exact origin navigation uses object and field hierarchy instead of duplicate global source text', () => {
    const al = `table 50100 "Other"
{
    fields
    {
        field(1; Status; Text[20])
        {
            Caption = 'Open';
        }
    }
}

table 50101 "Demo"
{
    fields
    {
        field(1; Status; Text[20])
        {
            Caption = 'Open';
        }
        field(2; OtherStatus; Text[20])
        {
            Caption = 'Open';
        }
    }
}`;
    const unit = {
        source: 'Open',
        noteDetails: [{ from: 'Xliff Generator', text: 'Table Demo - Field Status - Property Caption' }]
    };
    const candidates = findExactAlOriginCandidates(al, unit);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].context.objectName, 'Demo');
    assert.equal(candidates[0].context.elementName, 'Status');
    assert.equal(candidates[0].property, 'Caption');
});

test('exact origin navigation resolves Method plus NamedType labels', () => {
    const al = `codeunit 50100 "Demo Codeunit"
{
    local procedure First()
    var
        SameErr: Label 'Blocked';
    begin
    end;

    local procedure CheckContact()
    var
        SameErr: Label 'Blocked';
    begin
    end;
}`;
    const unit = {
        source: 'Blocked',
        noteDetails: [{ from: 'Xliff Generator', text: 'Codeunit Demo Codeunit - Method CheckContact - NamedType SameErr' }]
    };
    const candidates = findExactAlOriginCandidates(al, unit);
    assert.equal(candidates.length, 1);
    assert.match(candidates[0].lineText, /SameErr/);
    assert.equal(candidates[0].line, 10);
});

test('exact origin navigation resolves PageExtension Change blocks', () => {
    const al = `pageextension 50100 "Contact Ext" extends "Contact Card"
{
    layout
    {
        modify(Name)
        {
            Caption = 'Company Name';
        }
        modify("Company Name")
        {
            Caption = 'Company Name';
        }
    }
}`;
    const unit = {
        source: 'Company Name',
        noteDetails: [{ from: 'Xliff Generator', text: 'PageExtension Contact Ext - Change Company Name - Property Caption' }]
    };
    const candidates = findExactAlOriginCandidates(al, unit);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].line, 10);
});

test('exact origin navigation supports generator-named properties outside hover property list', () => {
    const al = `page 50100 "API Demo"
{
    PageType = API;
    EntityCaption = 'Customer entry';
    EntitySetCaption = 'Customer entries';
}`;
    const unit = {
        source: 'Customer entry',
        noteDetails: [{ from: 'Xliff Generator', text: 'Page API Demo - Property EntityCaption' }]
    };
    const candidates = findExactAlOriginCandidates(al, unit);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].property, 'EntityCaption');
});

test('exact origin navigation resolves OptionMembers structurally', () => {
    const al = `table 50100 "Demo"
{
    fields
    {
        field(1; OtherStatus; Option)
        {
            OptionMembers = " ",Freigegeben,Gesperrt;
        }
        field(2; Status; Option)
        {
            OptionMembers = " ",Freigegeben,Gesperrt;
        }
    }
}`;
    const unit = {
        source: '[ ,Freigegeben,Gesperrt]',
        noteDetails: [{ from: 'Xliff Generator', text: 'Table Demo - Field Status - Property OptionMembers' }]
    };
    const candidates = findExactAlOriginCandidates(al, unit);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].context.elementName, 'Status');
});

test('fallback project search query is useful for AL literals and bracketed lists', () => {
    assert.equal(createFallbackSourceSearchQuery({ source: "Customer's value" }), "Customer''s value");
    assert.equal(createFallbackSourceSearchQuery({
        source: '[ ,Freigegeben,Gesperrt]',
        noteDetails: [{ from: 'Xliff Generator', text: 'Table Demo - Field Status - Property OptionMembers' }]
    }), 'Freigegeben');
});


test('missing Xliff Generator origin is recovered from matching generator trans-unit id', () => {
    const unit = {
        id: 'Table 808207476 - Field 513339096 - Property 2879900210',
        source: 'Old caption',
        noteDetails: [{ from: 'Developer', text: 'DEU=Alt' }]
    };
    const generatorParsed = {
        units: [{
            id: unit.id,
            source: 'Current caption',
            noteDetails: [{ from: 'Xliff Generator', text: 'Table Demo - Field Status - Property Caption' }]
        }]
    };
    const resolved = withGeneratorOriginFromCompanion(unit, generatorParsed);
    assert.equal(resolved.source, 'Current caption');
    assert.equal(parseGeneratorOrigin(resolved).objectName, 'Demo');
    assert.equal(parseGeneratorOrigin(resolved).property, 'Caption');
    assert.equal(resolved.noteDetails.some(note => note.from === 'Developer'), true);
});

test('generator-origin recovery refuses ambiguous or missing generator ids', () => {
    const unit = { id: 'A', source: 'Text', noteDetails: [] };
    assert.equal(withGeneratorOriginFromCompanion(unit, { units: [] }), unit);
    assert.equal(withGeneratorOriginFromCompanion(unit, { units: [
        { id: 'A', source: 'One', noteDetails: [{ from: 'Xliff Generator', text: 'Table A - Property Caption' }] },
        { id: 'A', source: 'Two', noteDetails: [{ from: 'Xliff Generator', text: 'Table B - Property Caption' }] }
    ] }), unit);
});
