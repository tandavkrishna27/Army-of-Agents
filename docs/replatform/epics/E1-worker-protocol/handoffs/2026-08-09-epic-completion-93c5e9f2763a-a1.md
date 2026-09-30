# Handoff — E1-worker-protocol epic completion

**Date (UTC):** `2026-08-09`
**Epic:** `E1-worker-protocol`
**Record path:** `docs/replatform/epics/E1-worker-protocol/handoffs/2026-08-09-epic-completion-93c5e9f2763a-a1.md`
**Gate slug:** `epic-completion`
**Reviewed revision:** `93c5e9f2763a16ce17507fde11b8cac770d5478a`
**Attempt:** `1`
**Supersedes:** `none`
**Decision:** `fail`
**Gate owner role:** `Integration Gate Owner`
**Gate owner identity:** `E1 integration-gate owner subagent (Claude)`

> This file is immutable from its first commit. A correction, rerun, changed decision, or changed revision creates a higher attempt and links this path through `Supersedes`.

The gate owner did not implement or review any PRT ticket. All seven ticket ledgers were read and independently confirmed `complete`/`approved` with a distinct implementer≠reviewer and an ancestor reviewed revision (the literal plan Step-1 block throws on PRT-004's annotated `Reviewed revision:` line — finding **E1-F006**, non-blocking; substance re-verified with a tolerant extractor). Every focused E1-scope suite, the integration signals, the repository suite (DEC-03), and the D0 3× stability loop were independently re-run on the recorded revision. The blob SHAs below were recomputed with `git rev-parse HEAD:<path>`; each reviewed implementation SHA was confirmed a commit and an ancestor of HEAD.

**This gate does not pass.** A REQUIRED focused E1-scope check (the packed protocol import smoke `scripts/check-worker-protocol-package.mjs`, also a D0 stability-loop member) is RED on the recorded revision — finding **E1-F007**. E1 remains in `gate_review`.

## Included ticket results

| Ticket | Ticket-result path | Ticket-result Git blob SHA | Reviewed implementation SHA | Latest review disposition |
|---|---|---|---|---|
| PRT-001 | `docs/replatform/epics/E1-worker-protocol/tickets/PRT-001-result.md` | `7feb5859eabbbf6bd45b1d2155a2d3c37f48ffe9` | `7e0f37e1b1e78564ddbda9708485b592087a5380` | `approved` |
| PRT-002 | `docs/replatform/epics/E1-worker-protocol/tickets/PRT-002-result.md` | `5023c9e35cada1b391da85eac3440260013ee9ee` | `26f6f61d921b3185d4b697e09b45dba27eaec688` | `approved` |
| PRT-003 | `docs/replatform/epics/E1-worker-protocol/tickets/PRT-003-result.md` | `165414ad1bf2f986d8c2e526a0dcf2a637ad46bd` | `e62921b1743f9cbc33e6ecf79348a7f4bf5d5483` | `approved` |
| PRT-004 | `docs/replatform/epics/E1-worker-protocol/tickets/PRT-004-result.md` | `741c1a3feecf61bfa354b133144d0676728f709b` | `0a00e3f3a61f1e532b11fb526e209589f7a0fe69` | `approved` |
| PRT-005 | `docs/replatform/epics/E1-worker-protocol/tickets/PRT-005-result.md` | `0ecaa2f3191ae762b165c701e5717dea82a87127` | `36d3733e06555ca2b43529734d79f559a4e940a8` | `approved` |
| PRT-006 | `docs/replatform/epics/E1-worker-protocol/tickets/PRT-006-result.md` | `edf7e653ad3c865944e8c723a1a5f6c1f4aa1f4e` | `3cda34467978031c4b04a5f856a771c8d071fe08` | `approved` |
| PRT-007 | `docs/replatform/epics/E1-worker-protocol/tickets/PRT-007-result.md` | `f5f6b47fead8218b48631bb8809c9e043eba3ffd` | `c68053421ac53c5b49066b041c8fbcdd920dad62` | `approved` |

PRT-007 two-commit sequence — `BASELINE_SOURCE_SHA` = `b7a842870ce7509d8baa75409e0ab19da375c88a` (source commit, bare 40-hex, confirmed a commit and ancestor of HEAD); the freeze commit `c68053421…` is the reviewed revision.

## QA evidence

| QA record | QA revision | Lane | Attempt | Result |
|---|---|---|---:|---|
| `docs/replatform/epics/E1-worker-protocol/qa/2026-08-09-d0-e1-completion-93c5e9f2763a-a1.md` | `93c5e9f2763a16ce17507fde11b8cac770d5478a` | `D0` | `1` | `fail` |

## Threshold decision

| Requirement ID | Class | Required value/condition | Observed value | Evidence record | Decision |
|---|---|---|---|---|---|
| D0-T01 | REQUIRED | Each ticket's focused tests + typecheck/build + boundary + contract-manifest pass with zero failures | PRT-002…007 focused sets green; **PRT-001's packed-import smoke `check-worker-protocol-package.mjs` RED** (E1-F007) | QA `…-93c5e9f2763a-a1.md` | `fail` |
| D0-T02 | REQUIRED | Lifecycle-owning ticket tests the full legal/illegal matrix | PRT-002 full Cartesian + JSON-authority parity + forbidden cross-edge (19 tests) green | QA record | `pass` |
| D0-T03 | REQUIRED | ≥10,000 vectors for owned secret/path validators | PRT-003 wire-safety/job + PRT-005 path canary corpora run green in the 543/543 package suite | QA record | `pass` |
| D0-T04 | REQUIRED | Every affected valid/invalid protocol conformance vector | PRT-007 conformance (42) + contract (47) + cross-version (53) + frozen integrity all green; manifest `--check` OK | QA record | `pass` |
| D0-T05 | REQUIRED | Hermetic inputs — no network provider, customer data, or live credential | protocol checkers `node:*`-only offline; no secrets | QA record | `pass` |
| D0-R01 | REQUIRED | `pnpm -r typecheck` + `pnpm test:run` + `pnpm -r build`; DEC-03-governed | typecheck 0; recursive build 0; `test:run` exit 1 all pre-existing non-E1 environment; worker-protocol 543/543; zero E1-touched test-file failure | QA record | `pass` |
| D0-R02 | REQUIRED | Authoritative root `pnpm build` passes; no tracked-byte change; network-free | `pnpm build` 0; byte-clean after | QA record | `pass` |
| D0-R03 | REQUIRED | Every designated critical suite passes 3 consecutive runs, zero flaky | boundary + boundary-mutation + package `test:run` green 3×; **package-smoke RED 3×** (E1-F007) | QA record | `fail` |
| D0-R04 | REQUIRED | Byte-clean worktree after the gate; all commands/exits/counts retained | `git status --porcelain` empty; `git diff --exit-code` 0; all retained | QA record | `pass` |
| H-04 | HARD | Secret containment — zero known secret-canary values in envelopes/argv/URLs/events | wire-safety + job/event/transport canary corpora + envelope credential-key rejection green; no secret in artifacts | QA record | `pass` |
| H-01/02/03/05/06/07/09 | HARD | Distributed-runtime + hosted-exclusion invariants | `not_applicable` at E1 (wire contract, no runtime constructed); proved by owning tickets at D1+; H-07 established at E0 | QA record | `recorded` |
| H-08 | HARD | Supply chain — approved digests/provenance | Partial: frozen v1 consumer pins zod/esbuild + integrity + deterministic re-bundle; full image signing is D5+ | QA record | `recorded` |
| H-10 | HARD | No failing run overwritten/hidden without a new immutable record | this `fail` record committed immutably at first write | QA record | `pass` |
| E1 exit gate — package contract | REQUIRED | Package build/typecheck/tests pass; packed public surface + consumer import smoke hold | build/typecheck/543-test pass; **packed consumer import smoke RED** (E1-F007) | QA record | `fail` |
| E1 exit gate — frozen conformance | REQUIRED | Vectors hash-pinned; frozen baseline independent; bidirectional cross-version `baseline_established` | contract-manifest OK; frozen integrity OK + 12/12; cross-version 53/53 `baseline_established` | QA record | `pass` |
| E1 exit gate — source boundary | REQUIRED | Runtime source has no Node/server/db/adapter/UI imports | boundary PASS + 50/50 mutation, green 3× | QA record | `pass` |
| E1 exit gate — execution-source provenance | REQUIRED | Six source variants round-trip; only `task_run` carries `runId`/`issueId`; fabricated/cross-source fails closed | PRT-003 source/job suites green | QA record | `pass` |
| DEC-01 | REQUIRED | Owner records pass/fail on one revision; REQUIRED failure is fail; epic-touched failure always fail; no hard-invariant failure | `fail` on `93c5e9f2763a…`; blocker is epic-touched (E1-F007), non-waivable; zero hard-invariant violation | QA record | `fail` |
| DEC-03 | REQUIRED | REQUIRED repository-suite failures ⊆ attributed baseline in the gate environment; new/epic-touched failure is fail | Repository `test:run` failures are pre-existing non-E1 Windows-local environment (no E1-touched test-file failure); the gate fails on the **focused** E1-scope smoke (E1-F007), not the repository baseline | QA record (DEC-03 statement) | `recorded` |

A handoff cannot pass with any required condition/command failure or HARD/INITIAL failure. There is a REQUIRED failure (D0-T01, D0-R03, and the E1 package-contract exit-gate bullet, all via E1-F007), so the decision is `fail`. There is no hard-invariant violation. `blocked_external` does not apply (the blocker is an internal E1 deliverable defect, not an unavailable provider/environment).

## Decisions and findings

**Locked decisions (plan-alignment, no wire-contract change; approved by the operator acting as custodian):**
- **E1-D001** — PRT-002 lifecycle maps are authoritative from `docs/architecture/distributed-execution-lifecycles.json`, enforced by a byte-for-byte parity test.
- **E1-D002** — PRT-006 golden-journey checks are vocabulary/enum-membership parity, not full-object parse.

**Findings:**
- **E1-F001…F005** — resolved during PRT-002/003/004/006 review (see `findings.md`); E1-F004 (fail-open extension byte-sizer) and E1-F005 (event-extension under-enforcement) were High-severity and are RESOLVED-and-re-verified; none blocks this gate.
- **E1-F006 (Low, non-blocking)** — PRT-004's `Reviewed revision:` summary line carries trailing attempt annotation that the literal Task-8 Step-1 regex rejects; substance independently re-verified (commit + ancestor). Recommend the Step-1 regex tolerate trailing annotation and future reviewers keep the summary line to a bare backticked SHA.
- **E1-F007 (High, GATE BLOCKER, OPEN)** — `scripts/check-worker-protocol-package.mjs` is RED on the gate revision: (a) the consumer smoke never provisions the package's declared `zod` runtime dependency into the temp consumer (`ERR_MODULE_NOT_FOUND: zod`), and (b) `tests/fixtures/worker-protocol-import/worker-consumer.mjs` hard-asserts the stale PRT-001 two-constant public surface (now 275 exports). Both files are E1-touched; latent since PRT-002 because the smoke was never re-run and is not wired into CI. The shipped wire contract is otherwise green. Scoped remediation: provision `zod` into each consumer `node_modules`; replace the hard-coded surface assertion with a tolerant check (keep the deep-subpath encapsulation assertions); consider wiring the package smoke into the always-on CI policy job; then re-run the Task-8 gate on the resolving revision (new superseding QA + handoff).

## Compatibility and rollout

- **Protocol/schema compatibility:** E1 introduces `@armyofagents/worker-protocol` v1 (`PROTOCOL_VERSION = 1`, `MIN_PROTOCOL_VERSION = 1`). The v1 contract (`docs/contracts/worker-protocol/v1/`) and the independent hash-pinned frozen consumer are `baseline_established`; the first freeze records no fictional prior-version proof. The only runtime dependency is `zod@3.24.2`; `pnpm-lock.yaml` regenerated with the package importer.
- **Boundary:** runtime source under `packages/worker-protocol/src` imports only `zod` + relative modules (boundary checker green 3× + 50/50 mutation corpus); zero `server`/`ui`/`packages/db` source touched. No database schema, HTTP route, scheduler, worker, provider SDK, browser, or UI added.
- **Rollback/disable path:** E1 is additive leaf-package + additive root config; it constructs no runtime and changes no existing behavior. Reverting the E1 commits removes the package with no downstream migration.
- **Residual risk / blocker:** the packed-import smoke (E1-F007) must be fixed and the gate re-run green before E1 completes. The DEC-03 Linux-CI repository-baseline formalization is a separate, non-blocking recommendation.

## Next unblocked work

E1 is **not** complete; it remains in `gate_review` pending the E1-F007 fix and a re-run Task-8 gate. The remediation is scoped (harness + fixture, no protocol-contract change) — the wire contract itself is green on this revision.

- **E2 (Tenant kernel)** is independent of E1 and may start now from the accepted E0 completion handoff without waiting for E1; its epic-level E0 dependency is satisfied.
- Once **both E1 and E2** are green on main, the next planning order is:
  1. **E3/E4 core planning** against both accepted handoffs.
  2. **JOB-001 / JOB-002 / WRK-001** core bootstrap, then **JOB-009 / JOB-003 / WRK-004**.
  3. **E6 DEP-000 through DEP-004** and the named **`E6-D1-FOUNDATION`** gate.

No downstream implementation begins merely because E1 types compile; each dependency epic's gate must be green on main.
