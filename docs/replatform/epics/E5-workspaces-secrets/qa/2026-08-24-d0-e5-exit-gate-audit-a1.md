# QA — D0 — E5 workspaces/secrets exit-gate audit — `dd8d3c88e` — a1

## Record identity

| Field | Value |
|---|---|
| Date (UTC) | `2026-08-24` |
| Scope | Audit of the E5 exit gate as written in `E5-workspaces-secrets/README.md:6`. No code changed. |
| Supersedes | — (E5 has no prior QA record; this is the first) |
| Candidate code revision | `dd8d3c88e` |
| Topology | Live D1 two-replica stack (`docker-compose.d1.yml`), campaign `foundation`, 45 tests / 45 pass / 0 skipped |
| Formal authority | Linux CI under DEC-03 |
| Gate owner | `TBD — distinct reviewer` |
| Result | **`awaiting_review`** |

**This is implementer-observed evidence, not an independent gate decision. It does not mark E5
complete/pass.** It exists because E5 is currently recorded as `✅ complete` on a TICKET COUNT
(`HANDOFF-next-wave.md:40`, "7 / 7"), while the epic's own README defines completion as its exit
gate passing **in D1** — and those are not the same claim.

## The gate, verbatim

> **Exit gate:** immutable workspace staging, fenced object commit, patch conflict quarantine,
> lease-scoped secrets, redaction, denied egress, and the brokered internal tool surface
> (DAT-007) pass in D1.

## Candidate observations

| # | Clause | Candidate result | Basis |
|---|---|---|---|
| 1 | immutable workspace staging | `proven_weakly` | DAT-001's tests are real and run in `verify` — but its producer has **zero production callers**, and `job-leasing.ts:371` hardcodes `workspace: null`, so **no live lease ever carries a workspace**. Nothing in D1 touches it. |
| 2 | fenced object commit | **`proven_in_d1`** | `e6f-05-live-minio` (round-trip + truncated-upload fail-closed) and `e6f-14-orphan-sweep`, green against real MinIO-over-TLS. |
| 3 | patch conflict quarantine | `proven_weakly` | Real in-process tests; nothing in the D1 campaign. |
| 4 | lease-scoped secrets | `proven_weakly` | DAT-008's own result records slices 5/6/7 (worker-side redemption) as **deferred**, so the path is server-half-only; nothing in D1. |
| 5 | redaction | `proven_weakly` | In-process only. `e6f-08` non-disclosure and `e6f-10` tenant scoping are **adjacent**, not DAT-005 redaction. |
| 6 | denied egress | **`proven_in_d1`** | `e6f-08` — external, private-net, IMDS, ECS metadata, provider-socket, cross-job. |
| 7 | brokered internal tool surface (DAT-007) | **`not_proven`** | DAT-007's own result records that of four design items only one landed; the core (run-scoped fence binding, remote reachability) was **not built**. Nothing in D1. |

**2 of 7 clauses meet the gate as written. 4 are proven in a weaker sense than the clause reads.
1 is not proven at all.**

## ★ The pattern, stated plainly

In every weak case the **ticket documentation is honest** and the **epic gate sentence is not**.
DAT-001's design says outright it is *"a pure library … inert-until-wired (nothing calls it in a
live loop yet)"*; DAT-008's result names its deferred slices; DAT-007's result records what was
not built. None of them claimed more than they did.

What over-claims is the aggregation: seven tickets with result docs became `✅ complete`, and the
gate's own words — *"pass in D1"* — were never checked against the lane.

This is the same failure class this programme keeps paying for, at epic scale rather than
function scale: **a check that was never run, reported as a pass.**

## What this record does NOT assert

- It does **not** say the E5 work is bad. The tests behind the weak clauses are real, substantive
  and CI-covered; several are excellent.
- It does **not** propose relaxing the gate. If "pass in D1" is stricter than intended, that is a
  decision for the gate owner to make explicitly — not something to resolve by re-reading the
  sentence more kindly.
- It does **not** mark E5 incomplete either. That is the gate owner's call. This record supplies
  the evidence that call needs and which did not previously exist.

## Recommended disposition

1. **Correct `HANDOFF-next-wave.md:40`** so the status reflects the gate rather than a ticket
   count. (Done in the same commit as this record.)
2. **Gate owner decides** per clause: accept in-process evidence, or require D1 coverage.
3. **★ CORRECTION (same day, before anyone acted on it): there are no cheap clauses.** This
   record originally said clauses 3 and 5 were "the cheapest — real tests exist and would need a
   D1 harness case plus a nonce bump, exactly as `e6f-14` did". **That is wrong.** Checking what
   would actually close them:

   - **Patch conflict quarantine** — DAT-006's `runOrphanQuarantine` has no producer
     (`quarantineCandidates` is never supplied and `deps.reconciler` is never wired at
     `bin/worker-daemon.ts:311-313`), and DAT-003's `createResultCommitter` /
     `buildWorkspacePatch` / `createPatchApplyService` have **zero production callers**.
   - **Redaction** — `redactionCanaries` is `[]` at every production site, and
     `createFenceAwareEgressProxy` has **zero callers**, so no secret value is ever resolved.
     *Until a live egress path exists, redaction has no input and cannot be proven above unit
     level.*

   **So ALL FIVE non-passing clauses are build items, not coverage gaps.** Not one of them can be
   closed by writing a D1 test, because in each case the production path does not execute. That
   is a materially different — and more useful — statement than "some are cheap", and it points
   at the same wall as everything else: nothing is wired to a live worker.

4. **One thing here IS unblocked and worth doing on its own merits**, independent of the gate:
   `SupervisorDeps.redactionCanaries` is **optional with `?? []`** (`supervisor.ts:113,284`) —
   an omission-by-default in a *redaction* mechanism, where a caller that forgets silently gets
   no redaction at all. That is a fail-OPEN default in a security control and should be a
   compile error instead.
