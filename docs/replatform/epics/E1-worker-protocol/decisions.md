# E1 Decisions

Breaking wire decisions require the Protocol Custodian and a versioned contract directory. The entries below are plan-alignment decisions that make the implementation plan agree with the frozen E0 authorities; they change no wire contract.

## E1-D001 — PRT-002 lifecycle maps are authoritative from the E0 JSON, with a parity test

- **Date (UTC):** `2026-08-09`
- **Status:** `locked` (approved by the operator acting as custodian / Integration Gate Owner).
- **Context:** PRT-002 Task 2 Step 2 embedded illustrative transition maps that diverged from `docs/architecture/distributed-execution-lifecycles.json` (Decision #121; frozen E0/FND-001 authority) — see finding [E1-F001](findings.md). Divergences existed in the attempt, browser_session, and service_instance machines (missing edges and one phantom `pending→stopped`).
- **Decision:** The machine-readable lifecycle JSON is the sole authority. The Step-2 illustrative maps are corrected to match it exactly, and `states.test.ts` must load the JSON at test time and assert byte-for-byte semantic parity of the embedded `states.ts` maps, reason `guards`, and `terminal` sets against the JSON's `allowed`/`guards`/`terminal` — the PRT-002 counterpart to PRT-004's canonicalizer cross-check.
- **Alternatives:** Implement from the illustrative examples (rejected — produces an incorrect state machine that would fail parity with the E0 authority).
- **Consequences:** Any future drift between `states.ts` and the JSON fails the PRT-002 suite; the JSON remains the single edit point for lifecycle changes (which themselves require an E1 decision + Decision #121 update).
- **Affected tickets:** PRT-002.

## E1-D002 — PRT-006 golden-journey checks are vocabulary/enum-membership parity, not full-object parse

- **Date (UTC):** `2026-08-09`
- **Status:** `locked` (approved by the operator acting as custodian / Integration Gate Owner).
- **Context:** The frozen FND-004 golden-journey fixtures use a broader emission vocabulary and a simpler, ULID-encoded `source`/event shape than the E1 wire schemas — see finding [E1-F002](findings.md). `steps[].emits` includes non-worker-event operation/receipt names, and the fixture `source` cannot round-trip through the full `executionSourceV1Schema`.
- **Decision:** `golden-journeys.test.ts` asserts vocabulary/enum-membership parity: the fixture `source.kind` is a member of the `ExecutionSourceV1` discriminant set, and each `emits` value is a member of a reviewed "known distributed-execution emission vocabulary" = the worker-event type union ∪ the frozen non-event operation/receipt names (`artifact_transfer_rejected`, `quarantine_grant_issued`, `quarantine_receipt_finalized`, `replacement_lease_activated`). Control-plane journey event types (`budget_exhausted`, `lease_lost`, `cancel_requested`, `producer_safety_rejected`, `provider_pause_observed`) are not forced into the worker-event union. The fixtures remain immutable E0 authority; the test conforms to them.
- **Alternatives:** Force fixtures through the wire schemas (rejected — fixtures are frozen E0 output and use a deliberately different identity encoding). PRT-004's digest cross-check is unaffected: it canonicalizes raw fixture event objects.
- **Consequences:** The emission vocabulary the package exports for the golden-journeys test is a documented superset of the worker-event union.
- **Affected tickets:** PRT-006.
