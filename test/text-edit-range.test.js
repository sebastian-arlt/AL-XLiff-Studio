'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {changedTextRange}=require('../src/textEditRange');
test('chunked text edits preserve minimal insertion/removal/replacement ranges and yield on large files',async()=>{
 for(const [oldText,newText] of [['abc','abxc'],['abxc','abc'],['abc','axc'],['','x'],['x',''],['same','same']]){
  const range=await changedTextRange(oldText,newText);
  assert.equal(oldText.slice(0,range.prefix)+newText.slice(range.prefix,range.newEnd)+oldText.slice(range.oldEnd),newText);
 }
 const tail='x'.repeat(4*1024*1024);let yields=0;
 const range=await changedTextRange('A'+tail,'B'+tail,{yieldWork:async()=>{yields++;}});
 assert.ok(yields>=16);assert.deepEqual(range,{prefix:0,oldEnd:1,newEnd:1});
});
