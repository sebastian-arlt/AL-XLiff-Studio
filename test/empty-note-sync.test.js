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
