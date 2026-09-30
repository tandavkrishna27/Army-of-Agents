# SPIKE — can one real worker daemon receive and execute one real job?

**Status: SPIKE. Throwaway by construction.** No code produced here may merge as production.
Started from `docs/replatform-program` at `43f886bc9`, run locally against the D1 compose stack.

**The single question:** can one real `worker-daemon` process, on the real two-replica D1 stack,
receive one real job offer and execute it to a durable terminal?

**Why this exists.** Five prerequisites for that sentence have now been discovered *mid-implementation*
rather than by the plan — inherited deferral #1, E4-D12, the matchable hello, session renewal
(E4-F007), and a real `SandboxProvider` for the daemon. Three of those surfaced today. The
discovery rate is not falling, and two guards shipped this session turned out to protect states the
system cannot reach. That is the signature of building upward without a proven skeleton.

**The deliverable is a LIST, not code.** Every blocker hit, in the order hit, with what it would
cost to fix properly. That list becomes the real Wave 4 plan, sequenced on verified dependencies
instead of ticket-to-ticket edges.

---

## Rules

1. **Hacks are allowed and expected.** Hardcode the hello, stub the session, inject any provider.
   The point is to reach the next blocker, not to be correct.
2. **Nothing here merges.** Any production change this motivates gets its own ticket, terrain,
   design and review. This document and its scratch code are evidence, not implementation.
3. **Timeboxed.** If the question is not answerable within the box, *that is the answer* and the
   list of what was reached is still the deliverable.
4. **Record every blocker at the moment it is hit**, with the observed error — not a reconstruction
   afterwards. Runtime evidence beat my own reasoning twice today; reconstruction is where that
   advantage is lost.

## The path under test

```
submit job ─► placement ─► lease offer ─► worker poll ─► ack ─► supervisor ─► provider ─► events ─► terminal
                                              ▲
                                       the daemon must first
                                       enrol + build a self-model
```

Each hop is a place the skeleton can stop. The spike walks them in order and records where it does.

## Predicted blockers (stated BEFORE running, so the spike can falsify them)

Writing these down first matters: a spike that only confirms what it expected has usually just
re-read its own notes. Anything the run adds to this list is the real value, and anything it
*removes* is equally valuable.

| # | Predicted blocker | Predicted symptom | Confidence |
|---|---|---|---|
| P1 | The D1 workers never enrol (`mounted_secret` gates the enrolment block) | daemon boots, serves `/healthz`, no enrol traffic | high — verified statically |
| P2 | Nothing composes the poll loop, so no poll is ever issued | no `POST /worker-control/poll` from a worker container | high — verified statically |
| P3 | The server matches on `workers.profile_snapshot` written at enrolment from an unmatchable `buildDesktopHello` | poll answers `no_work` forever, even with a job queued and a live target | high — verified statically |
| P4 | Worker session TTL 15 min, no renewal | loop stops with `reenrollment_required` | high — documented in DSK-001 |
| P5 | Only `createFakeSandboxProvider` is importable under E4-D01 | execution "succeeds" without running anything | high — verified statically |

**What would falsify the plan's current shape:** if P3 is wrong — if a worker CAN be offered a job
with the profile mechanism as built — then WRK-008 slice 2 is close to deliverable and the descope
was unnecessary. That is the single most valuable thing this spike can find out.

## Stop conditions

- **Answered YES:** a job reaches a durable terminal attributable to a real daemon. Record every
  hack required; each hack is a ticket.
- **Answered NO:** a blocker is reached that cannot be hacked past within the box. Record it and
  everything behind it that remains unverified.
- **Timebox exhausted:** record the furthest hop reached and what was still unknown.

## Findings

### ★ F1 — The shipped worker container has NO IDENTITY MECHANISM, only a key (P1, far worse than predicted)

P1 predicted "the D1 workers never enrol because `mounted_secret` gates the enrolment block". That
is true and it is the *shallow* version. The real shape, established from source:

1. The container entry passes **no stores at all**: `bootstrapWorkerDaemon({ env: process.env,
   proc: process })` (`bin/worker-daemon.ts:353`). `docker/worker/Dockerfile:112` runs exactly that.
2. `resolveCustody` **refuses** `mounted_secret` if a store *is* injected
   (`identity/device-identity-store.ts:128-133`) — so you cannot fix (1) by injecting one.
3. And the reason it refuses is the decisive fact: *"`MountedSecretKeyStore` persists PKCS8 DER with
   **no `workerId` slot**"* (`:118-120`). The mode holds a device **key**, not an **identity**.

`workerId` / `targetId` / `deviceGeneration` are minted **by enrolment** and persisted in the
`DeviceIdentityRecord` that only the OS-custody store holds. So a `mounted_secret` container has a
keypair and nothing to be. It cannot enrol, cannot hold a session, and therefore **cannot poll —
ever, under any flag**.

**Why this matters more than the flag framing.** Every plan to date, including my own E4-D12
terrain, treated live dispatch as "compose the loop behind a flag". There is no flag that reaches
this. The shipped container needs a **provisioning path that does not exist**: either a new custody
mode that carries an identity, or enrolment made reachable for containers, or an out-of-band
identity injection. None is designed, none is owned.

