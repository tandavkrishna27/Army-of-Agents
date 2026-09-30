# WRK-008 slice 2 Result — the daemon now says why it does not dispatch

**Status:** LANDED as **slice 2a**. **Slice 2b — actually composing the supervisor and poll
loop — is NOT in this push**, and §2 says exactly what that means. Read that before reading
"dispatch" anywhere below.
**Epic:** `E4-worker-daemon`. **Start SHA:** `1777923c3`
([`WRK-008-slice-2-design.md`](./WRK-008-slice-2-design.md)).

---

## 1. What landed

| Piece | Where |
|---|---|
| `decideDispatchComposition` — the decision, with a REASON | `lifecycle/compose-dispatch.ts` |
| `AOA_WORKER_DISPATCH_ENABLED` — strict parse, default OFF | `config/config.ts` |
| `provider?: SandboxProvider` seam on `BootstrapDeps` | `bin/worker-daemon.ts` |
| The decision wired into boot, logging the reason | `bin/worker-daemon.ts` |
| `assembleWorkerSelfModel` — response → branded self-model, or null | `identity/self-model.ts` |
| `selfModelRead` client op + `SELF_MODEL_READ_PATH` + local descriptor | `transport/client.ts` |
| **A repo-level route-path parity guard**, wired into `policy` and declared | `scripts/check-worker-path-parity.mjs` |

**26 mutants, 26 killed, 0 survivors, 0 false kills** (10 decision + 5 assembly + 4 boot
wiring + 4 config + 3 parity guard). 18 new tests; the package is **123 files / 701 tests**
green, `tsc` clean, and every repo guard passes.

## ★ 2. What this does and does NOT do — read this before believing the title

**It does:** make a worker that takes no work explain itself. Before this the daemon was
*silent*: the health server said "up", the process stayed alive, and an operator had nothing
to act on. Now every boot logs a machine-readable reason naming which of four different
places the fix lives in.

**It does not:** dispatch anything. The `compose: true` branch is **unreachable in
production today**, because `hasSelfModelReader` is `false` until slice 2b threads the
session lifecycle through. And `client.selfModelRead` — added here so the parity guard has
something to pin — has **ZERO callers**. Stated plainly rather than implied, because this
programme's worst defects have all been things that looked wired and were not.

The distinction I am relying on, and it is worth naming: an unwired **security guard** is
actively dangerous, because it manufactures confidence that something is enforced. An
unwired **transport method** is inert plumbing that claims nothing. The first is the defect
class this programme keeps finding; the second is an ingredient. `selfModelRead` is the
second — but the moment anyone describes it as "the worker reads its self-model", it has
become the first.

## ★ 3. The design's fourth question turned the plan's largest risk into a non-risk

The Wave-4 plan named this as the biggest single risk in the wave:

> *"Composing the loop therefore turns dispatch on unconditionally, for every daemon running
> that build, including both D1 workers, the moment it merges."*

**It cannot.** `SupervisorDeps.provider` is required; worker-daemon defines the
`SandboxProvider` port and implements it **zero** times; the only implementation
(`E2bSandboxProvider`) lives in a package that **depends on** worker-daemon, so importing it
would be an E4-D01 breach *and* a dependency cycle; and `sandbox-fake-provider` implements
the *other* port (the contract driver — the open E6-F008 item), so it is not a substitute.
The shipped entrypoint injects nothing and cannot acquire one.

So dispatch is off **by construction**, in the same inert-by-absence shape
`leasing`/`renewal`/`reconciler` already use — a stronger guarantee than a flag.

**The flag still ships, placed where it can actually fire.** It gates composition *given* a
provider. Absence-of-provider covers today's binary; the flag covers the day a composition
root exists. A flag only ever exercised in the state where the answer is already "no" would
be a guard that can never fire — so the tests reach that row by injecting a provider, which
is the only way it is currently reachable at all.

**The consequence nobody had written down:** the composition root **lives outside this
package** and does not exist. Choosing where (a new `worker-host`, or a bin inside
`sandbox-e2b-provider` — DSK-003 also ships a desktop host) is a package-topology decision
with a release dimension, and it is not E4's to make alone.

