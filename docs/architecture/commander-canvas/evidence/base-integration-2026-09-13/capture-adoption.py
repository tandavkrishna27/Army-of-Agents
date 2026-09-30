import json,pathlib,subprocess
root=pathlib.Path('C:/Users/TK/OneDrive/Desktop/Claude Data/Paperclip-AoA/AoA-2.5/.worktrees/universe-interface')
run=pathlib.Path(__file__).parent
def git(*args):return subprocess.check_output(['git',*args],cwd=root).decode().strip()
before='b117616664f62815b341b5c4aac4942e73fa87b5'
landing='b48132dac0f3435e017915e1e21ef1d66a39d0cd'
candidate='bef01d9cc6947e25ec87df21e747eafdbe497527'
assert git('branch','--show-current')=='codex/universe-interface'
assert not git('status','--porcelain')
assert not git('diff','--name-only',candidate,landing)
adoption=git('rev-parse','HEAD')
assert git('log','-1','--format=%P').split()==[before,landing]
assert not git('diff','--name-only',before,adoption,'--','docs/architecture/commander-canvas','docs/architecture/commander-canvas-master-scope-review.md')
delta=git('diff','--name-only',landing,adoption).splitlines()
assert all(p.startswith('docs/architecture/commander-canvas/') or p=='docs/architecture/commander-canvas-master-scope-review.md' for p in delta)
assert not git('ls-tree','-r','--name-only',adoption,'--','ui/src/components/universe','ui/src/pages/Universe.tsx')
result=dict(adopted=True,ciPassed=json.loads((run/'ci.json').read_text())['gatePassed'],before=before,landing=landing,candidate=candidate,adoption=adoption,branch='codex/universe-interface',candidateTree=git('rev-parse',candidate+'^{tree}'),landingTree=git('rev-parse',landing+'^{tree}'),adoptionTree=git('rev-parse',adoption+'^{tree}'),candidateAndLandingIdentical=True,adoptedApplicationAndToolingEqualLanding=True,universePlanningPreserved=True,onlyDifferencesFromLanding=delta,noUniverseFeaturePaths=True,workingTreeClean=True)
(run/'adoption.json').write_bytes((json.dumps(result,indent=2)+'\n').encode())
print(json.dumps({k:v for k,v in result.items() if k!='onlyDifferencesFromLanding'},indent=2))
