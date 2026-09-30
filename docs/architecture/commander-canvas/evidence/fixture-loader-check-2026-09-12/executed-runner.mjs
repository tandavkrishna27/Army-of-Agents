import {spawn,execFileSync} from 'node:child_process';
import {createWriteStream,readFileSync,writeFileSync,mkdirSync,existsSync,lstatSync,readlinkSync} from 'node:fs';
import {createHash} from 'node:crypto';
const [phase,label,...args]=process.argv.slice(2),kind='fixture-diagnostics',cwd='/workspace/'+kind,dir='/workspace/fixture-loader-check-logs';
mkdirSync(dir,{recursive:true});
const deadlinePath=dir+'/'+phase+'-deadline.json';
if(!existsSync(deadlinePath))writeFileSync(deadlinePath,JSON.stringify(Date.now()+({setup:300000,diagnostic:900000}[phase])));
if(existsSync(dir+'/'+label+'-result.json')||existsSync(dir+'/'+label+'.log'))throw Error('Refusing repeated command label');
const totalPath=dir+'/total-deadline.json';
if(!existsSync(totalPath))writeFileSync(totalPath,JSON.stringify(Date.now()+1200000));
const deadline=Math.min(JSON.parse(readFileSync(deadlinePath)),JSON.parse(readFileSync(totalPath)));
const sha=execFileSync('git',['rev-parse','HEAD'],{cwd,encoding:'utf8'}).trim();
const names=execFileSync('git',['ls-files','-z'],{cwd,encoding:'utf8'}).split('\0').filter(Boolean);
function snapshot(){return Object.fromEntries(names.map(p=>{const f=cwd+'/'+p,symlink=lstatSync(f).isSymbolicLink();return [p,{type:symlink?'symlink':'file',value:symlink?readlinkSync(f):createHash('sha256').update(readFileSync(f)).digest('hex')}];}));}
const before=snapshot();
if(sha!=='b5cc42643223c433a8263564c7142761472a13d9')throw Error('Wrong source SHA');
const expected=JSON.parse(readFileSync('/workspace/fixture-stage-a-logs/shard-4-after.json'));
if(JSON.stringify(before)!==JSON.stringify(expected))throw Error('Retained source manifest changed');writeFileSync(dir+'/'+label+'-before.json',JSON.stringify(before));
const patch=execFileSync('git',['diff','--binary','b5cc42643223c433a8263564c7142761472a13d9'],{cwd});
if(createHash('sha256').update(patch).digest('hex')!=='0bef3abd63312e8877af950249cd28c3dfafac1e265fff9fe29326f2f8388e4c')throw Error('Diagnostic patch changed');
const expectedExport=["node","--import","tsx","--input-type=module","-e","await import('./packages/plugins/sdk/dist/index.js'); await import('./packages/plugins/sdk/dist/testing.js')"];
const expectedShard=["corepack","pnpm","exec","vitest","run","--shard=4/4"];
const expectedCommand=label==='exports-tsx'?expectedExport:label==='shard-4-gated'?expectedShard:null;
if(!expectedCommand||JSON.stringify(args)!==JSON.stringify(expectedCommand)||phase!==(label==='exports-tsx'?'setup':'diagnostic'))throw Error('Unapproved command or label');
for(const f of ['packages/plugins/sdk/dist/index.js','packages/plugins/sdk/dist/testing.js'])if(!existsSync(cwd+'/'+f))throw Error('Required generated export missing');
if(label==='shard-4-gated'){
 const f=dir+'/exports-tsx-result.json';if(!existsSync(f))throw Error('Missing successful prerequisite');
 const r=JSON.parse(readFileSync(f));
 if(r.code!==0||r.signal!==null||r.timeout!==false||r.sha!==sha||r.patchSha256!==createHash('sha256').update(patch).digest('hex')||r.changedSource.length||JSON.stringify(r.command)!==JSON.stringify(expectedExport)||Date.parse(r.startedAt)<JSON.parse(readFileSync(totalPath))-1200000)throw Error('Prerequisite failed or stale');
}
const rec={label,phase,cwd,sha,patchSha256:createHash('sha256').update(patch).digest('hex'),command:args,startedAt:new Date().toISOString()};
if(Date.now()>=deadline)throw Error('Approved phase deadline exhausted');
const start=Date.now(),log=createWriteStream(dir+'/'+label+'.log');log.write(JSON.stringify(rec)+'\n');
const result=await new Promise(resolve=>{const child=spawn(args[0],args.slice(1),{cwd,detached:true,env:{PATH:'/workspace/home/bin:'+process.env.PATH,HOME:'/workspace/home',COREPACK_HOME:'/workspace/home/corepack',XDG_CACHE_HOME:'/workspace/home/cache',CI:'true',LANG:'C.UTF-8',AOA_HOME:'/workspace/home/aoa-'+kind},stdio:['ignore','pipe','pipe']});child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});let timeout=false;const timer=setTimeout(()=>{timeout=true;try{process.kill(-child.pid,'SIGKILL');}catch{}},deadline-Date.now());child.on('error',err=>{clearTimeout(timer);resolve({code:null,error:err.message});});child.on('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal,timeout});});});
Object.assign(rec,result,{elapsedSeconds:(Date.now()-start)/1000});
const after=snapshot();const changed=names.filter(p=>JSON.stringify(before[p])!==JSON.stringify(after[p]));rec.changedSource=changed;writeFileSync(dir+'/'+label+'-after.json',JSON.stringify(after));
await new Promise(resolve=>log.end('\nRESULT '+JSON.stringify(rec)+'\n',resolve));writeFileSync(dir+'/'+label+'-result.json',JSON.stringify(rec,null,2));console.log(JSON.stringify(rec));process.exitCode=result.code===0&&!result.timeout&&!changed.length?0:1;
