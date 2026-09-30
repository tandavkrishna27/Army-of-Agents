# Handoff — E0-foundation epic completion

**Date (UTC):** `2026-08-08`
**Epic:** `E0-foundation`
**Record path:** `docs/replatform/epics/E0-foundation/handoffs/2026-08-08-epic-completion-3a469b6bec68-a1.md`
**Gate slug:** `epic-completion`
**Reviewed revision:** `3a469b6bec687a3055360dcd657df45b7d20ba88`
**Attempt:** `1`
**Supersedes:** `none`
**Decision:** `pass`
**Gate owner role:** `Integration Gate Owner`
**Gate owner identity:** `E0 integration-gate agent (Claude)`

> This file is immutable from its first commit. A correction, rerun, changed decision, or changed revision creates a higher attempt and links this path through `Supersedes`.

The gate owner did not implement or review any FND ticket. The fast conditions (commit/file boundaries + the four dependency-free critical suites, three consecutive times) were independently re-run; the heavy commands were captured by the controller and spot-checked against their retained logs. All eight ticket ledgers were read and confirmed `complete`/`approved` with a distinct reviewer and an ancestor reviewed revision. The blob SHAs below were recomputed with `git rev-parse HEAD:<path>` at the reviewed revision; each reviewed implementation SHA was confirmed a commit and an ancestor of HEAD.

## Included ticket results

| Ticket | Ticket-result path | Ticket-result Git blob SHA | Reviewed implementation SHA | Latest review disposition |
|---|---|---|---|---|
| FND-001 | `docs/replatform/epics/E0-foundation/tickets/FND-001-result.md` | `0b034d832f92f572871101f21fde47004cc8bea9` | `490049551ef57bc741ec4e0d51238bdb1ce96e69` | `approved` |
| FND-002 | `docs/replatform/epics/E0-foundation/tickets/FND-002-result.md` | `8ba97254c81b5d35344dbf75fd1fe2f7c5bffe95` | `f5e45cf2b2a3ddf588307e2cba12ec2d183925f6` | `approved` |
| FND-003 | `docs/replatform/epics/E0-foundation/tickets/FND-003-result.md` | `80912208c12ddfab8002ced825bf5c63d1535e07` | `09651fb63ee24c4b14aadabbd30cfa3450f7b696` | `approved` |
| FND-004 | `docs/replatform/epics/E0-foundation/tickets/FND-004-result.md` | `636800b48847220389abe0980ad92806051b9cdc` | `3f10606a5c8716515d37df68a806145c39b66552` | `approved` |
| FND-005 | `docs/replatform/epics/E0-foundation/tickets/FND-005-result.md` | `e31210568c4f0adfc73637bc8f5a6dd9134cbc69` | `196d66403f6228e746c3145b2199dba8b4041b68` | `approved` |
| FND-006 | `docs/replatform/epics/E0-foundation/tickets/FND-006-result.md` | `9813d2f8e1fdd27211f1089c620d9d07fa4ec356` | `f916457bece74bc524349021571d506dbef8f9cc` | `approved` |
| FND-007 | `docs/replatform/epics/E0-foundation/tickets/FND-007-result.md` | `81e65764f608f745b4599e98da76e49979bea1df` | `419400291a0b3e96725b9fc1c5d386d3253fec4a` | `approved` |
| FND-008 | `docs/replatform/epics/E0-foundation/tickets/FND-008-result.md` | `f5611f978f59bc55dbcd5fb9d07d5422c8ef88bb` | `0f04cc747c7054ba860de2401756430934f5c6c2` | `approved` |

## QA evidence

| QA record | QA revision | Lane | Attempt | Result |
|---|---|---|---:|---|
| `docs/replatform/epics/E0-foundation/qa/2026-08-08-d0-e0-completion-3a469b6bec68-a1.md` | `3a469b6bec687a3055360dcd657df45b7d20ba88` | `D0` | `1` | `pass` |

## Threshold decision

