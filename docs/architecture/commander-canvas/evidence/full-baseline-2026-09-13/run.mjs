import {spawn,execFileSync} from 'node:child_process';
import {createWriteStream,readFileSync,writeFileSync,mkdirSync,existsSync,lstatSync,readlinkSync} from 'node:fs';
import {createHash} from 'node:crypto';
const cwd='/workspace/full-baseline-20260913',dir='/workspace/full-baseline-20260913-logs';
const expectedSha='4aebfa0f4aaf011cfd85347246c18d3cbde305ba';
mkdirSync(dir,{recursive:true});
const label=process.argv[2];
const builds=['worker-protocol','sandbox-fake-provider','worker-daemon','sandbox-provider-contract','sandbox-e2b-provider','plugin-sdk'];
const commands={install:['corepack','pnpm','install','--offline','--frozen-lockfile'],...Object.fromEntries(builds.map((n,i)=>['build'+i,['corepack','pnpm','--filter','@armyofagents/'+n,'build']])),exports:['node','--import','tsx','--input-type=module','-e',"await import('./packages/plugins/sdk/dist/index.js'); await import('./packages/plugins/sdk/dist/testing.js')"],typecheck:['corepack','pnpm','-r','typecheck'],...Object.fromEntries([1,2,3,4].map(n=>['shard'+n,['corepack','pnpm','exec','vitest','run','--shard='+n+'/4','--reporter=default','--reporter=json','--outputFile.json='+dir+'/shard'+n+'-tests.json']])),build:['corepack','pnpm','build']};
const order=Object.keys(commands),index=order.indexOf(label);
if(index<0||existsSync(dir+'/'+label+'.json')||existsSync(dir+'/'+label+'.log'))throw Error('Unknown/repeated label');
const args=commands[label],phase=index<=7?'setup':'verification';
const phaseFile=dir+'/'+phase+'-start.json';
if(!existsSync(phaseFile))writeFileSync(phaseFile,JSON.stringify(Date.now()));
const deadline=Math.min(JSON.parse(readFileSync(phaseFile))+(phase==='setup'?900000:9000000),Date.now()+1800000);
const sha=execFileSync('git',['rev-parse','HEAD'],{cwd,encoding:'utf8'}).trim();
if(sha!==expectedSha)throw Error('Wrong source');
if(execFileSync('git',['status','--porcelain'],{cwd,encoding:'utf8'}).trim())throw Error('Source not clean');
const names=execFileSync('git',['ls-files','-z'],{cwd,encoding:'utf8'}).split('\0').filter(Boolean).sort();
function snapshot(){return Object.fromEntries(names.map(p=>{const f=cwd+'/'+p,s=lstatSync(f).isSymbolicLink();return [p,{type:s?'symlink':'file',value:s?readlinkSync(f):createHash('sha256').update(readFileSync(f)).digest('hex')}];}));}
const before=snapshot(),pristine=dir+'/pristine.json';
if(!existsSync(pristine)){if(label!=='install')throw Error('Missing pristine');writeFileSync(pristine,JSON.stringify(before));}
if(JSON.stringify(before)!==readFileSync(pristine,'utf8'))throw Error('Source drift');
const previous=order.slice(0,index).map(x=>JSON.parse(readFileSync(dir+'/'+x+'.json')));
for(const r of previous){if(r.sha!==sha||r.timeout||r.signal||r.error||r.changed.length||!r.safeToContinue)throw Error('Failed/unsafe prerequisite '+r.label);if((!label.startsWith('shard')||!r.label.startsWith('shard'))&&!r.accepted)throw Error('Failed prerequisite '+r.label);}
if(JSON.parse(readFileSync(cwd+'/packages/plugins/sdk/package.json')).name!=='@armyofagents/plugin-sdk')throw Error('SDK identity mismatch');
if(Date.now()>=deadline)throw Error('Deadline exhausted');
writeFileSync(dir+'/'+label+'-before.json',JSON.stringify(before));
const start=Date.now(),log=createWriteStream(dir+'/'+label+'.log');
const rec={label,sha,command:args,cwd,startedAt:new Date().toISOString()};log.write(JSON.stringify(rec)+'\n');
const r=await new Promise(resolve=>{let settled=false;const child=spawn(args[0],args.slice(1),{cwd,detached:true,env:{PATH:'/workspace/home/bin:'+process.env.PATH,HOME:'/workspace/home',COREPACK_HOME:'/workspace/home/corepack',XDG_CACHE_HOME:'/workspace/home/cache',CI:'true',LANG:'C.UTF-8',AOA_HOME:'/workspace/home/aoa-full-baseline-20260913'},stdio:['ignore','pipe','pipe']});child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});let timeout=false;const timer=setTimeout(()=>{timeout=true;try{process.kill(-child.pid,'SIGKILL');}catch{}},deadline-Date.now());child.on('error',error=>{if(!settled){settled=true;clearTimeout(timer);resolve({code:null,signal:null,timeout,error:error.message});}});child.on('close',(code,signal)=>{if(!settled){settled=true;clearTimeout(timer);resolve({code,signal,timeout});}});});
const after=snapshot(),changed=names.filter(p=>JSON.stringify(before[p])!==JSON.stringify(after[p]));
if(execFileSync('git',['status','--porcelain'],{cwd,encoding:'utf8'}).trim())changed.push('git-status-dirty');
Object.assign(rec,r,{elapsedSeconds:(Date.now()-start)/1000,changed});
await new Promise(resolve=>log.end('\nRESULT '+JSON.stringify(rec)+'\n',resolve));
const output=readFileSync(dir+'/'+label+'.log','utf8');
// Expected fault-test console messages are not runner failures. Only inspect
// Vitest's failure summary plus explicit process/unhandled-error diagnostics.
const failureStart=[output.indexOf('Failed Tests'),output.indexOf('Failed Suites')].filter(n=>n>=0);
const failureSummary=failureStart.length?output.slice(Math.min(...failureStart)):'';
const unhandled=/Vitest caught \d+ unhandled|[⎯━]{3,} Unhandled|FATAL ERROR:|ERR_WORKER_OUT_OF_MEMORY/.test(output)||/Hook timed out|Test timed out|Failed to load url|Cannot find module|EADDRINUSE/.test(failureSummary);
let report=null;
if(label.startsWith('shard')&&existsSync(dir+'/'+label+'-tests.json')){const j=JSON.parse(readFileSync(dir+'/'+label+'-tests.json'));report={total:j.numTotalTests,passed:j.numPassedTests,failed:j.numFailedTests,pending:j.numPendingTests,success:j.success};}
rec.report=report;rec.unhandled=unhandled;
rec.accepted=r.code===0&&!r.timeout&&!r.signal&&!r.error&&!changed.length&&!unhandled;
rec.safeToContinue=rec.accepted||Boolean(label.startsWith('shard')&&report&&report.failed>0&&!unhandled&&!r.timeout&&!r.signal&&!r.error&&!changed.length&&/AssertionError|expected .* to /.test(output));
writeFileSync(dir+'/'+label+'-after.json',JSON.stringify(after));writeFileSync(dir+'/'+label+'.json',JSON.stringify(rec,null,2));console.log(JSON.stringify(rec));process.exitCode=rec.accepted?0:1;
