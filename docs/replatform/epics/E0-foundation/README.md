# E0 — Program Foundation

**Status:** `complete`
**Depends on:** approved [`program-design.md`](../../program-design.md)
**Tickets:** FND-001 through FND-008
**Implementation plan:** [`implementation-plan.md`](implementation-plan.md)

## Outcome

Lock workload lifecycles and sources, state authority, current-main cutover/parity ownership, security controls, actual hosted plugin exclusion, golden journeys, rollout/build/evidence policy, merge gates, and custodian roles before protocol implementation.

## Exit gate

- Structured lifecycle/authority/threat/fixture foundation checker passes; Markdown and JSON authorities agree.
- Hosted unsafe override regression passes.
- All nine deterministic golden fixtures and their strict schema are committed.
- Every trust crossing has complete control fields and every Critical/High item owns a release test. ★ **Complete FIELDS, not delivered controls** — this gate is about the record's shape, and passing it says nothing about whether a control exists. The delivery audit completed 2026-09-08: **1 `delivered`, 25 `partial`, 4 `not-delivered`, 0 `unaudited`**. See the head of [`distributed-execution-threat-model.md`](../../../architecture/distributed-execution-threat-model.md).
- Every `CM-*`/`CP-*` current-main sink and legacy parity dimension has a checked owner; Decision #103 plugin process/runtime/UI exclusions pass in the real `cloud_auth` app, while self-hosted positives remain green.
- Every applicable D0 REQUIRED condition plus HARD/INITIAL threshold in `test-gates.md` passes on one revision.
- Repository typecheck, tests, same-revision recursive build, and authoritative deterministic root build pass. A failure outside the changed paths still blocks completion; a focused pass or baseline-failure note is evidence, not a waiver or pass.
- Completion handoff links every ticket result and QA run.

## Records

- [`decisions.md`](decisions.md)
- [`findings.md`](findings.md)
- [`tickets/`](tickets/)
- [`qa/`](qa/)
- [`handoffs/`](handoffs/)
