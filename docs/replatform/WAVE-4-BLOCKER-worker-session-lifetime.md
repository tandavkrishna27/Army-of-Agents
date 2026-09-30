# Wave 4 blocker — a worker cannot hold authority for more than 15 minutes

**Found:** 2026-08-24, mapping terrain for WRK-008 slice 2b (composing the poll loop).
**Verified in code at branch tip**, not taken from the documents that describe it.
**Status of the underlying finding:** `E4-F007`, **open**, severity **HIGH**, filed by
WRK-002's adversarial review, escalated "to E3/JOB-002" — and **no ticket owns it.**

---

## 1. The fact, verified rather than cited

| Fact | Evidence at tip |
|---|---|
| Enrollment code route lives **10 minutes** | `worker-enrollment.ts:22` `CODE_TTL_MS = 10 * 60_000` |
| A device session lives **15 minutes** | `worker-enrollment.ts:23` `SESSION_TTL_MS`; `worker-session-auth.ts:15` `SESSION_MAX_MS`, enforced at mint **and** verify |
| A session is minted **only** by enrollment | `createWorkerSessionToken` has exactly two call sites, `worker-enrollment.ts:369` (replay) and `:489` (enroll) |
| There is **no** device-session renewal route | the only `renew` on the worker surface is `/worker-control/leases/:leaseId/renew` — a **lease fence**, audience `worker_run` |
| Poll does not slide the session | no re-issue on `/worker-control/poll` or lease ack |

**Therefore:** a worker enrolled at T0 loses its replay path at **T0+10min** (the code route
gates all replays) and its authority at **T0+15min**, and has no way to obtain a fresh
session. The poll loop then stops with `reenrollment_required` — correctly, and permanently.

This is not a race or an edge case. It is the steady state of every worker.

## ★ 2. Why this lands on Wave 4 now

WRK-008 slice 2b composes the poll loop and supervisor — the step where the daemon starts
taking work. Composing it against the current server produces **a worker that dispatches for
at most fifteen minutes and then stops for good**, recoverable only by a human pasting a new
enrollment code. DSK-001 already said the quiet part: *"'Re-paste a code every 10 minutes' is
not a shippable UX."*

So the blocker is not slice 2b's to solve, and slice 2b cannot honestly claim to deliver
live dispatch while it stands.

**Everything downstream inherits it:**

- **MIG-005 / MIG-006 / MIG-007 ACTIVE** route real Commander turns, crew dispatch and
  extraction to a worker. A 15-minute authority ceiling is not a cutover target.
- **DSK-003's background desktop host** — DSK-001's own risk register calls it
  *"unshippable without it"* (R1), and recommended filing the successor **"now, before
  DSK-003 is planned."** DSK-003 has since shipped. The successor was never filed.
- **DAT-008 slice 5** (worker credential redemption) needs a live worker to be provable.

## ★ 3. This is the fourth unscheduled blocker, and the pattern is now the finding

| # | Blocker | How it was found | Owner when found |
|---|---|---|---|
| 1 | Deferral #1 — a worker receives no provider credential | Wave-2 deferral, re-read | none → **DAT-008** (created) |
| 2 | E4-D12 — the worker does not dispatch at all | terrain for DAT-008 slice 5 | none → **WRK-008** (created) |
| 3 | No composition root can supply a `SandboxProvider` | designing WRK-008 slice 2 | **none** |
| 4 | **E4-F007 — a worker cannot stay authorised** | terrain for WRK-008 slice 2b | **none** |

Each was found the same way: reading the code underneath a sentence the plan had already
written, one level deeper than the last. Three of the four were already **documented** —
E4-F007 has a findings entry with severity HIGH, and DSK-001 has a risk register entry
recommending the fix be filed. Documenting a blocker is not scheduling it.

**A finding with no ticket is indistinguishable from a finding nobody had**, and this
programme has now proved that four times. The mechanical fix is the one already used for
guards and test suites: `check-ticket-graph-coverage.mjs` fails when a ticket *file* has no
node in `program-design.md`. Nothing yet fails when an **open HIGH finding** has no ticket at
all. That is the same shape of hole, one register over.

## 4. What the fix looks like (not taken here)

DSK-001 already scoped it, and the material exists:

> *"the fix is a device-proof-bound renewal endpoint, and the material exists
> (`worker-session-auth.ts:130-141` re-verifies key + thumbprint per operation)."*

`IdentityLifecycle.acquireSession()` was deliberately landed as the drop-in seam for exactly
this successor, so the daemon side does not need reshaping.

**The decision this needs is ownership, not design**: a server-side ticket in E3 (JOB-002's
family, where the escalation was addressed) versus E4 (where the finding lives, and which has
already been reopened once for WRK-008). It is a programme call, and it is the same call
still outstanding for blocker #3.

## 5. What is safe to build meanwhile

**Slice 2b is still worth building, and is safe**, because dispatch remains off by
construction: the shipped binary injects no `SandboxProvider` and cannot acquire one
(blocker #3), so composing the loop changes nothing in production, including for both D1
workers. It is provable by injection in tests.

What it must **not** do is claim to deliver a dispatching worker. With blockers #3 and #4
open, a composed loop is a tested mechanism waiting for two things it does not own.
