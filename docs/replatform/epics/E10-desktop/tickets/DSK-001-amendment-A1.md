# DSK-001 — Amendment A1: wiring the enrollment client

**Date:** 2026-08-21
**Amends:** `DSK-001-enrollment-client-plan.md` §4 (D4, D6)
**Status:** committed before the code it describes

---

## Why this exists

The Lane A adversarial review found that the enrollment client is built, tested,
and **wired to nothing**: `enrollOnce` has zero callers outside its own file and
its tests, so `bootstrapWorkerDaemon` loads config, checks custody, starts a
health server, and never enrols. Plan D4 (the enrolment block) and D6 (the
barrel re-exports) did not ship. That is the ticket's central deliverable.

Re-verifying D4 against the code that actually landed shows it cannot be
implemented as written. Four of its premises are wrong. Recording the divergence
and the decision it forces, before writing the code, rather than quietly
improvising at the keyboard.

---

## What D4 assumed, and what is true

### 1. The custody verdict does not carry a mode or the stores

D4 branches on `custody.mode === "enrolling"` and reads `custody.identityStore`.
The shipped type is:

```ts
export type CustodyVerdict =
  | { readonly kind: "ok" }
  | { readonly kind: "refuse"; readonly reason: string };
```

No `mode`, no stores. **Ships instead:** bootstrap gates enrolment on
`config.keyStoreMode === "os_keychain"` and uses the injected stores directly.

This is the better shape and stays. `resolveCustody` encodes the same I11 truth
table either way; widening a pure decision function into a container that hands
back the objects it was given buys nothing and makes it harder to test.

### 2. `readEnrollmentInput` takes three arguments, not two

D4 calls `readInput(config.enrollmentCodeSource, deps.env)`. The real signature
is `(source, env, readFileText)` — the file reader is injected, which is what
makes the `{kind:"path"}` arm testable.

**Ships instead:** `BootstrapDeps` gains a fifth field,
`readFileText?: (path: string) => string`, defaulting to a `node:fs` read.
Without that seam the 401/503 and ticket-rejection cases could not run without
touching a real filesystem.

### 3. `EnrollmentOutcome` has no `failure` field — the coordinator THROWS

D4 branches three ways on `outcome.failure` + `outcome.minted`. The shipped
outcome is a frozen success record with no failure key; `enrollOnce` rejects
instead. So the caller cannot tell **minted** from **not minted** on the failure
path — and that is precisely what D4's fatal/non-fatal split turns on.

The split is worth keeping:

- `minted === true` and the network failed ⇒ **exit 1**. A fresh device that
  could not enrol is useless, the failure is actionable, and the loop is bounded
  because the next boot loads the persisted record instead of minting again.
- `minted === false` and the network failed ⇒ **log and run idle**. The identity
  is intact. Exiting would convert a survivable state into a restart loop — and a
  restart loop is exactly what pressures an operator toward `--reset-identity`,
  which on the same target IS the permanent lockout. That path now has a guard in
  front of it (`RESET_ACKNOWLEDGEMENT_FLAG`); making every failure fatal would
  aim operators straight at that guard and train them to push through it.

**Ships instead:** the coordinator gains `EnrollmentAuthorityError`, thrown only
when the network call rejects, carrying `{ minted, workerId, targetId, cause }`.
Store faults and ticket faults keep throwing plain `EnrollOnceError` and remain
unconditionally fatal — a store that cannot open must never look survivable (I3).

**Scope note, stated rather than glossed:** today the `identity && receipt`
steady state returns before the network is touched, so the not-minted-and-failed
case is narrower than D4's wording implies. It is reached by a device that
crashed between the identity write and the receipt write, not by a fully-enrolled
device refreshing authority. The branch is still correct and still worth having;
it is simply rarer than the plan suggests. If a later ticket adds an authority
refresh for enrolled devices, this branch is already the right shape for it.

### 4. `ticket.ts` exports `decodeEnrollmentTicket`

D6 lists `parseEnrollmentTicket`, which does not exist. The barrel re-exports the
real name.

---

## What is unchanged from D4

- Enrolment runs **after** the health server is up, so the compose healthcheck
  answers during enrolment (D14), and **after** the pre-socket custody gate, so a
  configuration fault still fails before any socket is opened (I11).
- `readInput` is passed as a **thunk**, so the credential materializes only when
  a ticket is actually needed — never on the steady-state path.
- `health.close()` is `.catch(() => {})`-guarded, because a rejected close would
  otherwise escape `bootstrap` into the entry guard's `console.error(err.stack)`,
  bypassing the redactor (I13).
- `enroll.ts`, `config/config.ts`, `identity/key-store.ts` and `package.json`
  still get zero lines.