**Consequence for WRK-008 slice 2:** composing the loop in the shipped container produces a daemon
that cannot get past step one. The "default OFF" gate the execution plan called a hard requirement
is not merely unprovable in D1 (already recorded) — it is *irrelevant*, because ON is unreachable.

### F2 — Only `desktop-host.ts` can enrol

`packages/worker-keystore/src/bin/desktop-host.ts:254-260` is the sole caller that injects
identity + receipt stores, and it does so with `os_keychain`. So the **only** code path in the repo
that can produce an enrolled worker is the desktop host — not the container the distributed fleet
is built from. That inverts an assumption running through the programme: the containerised fleet is
the *less* provisioned of the two paths, not the more.

### ★ F3 — P3 is FALSIFIED. The matching mechanism WORKS; the gap is one missing builder

This is the most consequential finding and it is **good news**, so it deserves the same scrutiny as
a bad one.

The claim under test was *"the server matches on `workers.profile_snapshot`, written at enrolment
from an unmatchable hello, so a worker can never be offered a job."* The first half is true. The
conclusion is **too strong**, and the D1 lane disproves it on every run:

- `tests/d1/lib/e6f-harness.mjs:133-141` — *"The seed embeds POLICY_HASH + WORKER_CAPABILITIES into
  the registered target profile (capabilityCeiling) and the `buildWorkerHello()` output reuses them
  for reportedCapabilities/policyHash, **so the poll-time matcher … is satisfied**."*
- `buildWorkerHello` (`:208-220`) reports `reportedCapabilities: [...WORKER_CAPABILITIES]`,
  a real `capacity`, and `policyHash: POLICY_HASH`.
- `tests/d1/e6f-03-networked-smoke.test.mjs:6-9` — the *"enroll → (seeded submit + placement) →
  poll → lease → ack → fake-execute path works end to end, with genuine Ed25519 device proofs (no
  security check is weakened or bypassed)."*

**So submit → placement → lease → ack is proven working, live, on every D1 run.** What does not
exist is a *worker* hello builder: the daemon's only one is `buildDesktopHello`, whose header says
it exists to emit a desktop that *"can never be matched work"*.

**Why the distinction changes the plan.** "The mechanism cannot offer a worker a lease" would be a
deep architectural gap. "The daemon has no matchable hello builder, while a matchable hello is
demonstrated working in-repo" is a much smaller, well-precedented piece of work. The path *behind*
identity is not speculative — it runs green every night.

### F4 — A shipping build defect, found only by running (fixed in `bcf7cf21a`)

`packages/db`'s build was `tsc && cp -r src/migrations dist/migrations`. `cp -r` is not idempotent
against an existing destination: the first build is correct, and every later build copies *into* it
(`dist/migrations/migrations`), so `dist/migrations` keeps the FIRST build's contents forever. The
worktree held 213 stale `.sql` at the top level and 264 current ones nested inside.

The stack failed to come up with `role "aoa_operator" does not exist` — because the image contained
213 of 264 migrations, stopping exactly at `0213_e2_serving_role_correction`, the migration that
creates that role. The migration runner reported success; it had applied everything it *had*.

CI never sees this (its `dist/` starts clean). **Any developer who builds twice ships stale
migrations silently** — including migrations 0262/0263 from earlier today, so DAT-008 would fail
locally with "column does not exist" and nothing would point at the cause.

Invisible to every static check, to CI, and to reading the script. Ten minutes to hit once
something actually ran. **This is the argument for the spike, in one bug.**

### * F5 - Enrolment input is WINDOWS-ONLY, and the entire fleet is Linux

`assertLocalAbsolutePath` (`packages/worker-daemon/src/enrollment/enrollment-input.ts:58-72`)
normalizes `/` into a backslash and then requires `/^[A-Za-z]:\/`. A POSIX path — `/worker/state` —
becomes `\worker\state`, matches no drive letter, and throws `"path is not an absolute local path"`.

The function is careful and well-reasoned about hostile Windows path syntax (UNC, device namespace,
long-path UNC). It is an allowlist of exactly one shape, and **that shape does not exist on Linux**.
Both D1 workers and every staging container are Linux.

**This sits BEHIND F1 and would have been the next wall.** Even if a container could obtain an
identity, it could not present a local path to enrol with. Two independent blockers on the same hop,
and the second is invisible until the first is fixed — which is precisely why walking the skeleton
finds things that reading the plan does not.

Own ticket. The fix is not "also accept a leading slash" without thought: the docstring's reasoning
about ambiguous shapes has a POSIX analogue, and whoever owns it should state the accepted shape per
platform rather than widen the regex.

### * F6 - The worker image ships a provider that FABRICATES SUCCESS

`createFakeSandboxProvider` lived in the daemon's own production source tree
(`src/supervisor/fake-provider.ts`), was re-exported from the public barrel, and therefore shipped at
`/worker-app/dist/supervisor/fake-provider.js`. Its default script returns exit 0; the supervisor
maps that to `terminal{status:"succeeded"}`; the server completes a tenant attempt **for work that
never ran**.

