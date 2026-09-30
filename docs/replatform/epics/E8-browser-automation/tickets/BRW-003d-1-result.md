# BRW-003d-1 — Payload bounding — RESULT

**Epic:** E8 · **Lane:** B (`C:\e8`) · **Status:** ✅ complete
**Index:** [`BRW-003d-design.md`](./BRW-003d-design.md) · **Terrain:** [`BRW-003d-terrain.md`](./BRW-003d-terrain.md)
**Start SHA:** `b2703b8a5` (design) · **End SHA:** `e3abdf312`
**Discharges:** BRW-003 acceptance "payloads bounded" (request side).

| Commit | What |
|---|---|
| `f4135516f` | legal requests were refused, and the refusal had a shape no worker could read |
| `70424e25e` | a mutant survived, and a structural guard measured the wrong block |
| `30ad7428c` | reviving a dead guard made it speak a word its operation cannot say |
| `e3abdf312` | enrollment had no ceiling at all, and raising the mount removed the accident that hid it |

---

## 1. The defect

`express.json()` at `app.ts` carried **no `limit`**, so express's 100 KB default applied to every
`/api` route — while the frozen `OPERATION_DESCRIPTORS` declare up to **4 MiB**. Two consequences:

- **Legal requests were refused.** A 200 KB `event_upload` batch sits ~21× *inside* the frozen
  ceiling and died in body-parser anyway.
- **The refusal had the wrong shape.** body-parser's 413 renders as a plain `{error: message}`, not
  a `ProtocolErrorV1`. `event_upload` carries `retry: "idempotent_retry"` over a **closed** error
  vocabulary; an unclassifiable 413 cannot be routed through that rule.

And the guard that *would* have said `payload_too_large` was **provably dead**: `rawBody` exists only
after a successful parse, so `rawBody.length ≤ 102,400` by construction and `102,400 > 4,194,304` is
always false.

## 2. ★ The crux — measured, because reasoning gets it wrong

Setting the mount **equal** to the contract ceiling — the natural reading of "align the limit with
the contract" — **does not fix the defect.** Verified by running express, contract 300 B, body 340 B:

```
mount == contract  ->  413 {"envelope":"NOT-protocol","err":"entity.too.large"}
mount  >  contract  ->  200 {"envelope":"protocol","code":"payload_too_large"}
```

Equal merely moves the threshold at which the wrong shape appears. The headroom is what lets the
handler observe an oversized body and refuse it in the protocol's own vocabulary.

## 3. ★ The regression this ticket almost shipped — found by adversarial review

A four-lens review returned **NOT SHIPPABLE**. Its first finding was a defect **this ticket created**,
and it is the most instructive thing here.

Six handlers refuse an oversized body; four hard-coded `payload_too_large`. But only **four of the
ten operations declare that code** — `artifact_commit` and `control_command` do not.
`workerOperationProtocolErrorV1` **throws** on an out-of-vocabulary code; the throw is caught by the
route's own catch; the fallthrough answers `internal_unavailable` → **503 with a bounded
`retryAfterMs`**. Both operations are `idempotent_retry`.

So a body that can **never** succeed would have been retried forever — **strictly worse than the
terminal 413 it replaced.**

This was harmless only while the 100 KB default kept those guards dead by construction.
**Raising the mount is what made them live.** The general lesson, and the reason it is written down:

> **The ticket that revives a guard is the ticket that has to make it speak a legal word.**
> Making a dead branch live means auditing *every* branch revived, not just the one you came for.

Fixed by **deriving** the refusal code from the operation's own frozen vocabulary (`sizeRefusalCode`)
so it cannot drift, plus a pure invariant over all ten operations and a real-app regression test
asserting an oversized `artifact_commit` returns `400 malformed` with `retryAfterMs: null`.

The other two blockers, both fixed: the **prefix mount had zero binding coverage** (deleting it left
every assertion green — only `/events` was ever proven), and the parsers **sat ahead of helmet, the
private-hostname guard, actorMiddleware and the logger** while widening an *unauthenticated* buffer.

## 4. What mutation testing found that review did not

