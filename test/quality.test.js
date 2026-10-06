'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseXliff } = require('../src/xliff');
const { analyzeXliffQuality, terminalPunctuation, findCopiedEnglishTerms, isPeriodAbbreviation } = require('../src/quality');
const { projectQualityIgnoreFromIssue } = require('../src/qualityIgnore');

function parse(body, attrs = 'source-language="en-US" target-language="de-DE"') {
    return parseXliff(`<xliff><file ${attrs}><body><group>${body}</group></body></file></xliff>`);
}

test('quality check detects placeholder, maxwidth, punctuation and source=target issues', () => {
    const parsed = parse(`
<trans-unit id="A" maxwidth="8"><source>Customer %1.</source><target state="translated">Customer %2</target></trans-unit>
<trans-unit id="B"><source>Posting Date</source><target state="translated">Posting Date</target></trans-unit>`);
    const report = analyzeXliffQuality(parsed);
    const codes = report.issues.map(issue => issue.code);
    assert.ok(codes.includes('placeholder-mismatch'));
    assert.ok(codes.includes('maxwidth'));
    assert.ok(codes.includes('punctuation'));
    assert.ok(codes.includes('source-equals-target'));
    assert.ok(report.summary.errors >= 1);
});

test('quality check detects whitespace and inconsistent translations for the same source', () => {
    const parsed = parse(`
<trans-unit id="A"><source> Order </source><target state="translated">Auftrag</target></trans-unit>
<trans-unit id="B"><source> Order </source><target state="translated"> Bestellung </target></trans-unit>`);
    const report = analyzeXliffQuality(parsed);
    assert.ok(report.issues.some(issue => issue.code === 'whitespace'));
    assert.equal(report.issues.filter(issue => issue.code === 'inconsistent-source').length, 2);
});

test('quality check detects suspicious shared targets for different meaningful sources', () => {
    const parsed = parse(`
<trans-unit id="A"><source>Open document</source><target state="translated">Dokument öffnen</target></trans-unit>
<trans-unit id="B"><source>Open order</source><target state="translated">Dokument öffnen</target></trans-unit>`);
    const report = analyzeXliffQuality(parsed);
    assert.equal(report.issues.filter(issue => issue.code === 'shared-target').length, 2);
});

test('quality check includes terminology violations from the project glossary', () => {
    const parsed = parse(`<trans-unit id="A"><source>Customer No.</source><target state="translated">Kundennummer</target></trans-unit>`);
    const report = analyzeXliffQuality(parsed, {
        glossaryEntries: [{ source: 'Customer', targetLanguage: 'de-DE', translation: 'Debitor', match: 'word', caseSensitive: false, note: '' }]
    });
    assert.ok(report.issues.some(issue => issue.code === 'terminology' && /Debitor/.test(issue.message)));
});

test('copied English-term heuristic is opt-in and skips common technical terms', () => {
    const parsed = parse(`<trans-unit id="A"><source>Customer payment server</source><target state="translated">Customer Zahlung Server</target></trans-unit>`);
    assert.equal(analyzeXliffQuality(parsed).issues.some(issue => issue.code === 'copied-source-term'), false);
    const report = analyzeXliffQuality(parsed, { checkCopiedSourceTerms: true });
    const issue = report.issues.find(item => item.code === 'copied-source-term');
    assert.ok(issue);
    assert.match(issue.message, /customer/i);
    assert.doesNotMatch(issue.message, /server/i);
});

test('terminal punctuation recognizes ellipsis and ordinary sentence punctuation', () => {
    assert.equal(terminalPunctuation('Loading...'), '...');
    assert.equal(terminalPunctuation('Really?'), '?');
    assert.equal(terminalPunctuation('No punctuation'), '');
});

test('quality check reports a non-empty target without state as review warning', () => {
    const parsed = parse(`<trans-unit id="A"><source>Customer No.</source><target>Debitornummer</target></trans-unit>`);
    const report = analyzeXliffQuality(parsed);
    const issue = report.issues.find(item => item.code === 'target-without-state');
    assert.ok(issue);
    assert.equal(issue.severity, 'warning');
    assert.match(issue.message, /no state/i);
    assert.match(issue.message, /state=translated/i);
});

test('punctuation check permits expanded English UI abbreviations without losing their visible period', () => {
    const parsed = parse(`<trans-unit id="A"><source>Customer No.</source><target state="translated">Debitornummer</target></trans-unit>`);
    const report = analyzeXliffQuality(parsed);
    assert.equal(report.issues.some(issue => issue.code === 'punctuation'), false);
    assert.equal(terminalPunctuation('Customer No.', { language: 'en-US' }), '.');
});

