import collections,gzip,hashlib,json,pathlib,shutil
run=pathlib.Path(__file__).parent
docs=pathlib.Path('C:/Users/TK/OneDrive/Desktop/Claude Data/Paperclip-AoA/AoA-2.5/.worktrees/universe-interface/docs/architecture/commander-canvas')
out=docs/'evidence/base-integration-2026-09-13'
logs=run/'full-logs'
def read(p): return json.loads(p.read_text(encoding='utf-8'))
def write(p,o): p.write_bytes((json.dumps(o,indent=2)+'\n').encode())
def sha(b): return hashlib.sha256(b).hexdigest()
def compress(src,dest): dest.write_bytes(gzip.compress(src.read_bytes(),mtime=0))
def identities(folder,prefix):
    cases=[]; files=[]
    for n in range(1,5):
        for suite in read(folder/f'shard{n}-tests.json')['testResults']:
            name=suite['name'].removeprefix(prefix)
            status=suite['status']
            if suite['assertionResults'] and all(a['status']=='skipped' for a in suite['assertionResults']): status='skipped'
            files.append(dict(file=name,shard=n,status=status))
            for a in suite['assertionResults']: cases.append(dict(file=name,name=a['fullName'],status=a['status'],suiteStatus=suite['status'],shard=n))
    return cases,files
labels=['install',*['build'+str(i) for i in range(6)],'exports','citation','citationTests','typecheck',*['shard'+str(i) for i in range(1,5)],'build']
ledger=[read(logs/(label+'.json')) for label in labels]
assert all(r['accepted'] and r['sha']=='bef01d9cc6947e25ec87df21e747eafdbe497527' for r in ledger)
cases,files=identities(logs,'/workspace/integrated-baseline-20260913/')
old,_=identities(pathlib.Path('C:/Users/TK/AppData/Local/Temp/universe-f5-repair-20260913/full-logs'),'/workspace/f5-qualified-baseline-20260913/')
key=lambda x:(x['file'],x['name'])
prior=collections.Counter(map(key,old)); current=collections.Counter(map(key,cases))
added=list((current-prior).elements()); removed=list((prior-current).elements())
skips=lambda records:collections.Counter(key(c) for c in records if c['status']=='skipped')
summary=dict(source=ledger[0]['sha'],replatformInput='664bc7e13c57bba37bf6bf1b838b1649fb0ec2dd',repairInput='fcab5a112aeac8385733f528396e65d258c02dfb',commands=len(ledger),allCommandsPassed=all(r['accepted'] for r in ledger),testCounts=dict(collections.Counter(c['status'] for c in cases)),testFiles=dict(collections.Counter(f['status'] for f in files)),crossShardDuplicates=[f for f,n in collections.Counter(f['file'] for f in files).items() if n>1],addedTests=added,removedTests=removed,ordinarySkipsUnchanged=skips(old)==skips(cases),nonPassingTests=[c for c in cases if c['status']!='passed'])
assert not removed and not summary['crossShardDuplicates'] and summary['ordinarySkipsUnchanged']
assert all(c['status'] in ['passed','skipped'] for c in cases)
out.mkdir(exist_ok=True)
write(out/'summary.json',summary); write(out/'command-ledger.json',ledger); write(out/'test-files.json',files)
(out/'test-identities.json.gz').write_bytes(gzip.compress(json.dumps(cases,indent=2).encode(),mtime=0))
aliases={}
for p in logs.iterdir():
    if not p.is_file(): raise RuntimeError('Unexpected run subdirectory: '+str(p))
    if p.suffix=='.log' or p.name.endswith('-tests.json'): compress(p,out/(p.name+'.gz'))
    elif p.name.endswith('-before.json') or p.name.endswith('-after.json') or p.name=='pristine.json':
        h=sha(p.read_bytes()); dest='source-'+h+'.json.gz'
        if not (out/dest).exists(): compress(p,out/dest)
        aliases[p.name]=dict(sha256=h,file=dest)
    elif p.suffix=='.json': shutil.copyfile(p,out/p.name)
write(out/'source-integrity.json',aliases)
assert len(aliases)==33 and len({x['sha256'] for x in aliases.values()})==1
for name in ['run.mjs','prepare.mjs','run.ps1','publish-evidence.py','check-bindings.py','binding-checks.json']:
    shutil.copyfile(run/name,out/name)
write(out/'manifest.json',{p.relative_to(out).as_posix():dict(sha256=sha(p.read_bytes()),bytes=p.stat().st_size) for p in sorted(out.rglob('*')) if p.is_file() and p.name!='manifest.json'})
print(json.dumps({k:v for k,v in summary.items() if k not in ['nonPassingTests','addedTests']},indent=2))
print('Added cases',len(added),'unchanged source snapshots',len(aliases))
