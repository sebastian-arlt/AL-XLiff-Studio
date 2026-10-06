'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {compareRuns,assessTier,tiers}=require('../tools/scaling-matrix.cjs');
const report=(elapsed,stall,rss)=>({measurements:[{name:'Apply',elapsedMs:elapsed,heartbeatMaxStallMs:stall,peak:{rssMB:rss}}],transfers:[]});
test('scaling budgets catch runtime, RAM, transfer and relative regressions',()=>{
 assert.equal(assessTier(report(100,50,100),tiers[0]).length,0);
 assert.equal(assessTier(report(8000,1001,1100),tiers[0]).length,3);
 assert.equal(compareRuns(report(100,100,100),report(500,300,500)).length,3);
 assert.deepEqual(compareRuns(report(100,100,100),report(120,120,120)),[]);
 const oversized=report(100,50,100);oversized.transfers=[{type:'qualityPage',bytes:600000}];
 assert.equal(assessTier(oversized,tiers[0]).length,1);
});