test('punctuation check still flags real sentence punctuation', () => {
    const parsed = parse(`<trans-unit id="A"><source>The customer does not exist.</source><target state="translated">Der Debitor existiert nicht</target></trans-unit>`);
    const report = analyzeXliffQuality(parsed);
    assert.ok(report.issues.some(issue => issue.code === 'punctuation'));
});

test('matching glossary quality exception suppresses configured warning', () => {
    const parsed = parse(`<trans-unit id="A"><source>Save.</source><target state="translated">Speichern</target></trans-unit>`);
    const report = analyzeXliffQuality(parsed, {
        glossaryEntries: [{ source: 'Save.', targetLanguage: 'de-DE', translation: 'Speichern', match: 'exact', caseSensitive: false, note: '', qualityIgnore: ['punctuation'] }]
    });
    assert.equal(report.issues.some(issue => issue.code === 'punctuation'), false);
    const ignored = report.ignoredIssues.find(issue => issue.code === 'punctuation');
    assert.ok(ignored);
    assert.equal(ignored.ignoredBy, 'glossary');
});

test('glossary quality exception does not hide warning when required translation is not satisfied', () => {
    const parsed = parse(`<trans-unit id="A"><source>Save.</source><target state="translated">Sichern</target></trans-unit>`);
    const report = analyzeXliffQuality(parsed, {
        glossaryEntries: [{ source: 'Save.', targetLanguage: 'de-DE', translation: 'Speichern', match: 'exact', caseSensitive: false, note: '', qualityIgnore: ['punctuation'] }]
    });
    assert.ok(report.issues.some(issue => issue.code === 'punctuation'));
});

test('unit QualityIgnore note suppresses matching warning only for same source and target', () => {
    const parsed = parse(`<trans-unit id="A"><source>Save.</source><target state="translated">Speichern</target><note from="AL.XliffStudio">QualityIgnore: {&quot;code&quot;:&quot;punctuation&quot;,&quot;source&quot;:&quot;Save.&quot;,&quot;target&quot;:&quot;Speichern&quot;}</note></trans-unit>`);
    const report = analyzeXliffQuality(parsed);
    assert.equal(report.issues.some(issue => issue.code === 'punctuation'), false);
    assert.equal(report.ignoredIssues.filter(issue => issue.code === 'punctuation').length, 1);

    const changed = parse(`<trans-unit id="A"><source>Save.</source><target state="translated">Jetzt speichern</target><note from="AL.XliffStudio">QualityIgnore: {&quot;code&quot;:&quot;punctuation&quot;,&quot;source&quot;:&quot;Save.&quot;,&quot;target&quot;:&quot;Speichern&quot;}</note></trans-unit>`);
    assert.ok(analyzeXliffQuality(changed).issues.some(issue => issue.code === 'punctuation'));
});


test('project-wide Quality Ignore suppresses the complete Quality rule across findings and languages', () => {
    const parsed = parse(`<trans-unit id="A"><source>Customer %1.</source><target state="translated">Kunde %2</target></trans-unit>
<trans-unit id="B"><source>Vendor %1.</source><target state="translated">Lieferant %3</target></trans-unit>`);
    const initial = analyzeXliffQuality(parsed);
    const placeholder = initial.issues.find(issue => issue.code === 'placeholder-mismatch');
    assert.ok(placeholder);
    assert.equal(placeholder.severity, 'error');

    const ignore = projectQualityIgnoreFromIssue(placeholder, 'de-DE');
    assert.deepEqual(ignore, { code:'placeholder-mismatch' });
    const suppressed = analyzeXliffQuality(parsed, { projectQualityIgnores: [ignore] });
    assert.equal(suppressed.issues.some(issue => issue.code === 'placeholder-mismatch'), false);
    assert.equal(suppressed.ignoredIssues.filter(issue => issue.code === 'placeholder-mismatch').length, 2);
    assert.ok(suppressed.ignoredIssues.filter(issue => issue.code === 'placeholder-mismatch').every(issue => issue.ignoredBy === 'project'));

    const changed = parse(`<trans-unit id="C"><source>Order %1.</source><target state="translated">Auftrag %9</target></trans-unit>`);
    const changedReport = analyzeXliffQuality(changed, { projectQualityIgnores: [ignore] });
    assert.equal(changedReport.issues.some(issue => issue.code === 'placeholder-mismatch'), false);
    assert.ok(changedReport.ignoredIssues.some(issue => issue.code === 'placeholder-mismatch'));
});


