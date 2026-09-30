import {spawn,execFileSync} from 'node:child_process';
import {createWriteStream,readFileSync,writeFileSync,mkdirSync,existsSync,lstatSync,readlinkSync,readdirSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import os from 'node:os';
const cwd='/workspace/full-baseline-20260913',dir='/workspace/f5-attribution-20260913-logs';
const input=JSON.parse(readFileSync('/workspace/f5-attribution-input.json'));
const mode=process.argv[2];
const names=execFileSync('git',['ls-files','-z'],{cwd,encoding:'utf8'}).split('\0').filter(Boolean).sort();
const sha=execFileSync('git',['rev-parse','HEAD'],{cwd,encoding:'utf8'}).trim();
if(sha!==input.sha)throw Error('Wrong source SHA');
const hash=b=>createHash('sha256').update(b).digest('hex');
function snapshot(){return Object.fromEntries(names.map(p=>{const f=cwd+'/'+p,s=lstatSync(f).isSymbolicLink();return [p,{type:s?'symlink':'file',value:s?readlinkSync(f):hash(readFileSync(f))}];}));}
const pristine=JSON.parse(readFileSync('/workspace/full-baseline-20260913-logs/pristine.json'));
const env={PATH:'/workspace/home/bin:'+process.env.PATH,HOME:'/workspace/home',COREPACK_HOME:'/workspace/home/corepack',XDG_CACHE_HOME:'/workspace/home/cache',CI:'true',LANG:'C.UTF-8',AOA_HOME:'/workspace/home/aoa-full-baseline-20260913'};
if(mode==='prepare'){
 if(existsSync(dir))throw Error('Attempt exists');
 if(JSON.stringify(snapshot())!==JSON.stringify(pristine)||execFileSync('git',['status','--porcelain'],{cwd,encoding:'utf8'}).trim())throw Error('Source not pristine');
 if(hash(readFileSync(cwd+'/'+input.target))!==input.originalSha256)throw Error('Original hash mismatch');
 const instrumented=readFileSync('/workspace/f5-attribution-instrumented.test.ts');
 if(hash(instrumented)!==input.instrumentedSha256)throw Error('Instrumented hash mismatch');
 const original=readFileSync(cwd+'/'+input.target,'utf8'),modified=instrumented.toString();
 if(original.slice(original.indexOf('  it('))!==modified.slice(modified.indexOf('  it(')))throw Error('Test bodies changed');
 mkdirSync(dir);writeFileSync(dir+'/attempt.json',JSON.stringify({startedAt:Date.now(),input,availableParallelism:os.availableParallelism(),logicalCpus:os.cpus().length,node:process.version,retainedCheckout:true,runnerSha256:hash(readFileSync('/workspace/f5-attribution-run.mjs'))},null,2));
 writeFileSync(dir+'/pristine.json',JSON.stringify(pristine));
 writeFileSync(cwd+'/'+input.target,instrumented);
 writeFileSync(dir+'/instrumentation.patch',execFileSync('git',['diff','--binary','--',input.target],{cwd}));
 writeFileSync(dir+'/instrumented.json',JSON.stringify(snapshot()));
 const exports=['--import','tsx','--input-type=module','-e',"await import('./packages/plugins/sdk/dist/index.js'); await import('./packages/plugins/sdk/dist/testing.js')"];
 try{const output=execFileSync('node',exports,{cwd,env,timeout:300000,encoding:'utf8'});writeFileSync(dir+'/exports.log',output);writeFileSync(dir+'/exports.json',JSON.stringify({sha,exit:0,at:Date.now(),command:['node',...exports],sdkExports:Object.fromEntries(['index.js','testing.js'].map(n=>[n,hash(readFileSync(cwd+'/packages/plugins/sdk/dist/'+n))]))}));}catch(e){writeFileSync(dir+'/exports.json',JSON.stringify({sha,exit:e.status,failed:true}));throw e;}
 console.log('Prepared one-file diagnostic; unchanged test bodies; SDK gate passed');
}else if(mode==='run'){
 if(existsSync(dir+'/result.json')||existsSync(dir+'/shard4.log'))throw Error('Diagnostic already attempted');
 const attempt=JSON.parse(readFileSync(dir+'/attempt.json')),gate=JSON.parse(readFileSync(dir+'/exports.json'));
 if(gate.exit!==0||gate.sha!==sha||gate.at<attempt.startedAt||Date.now()-attempt.startedAt>300000)throw Error('Prerequisite failed/stale');
 const before=snapshot();if(JSON.stringify(before)!==readFileSync(dir+'/instrumented.json','utf8'))throw Error('Instrumented source drift');
 if(execFileSync('git',['ls-files','--others','--exclude-standard'],{cwd,encoding:'utf8'}).trim())throw Error('Unexpected untracked source');
 const cmd=['corepack','pnpm','exec','vitest','run','--shard=4/4','--reporter=default','--reporter=json','--outputFile.json='+dir+'/tests.json'];
 const rec={sha,startedAt:new Date().toISOString(),command:cmd,patchSha256:hash(readFileSync(dir+'/instrumentation.patch'))};
 const log=createWriteStream(dir+'/shard4.log');log.write(JSON.stringify(rec)+'\n');
 function read(p){try{return readFileSync(p,'utf8').trim();}catch(e){return {unavailable:e.code};}}
 function sample(){const start=performance.now();const db=[];let all=0;for(const pid of readdirSync('/proc').filter(x=>/^\d+$/.test(x))){all++;try{const comm=readFileSync('/proc/'+pid+'/comm','utf8').trim();if(!['initdb','postgres','pg_ctl'].includes(comm))continue;const stat=readFileSync('/proc/'+pid+'/stat','utf8');const rest=stat.slice(stat.lastIndexOf(')')+2).split(' ');db.push({pid:Number(pid),ppid:Number(rest[1]),comm,state:rest[0],userTicks:Number(rest[11]),systemTicks:Number(rest[12]),blockIoDelayTicks:Number(rest[39]),wait:read('/proc/'+pid+'/wchan'),io:read('/proc/'+pid+'/io')});}catch{}}const metrics={};for(const f of ['cpu.stat','cpu.max','cpu.pressure','io.stat','io.pressure','memory.current','memory.max','memory.events','memory.pressure'])metrics[f]=read('/sys/fs/cgroup/'+f);appendFileSync(dir+'/resources.jsonl',JSON.stringify({utc:new Date().toISOString(),processes:all,dbProcesses:db,metrics,load:os.loadavg(),samplingMs:performance.now()-start})+'\n');}
 sample();const sampler=setInterval(sample,1000);
 const result=await new Promise(resolve=>{let settled=false;const c=spawn(cmd[0],cmd.slice(1),{cwd,env,detached:true,stdio:['ignore','pipe','pipe']});c.stdout.pipe(log,{end:false});c.stderr.pipe(log,{end:false});let timedOut=false;const timer=setTimeout(()=>{timedOut=true;try{process.kill(-c.pid,'SIGKILL');}catch{}},900000);c.once('error',e=>{if(!settled){settled=true;clearTimeout(timer);resolve({code:null,error:e.message,timedOut});}});c.once('close',(code,signal)=>{if(!settled){settled=true;clearTimeout(timer);resolve({code,signal,timedOut});}});});
 clearInterval(sampler);sample();const after=snapshot();Object.assign(rec,result,{endedAt:new Date().toISOString(),changed:names.filter(p=>JSON.stringify(before[p])!==JSON.stringify(after[p]))});
 writeFileSync(dir+'/after.json',JSON.stringify(after));await new Promise(resolve=>log.end('\nRESULT '+JSON.stringify(rec)+'\n',resolve));writeFileSync(dir+'/result.json',JSON.stringify(rec,null,2));console.log(JSON.stringify(rec));process.exitCode=rec.code===0&&!rec.timedOut&&!rec.changed.length?0:1;
}else if(mode==='restore'){
 if(JSON.stringify(snapshot())!==readFileSync(dir+'/instrumented.json','utf8'))throw Error('Unexpected drift; refusing restore');
 const original=execFileSync('git',['show',sha+':'+input.target],{cwd});if(hash(original)!==input.originalSha256)throw Error('Original identity mismatch');writeFileSync(cwd+'/'+input.target,original);
 const after=snapshot();if(JSON.stringify(after)!==JSON.stringify(pristine))throw Error('Restore mismatch');writeFileSync(dir+'/restored.json',JSON.stringify(after));console.log('Original source restored and verified');
}else throw Error('Unknown mode');
