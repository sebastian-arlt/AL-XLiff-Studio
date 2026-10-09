'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {createEditorHarness}=require('../tools/editor-harness.cjs');
const {parseXliff,getStagedTranslation}=require('../src/xliff');
const text='<xliff><file source-language="en-US" target-language="de-DE"><body><trans-unit id="a"><source>Customer</source><target/></trans-unit><trans-unit id="b"><source>Order</source><target/></trans-unit></body></file></xliff>';
test('volatile AI proposal moves to draft, applies, saves and reloads without resurrection',async()=>{
 const h=await createEditorHarness({root:fs.mkdtempSync(path.join(os.tmpdir(),'xliff-stage-')),text});
 try {
 await h.send({type:'ready'});
 await h.send({type:'proposalChanged',ordinal:0,text:'Debitor',origin:'AI'});
 await h.send({type:'acceptMany',items:[{ordinal:0,translation:'Debitor',origin:'AI'}]});
 await h.send({type:'ready'});
 assert.equal(h.last('document').rowStateIndex[0].hasProposal,undefined);
 assert.equal(getStagedTranslation(parseXliff(h.document.getText()).units[0]).kind,'draft');
 await h.send({type:'saveManyDrafts',items:[{ordinal:0,translation:'Debitor',source:'Customer'}]});
 let u=parseXliff(h.document.getText()).units;assert.equal(u[0].target,'Debitor');assert.equal(getStagedTranslation(u[0]),undefined);assert.equal(u[1].target,'');
 await h.send({type:'saveDocument',items:[]});await h.send({type:'ready'});
 u=parseXliff(h.document.getText()).units;assert.equal(u[0].target,'Debitor');assert.equal(getStagedTranslation(u[0]),undefined);
 }finally{h.close();}
});
test('bulk apply acknowledgement updates cached paging state, not only visible controls',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../src/xlfEditor.js'),'utf8');
 const start=source.indexOf("  } else if (message.type === 'draftsSaved') {");const end=source.indexOf('    if (message.qualityReport)',start);
 const body=source.slice(start+"  } else if (message.type === 'draftsSaved') {".length,end);
 const row={ordinal:0,translation:'Debitor',savedTranslation:'',translationDirty:true,hasTranslationDraft:true,proposal:''};let override;
 vm.runInNewContext(body,{message:{items:[{ordinal:0,translation:'Debitor',canUndoApply:true}]},applyDraftsBusy:true,applyDraftsOverlayVisible:false,dirtyOrdinals:new Set([0]),proposalOrdinals:new Set(),appliedUndoOrdinals:new Set(),pageRowCache:new Map([[0,row]]),updateInlineValidation(){},updateRowControls(){},syncIndexFromFullRow(r){override={...r};},mergePartialRowOverride(){throw Error('unexpected');}});
 assert.equal(override.translationDirty,false);assert.equal(override.savedTranslation,'Debitor');assert.equal(override.proposal,'');assert.equal(override.appliedUndo,true);
});

test('applied memory drafts can be undone until Save and restore editable drafts',async()=>{
 const h=await createEditorHarness({root:fs.mkdtempSync(path.join(os.tmpdir(),'xliff-undo-')),text});
 try {
 await h.send({type:'ready'});await h.send({type:'saveManyDrafts',items:[{ordinal:0,translation:'Debitor'}]});
 await h.send({type:'revertAppliedTranslation',ordinal:0});
 let u=parseXliff(h.document.getText()).units[0];assert.equal(u.target,'');assert.equal(getStagedTranslation(u).kind,'draft');assert.equal(getStagedTranslation(u).text,'Debitor');
 await h.send({type:'saveManyDrafts',items:[{ordinal:0,translation:'Debitor'}]});await h.send({type:'saveDocument',items:[]});
 await h.send({type:'revertAppliedTranslation',ordinal:0});assert.equal(parseXliff(h.document.getText()).units[0].target,'Debitor');
 }finally{h.close();}
});