test('quality check detects repeated spaces in target but tolerates repeated spacing already present in source', () => {
    const parsed = parse(`
<trans-unit id="A"><source>Posting Date</source><target state="translated">Buchungs  datum</target></trans-unit>
<trans-unit id="B"><source>Keep  spacing</source><target state="translated">Abstand  behalten</target></trans-unit>`);
    const report = analyzeXliffQuality(parsed);
    assert.equal(report.issues.filter(issue => issue.code === 'repeated-whitespace').length, 1);
    assert.equal(report.issues.find(issue => issue.code === 'repeated-whitespace').id, 'A');
});

test('quality check detects placeholder order separately from missing placeholders', () => {
    const reordered = parse(`<trans-unit id="A"><source>Move %1 to %2</source><target state="translated">Verschiebe %2 nach %1</target></trans-unit>`);
    const reorderedReport = analyzeXliffQuality(reordered);
    assert.equal(reorderedReport.issues.some(issue => issue.code === 'placeholder-order'), false);
    assert.equal(reorderedReport.issues.some(issue => issue.code === 'placeholder-mismatch'), false);

    const missing = parse(`<trans-unit id="A"><source>Move %1 to %2</source><target state="translated">Verschiebe %1</target></trans-unit>`);
    const missingReport = analyzeXliffQuality(missing);
    assert.ok(missingReport.issues.some(issue => issue.code === 'placeholder-mismatch'));
    assert.equal(missingReport.issues.some(issue => issue.code === 'placeholder-order'), false);
});

test('quality check detects lost line breaks, backslashes and escape sequences as formatting errors', () => {
    const parsed = parse(String.raw`<trans-unit id="A"><source>Line 1\Line 2\n%1</source><target state="translated">Zeile 1 Zeile 2 %1</target></trans-unit>`);
    const report = analyzeXliffQuality(parsed);
    const issue = report.issues.find(item => item.code === 'formatting-sequence-mismatch');
    assert.ok(issue);
    assert.equal(issue.severity, 'error');
});


test('quality ignores C-style escape spellings in BC and retains real parameter checks', () => {
    const parsed = parse(String.raw`<trans-unit id="A"><source>Line 1\Line 2 %1</source><target state="translated">Zeile 1\nZeile 2 %1</target></trans-unit>
<trans-unit id="B"><source>Line 1\Line 2</source><target state="translated">Zeile 1\r\nZeile 2</target></trans-unit>
<trans-unit id="C"><source>Line %1\n</source><target state="translated">Zeile %2\r</target></trans-unit>`);
    const report = analyzeXliffQuality(parsed);
    assert.equal(report.issues.some(issue => issue.code === 'invalid-al-escape-sequence'), false);
    assert.equal(report.issues.some(issue => issue.code === 'formatting-sequence-mismatch'), false);
    assert.deepEqual(report.issues.filter(issue => issue.code === 'placeholder-mismatch').map(issue => issue.id), ['C']);
});

test('quality check detects an unusually strong translation length deviation conservatively', () => {
    const parsed = parse(`
<trans-unit id="A"><source>This is a reasonably long source caption</source><target state="translated">Kurz</target></trans-unit>
<trans-unit id="B"><source>Posting Date</source><target state="translated">Buchungsdatum</target></trans-unit>`);
    const report = analyzeXliffQuality(parsed);
    assert.equal(report.issues.filter(issue => issue.code === 'length-deviation').length, 1);
    assert.equal(report.issues.find(issue => issue.code === 'length-deviation').id, 'A');
});

test('punctuation comparison counts all visible final periods including abbreviations', () => {
    assert.equal(terminalPunctuation('Customer No.', { language: 'en-US' }), '.');
    assert.equal(terminalPunctuation('Debitor Nr.', { language: 'de-DE' }), '.');
    assert.equal(terminalPunctuation('z. B.', { language: 'de-DE' }), '.');
    assert.equal(terminalPunctuation('u. a.', { language: 'de-DE' }), '.');
    assert.equal(terminalPunctuation('U.S.', { language: 'en-US' }), '.');
    assert.equal(isPeriodAbbreviation('Debitor Nr.', 'de-DE'), true);

    const parsed = parse(`<trans-unit id="A"><source>Customer No.</source><target state="translated">Debitor Nr.</target></trans-unit>`);
    assert.equal(analyzeXliffQuality(parsed).issues.some(issue => issue.code === 'punctuation'), false);
});

