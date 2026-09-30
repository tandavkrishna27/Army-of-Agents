# DAT-008 slice 7 — Result: warm-resume re-resolution — **DEFERRED**

**Status:** DEFERRED (no code, no test). **Epic:** `E5-workspaces-secrets`. **Sprint:** 4.
**Design / analysis:** [`DAT-008-slice-7-design.md`](./DAT-008-slice-7-design.md) (Start SHA `bc288f004`).
Line references are to `docs/replatform-program` at `bd178603f`.

---

## 1. The decision, and the evidence for it

Slice 7 would re-resolve a handle when a **warm** sandbox resumes. **It has no mechanism to attach
to on the distributed path, so it is deferred** — the go-book Sprint 4 card anticipated exactly this
and instructed: *"If warm resume STILL has no production mechanism (no lease pause/resume), slice 7
has nothing to attach to — SAY SO and defer it rather than building against an absent mechanism."*

Verified at tip (also re-confirmed by the Sprint-4 completeness critic):

- `EffectAuthority.resume()` (`packages/worker-daemon/src/supervisor/effect-authority.ts:94-97`) →
  `SandboxProvider.restore()` has **zero production callers**. A grep of `worker-daemon/src` (minus
  tests) for `.resume(`/`.checkpoint(` returns only the method definitions. Sprint 3 composed
  create → execute → destroy, not resume — the prior scope note's *"provider.restore has no
  production caller"* is **still true**.
- There is **no distributed lease pause/resume**. The only "pause" is REL-004 `drain_paused`
  (`poll/poll-loop.ts:659-669`), a poll drain, not a sandbox checkpoint/restore.
- The frozen wire has **no** pause/resume/warm/checkpoint/restore op
  (`WORKER_PROTOCOL_OPERATIONS`, `packages/worker-protocol/src/transport.ts:757-768`).
- The one **live** warm-resume — the server warm-lease lifecycle (`environment-runtime.ts:485-530`
  resume / `:665-687` pause) — is the **legacy #320 host-executor substrate**, the path
  `DAT-008-terrain.md` §0 warns is not the distributed one, and the path **MIG-005 will replace**.
  Attaching slice 7 to it would harden the code MIG-005 is meant to retire, on the wrong
  abstraction, and would be "inventing the mechanism" — forbidden by go-book §4.

## 2. Why deferring leaves nothing unprotected

Cold-lease re-resolution — the CM-013 clause DAT-008 actually owns — is already free and now real on
the worker (slice 5): every new lease re-resolves per redemption. The rotation/revocation residual is
bounded and honest (parent §8): a key rotated mid-run is picked up at the next new lease, and handle
revocation makes the next redemption fail closed. Until a distributed warm-resume path exists, "next
lease" is the only resume boundary, and cold re-resolution covers it. Deferring slice 7 leaves no
distributed capability unprotected, because there is no distributed warm path.

## 3. No gate clause promoted or falsely green

E5 carries no `warm-resume` gate clause, so nothing goes falsely green by this deferral. `E5-5-redaction`
(wired by slice 5) is unrelated. No finding is filed: an absent, out-of-scope future mechanism is not
a defect in shipped code.

## 4. What a future slice 7 needs (recorded so it is not forgotten)

A distributed lease pause/resume (or reuse-by-key) lifecycle that drives `EffectAuthority.resume()`
from production, a provider advertising `restore` on the distributed port, and the MIG-005 cutover
routing warm-E2B leases onto the distributed path. Only then does "redeem again, compare, tear down
if changed" have a place to run. Slice 5's redemption path (`resolveExecutionSecret` +
`synthesiseRunSecrets`) is a pure function over the handle + fence and is callable again at that
future boundary — nothing in slice 5 forecloses it. Ownership sits with the MIG-005 cutover era /
long-running-lifecycle work, not DAT-008. This document is the standing record.
