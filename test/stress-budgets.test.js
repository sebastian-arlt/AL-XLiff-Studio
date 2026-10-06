'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const {assessStressBudgets}=require('../tools/stress-budgets.cjs');
test('section-one budgets reject the former one-second Sync stall while retaining later-section warnings',()=>{
    const sample=(name,stall)=>({name,heartbeatMaxStallMs:stall,peak:{rssMB:1000}});
    const result=assessStressBudgets([sample('Sync + companion translation memory',969),sample('Apply draft + background maintenance',335),sample('Quality paging + query cache',101)]);
    assert.deepEqual(result.exceeded,['Sync + companion translation memory','Apply draft + background maintenance','Quality paging + query cache']);
    assert.ok(result.ui100msCandidates.includes('Apply draft + background maintenance'));
    assert.deepEqual(assessStressBudgets([sample('Sync + companion translation memory',105)]).exceeded,[]);
});