test('Import Entry Line No accepts an abbreviation or expanded translation without a final period', () => {
    const parsed = parse(`<trans-unit id="A"><source>Import Entry Line No.</source><target state="translated">Importeintrag Zeilennr.</target></trans-unit>
<trans-unit id="B"><source>Import Entry Line No.</source><target state="translated">Importeintrag Zeilennummer</target></trans-unit>
<trans-unit id="C"><source>Import Entry Line No.</source><target state="translated">Importeintrag Zeilennummer!</target></trans-unit>
<trans-unit id="D"><source>Import completed.</source><target state="translated">Import abgeschlossen</target></trans-unit>`);
    const issues = analyzeXliffQuality(parsed).issues.filter(issue => issue.code === 'punctuation');
    assert.deepEqual(issues.map(issue => issue.id), ['C','D']);
});

test('single-letter designator before a final period is sentence punctuation, not an abbreviation', () => {
    assert.equal(terminalPunctuation('rMQR understøtter kun fejlkorrektionsniveauer M og H.', { language: 'da-DK' }), '.');
    assert.equal(isPeriodAbbreviation('rMQR understøtter kun fejlkorrektionsniveauer M og H.', 'da-DK'), false);

    const parsed = parse(`<trans-unit id="A"><source>rMQR supports error correction levels M and H only.</source><target state="translated">rMQR understøtter kun fejlkorrektionsniveauer M og H.</target></trans-unit>`);
    assert.equal(analyzeXliffQuality(parsed).issues.some(issue => issue.code === 'punctuation'), false);
});

test('punctuation check reports unexpected target punctuation as well as missing source punctuation', () => {
    const extra = parse(`<trans-unit id="A"><source>Posting Date</source><target state="translated">Buchungsdatum!</target></trans-unit>`);
    assert.ok(analyzeXliffQuality(extra).issues.some(issue => issue.code === 'punctuation'));
});

test('quality check detects NAB marker residues without flagging supported NAB review metadata', () => {
    const malformed = parse(`<trans-unit id="A"><source>Customer</source><target state="translated">Debitor [NAB: REVIEW]</target></trans-unit>`);
    assert.ok(analyzeXliffQuality(malformed).issues.some(issue => issue.code === 'nab-residue'));

    const supported = parse(`<trans-unit id="B"><source>Customer</source><target>[NAB: REVIEW]Debitor</target><note from="NAB AL Tools">Review this translation</note></trans-unit>`);
    assert.equal(analyzeXliffQuality(supported).issues.some(issue => issue.code === 'nab-residue'), false);

    const staleNote = parse(`<trans-unit id="C"><source>Customer</source><target state="translated">Debitor</target><note from="NAB AL Tools">Review this translation</note></trans-unit>`);
    assert.ok(analyzeXliffQuality(staleNote).issues.some(issue => issue.code === 'nab-residue'));
});

test('package exposes the expanded Quality Check categories as enabled settings', () => {
    const pkg = require('../package.json');
    const properties = pkg.contributes.configuration.properties;
    for (const key of [
        'alXliffStudio.quality.checkRepeatedWhitespace',
        'alXliffStudio.quality.checkPlaceholderOrder',
        'alXliffStudio.quality.checkFormattingSequences',
        'alXliffStudio.quality.checkLengthDeviation',
        'alXliffStudio.quality.checkNabResidues'
    ]) {
        assert.equal(properties[key].default, true, `${key} should default to true`);
    }
});

test('Developer Note warning compares exact local suggestions for the target language', () => {
 const row=(id,target,notes,attrs='')=>`<trans-unit id="${id}" ${attrs}><source>Customer</source><target state="translated">${target}</target>${notes}</trans-unit>`;
 const note=text=>`<note from="Developer">${text}</note>`;
 const parsed=parse(row('A','Debitor',note('DEU=Kunde'))+row('B','Kunde',note('DEU=Kunde'))+row('C','Debitor',note('FRA=Client'))+row('D','Debitor',note('DEU=Kunde')+note('DEU=Abnehmer'))+row('E','',note('DEU=Kunde'))+row('F','Debitor',note('DEU=Kunde'),'translate="no"')+row('G','kunde',note('DEU=Kunde')));
 const report=analyzeXliffQuality(parsed), findings=report.issues.filter(issue=>issue.code==='developer-comment-mismatch');
 assert.deepEqual(findings.map(issue=>issue.id),['A','G']);assert.ok(findings.every(issue=>issue.severity==='warning'));
 assert.match(findings[0].message,/Kunde/);
 assert.equal(analyzeXliffQuality(parsed,{checkDeveloperComment:false}).issues.some(issue=>issue.code==='developer-comment-mismatch'),false);
 const ignored=analyzeXliffQuality(parsed,{projectQualityIgnores:[projectQualityIgnoreFromIssue(findings[0],'de-DE')]});
 assert.ok(ignored.ignoredIssues.some(issue=>issue.code==='developer-comment-mismatch'));
});

