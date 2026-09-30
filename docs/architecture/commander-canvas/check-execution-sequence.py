"""Read-only scheduling validation. Run with Python 3 from any directory.

This checks the plan's coverage/order, not the application's runtime readiness.
"""
import copy
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent


def validate(data):
    errors = []
    def require(ok, message):
        if not ok:
            errors.append(message)
    expected = {}
    for path in sorted((ROOT / 'coding-plans').glob('e[0-9]-[0-9].md')):
        for ident, title in re.findall(r'^## (E\d\.\d/\d) [—–-] (.+)$', path.read_text(encoding='utf-8-sig'), re.M):
            expected[ident] = ('V2' if ident.startswith('E3.4/') else 'V1', 'coding-plans/' + path.name)
    require(len(expected) == 69, 'original coding-plan increment count changed')
    require(set(data['parents']) == set(expected), 'parent coverage differs from original increments')
    require(len({x.split('/')[0] for x in expected}) == 31, 'slice coverage is not 31')
    for ident, (version, plan) in expected.items():
        parent = data['parents'].get(ident, {})
        require(parent.get('release') == version and parent.get('plan') == plan, 'parent binding/version mismatch: ' + ident)
    nodes = {x['id']: x for x in data['packages']}
    require(len(nodes) == len(data['packages']), 'duplicate work package')
    batches = {x['id'] for x in data['batches']}
    require(len(batches) == len(data['batches']), 'duplicate batch')
    require({n['parent'] for n in nodes.values()} == set(expected), 'work package coverage incomplete')
    for ident, n in nodes.items():
        require(n['parent'] in expected, 'unknown parent: ' + ident)
        require(ident == n['parent'] or re.fullmatch(re.escape(n['parent']) + r'\.[a-z]', ident), 'invalid partition identifier: ' + ident)
        require(n['batch'] in batches, 'unknown batch: ' + ident)
        require(n['release'] == data['parents'].get(n['parent'], {}).get('release'), 'wrong package version: ' + ident)
        require(n['boundary'] and n['lane'] and n['acceptance'], 'missing delivery contract: ' + ident)
        require((ROOT / n['plan']).is_file(), 'missing owning coding plan: ' + ident)
        require(len(n['requires']) == len(set(n['requires'])), 'duplicate predecessor: ' + ident)
        for prior in n['requires']:
            require(prior in nodes, 'unknown predecessor: ' + ident + ' <- ' + prior)
            if prior in nodes:
                require(nodes[prior]['batch'] <= n['batch'], 'backward batch edge: ' + ident + ' <- ' + prior)
                require(not (n['release'] == 'V1' and nodes[prior]['release'] == 'V2'), 'V1 waits on V2: ' + ident)
        for g in n['gates'] + n['completionGates']:
            require(g in data['gates'], 'unknown external gate: ' + g)
        require('V1_ACCEPTANCE' not in n['gates'], 'V1 acceptance must be an output, not an entry condition')
        require(n['status'] == ('evidenced_portion' if n['batch'] == 'B00' else 'not_started'), 'unverified implementation credit: ' + ident)
    for parent in expected:
        children = [x for x in nodes if nodes[x]['parent'] == parent]
        require(not (len(children) > 1 and parent in children), 'whole increment overlaps partitions: ' + parent)
        joins = data['parents'].get(parent, {}).get('acceptanceAfter', [])
        require(set(children) <= set(joins), 'parent acceptance omits own delivery: ' + parent)
        require(all(x in nodes for x in joins), 'parent acceptance references missing package: ' + parent)
        require(all(nodes[x]['release'] == expected[parent][0] for x in joins if x in nodes), 'parent acceptance crosses release boundary: ' + parent)
    for key, g in data['gates'].items():
        require(all(g.get(k) for k in ('owner', 'entryRequirement', 'completionEvidence', 'status', 'kind')), 'incomplete gate record: ' + key)
        require((ROOT / g['plan']).is_file(), 'missing gate plan: ' + key)
    pending = {key: set(n['requires']) for key, n in nodes.items()}
    ordered = []
    while pending:
        ready = sorted(k for k, deps in pending.items() if not deps)
        if not ready:
            errors.append('cycle or unresolved predecessor: ' + ', '.join(sorted(pending)))
            break
        ordered.extend(ready)
        for k in ready:
            del pending[k]
        for deps in pending.values():
            deps.difference_update(ready)
    # These are producer boundaries corrected during review, not optional prose.
    required_edges = {
        'E2.1/1': ['E1.3/1.a'], 'E1.3/2': ['E2.2/1'],
        'E7.3/1': ['E8.1/1.b'], 'E2.3/1': ['E7.3/1'],
        'E1.6/1': ['E2.1/1'], 'E4.2/1': ['E4.1/1'],
        'E4.1/2': ['E4.2/2'], 'E4.2/2': ['E2.2/2.a'],
        'E2.2/2.b': ['E4.3/1'], 'E7.3/2': ['E2.4/1'],
        'E2.4/2': ['E7.3/2'], 'E1.0/2': ['E2.4/2'],
        'E3.1/2': ['E3.1/1.a', 'E8.1/1.c', 'E8.1/1.d'],
        'E3.1/1.b': ['E3.1/2', 'E3.2/2'],
        'E5.2/1.b': ['E5.2/1.a'],
        'E6.2/1.b': ['E6.0/2', 'E6.1/2.a', 'E6.2/1.a'],
        'E6.2/2.b': ['E6.2/2.a', 'E6.2/1.b'],
        'E6.3/1': ['E6.0/3', 'E6.1/2.a', 'E6.2/1.a', 'E6.2/2.a'],
        'E6.1/2.b': ['E6.2/2.b', 'E6.3/2'],
        'E3.4/1': ['E8.2/2'], 'E3.4/2': ['E8.2/2', 'E3.4/1'],
    }
    for consumer, producers in required_edges.items():
        require(set(producers) <= set(nodes.get(consumer, {}).get('requires', [])), 'missing reviewed producer edge: ' + consumer)
    def ancestors(ident, seen=None):
        seen = set() if seen is None else seen
        for prior in nodes.get(ident, {}).get('requires', []):
            if prior not in seen:
                seen.add(prior)
                ancestors(prior, seen)
        return seen
    require('E6.0/2' not in ancestors('E6.3/1'), 'local view unnecessarily waits on cloud qualification')
    require('E3.3/1' not in ancestors('E3.3/2'), 'ElevenLabs unnecessarily waits on Gemini qualification')
    require('E3.1/1.b' not in ancestors('E1.5/3'), 'visual Commander waits on live voice')
    require('E2.2/2.a' not in ancestors('E4.1/1'), 'manual originals wait on distributed execution')
    required_v1 = {k for k, n in nodes.items() if n['release'] == 'V1' and not n['parent'].startswith('E8.2/')}
    require(required_v1 == set(nodes.get('E8.2/1', {}).get('requires', [])), 'V1 integrated closure omits or adds a work package')
    require(nodes.get('E8.2/2', {}).get('completionGates') == ['V1_ACCEPTANCE'], 'missing V1 completion acceptance')
    require('E3.1/1.b' in data['parents'].get('E3.1/2', {}).get('acceptanceAfter', []), 'session acceptance omits deferred real matrix')
    require({'E5.1/2', 'E5.2/2'} <= set(data['parents'].get('E1.2/1', {}).get('acceptanceAfter', [])), 'checkpoint acceptance omits real consumers')
    require(data['featureImplementationAuthorized'] is False, 'planning packet claims implementation authorization')
    return errors, ordered


