import collections, gzip, hashlib, json, pathlib, shutil, subprocess

run = pathlib.Path(__file__).parent
repo = pathlib.Path('C:/Users/TK/OneDrive/Desktop/Claude Data/Paperclip-AoA/AoA-2.5')
docs = repo / '.worktrees/universe-interface/docs/architecture/commander-canvas'
out = docs / 'evidence/f5-repair-2026-09-13'
out.mkdir(exist_ok=True)
def read(p): return json.loads(p.read_text(encoding='utf-8'))
def write(p, o): p.write_bytes((json.dumps(o, indent=2)+'\n').encode())
def sha(b): return hashlib.sha256(b).hexdigest()
def compress(src, dest): dest.write_bytes(gzip.compress(src.read_bytes(),mtime=0))
def identities(folder, prefix):
    records=[]; files=[]
    for n in range(1,5):
        p=folder/f'shard{n}-tests.json'
        if not p.exists(): continue
        for suite in read(p)['testResults']:
            name=suite['name'].removeprefix(prefix)
            status=suite['status']
            if suite['assertionResults'] and all(x['status']=='skipped' for x in suite['assertionResults']): status='skipped'
            files.append({'file':name,'shard':n,'status':status})
            for x in suite['assertionResults']: records.append({'file':name,'name':x['fullName'],'status':x['status'],'suiteStatus':suite['status'],'shard':n})
    return records, files
labels=['install', *['build'+str(i) for i in range(6)], 'exports','typecheck', *['shard'+str(i) for i in range(1,5)], 'build']
logs=run/'full-logs'
ledger=[read(logs/(x+'.json')) for x in labels if (logs/(x+'.json')).exists()]
records,files=identities(logs,'/workspace/f5-qualified-baseline-20260913/')
old,_=identities(pathlib.Path('C:/Users/TK/AppData/Local/Temp/universe-full-baseline-20260913/logs'),'/workspace/full-baseline-20260913/')
key=lambda t:(t['file'],t['name'])
prior=collections.Counter(map(key,old));current=collections.Counter(map(key,records))
added=list((current-prior).elements());removed=list((prior-current).elements())
oldskips=collections.Counter(key(t) for t in old if t['status']=='skipped' and t['suiteStatus']!='failed')
newskips=collections.Counter(key(t) for t in records if t['status']=='skipped')
summary={'source':'fcab5a112aeac8385733f528396e65d258c02dfb','commands':len(ledger),'allCommandsPassed':len(ledger)==14 and all(x['accepted'] for x in ledger),'testCounts':dict(collections.Counter(x['status'] for x in records)),'testFiles':dict(collections.Counter(x['status'] for x in files)),'crossShardDuplicates':[f for f,n in collections.Counter(x['file'] for x in files).items() if n>1],'addedTests':added,'removedTests':removed,'ordinarySkipsUnchanged':oldskips==newskips,'nonPassingTests':[x for x in records if x['status']!='passed']}
summary['previousSetupBlockedTests']=[key(t) for t in old if t['status']=='skipped' and t['suiteStatus']=='failed']
summary['previousSetupBlockedNowPassed']=all(any(key(t)==tuple(k) and t['status']=='passed' for t in records) for k in summary['previousSetupBlockedTests'])
write(out/'summary.json',summary);write(out/'command-ledger.json',ledger)
(out/'test-identities.json.gz').write_bytes(gzip.compress(json.dumps(records,indent=2).encode(),mtime=0))
write(out/'test-files.json',files)
manifest_alias={}
for p in logs.iterdir():
    if p.suffix=='.log' or p.name.endswith('-tests.json'): compress(p,out/(p.name+'.gz'))
    elif p.name.endswith('-before.json') or p.name.endswith('-after.json') or p.name=='pristine.json':
        h=sha(p.read_bytes()); dest='source-'+h+'.json.gz'
        if not (out/dest).exists():compress(p,out/dest)
        manifest_alias[p.name]={'sha256':h,'file':dest}
    elif p.suffix=='.json': shutil.copyfile(p,out/p.name)
write(out/'source-integrity.json',manifest_alias)
interrupted=logs/'interrupted-shard3'
if interrupted.exists():
    dest=out/'interrupted-shard3';dest.mkdir(exist_ok=True)
    for p in interrupted.iterdir():
        if p.suffix=='.log' or p.name.endswith('-before.json'): compress(p,dest/(p.name+'.gz'))
        else: shutil.copyfile(p,dest/p.name)
target=out/'targeted';target.mkdir(exist_ok=True)
for p in (run/'target-logs').iterdir():
    if p.suffix=='.log' or p.name.endswith('-tests.json'): compress(p,target/(p.name+'.gz'))
    else:shutil.copyfile(p,target/p.name)
for name in ['target-run.mjs','target-run-initial.mjs','full-run.mjs','prepare-full.mjs','full-run.ps1','publish-results.py','verify-evidence.py']:
    shutil.copyfile(run/name,out/name)
for name in ['negative-active.ts','negative-wait.ts']:
    compress(run/name,target/(name+'.gz'))
wt=repo/'.worktrees/universe-f5-fixture-repair'
paths=['packages/db/src/__tests__/backup-fixture.test.ts','packages/db/src/__tests__/helpers/backup-fixture.ts','packages/db/src/__tests__/backup-lib-non-system-schemas.test.ts']
integrity={'source':summary['source'],'files':{p:sha(subprocess.check_output(['git','show','HEAD:'+p],cwd=wt)) for p in paths}}
original=subprocess.check_output(['git','show','4aebfa0f4aaf011cfd85347246c18d3cbde305ba:'+paths[-1]],cwd=wt)
modified=subprocess.check_output(['git','show','HEAD:'+paths[-1]],cwd=wt)
assert original[original.index(b'  it('):]==modified[modified.index(b'  it('):]
integrity['originalAssertionBodiesIdentical']=True
integrity['originalAssertionBodySha256']=sha(original[original.index(b'  it('):])
final=read(run/'target-logs/integration.json')['beforeHashes']
assert all(final[p]['value']==integrity['files'][p] for p in paths)
integrity['targetedHashesMatchCommittedSource']=True
write(out/'repair-integrity.json',integrity)
write(out/'manifest.json',{p.relative_to(out).as_posix():{'sha256':sha(p.read_bytes()),'bytes':p.stat().st_size} for p in sorted(out.rglob('*')) if p.is_file() and p.name!='manifest.json'})
print(json.dumps({k:v for k,v in summary.items() if k not in ['nonPassingTests','addedTests']},indent=2))
print('Added cases',len(added),'source snapshot hashes',len({x['sha256'] for x in manifest_alias.values()}))
