'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createEditorHarness, generateLargeXliff} = require('../tools/editor-harness.cjs');
const {observeWorkers} = require('../src/xlfWorkerHost');

test('document change cancels Apply without overwriting edits or leaving bulk progress busy', async () => {
 const text=generateLargeXliff(1000,0);
 const h=await createEditorHarness({root:fs.mkdtempSync(path.join(os.tmpdir(),'xliff-apply-cancel-')),text,configuration:{'performance.workerThreads.minUnits':1000}});
 const events=[];
 const stop=observeWorkers(event=>{events.push(event);if(event.task==='apply'&&event.event==='started')h.externalChange(text+'\n<!--external edit-->');});
 try {
  await h.send({type:'ready'});
  await h.send({type:'saveManyDrafts',items:Array.from({length:20},(_,ordinal)=>({ordinal,translation:'Neu %1.'}))});
  assert.equal(h.document.getText(),text+'\n<!--external edit-->');
  assert.equal(h.last('draftsSaved').items.length,0);
  assert.ok(h.last('applyDraftsProgressDone'));
  assert.ok(events.some(event=>event.task==='apply'&&event.outcome==='cancelled'));
 } finally {stop();h.close();}
});

test('Apply rejects a document changed during asynchronous edit-range preparation', async () => {
 const rangeModule=require('../src/textEditRange'), original=rangeModule.changedTextRange;
 const Module=require('node:module'), originalLoad=Module._load;
 const text=generateLargeXliff(3,0);let h, change=false;
 rangeModule.changedTextRange=async(...args)=>{const result=await original(...args);if(change)h.externalChange(text+'\n<!--range preparation edit-->');return result;};
 delete require.cache[require.resolve('../src/xlfEditor')];
 Module._load=function(request,parent,isMain){return request==='./textEditRange'?rangeModule:originalLoad.call(this,request,parent,isMain);};
 try {
  h=await createEditorHarness({root:fs.mkdtempSync(path.join(os.tmpdir(),'xliff-apply-range-')),text});
  await h.send({type:'ready'});change=true;
  await h.send({type:'saveManyDrafts',items:[{ordinal:0,translation:'Neu %1.'}]});
  assert.equal(h.document.getText(),text+'\n<!--range preparation edit-->');
  assert.equal(h.last('draftsSaved').items.length,0);
 } finally {Module._load=originalLoad;rangeModule.changedTextRange=original;if(h)h.close();}
});