- **M10 survived.** Deleting `inflate:` from the mount left every tier green: the *constant* was
  guarded, its **binding into app.ts** was not. The 1019.8 : 1 gzip amplification could have been
  reopened one keystroke at a time. This is the programme's binding-gap class, again.
- **My gate broke a structural guard by being the second of its kind.**
  `desktop-disabled.negative.test.ts` scanned `app.ts` for the **first**
  `if (opts.distributedExecutionEnabled) {`, correct only while one existed. The parser gate must
  precede `express.json()` and the routes follow it, so two blocks are structurally necessary. The
  scan now enumerates and **pins the count**.
- **And then I repeated the same bug one level down.** The repaired helper resolved its needle with
  `indexOf` — first occurrence only. Worse, the file's own control case still used the old pattern
  and, with two blocks, silently began proving `executionTargetRoutes` is after the *parser* block
  (true of nearly everything) instead of outside the *route* block. **It passed throughout** — found
  by reading, not by a red test.

## 5. Mutation testing — 14 mutants, 14 killed

| Mutant | Result |
|---|---|
| headroom → 0 (mount equals contract) | killed |
| `inflate` constant → true | killed |
| events limit collapses to the prefix limit | killed |
| prefix limit includes `event_upload` | killed |
| events path == prefix path | killed |
| `/events` mount uses the narrow limit | killed |
| both mounts removed | killed |
| flag gate removed | killed |
| events path loses the `/api` prefix | killed |
| `inflate` dropped at the mount site | **survived → test added → killed** |
| route mount escapes its flag block | killed |
| a third flag block appears | killed |
| `sizeRefusalCode` → hard-coded `payload_too_large` | killed (both tiers) |
| enrollment ceiling guard removed | killed |

No false kills: each failing set was checked to be the mutation's *signature* rather than collateral.
One false result was caught and redone — a sanity assertion threw before its restore, leaving the
file mutated; it was restored from the commit and re-run.

## 6. ★ Corrections to my own earlier claims

Recorded because a false claim of enforcement is worse than a missing one.

1. **"The refusal had the wrong shape" is FALSE for `/enroll`.** `error-handler.ts:34` already
   renders a `ProtocolErrorV1` when `isEnrollmentWorkerControlPath(req.originalUrl)` matches — and
   that matcher covers `/worker-control/enroll` **only**. The claim holds for `/events` and the rest;
   the first commit message overstated it.
2. **"No test builds the real app"** — false, and an inference from a filename filter.
   `job-submission.integration.test.ts` boots the real `createApp` with the flag on.
3. **`payload_too_large` is not 413.** It takes the **409** fallthrough. An earlier design assumed
   413 and would have been red forever.

## 7. Named follow-ups — recorded, not silently dropped

1. **The headroom is per-GROUP, not per-operation.** Nine operations share one prefix limit, so the
   five that declare 64 KiB carry 262,144 bytes of slack rather than 64 KiB. Safe, but the constant's
   name over-promises.
2. **Two non-frozen routes live under the prefix** and inherit its limit:
   `/worker-control/execution-secrets/resolve` (own 4 KiB descriptor, guarded) and the env-gated
   `/worker-control/_test/reap` (no descriptor, no guard). The derivation's drift-guard property does
   **not** extend to their descriptors — raising `EXECUTION_SECRET_RESOLVE_DESCRIPTOR` above the mount
   would recreate the dead-guard defect with every test green.
3. **`inflate: false` introduces a new non-protocol refusal** (415 `encoding.unsupported`), rendered
   as a plain object on every worker path except `/enroll`. Accepted: no legitimate client compresses.
4. **The prefix mount covers the whole subtree**, so any `/api/worker-control/...` path gets the
   raised limit whether or not a route exists there.

## 8. Verification

- 72 green across the six affected files; 651 green across the app/worker/job suites; typecheck clean
- Integration assertions run on the **required Linux lane** — the skip is `platform === "win32"` only
  and `pnpm test:run` includes the file
- **11 red integration tests investigated, not dismissed:** `job-leasing`, `job-reconciliation` and
  `worker-self-model-read` fail when many embedded-Postgres files run concurrently on Windows and
  pass **54/54 in isolation** — the harness contention that is also why CI skips the Windows e2e lane
- Six other red suites on this branch reproduce with `app.ts` reverted, so they pre-date this work
