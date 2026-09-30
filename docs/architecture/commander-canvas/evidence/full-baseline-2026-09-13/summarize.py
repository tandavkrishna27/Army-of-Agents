import json, hashlib, gzip
from pathlib import Path
from collections import Counter

root = Path(__file__).parent
logs = root / 'logs'
out = root / 'publication'
out.mkdir(exist_ok=True)
labels = ['install', *['build'+str(i) for i in range(6)], 'exports', 'typecheck', *['shard'+str(i) for i in range(1,5)], 'build']
ledger = [json.loads((logs / (x+'.json')).read_text(encoding='utf-8')) for x in labels if (logs / (x+'.json')).exists()]
tests, files, skips = [], [], []
for n in range(1,5):
    path = logs / f'shard{n}-tests.json'
    if not path.exists(): continue
    j = json.loads(path.read_text(encoding='utf-8'))
    for suite in j['testResults']:
        name = suite['name'].replace('/workspace/full-baseline-20260913/', '')
        status = suite['status']
        if status=='passed' and suite['assertionResults'] and all(a['status']=='skipped' for a in suite['assertionResults']): status='skipped'
        files.append({'shard': n, 'file': name, 'status': status, 'tests': len(suite['assertionResults'])})
        for a in suite['assertionResults']:
            entry = {'shard': n, 'file': name, 'name': a['fullName'], 'status': a['status']}
            tests.append(entry)
            if a['status'] != 'passed': skips.append(entry)
summary = {'source': '4aebfa0f4aaf011cfd85347246c18d3cbde305ba', 'commands': len(ledger), 'allCommandsPassed': len(ledger)==14 and all(r['accepted'] for r in ledger), 'testCounts': dict(Counter(t['status'] for t in tests)), 'fileCounts': dict(Counter(f['status'] for f in files)), 'crossShardFiles': sorted({f['file'] for f in files if len({x['shard'] for x in files if x['file']==f['file']})>1}), 'nonPassingTests': skips}
for name,data in [('command-ledger.json',ledger),('summary.json',summary),('test-files.json',files)]:
    (out/name).write_text(json.dumps(data,indent=2)+'\n')
(out/'test-identities.json.gz').write_bytes(gzip.compress(json.dumps(tests,indent=2).encode(),mtime=0))
manifest_aliases = {}
for file in logs.glob('*'):
    if file.suffix=='.log' or file.name.endswith('-tests.json'):
        data=file.read_bytes()
        (out/(file.name+'.gz')).write_bytes(gzip.compress(data,mtime=0))
    elif file.name.endswith('-before.json') or file.name.endswith('-after.json') or file.name=='pristine.json':
        data=file.read_bytes(); sha=hashlib.sha256(data).hexdigest()
        dest='source-'+sha+'.json.gz'
        if not (out/dest).exists(): (out/dest).write_bytes(gzip.compress(data,mtime=0))
        manifest_aliases[file.name]={'sha256':sha,'file':dest}
    elif file.suffix=='.json': (out/file.name).write_bytes(file.read_bytes())
(out/'source-integrity.json').write_text(json.dumps(manifest_aliases,indent=2)+'\n')
for name in ['setup-run.mjs','run.mjs','summarize.py','source-commit.txt','correction-delta.txt','isolation.txt']:
    (out/name).write_bytes((root/name).read_bytes())
(out/'manifest.json').write_text(json.dumps({p.name:{'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'bytes':p.stat().st_size} for p in sorted(out.iterdir()) if p.name!='manifest.json'},indent=2)+'\n')
print(json.dumps({k:v for k,v in summary.items() if k!='nonPassingTests'},indent=2))