def main():
    data = json.loads((ROOT / 'execution-sequence.json').read_text(encoding='utf-8'))
    errors, ordered = validate(data)
    controls = {}
    for scenario in ['missing_package', 'cycle', 'lost_producer_edge', 'v1_waits_on_v2', 'acceptance_as_entry', 'omitted_release_obligation', 'false_completion']:
        bad = copy.deepcopy(data)
        nodes = {n['id']: n for n in bad['packages']}
        if scenario == 'missing_package':
            bad['packages'] = [n for n in bad['packages'] if n['id'] != 'E1.1/2']
        elif scenario == 'cycle':
            nodes['E1.1/1']['requires'].append('E1.1/3')
        elif scenario == 'lost_producer_edge':
            nodes['E7.3/1']['requires'].remove('E8.1/1.b')
        elif scenario == 'v1_waits_on_v2':
            nodes['E1.5/3']['requires'].append('E3.4/1')
        elif scenario == 'acceptance_as_entry':
            nodes['E8.2/2']['gates'].append('V1_ACCEPTANCE')
        elif scenario == 'omitted_release_obligation':
            nodes['E8.2/1']['requires'].remove('E6.4/3')
        elif scenario == 'false_completion':
            nodes['E1.1/1']['status'] = 'passed'
        controls[scenario] = bool(validate(bad)[0])
    report = dict(kind='planning-structure-only', originalIncrements=len(data['parents']),
                  v1Increments=sum(n['release'] == 'V1' for n in data['parents'].values()),
                  v2Increments=sum(n['release'] == 'V2' for n in data['parents'].values()),
                  workPackages=len(data['packages']), schedulingSlots=len(data['batches']),
                  topologicallyOrderedPackages=len(ordered), negativeControlsRejected=controls, errors=errors)
    print(json.dumps(report, indent=2))
    raise SystemExit(bool(errors) or not all(controls.values()))


if __name__ == '__main__':
    main()