test('late blur from an applied bulk draft does not restage the translation',async()=>{
 const h=await createEditorHarness({root:fs.mkdtempSync(path.join(os.tmpdir(),'xliff-blur-')),text});
 try{await h.send({type:'ready'});await h.send({type:'saveManyDrafts',items:[{ordinal:0,translation:'Debitor',revision:4}]});
 await h.send({type:'translationDraftChanged',ordinal:0,hasDraft:true,text:'Debitor',revision:4});await h.send({type:'ready'});
 assert.equal(h.last('document').rowStateIndex.some(row=>row.hasTranslationDraft||row.hasProposal),false);
 await h.send({type:'translationDraftChanged',ordinal:0,hasDraft:true,text:'Kunde',revision:5});await h.send({type:'ready'});
 assert.equal(h.last('document').rowStateIndex[0].hasTranslationDraft,true);
 }finally{h.close();}
});
test('Discard is enabled only for unapplied drafts',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../src/xlfEditor.js'),'utf8');const line=source.split('\n').find(line=>line.includes('discardDraftsButton.disabled ='));
 for(const [count,busy,readOnly,expected] of [[0,false,false,true],[1,false,false,false],[1,true,false,true],[1,false,true,true]]){
 const context={discardDraftsButton:{},model:{readOnly},applyDraftsBusy:busy,drafts:count,appliedUndoOrdinals:new Set(),busyApplyRows:new Set()};vm.runInNewContext(line,context);assert.equal(context.discardDraftsButton.disabled,expected);
 }
});

test('Discard persists drafts as proposals, preserves targets and survives Save and reload',async()=>{
 const h=await createEditorHarness({root:fs.mkdtempSync(path.join(os.tmpdir(),'xliff-to-proposal-')),text});
 try{await h.send({type:'ready'});
 await h.send({type:'translationDraftChanged',ordinal:0,hasDraft:true,text:'Debitor',origin:'Translation Memory',revision:1});
 await h.send({type:'draftsToProposals',items:[{ordinal:0,source:'Customer',translation:'Debitor',origin:'Translation Memory'}]});
 let unit=parseXliff(h.document.getText()).units[0];assert.equal(unit.target,'');assert.equal(getStagedTranslation(unit).kind,'proposal');assert.equal(getStagedTranslation(unit).text,'Debitor');
 await h.send({type:'saveDocument',items:[{ordinal:0,kind:'proposal',translation:'Debitor',origin:'Translation Memory'}]});await h.send({type:'ready'});
 assert.equal(h.last('document').rowStateIndex[0].hasProposal,true);assert.equal(h.last('document').rowStateIndex[0].hasTranslationDraft,undefined);
 assert.equal(parseXliff(h.document.getText()).units[1].target,'');
 await h.send({type:'acceptMany',items:[{ordinal:0,translation:'Debitor'}]});await h.send({type:'saveManyDrafts',items:[{ordinal:0,translation:'Debitor'}]});
 assert.equal(parseXliff(h.document.getText()).units[0].target,'Debitor');
 }finally{h.close();}
});
test('single-row and bulk Discard use shared conversion and retain draft metadata',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../src/xlfEditor.js'),'utf8');const start=source.indexOf('function moveDraftsToProposals(rows) {');const end=source.indexOf('function ensureNoDrafts',start);const messages=[];
 const row={ordinal:0,source:'Customer',translation:'Debitor',savedTranslation:'Kunde',translationDirty:true,translationDraftProvenance:{origin:'ai'},translationDraftOrigin:'AI'};
 const other={ordinal:1,translation:'Auftrag',savedTranslation:'Auftrag',translationDirty:false};
 const context={pageRowCache:new Map([[0,row],[1,other]]),cancelStagePersistence(){},syncIndexFromFullRow(){},mergePartialRowOverride(){},render(){},vscode:{postMessage(m){messages.push(m);}}};
 vm.runInNewContext(source.slice(start,end),context);context.moveDraftsToProposals([row,other]);
 assert.equal(row.translation,'Debitor');assert.equal(row.translationDirty,true);assert.equal(other.proposal,undefined);assert.equal(messages[0].items.length,1);assert.equal(messages[0].items[0].translation,'Debitor');assert.equal(messages[0].items[0].provenance.origin,'ai');
});