No production constructor calls it, so this was a loaded footgun rather than a live vulnerability —
but it is the ONLY `SandboxProvider` the daemon can import under E4-D01, `createSpecFor` already
hardcodes `env: {}`, and **a fabricated success is byte-identical to a real one on every existing
gate**. Closed by WRK-009.

### *** F7 - The images were NOT REPRODUCIBLE FROM SOURCE (`.dockerignore` had no `dist` rule)

Found because the F6 fix **did not work**: the file was moved out of the source tree, the whole suite
passed, and `/worker-app/dist/supervisor/fake-provider.js` was STILL in the rebuilt image.

`.dockerignore` excluded `node_modules` but never `dist`. So `COPY packages/worker-daemon/
packages/worker-daemon/` (`docker/worker/Dockerfile:58`) carried the **developer's local `dist/`**
into the build, and `tsc` then wrote into that same directory — without removing outputs whose source
was gone. A file deleted or moved in source keeps shipping forever.

The general statement is worse than the specific one: **every image depended on whatever `dist/`
happened to be sitting on the machine that built it.** CI escapes it only because its tree starts
clean, which also means CI can never detect it.

Same shape as F4 (stale `dist/migrations`): a build output surviving a rebuild. Two instances in one
day is a pattern, not a coincidence. Fixed by adding `**/dist`; verified safe because every
Dockerfile compiles its own `dist` inside the image (`RUN pnpm build` / `RUN tsc`) and the
`COPY --from=build` lines copy between STAGES, which `.dockerignore` does not affect.

Measured side effect: the build context fell from **403 MB to 19.5 kB**.

### *** F8 - The built-image test lane HAS NEVER RUN, and a latent crash proves it

`docker/images/__tests__/image-contents.test.mjs` and `image-startup-smoke.test.mjs` had **no CI
invocation anywhere in the repo**. `pr.yml:390` runs only the STATIC `dockerfile-static.test.mjs`
and states the built-image lane "is wired by DEP-004's image lane" — **that lane does not exist**.
`d1-merge-train.yml` builds both images and greps their tags for compose, but never runs the
assertions.

**The proof is a latent crash, not an absence of evidence.** `build.sh:52` emits an uppercased image
name; bash `^^` uppercases without translating the hyphen, so the file records `CONTROL-PLANE_IMAGE`.
Both test files parsed with `/^([A-Z_]+)=(.*)$/`, which does not match a hyphen, so those lines were
silently dropped and `env.CONTROL_PLANE_IMAGE` was `undefined`. Every control-plane assertion ran
`docker run undefined:latest`. **Had the lane ever executed with Docker present, it would have hard
failed on the first run.** It never did.

This is the programme's recurring failure class — *a check that nothing runs is not a check* — and it
evaded the standing guard built for exactly it: `check-guard-inventory.mjs` scans only
`scripts/check-*.mjs` and `scripts/verify-*.mjs`, so **test files are outside its scope**. The
defect lived in the blind spot of its own detector. Extending that guard to cover
`__tests__/*.test.mjs` is its own ticket and should be taken.

Fixed in the consumer, deliberately: `d1-merge-train.yml` greps `^CONTROL-PLANE_IMAGE=` to point
compose at the built tags, so "correcting" `build.sh` to emit an underscore would have silently
broken D1 bring-up — a worse failure than the one being repaired.

### F9 - `image-startup-smoke` mounts a root-owned tmpfs over a chowned directory

With F8's parser fixed, the worker case still fails: `mkdir: cannot create directory
'/worker/tmp': Permission denied`. `--tmpfs /worker:rw,size=32m` lands a fresh root-owned tmpfs
**over** `docker/worker/Dockerfile:92-93`'s `mkdir -p /worker && chown node:node /worker`, and the
container runs as `node`.

**A defect in the TEST, not the image.** D1 mounts the named volume `d1-worker-a-state:/worker`,
which Docker initialises from the image and which therefore keeps that ownership; tmpfs does not.
So this file is left un-wired with the reason recorded in place, rather than wired red to say the
worker image is broken when it is not. Its own ticket.

It does surface a real operability fact worth writing down: **the worker requires a writable
`/worker` owned by its uid**, and an operator who mounts a bare tmpfs there gets a container that
dies with an error message no runbook explains — because there is no runbook.

## Log

**Established before the D1 stack finished building** (static, from source — recorded here because
the conclusion is structural and does not need the runtime to demonstrate it):

- P1 → **confirmed and deepened** into F1. Not a gate; an absent mechanism.
- F2 → new, not predicted.
- **P3 → FALSIFIED** (F3). The single most valuable outcome available to this spike, and it came
  back the favourable way: the mechanism works and is exercised nightly.
- P4, P5 → still standing, but **re-ordered**: both are downstream of an identity the container
  cannot obtain, so neither is next.
- F4 → a real shipping defect, entirely outside the spike's question, found by running the stack.

**Runtime confirmation of F1 pending** — the first bring-up died on F4 before the worker containers
started, which is itself a data point: the D1 stack could not be brought up locally at all until
that build defect was fixed.
