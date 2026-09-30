import {execFileSync,spawn} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,existsSync,createWriteStream,lstatSync,readlinkSync} from 'node:fs';
import {createHash} from 'node:crypto';
const cwd='/workspace/full-baseline-20260913',dir='/workspace/f5-repair-target-logs';
const label=process.argv[2];
const env={PATH:'/workspace/home/bin:'+process.env.PATH,HOME:'/workspace/home',COREPACK_HOME:'/workspace/home/corepack',XDG_CACHE_HOME:'/workspace/home/cache',CI:'true',LANG:'C.UTF-8',AOA_HOME:'/workspace/home/aoa-full-baseline-20260913'};
const unit=['corepack','pnpm','exec','vitest','run','packages/db/src/__tests__/backup-fixture.test.ts'];
const cmds={red:unit,green:unit,negativeWaitReviewed:unit,finalReviewed:unit,typecheckReviewed:['corepack','pnpm','--filter','@armyofagents/db','typecheck'],negativeActive:unit,negativeWait:unit,finalUnit:unit,typecheck:['corepack','pnpm','--filter','@armyofagents/db','typecheck'],integration:['corepack','pnpm','exec','vitest','run','packages/db/src/__tests__/backup-lib-non-system-schemas.test.ts','server/src/__tests__/blocked-task-fixture.test.ts']};
if(!cmds[label])throw Error('Unknown command');
mkdirSync(dir,{recursive:true});
if(existsSync(dir+'/'+label+'.json')||existsSync(dir+'/'+label+'.log'))throw Error('Repeated command');
const hash=b=>createHash('sha256').update(b).digest('hex');
const sha=execFileSync('git',['rev-parse','HEAD'],{cwd,encoding:'utf8'}).trim();
if(sha!=='4aebfa0f4aaf011cfd85347246c18d3cbde305ba')throw Error('Unexpected input');
const names=execFileSync('git',['ls-files','-z','--cached','--others','--exclude-standard'],{cwd,encoding:'utf8'}).split('\0').filter(Boolean).sort();
function snapshot(){return Object.fromEntries(names.map(p=>{const f=cwd+'/'+p,s=lstatSync(f).isSymbolicLink();return [p,s?{type:'symlink',value:readlinkSync(f)}:{type:'file',value:hash(readFileSync(f))}];}));}
const before=snapshot();
const pristine=JSON.parse(readFileSync('/workspace/full-baseline-20260913-logs/pristine.json'));
const allowed=['packages/db/src/__tests__/backup-fixture.test.ts','packages/db/src/__tests__/helpers/backup-fixture.ts','packages/db/src/__tests__/backup-lib-non-system-schemas.test.ts'];
for(const p of new Set([...Object.keys(pristine),...names]))if(!allowed.includes(p)&&JSON.stringify(before[p])!==JSON.stringify(pristine[p]))throw Error('Unexpected source drift '+p);
const startFile=dir+'/start.json';
if(!existsSync(startFile)){
 execFileSync('node',['--import','tsx','--input-type=module','-e',"await import('./packages/plugins/sdk/dist/index.js'); await import('./packages/plugins/sdk/dist/testing.js')"],{cwd,env,timeout:60000});
 writeFileSync(startFile,JSON.stringify({at:Date.now(),sha,sdkExports:true,runnerHash:hash(readFileSync('/workspace/f5-target-run.mjs'))}));
}
const deadline=JSON.parse(readFileSync(startFile)).at+600000;
if(deadline<Date.now())throw Error('Targeted batch budget exhausted');
const cmd=[...cmds[label]];
if(!label.startsWith('typecheck'))cmd.push('--reporter=default','--reporter=json','--outputFile.json='+dir+'/'+label+'-tests.json');
const rec={label,sha,runnerHash:hash(readFileSync('/workspace/f5-target-run.mjs')),command:cmd,startedAt:new Date().toISOString(),beforeHashes:Object.fromEntries(allowed.filter(p=>before[p]).map(p=>[p,before[p]]))};
const log=createWriteStream(dir+'/'+label+'.log');
const result=await new Promise(resolve=>{
 const c=spawn(cmd[0],cmd.slice(1),{cwd,env,detached:true,stdio:['ignore','pipe','pipe']});
 c.stdout.pipe(log,{end:false});c.stderr.pipe(log,{end:false});let timeout=false;
 const timer=setTimeout(()=>{timeout=true;try{process.kill(-c.pid,'SIGKILL');}catch{}},Math.min(deadline-Date.now(),180000));
 c.once('error',e=>{clearTimeout(timer);resolve({code:null,error:e.message,timeout});});
 c.once('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal,timeout});});
});
await new Promise(resolve=>log.end(resolve));
const after=snapshot();
Object.assign(rec,result,{endedAt:new Date().toISOString(),changed:names.filter(p=>JSON.stringify(before[p])!==JSON.stringify(after[p]))});
if(existsSync(dir+'/'+label+'-tests.json')){
 const j=JSON.parse(readFileSync(dir+'/'+label+'-tests.json'));
 rec.tests={total:j.numTotalTests,passed:j.numPassedTests,failed:j.numFailedTests,pending:j.numPendingTests,success:j.success};
}
const out=readFileSync(dir+'/'+label+'.log','utf8');
rec.unhandled=/Vitest caught \d+ unhandled|[⎯━]{3,} Unhandled|FATAL ERROR:/.test(out);
rec.expectedRed=['red','negativeActive','negativeWait','negativeWaitReviewed'].includes(label);
rec.accepted=!rec.timeout&&!rec.signal&&!rec.error&&!rec.unhandled&&!rec.changed.length&&(rec.expectedRed?rec.code===1:rec.code===0);
writeFileSync(dir+'/'+label+'.json',JSON.stringify(rec,null,2));console.log(JSON.stringify(rec));process.exitCode=rec.accepted?0:1;
