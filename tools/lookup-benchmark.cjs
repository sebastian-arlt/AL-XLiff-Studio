'use strict';
const {performance}=require('node:perf_hooks'),fs=require('node:fs');
const {parseXliffOffThread}=require('../src/xlfWorkerHost');
const {getUnitIndex}=require('../src/unitIndex');
async function benchmark(file,output){
 const parsed=await parseXliffOffThread(fs.readFileSync(file,'utf8'));
 const queries=Array.from({length:500},(_,i)=>parsed.units[Math.floor(i*(parsed.units.length-1)/499)]);
 const start=performance.now();let checksum=0;
 for(const unit of queries)checksum+=parsed.units.find(candidate=>candidate.id===unit.id).ordinal;
 const linearMs=performance.now()-start,buildStart=performance.now(),index=getUnitIndex(parsed),buildMs=performance.now()-buildStart;
 const lookupStart=performance.now();let indexedChecksum=0;
 for(const unit of queries)indexedChecksum+=index.byId.get(String(unit.id))[0].ordinal;
 const indexedMs=performance.now()-lookupStart;
 if(checksum!==indexedChecksum)throw new Error('Lookup behavior changed');
 const result={units:parsed.units.length,queries:queries.length,linearMs,buildMs,indexedMs,checksum};
 fs.writeFileSync(output,JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}
if(require.main===module)benchmark(process.argv[2],process.argv[3]).catch(e=>{console.error(e);process.exitCode=1;});
module.exports={benchmark};