| Requirement ID | Class | Required value/condition | Observed value | Evidence record | Decision |
|---|---|---|---|---|---|
| D0-R01 | REQUIRED | `pnpm -r typecheck` + `pnpm test:run` + `pnpm -r build` on the exact revision; DEC-03-governed | typecheck 0; recursive build 0; `test:run` exit 1 with all failures in non-E0-logic Windows-local environment paths; every E0-touched file green (runs) or proven 86/86 on embedded PG | QA `2026-08-08-d0-e0-completion-3a469b6bec68-a1.md` | `pass` |
| D0-R02 | REQUIRED | Authoritative root `pnpm build` passes network-free with zero tracked-byte change | `pnpm build` 0; `bundled snapshot inputs: PASS`; byte-clean; snapshot checker + 12/12 corpus re-verified 3× | QA record | `pass` |
| D0-R03 | REQUIRED | Each critical suite passes 3 consecutive runs, zero flaky | 4 suites × 3 runs exit 0 (PASS; 169/169; PASS; 12/12) | QA record | `pass` |
| D0-R04 | REQUIRED | Byte-clean worktree after the gate; all commands/exits/counts retained | `git status --porcelain` empty; `git diff --check` clean; all retained | QA record | `pass` |
| D0-T05 | REQUIRED | Hermetic inputs — no network provider, customer data, or live credential | checkers `node:*`-only offline; local ephemeral PG; no secrets | QA record | `pass` |
| D0-T03 | REQUIRED | ≥10,000 vectors for an owned secret/path validator | `not_applicable` at E0 (no runtime validator owned); FND-004 canary + 169-case mutation corpus is E0-scope coverage | QA record | `recorded` |
| D0-T04 | REQUIRED | Every affected valid/invalid protocol conformance vector | `not_applicable` at E0 (wire protocol is E1/PRT); FND-004 froze the strict fixture schema + 9 fixtures + digest recompute | QA record | `recorded` |
| E0 exit gate | REQUIRED | Foundation checker + authority agreement; hosted unsafe-override regression; 9 golden fixtures + strict schema; complete trust-crossing control fields + Critical/High release tests; CM-*/CP-* owners + Decision #103 cloud-plugin exclusions in real `cloud_auth` with self-hosted green; D0 REQUIRED; repository typecheck/tests/recursive build/authoritative root build | All satisfied on `3a469b6be`: checker PASS 3×; FND-005 override regression green; FND-004 fixtures/schema/digests; FND-003 30 crossings + release tests; FND-006/007/008 CM/CP owners + 86/86 embedded-PG exclusions with self-hosted positives | QA record | `pass` |
| CP-001..CP-005 | REQUIRED | All five cloud-plugin crosswalk rows closed (E0 cannot pass otherwise) | CP-001 six-sink matrix + marker negative (FND-006); CP-002 zero-composition + reconcile (FND-006, 7/7); CP-003 503 envelope + MCP typed denial (FND-008); CP-004 reject-before-I/O + metadata reads (FND-008); CP-005 external-adapter exclusion preserved (FND-008) — 86/86 embedded PG | QA record; `e0gate-final.log` | `pass` |
| H-07 | HARD | Hosted exclusions impossible while disabled (public ingress, cloud-plugin execution, unsafe multi-tenant override) | Startup hard-reject of both reserved surfaces + `cloud_auth` override; 86/86 real-app cloud-plugin process/runtime/UI/MCP denial; self-hosted positives; no distributed runtime constructed at this revision (full runtime proof deferred to D1+) | QA record | `pass` |
| DEC-01 | REQUIRED | Owner records pass/fail on one revision; REQUIRED repository failure is fail unless DEC-03-covered; no hard-invariant failure | `pass` on `3a469b6be`; zero hard-invariant violations; `test:run` failures carry no E0-logic regression | QA record | `pass` |
| DEC-03 | REQUIRED | REQUIRED-suite failures ⊆ attributed baseline in the gate environment; new/epic-touched failure is fail | Windows-local operator-directed gate; Linux-CI authority NOT exercised; no E0-touched genuine failure (runnable E0 suites green + 86/86 embedded PG + all failures in pre-existing environment paths); baseline seed left as advisory, not overwritten | QA record (DEC-03 honesty statement) | `pass` |

A handoff cannot pass with any required condition/command failure or HARD/INITIAL failure. There is no required-condition or hard-invariant failure at this revision; the only non-blocking caveat is the DEC-03 Linux-CI formalization recommendation.

## Decisions and findings

**Locked decision**
- **Decision #121** (promoted, `docs/architecture/decisions.md`): Cloud control plane uses a fenced outbound worker protocol with distinct batch, browser-session, and service lifecycles. Linked from the E0 foundation authorities (lifecycles, authority, threat-model, delivery-policy, legacy-parity, current-main crosswalk) and locked across FND-001..007.

