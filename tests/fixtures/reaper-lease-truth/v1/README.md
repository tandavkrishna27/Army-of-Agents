# reaper-lease-truth/v1 — the FROZEN AM→control-plane lease-truth wire contract

DEP-011 reaper Slice B. This fixture IS the freeze of the read-only lease-truth
PULL the adapter-manager (AM) makes against the control-plane (CP) to decide which
sandboxes it owns are orphans. It is loaded and dual-asserted by BOTH sides so a
field-name / enum divergence reds in unit tests, never first at Slice-5 live wiring:

- **B1** (CP endpoint) — `server/src/__tests__/adapter-manager-control-lease-truth.integration.test.ts`
  seeds leases/attempts/targets to match `request.json` and asserts the
  `classifyLeaseTruth` verdicts equal `response.json`.
- **B2** (AM outbound client) — `packages/adapter-manager/src/__tests__/reaper-truth-client.test.ts`
  feeds `summaries.json` to the client, asserts it POSTs `request.json` (grouped by
  org, leaseIds de-duplicated), and — given `response.json` back — maps to
  `expected-client-verdicts.json`.

## Files

- `request.json` — the request body: `{ orgs: [{ organizationId, leases: [{ leaseId }] }] }`.
  Request carries `leaseId` ONLY (B1-F2): jobId/attempt/targetGeneration are redundant
  with immutable DB columns the CP already holds by leaseId, and a caller-supplied
  generation next to the classifier is a mass-kill trap.
- `response.json` — `{ verdicts: { <leaseId>: "terminal" | "live" | "superseded" | "absent" } }`.
- `summaries.json` — the AM client's input (the provider fleet snapshot). Includes the
  **multi-sandbox-per-lease** case: `sb-superseded-a` and `sb-superseded-b` share one
  `leaseId` (a retried create), so both must resolve to the same verdict — the
  fail-safe keying (iterate own summaries; `leases.id` is a globally-unique UUID).
- `expected-client-verdicts.json` — the client's output map `sandboxId -> "orphan" | "live" | "unknown"`.
  `terminal`/`superseded` -> `orphan`; `live` -> `live`; `absent` (and anything
  out-of-contract) -> `unknown`. Positive-confirmed-death: never a negative default.
