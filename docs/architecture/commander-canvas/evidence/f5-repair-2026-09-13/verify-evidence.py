import hashlib, json, pathlib
p=pathlib.Path('C:/Users/TK/OneDrive/Desktop/Claude Data/Paperclip-AoA/AoA-2.5/.worktrees/universe-interface/docs/architecture/commander-canvas/evidence/f5-repair-2026-09-13')
read=lambda n:json.loads((p/n).read_text(encoding='utf-8'))
s=read('summary.json'); ledger=read('command-ledger.json')
assert s['allCommandsPassed'] and len(ledger)==14
assert s['ordinarySkipsUnchanged'] and not s['removedTests'] and not s['crossShardDuplicates']
assert s['testCounts']=={'passed':24276,'skipped':76}
assert len(s['addedTests'])==16
assert s['previousSetupBlockedNowPassed'] and len(s['previousSetupBlockedTests'])==2
for r in ledger:
    assert r['sha']==s['source'] and r['code']==0 and r['accepted']
    assert not any([r['changed'],r['timeout'],r['signal'],r['unhandled']])
snap=read('source-integrity.json')
assert len(snap)==29 and len({x['sha256'] for x in snap.values()})==1
i=read('repair-integrity.json')
assert i['originalAssertionBodiesIdentical'] and i['targetedHashesMatchCommittedSource']
for name,meta in read('manifest.json').items():
    b=(p/name).read_bytes()
    assert hashlib.sha256(b).hexdigest()==meta['sha256'] and len(b)==meta['bytes'],name
assert read('interrupted-shard3/record.json')['result']=='incomplete; not counted'
print('Evidence verified: 14 accepted commands, 24,276 passes, 76 unchanged skips, 16 added cases, 29 identical source snapshots, manifest valid.')