## ★ 4. Three things I got wrong, caught by the process rather than by review

**A refusal suite passing for the wrong reason.** My first assembly tests passed
`registeredProfile: {}` to every refusal case. That fails the *registered-profile* parse — so
"refuses a profile whose digest does not recompute" was green because of a different field
entirely, and would have stayed green with the digest check deleted. A **positive control**
(a correctly sealed profile that assembles) exposed it immediately; two later mutants were
killed by that control alone. A refusal suite with no positive control cannot tell
"correctly refused" from "never got there".

**A fixture that skipped instead of failing.** The same suite built its profile in a helper
that returned `null` on failure, and every caller did `if (!profile) return;`. The day the
frozen shape moved, three tests would have **silently passed while asserting nothing** — the
"a guard that passes because it could not evaluate anything" trap, for the fourth time in
this programme. Now it uses the existing `poll-fixtures` builders, which already throw.

**A catch block whose comment described an impossible case.** Mutation left four assembly
mutants alive; all four were dead code, including a try/catch around the branding call with a
confident comment about a caller-supplied hash function that throws.
`verifyAndBrandProviderConstraintProfileV1` **already catches that** and returns null
(`capabilities.ts:258-262`), so my handler was unreachable and my explanation was wrong.
This is the third time mutation testing has refuted a comment of mine about my own code.
All four were deleted; the file is now five load-bearing lines and 5/5 mutants die.

## ★ 5. A fourth refusal reason, added to avoid pointing at the wrong person

The obvious wiring was `selfModel: null` — which reports `no_self_model`, whose message is
*"an admin must set a placement profile"*. That would send an operator to ask an admin for a
profile **that may already be set**, for a worker whose actual problem is unbuilt code.

So `no_self_model_reader` is distinct: *"this build cannot read its own self-model yet
(slice 2b); this is NOT a target-configuration problem"*. A message that points at the wrong
person is worse than no message. It retires when 2b lands, and a mutant collapsing the two
messages is killed.

## 6. The parity guard, and why it is a script

The device proof is signed **over the request path**. If the daemon's vendored constant and
the server route drift, the symptom is not a 404 — it is a signature that can never verify on
a request that reached the right handler, which reads as a crypto bug and sends the reader
nowhere near the renamed route.

Neither side can import the other (E4-D01 one way; `server` has no worker-daemon dependency
the other), so a test in either package would have to read the other's source as text and
would skip silently wherever that file is absent. A repo-level guard has the whole tree by
definition. It is wired into `policy` and declared in `guard-inventory.json` — which
**caught it as undeclared the moment it was written**, exactly as intended.

It is mutation-tested in three directions, including the one this programme keeps walking
into: a route name present **only in a comment** does not satisfy it.

## 7. The other three design questions, as answered

- **Q1 — no placement profile ⇒ fail closed**, with the product-visible consequence asserted
  deliberately: **enrolment alone does not produce a dispatchable worker**.
- **Q2 — no client-side refresh, and that is not a gap.** Verified, not assumed:
  `job-leasing.ts` re-checks `deviceGeneration` and `revokedAt` on **every** poll and again
  under the lease lock, and the daemon treats `target_revoked` as terminal. A stale
  self-model cannot buy a lease; a refresh loop would add a second, weaker authority for
  something the poll path already decides.
- **Q3 — ordering.** A failed read leaves the daemon **healthy and inert**, which is the
  state it ships in today, so no new failure mode is introduced.

## 8. Next

1. **Slice 2b** — session lifecycle → `client.selfModelRead` → `assembleWorkerSelfModel` →
   construct supervisor + poll loop behind `compose: true`. This is where dispatch begins,
   and where `selfModelRead` acquires its first caller.
2. **The composition-root decision** (§3) — a programme-level call, not E4's alone.
3. **DAT-008 slice 5** — worker redemption + env synthesis, which needs 2b to be provable
   end to end. Note the plan's §4.1 finding still stands: `redactionCanaries` is
   per-supervisor, not per-run, and slice 5 must fix that before it can seed anything.