**Findings (all Minor and non-gate-blocking except E0-F009, which is Medium and fixed+re-verified before this decision)**
- **E0-F001** — ticket-result template vs Task-9 gate-regex Start SHA/Disposition format conflict. Disposition: resolved inline (bare Start SHA convention) + template fixed by FND-005. Does not block.
- **E0-F002** — FND-001 shared-checker hygiene carry-forward. Disposition: items 1–3 resolved in FND-002; item 4 (prose parity) open/optional. Does not block.
- **E0-F003** — structural-checker negation/row-pinning hardening. Disposition: applied by FND-003 (exact-set parity) and FND-007 (per-clause negation + count pin); open non-blocking hardening otherwise.
- **E0-F004** — threat-controls parity fields not in required-field set. Disposition: resolved in FND-004. Does not block.
- **E0-F005** — plan `createApp()` unit-import vs drizzle-ESM/embedded-PG constraint. Disposition: ratified by custodian; integration proofs moved to `*.integration.test.ts` (Windows-skip, embedded-PG-authoritative). Does not block; drives the DEC-03 Linux-CI caveat.
- **E0-F006** — build reproducibility: digest-manifest pin vs committed snapshot bytes. Disposition: ratified (D0-R02 split-refresh option); build is network-free + tracked-byte-clean. Does not block.
- **E0-F007** — FND-006 test-flip scope + FND-008 carry-forwards. Disposition: item 1 ratified; item 2 partially resolved in FND-008; item 3 (Linux-CI integration run) satisfied by the embedded-PG gate run (86/86). Does not block.
- **E0-F008** — FND-008 marketplace-install 404 (vs 503 stub) + residual minors. Disposition: ratified acceptable-interim (fail-closed, no I/O; CP-004 satisfied); comment/uniformity minors deferred to 1.1. Does not block.
- **E0-F009** — the embedded-PG gate run caught two defects the unit/typecheck/review layers missed: a sync-throw cloud-denial facade (fixed to async reject in `routes/plugins.ts`) and a stale c2 broker `404`→`403` assertion (code correct, test stale). Both fixed at `3a469b6be` and re-verified 86/86. Severity Medium; does not block (fixed before the decision).

No open finding blocks the gate.

## Compatibility and rollout

- **Protocol/schema compatibility:** E0 adds no wire protocol and no runtime schema/migration. The golden-journey fixture schema (`schema-v1.json`, draft 2020-12) is additive within `schemaVersion: 1`; breaking changes require a new versioned directory. `pnpm-lock.yaml` is byte-unchanged across the epic (no dependency added).
- **Flags/migration state:** the distributed-execution rollout flag defaults off; no distributed scheduler/adapter/route/worker/plugin-runner is constructed at this revision. FND-006 boot reconciliation is metadata-only and idempotent (safe on every replica during rolling upgrade).
- **Rollback/disable path:** the cloud-plugin denial is derived from the static `tenantIsolationEnforced()` deployment mode — there is no operator override and nothing re-enables hosted plugin execution; rollback retains the denial. Self-hosted `local_trusted`/`authenticated` plugin behavior is unchanged (positives green).
- **Active-work handling:** in the hosted `cloud_auth` parent no plugin worker/lifecycle/loader is composed, so there is no background plugin work to drain; new triggers are denied first (HTTP 503 at the gate; MCP typed denial before dispatch).
- **Residual risk (non-blocking):** the authoritative full-suite/integration baseline per DEC-03 must run on Linux CI; this gate ran Windows-local per the operator's explicit directive. A Linux-CI run at this revision is recommended to formalize; if it differed, it would create a superseding QA record and completion handoff (`Supersedes` → these records).

## Next unblocked work

- **E1 — Worker protocol** (`PRT-001` through `PRT-007`). E1 depends on E0 and consumes the frozen E0 authorities: the lifecycle/authority/threat-model contracts, the nine golden-journey fixtures + `schema-v1.json` + the shared RFC 8785 `eventDigest`/canonicalizer (PRT-004 reproduces byte-for-byte), and the frozen six execution-source kinds + legacy-parity/current-main crosswalk. E2 (Tenant kernel) and E6 (Deployment/test harness) also list E0 as a dependency and are unblocked at the epic level by this completion.
