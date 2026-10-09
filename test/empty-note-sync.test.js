'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {synchronizeNotesByFrom}=require('../src/synchronize');
const unit=notes=>`<trans-unit id="A"><source>Text</source><target>Text</target>${notes}</trans-unit>`;
test('an empty self-closing Note never swallows the following Note',()=>{
 const {parseXliff}=require('../src/xliff');
 const parsed=parseXliff('<xliff><file>'+unit('<note from="Developer"/><note from="Other">Keep</note>')+'</file></xliff>');
 assert.deepEqual(parsed.units[0].noteDetails.map(note=>[note.from,note.text]),[['Other','Keep']]);
});
test('empty Note spelling stays unchanged in both directions without a false Sync difference',()=>{
 const short='<note from="Developer" annotates="general" priority="2"/>';
 const long='<note from="Developer" annotates="general" priority="2"></note>';
 for(const [current,desired] of [[short,long],[long,short],[short.replace('/>',' />'),long]]){
  const raw=unit(current+'<note from="Other">Keep</note>');
  const result=synchronizeNotesByFrom(raw,unit(desired),'Developer');
  assert.equal(result.changed,false);assert.equal(result.text,raw);
 }
});

test('full Sync and worker retain current empty Note spelling across repeated runs',async()=>{
 const {synchronizeTranslationUnits}=require('../src/synchronize');
 const {runWorkerTask}=require('../src/xlfWorkerHost');
 const wrap=raw=>`<xliff><file source-language="en-US" target-language="de-DE"><body>\n${raw}\n</body></file></xliff>`;
 for(const closing of ['/>','></note>']){
  const current=wrap(unit(`<note from="Developer" priority="2"${closing}<note from="Other">Keep</note>`));
  const generator=wrap(unit('<note from="Developer" priority="2"></note>'));
  const expected=synchronizeTranslationUnits(current,generator);
  assert.ok(expected.text.includes(`<note from="Developer" priority="2"${closing}`));
  assert.equal(expected.synchronizedDeveloperNotes,0);
  assert.equal(synchronizeTranslationUnits(expected.text,generator).text,expected.text);
  const threaded=await runWorkerTask('sync',{targetText:current,sourceText:generator,includeMemory:false});
  assert.deepEqual(threaded,expected);
 }
});
test('real Note edits retain empty Note spelling and do not consume adjacent unrelated Notes',()=>{
 for(const closing of ['/>','></note>']){
  const current=`<note from="Developer" priority="2"${closing}`;
  const result=synchronizeNotesByFrom(unit(current+'<note from="Other">Keep</note><note from="Developer">Old</note>'),unit('<note from="Developer" priority="3"></note><note from="Developer">New</note>'),'Developer');
  assert.ok(result.text.includes(`<note from="Developer" priority="3"${closing}`));
  assert.ok(result.text.includes('<note from="Other">Keep</note>'));assert.ok(result.text.includes('>New</note>'));
  assert.equal(synchronizeNotesByFrom(result.text,unit('<note from="Developer" priority="3"></note><note from="Developer">New</note>'),'Developer').changed,false);
 }
});


test('Sync updates notes in place around Studio and other notes and matches worker results', async () => {
 const {synchronizeTranslationUnits}=require('../src/synchronize');
 const {runWorkerTask}=require('../src/xlfWorkerHost');
 const wrap=raw=>'<xliff><file source-language="en-US" target-language="de-DE"><body>'+raw+'</body></file></xliff>';
 for(const notes of [
  '<note from="Developer">Old</note><note from="Other">Keep</note><note from="Xliff Generator">Old context</note><note from="AL.XliffStudio">History</note>',
  '<note from="AL.XliffStudio">History</note><note from="Xliff Generator">Old context</note><note from="Other">Keep</note><note from="Developer">Old</note>'
 ]) {
  const current=wrap(unit(notes));
  const generator=wrap(unit('<note from="Xliff Generator">New context</note><note from="Developer">New</note>'));
  const expected=current.replace('>Old</note>','>New</note>').replace('>Old context</note>','>New context</note>');
  const result=synchronizeTranslationUnits(current,generator);
  const {parseXliff,getUnitRaw}=require('../src/xliff');
  assert.equal(getUnitRaw(result.text,parseXliff(result.text).units[0]),getUnitRaw(expected,parseXliff(expected).units[0]));
  assert.equal(synchronizeTranslationUnits(result.text,generator).text,result.text);
  assert.deepEqual(await runWorkerTask('sync',{targetText:current,sourceText:generator,includeMemory:false}),result);
 }
});

test('reordering matching notes in the generator does not reorder existing notes', () => {
 const current=unit('<note from="Developer">First</note><note from="Other">Keep</note><note from="Developer">Second</note>');
 const result=synchronizeNotesByFrom(current,unit('<note from="Developer">Second</note><note from="Developer">First</note>'),'Developer');
 assert.equal(result.text,current); assert.equal(result.changed,false);
 const changed=synchronizeNotesByFrom(current,unit('<note from="Developer">Second</note><note from="Developer">Changed</note>'),'Developer');
 assert.equal(changed.text,current.replace('>First</note>','>Changed</note>'));
});

test('multiple note additions and removals preserve surrounding notes and CRLF', () => {
 const current='<trans-unit id="A">\r\n  <source>Text</source>\r\n  <note from="Developer">Old</note>\r\n  <note from="Other">Keep</note>\r\n</trans-unit>';
 const desired=unit('<note from="Developer">New</note><note from="Developer">Second</note>');
 const updated=synchronizeNotesByFrom(current,desired,'Developer').text;
 assert.equal(updated,current.replace('<note from="Developer">Old</note>','<note from="Developer">New</note>\r\n  <note from="Developer">Second</note>'));
 const reduced=synchronizeNotesByFrom(updated,unit('<note from="Developer">Second</note>'),'Developer').text;
 assert.ok(!reduced.includes('>New</note>'));
 assert.ok(reduced.indexOf('>Second</note>')<reduced.indexOf('from="Other"'));
 assert.equal(synchronizeNotesByFrom(reduced,unit('<note from="Developer">Second</note>'),'Developer').changed,false);
});