test('Developer Note warning follows draft overrides, per-unit ignore and XML decoding', async () => {
 const {setQualityIssueIgnored}=require('../src/xliff');
 const body='<trans-unit id="A"><source>A &amp; B</source><target state="translated">Andere</target><note from="Developer">DEU=A &amp; B</note></trans-unit>';
 const parsed=parse(body), issue=analyzeXliffQuality(parsed).issues.find(issue=>issue.code==='developer-comment-mismatch');
 assert.ok(issue);
 const xml=`<xliff><file source-language="en-US" target-language="de-DE"><body>${body}</body></file></xliff>`;
 const ignored=setQualityIssueIgnored(xml,0,issue,true);
 assert.ok(analyzeXliffQuality(parseXliff(ignored.text)).ignoredIssues.some(issue=>issue.code==='developer-comment-mismatch'));
 const {runWorkerTask}=require('../src/xlfWorkerHost');
 const report=await runWorkerTask('qualityText',{text:xml,unitOverrides:[{ordinal:0,target:'A & B'}]});
 assert.equal(report.issues.some(issue=>issue.code==='developer-comment-mismatch'),false);
});

test('Developer Note QA includes leading and trailing spaces without changing Try resolution', () => {
 const {getDeveloperCommentTranslation,parseCommentTranslations}=require('../src/xliff');
 const parsed=parse('<trans-unit id="A"><source>Translation</source><target state="translated">Übersetzung</target><note from="Developer">DEU= Übersetzung </note></trans-unit>');
 const issue=analyzeXliffQuality(parsed).issues.find(issue=>issue.code==='developer-comment-mismatch');
 assert.ok(issue);assert.match(issue.message,/“ Übersetzung ”/);
 assert.equal(getDeveloperCommentTranslation(parsed.units[0],'de-DE').translation,'Übersetzung');
 parsed.units[0].target=' Übersetzung ';
 assert.equal(analyzeXliffQuality(parsed).issues.some(issue=>issue.code==='developer-comment-mismatch'),false);
 assert.equal(parseCommentTranslations('DEU= Text ;ENU= Text ',{preserveWhitespace:true}).get('DEU'),' Text ');
 assert.equal(parseCommentTranslations('DEU= Text ;ENU= Text ',{preserveWhitespace:true}).get('ENU'),' Text ');
});

test('Developer mismatch is first and suppresses shared-target until its suggestion is satisfied', () => {
 const parsed=parse('<trans-unit id="A"><source>Different first source.</source><target state="translated">Gemeinsame Übersetzung</target></trans-unit><trans-unit id="B"><source>Different second source.</source><target state="translated">Gemeinsame Übersetzung</target><note from="Developer">DEU=Andere Übersetzung</note></trans-unit>');
 let report=analyzeXliffQuality(parsed);
 assert.equal(report.issues[0].code,'developer-comment-mismatch');
 assert.equal(report.byOrdinal.get(1)[0].code,'developer-comment-mismatch');
 assert.equal(report.issues.some(issue=>issue.code==='shared-target'&&issue.ordinal===1),false);
 assert.ok(report.issues.some(issue=>issue.code==='shared-target'&&issue.ordinal===0));
 parsed.units[1].noteDetails[0].text='DEU=Gemeinsame Übersetzung';
 report=analyzeXliffQuality(parsed);
 assert.ok(report.issues.some(issue=>issue.code==='shared-target'&&issue.ordinal===1));
 parsed.units[1].noteDetails[0].text='DEU=Andere Übersetzung';
 assert.ok(analyzeXliffQuality(parsed,{checkDeveloperComment:false}).issues.some(issue=>issue.code==='shared-target'&&issue.ordinal===1));
});

test('Percent placeholders require each source number at least once, regardless of count or order', () => {
 const {placeholdersMatch}=require('../src/xliff');
 for(const [source,target,expected] of [['%1 %1','%1',true],['%1 %2 %3 %4','%4 %2 %1 %3',true],['%1','%10',false],['%1 %2','%1',false],['%1','%1 %1 %9',true],['Text','Text #1 {name}',true]]){
  assert.equal(placeholdersMatch(source,target),expected);
  const parsed={units:[{ordinal:0,source,target,targetState:'translated'}]};
  const report=analyzeXliffQuality(parsed);
  assert.equal(report.issues.some(issue=>issue.code==='placeholder-mismatch'),!expected);
  assert.equal(report.issues.some(issue=>issue.code==='placeholder-order'),false);
 }
});
