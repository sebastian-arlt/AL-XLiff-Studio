'use strict';
const fs=require('node:fs'), path=require('node:path'), {spawnSync}=require('node:child_process');
const tiers=[{mb:5,units:10000,rss:1024,elapsed:7000},{mb:15,units:30000,rss:1536,elapsed:12000},{mb:30,units:60000,rss:2560,elapsed:20000}];
function compareRuns(before,after) {
 const failures=[];
 for(const current of after.measurements){
  const previous=before.measurements.find(item=>item.name===current.name);
  if(!previous)continue;
  if(current.elapsedMs>previous.elapsedMs*1.4+100)failures.push(current.name+': elapsed regression');
  if(current.heartbeatMaxStallMs>previous.heartbeatMaxStallMs*1.5+50)failures.push(current.name+': stall regression');
  if(current.peak.rssMB>previous.peak.rssMB*1.35+128)failures.push(current.name+': RSS regression');
 }
 return failures;
}
function assessTier(report,tier){
 const failures=[];
 for(const m of report.measurements){
  if(m.elapsedMs>tier.elapsed)failures.push(m.name+': elapsed budget');
  if(m.peak.rssMB>tier.rss)failures.push(m.name+': RSS budget');
  if(m.heartbeatMaxStallMs>1000)failures.push(m.name+': host stall budget');
 }
 for(const t of report.transfers||[]){
  if(t.type==='viewPage'&&t.bytes>2*1024*1024)failures.push('translation page transfer budget');
  if(t.type==='qualityPage'&&t.bytes>512*1024)failures.push('quality page transfer budget');
 }
 return failures;
}
function runMatrix(output,baselinePath){
 const root=path.resolve(output);fs.mkdirSync(root,{recursive:true});
 const result={version:require('../package.json').version,tiers,runs:[],failures:[],relativeBudgets:{elapsedMultiplier:1.4,elapsedAllowanceMs:100,stallMultiplier:1.5,stallAllowanceMs:50,rssMultiplier:1.35,rssAllowanceMB:128},scope:'Two sequential fresh Node processes per size; actual host handlers and workers with VS Code adapter.'};
 const baseline=baselinePath?JSON.parse(fs.readFileSync(baselinePath,'utf8')):null;
 for(const tier of tiers){
  for(let repeat=1;repeat<=2;repeat++){
   const directory=path.join(root,`${tier.mb}mb-run${repeat}`);
   console.log(`Starting ${tier.mb} MB / ${tier.units} units, run ${repeat}`);
   const child=spawnSync(process.execPath,[path.join(__dirname,'large-xlf-stress.cjs'),`--output=${directory}`,`--units=${tier.units}`,`--bytes=${tier.mb*1024*1024}`,`--max-rss-mb=${tier.rss}`],{encoding:'utf8',timeout:180000});
   fs.writeFileSync(path.join(root,`${tier.mb}mb-run${repeat}.log`),(child.stdout||'')+(child.stderr||''));
   const reportPath=path.join(directory,'stress-report.json');
   if(!fs.existsSync(reportPath)){result.failures.push(`${tier.mb}mb/run${repeat}: ${child.error||'scenario failed'}`);continue;}
   const report=JSON.parse(fs.readFileSync(reportPath,'utf8'));
   const run={mb:tier.mb,repeat,report};result.runs.push(run);
   result.failures.push(...assessTier(report,tier).map(f=>`${tier.mb}mb/run${repeat}: ${f}`));
   if(child.status!==0)result.failures.push(`${tier.mb}mb/run${repeat}: phase budgets failed`);
   const reference=baseline?.runs.find(r=>r.mb===tier.mb&&r.repeat===repeat) || (repeat===2?result.runs.find(r=>r.mb===tier.mb&&r.repeat===1):null);
   if(reference)result.failures.push(...compareRuns(reference.report,report).map(f=>`${tier.mb}mb/run${repeat}: ${f}`));
  }
 }
 fs.writeFileSync(path.join(root,'matrix-report.json'),JSON.stringify(result,null,2));
 if(result.failures.length)throw new Error(result.failures.join('\n'));
 return result;
}
if(require.main===module){const args=Object.fromEntries(process.argv.slice(2).map(a=>a.replace(/^--/,'').split('=')));try{runMatrix(args.output||'artifacts/scaling-matrix',args.baseline);}catch(error){console.error(error);process.exitCode=1;}}
module.exports={tiers,compareRuns,assessTier,runMatrix};
