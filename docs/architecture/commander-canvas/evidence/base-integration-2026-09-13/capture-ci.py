import json,pathlib,subprocess
run=pathlib.Path(__file__).parent
def gh(*args): return json.loads(subprocess.check_output(['gh',*args]))
checks=gh('pr','checks','449','--json','name,state,link')
pr=gh('pr','view','449','--json','headRefOid,baseRefOid,mergeStateStatus,reviewDecision,reviewRequests,reviews,state')
actions=gh('run','view','34751057732','--json','status,conclusion,headSha,url,jobs')
assert pr['headRefOid']=='bef01d9cc6947e25ec87df21e747eafdbe497527'
assert pr['baseRefOid']=='664bc7e13c57bba37bf6bf1b838b1649fb0ec2dd'
assert pr['state']=='OPEN' and pr['mergeStateStatus']=='CLEAN'
assert actions['status']=='completed' and actions['conclusion']=='success'
assert actions['headSha']==pr['headRefOid']
assert any(c['name']=='ci-required' and c['state']=='SUCCESS' for c in checks)
assert all(c['state']=='SUCCESS' or (c['name']=='distributed-contract' and c['state']=='SKIPPED') for c in checks)
assert pr['reviewDecision']!='CHANGES_REQUESTED' and not pr['reviewRequests']
record=dict(pr=pr,checks=checks,run=actions,localSourceTree=json.loads((run/'ci-tree.json').read_text()),gatePassed=True)
(run/'ci.json').write_bytes((json.dumps(record,indent=2)+'\n').encode())
print('Exact PR source/base and all required checks verified; no pending review request.')
