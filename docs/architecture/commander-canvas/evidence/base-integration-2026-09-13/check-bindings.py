import hashlib,json,pathlib,re,subprocess
root=pathlib.Path('C:/Users/TK/OneDrive/Desktop/Claude Data/Paperclip-AoA/AoA-2.5/.worktrees/universe-interface')
old='183e46a9c65fc3105c7e3d125629276814df7dbb'
new='bef01d9cc6947e25ec87df21e747eafdbe497527'
def git(*args): return subprocess.check_output(['git',*args],cwd=root)
def exists(rev,p): return subprocess.run(['git','cat-file','-e',rev+':'+p],cwd=root,stderr=subprocess.DEVNULL).returncode==0
sources=set(); outputs=set()
for line in (root/'docs/architecture/commander-canvas/implementation-bindings.md').read_text(encoding='utf-8-sig').splitlines():
    if line.startswith('| [E'):
        cells=line.split('|')
        sources.update(re.findall(r'`([^`]+)`',cells[2]))
        outputs.update(re.findall(r'`([^`]+)`',cells[3]))
records=[]
for p in sorted(sources):
    if exists(old,p):
        present=exists(new,p)
        a=git('show',old+':'+p); b=git('show',new+':'+p) if present else b''
        records.append(dict(path=p,present=present,unchanged=a==b,oldSha256=hashlib.sha256(a).hexdigest(),newSha256=hashlib.sha256(b).hexdigest() if present else None))
first=['ui/src/App.tsx','ui/package.json','ui/vitest.config.ts','ui/src/components/commander/CommanderTaskFocusPane.tsx','ui/src/components/TaskDetail.tsx']
result=dict(historicalPlanningBase=old,candidate=new,runtimeAnchors=records,outputCollisions=[p for p in sorted(outputs) if exists(new,p)],firstBatch={p:dict(present=exists(new,p),unchanged=git('show',old+':'+p)==git('show',new+':'+p)) for p in first},candidateTree=git('rev-parse',new+'^{tree}').decode().strip())
pathlib.Path(__file__).with_name('binding-checks.json').write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8')
print(json.dumps(dict(runtimePaths=len(records),changed=[r['path'] for r in records if not r['unchanged']],missing=[r['path'] for r in records if not r['present']],collisions=result['outputCollisions'],firstBatch=result['firstBatch']),indent=2))
