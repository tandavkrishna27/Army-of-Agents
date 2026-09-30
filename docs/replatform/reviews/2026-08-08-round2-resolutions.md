# Round-2 Resolutions — founder decisions on the open items

**Date:** 2026-08-08
**Authority:** Founder decision, recorded for the program record. Subordinate to locked product decisions and `program-design.md`.
**Context:** After the hardening pass closed 6 of 10 Round-1 findings, four items remained (G2, G7, G9 partial/open; B1 sizing). The founder resolved all four plus the B2 process item. This record captures the decisions and points to the exact edits made.

## Decisions

### G2 — Legacy tenancy: **no retrofit** (accepted, not a gap)
The existing product's ~129 tenant tables stay application-layer isolated (the ~557 `assertCompanyAccess` checks + the `company_secrets` RLS canary); forced RLS + non-owner role apply only to the new distributed tables. This is a conscious scope decision for the invite-only/bounded-tenant beta, not an omission.
- **Recorded as:** `accepted-caveats.md` → **CAV-005**.

### G7 — Brokered internal tool surface: **add a ticket** (relocate, don't rebuild)
#320's broker is already an HTTP control-plane endpoint the sandbox calls with a run-JWT, so no new subsystem is needed — only an explicit ticket confirming the live per-actor RBAC tool surface (memory/tasks/goals/`use_skill`/`ask_human`) holds when the caller is a remote-worker sandbox.
- **Recorded as:** `program-design.md` → new ticket **DAT-007** (E5). Recommend the Migration Custodian also list DAT-007 as an owner on crosswalk row **CM-009** (which currently owns the connector/run-JWT half of the broker).

### G9 — Coding-adapter scope: **Option 1 (claude + codex)**
v1 sandboxed coding = `claude_local` + `codex_local` (fully wired + W8-validated). `gemini_local`/`opencode_local` = tracked follow-up once in-VM MCP staging + provider mapping are proven. Non-CLI adapters (`cursor`/`http`/`hermes_local`/`openclaw`/`process`) are out of scope for the sandbox path by design and keep the legacy route. Rejected: Option 2 (four CLIs — extra validation load off the critical path) and Option 3 (all adapters — category error for non-CLI adapters).
- **Recorded as:** `program-design.md` → **CLI-002** outcome/acceptance edited (mirrors CM-007's readiness matrix; fail-closed for out-of-scope adapters).

### B1 — Parity/cutover tickets: **exempt from the ≤3-day DoR**
MIG-002/004/005/008 and JOB-010–014 are exempt (bounded wiring/parity over existing engines; size dominated by test matrices, not new code). Exemption is non-transitive.
- **Recorded as:** `program-design.md` → Definition of Ready, exemption clause.

### B2 — Freeze main before work begins
The program executes against a frozen, pinned `origin/main` SHA; every gate/row/ticket verifies against it (not a local checkout, which may lag). Advancing the SHA is a Migration-Custodian decision that re-opens affected crosswalk rows.
- **Recorded as:** `current-main-crosswalk.md` → "Execution freeze" clause in the baseline section. The exact frozen SHA is filled in at freeze time.

## Net effect on the Round-1 findings

| Finding | Round-2 state |
|---|---|
| G2 | **Resolved by decision** (CAV-005 — accepted, no retrofit) |
| G7 | **Resolved** (DAT-007 ticket) |
| G9 | **Resolved** (CLI-002 = claude+codex, Option 1) |
| B1 | **Resolved** (DoR exemption) |
| B2 | **Resolved** (freeze clause) |
| G5 | Remains a defensible partial (gated by D3/D4 + CAV-001); optional upfront spike not adopted |

All Round-1 findings are now either addressed by the hardening pass or resolved by these decisions. G5 stands as an accepted design choice.

## Files touched by this record
- `accepted-caveats.md` (CAV-005)
- `program-design.md` (DoR exemption; CLI-002 scope; new DAT-007)
- `current-main-crosswalk.md` (execution-freeze clause)

*Prior review artifacts: `2026-08-07-320-reconciliation-review.md` (Round 1), `2026-08-08-hardening-verification.md` (Round 2 verification).*
