# DSK-004 — Desktop signed update, drain, rollback, and repair (result)

**Start SHA** `6bc5b44fc` (the design commit) · **Branch** `docs/replatform-program` (PR #323)
· **Design** [`DSK-004-design.md`](./DSK-004-design.md) · Follows [DSK-003](./DSK-003-result.md).

| Lane | Scope | SHA |
|---|---|---|
| A | Update manifest + admission: from→to binding, version deny-list | `13f604805` |
| B | Compatibility at install time | `a6883d64c` |
| C | Side-by-side layout, the pointer, the swap | `be09ef177`, `c7b6c55fa`, `94e5c4b8f` |
| D | Drain before swap | `f6c8f7409` |

Two commits between the lanes belong to an incident rather than to this ticket
(`b6aae0e10`, `3471c25d9`, `875af1f06`); see [DSK-003 §8](./DSK-003-result.md).

---

## 1. The decision the ticket turned on

Clause (5) — "power loss recovers to one valid version" — is normally attacked with
crash-recovery machinery: a journal, resume-from-step, a repair pass. **D1 replaced all of
it with a pointer swap.** Versions install side by side under their own directories and
one `current` pointer names the live one, so the pointer holds either the old value or the
new one and there is no state in which half a version is live.

Everything the ticket asked for either falls out of that or gets simpler:

- **Power loss** stops needing recovery logic and becomes an invariant.
- **Rollback stops being an undo.** The previous version is still on disk, so rolling back
  is pointing back. *A rollback that has to reconstruct something is a rollback that can
  itself fail* — at the moment an operator least wants that.
- **The running host is never modified**, which is clause (7)'s "source workspaces
  untouched" and the Windows in-use-executable problem answered together.
- **A failed health check is a no-op**, because health gates the SWAP and not the unpack.
  Clause (4)'s "rolls back" has nothing to undo.

---

## 2. Acceptance, clause by clause

| # | Clause | Evidence | Status |
|---|---|---|---|
| 1 | Only signed compatible builds install | `update-admission.mjs` (detached signature over a canonical payload binding digest + from + to + platform); `update-compatibility.ts` (`negotiateProtocolVersion`); `planUpdateSwap` refuses on either | **Done** |
| 2 | Update stops new leases before draining or policy-canceling/fencing active work | `createUpdateDrainSteps` composes `createLeaseLifecycleSteps`; lease-stop precedes lease-drain by construction | **Partial** — the drain path is built; the *policy-cancel / fence* alternative is not wired into the update path (see §5) |
| 3 | Outbox and device identity survive | Satisfied BY LAYOUT — the vault lives under `%LOCALAPPDATA%` via `resolveControlPaths`, which a swap never touches — and `assertVaultOutsideInstallRoot` now enforces that rather than assuming it. Outbox steps ordered after the drain | **Done (structurally)** — not exercised by a real update, because there is no artifact to install (see §5) |
| 4 | Failed health confirmation rolls back | `planUpdateSwap` returns `{action:"refuse", pointerTarget: currentVersion, reason:"health_unconfirmed"}` — the pointer never moved | **Done** |
| 5 | Power loss recovers to one valid version | Side-by-side layout + `writeVersionPointer` writing a temp file and renaming it onto the destination | **Done** |
| 6 | Revoked versions cannot reconnect | Version deny-list checked at admission, BEFORE the signature, separate from JOB-007's target revocation | **Done** |
| 7 | Source workspaces are untouched | The running version's directory is never written; only the pointer moves | **Done by construction** |

## 3. Invariants

| # | Invariant | Proven by |
|---|---|---|
| I1 | An unsigned or wrongly-signed update is refused | `update-admission.test.mjs` |
| I2 | A signature for a different from→to pair is refused | replay case, same suite |
| I3 | A revoked version is refused even when correctly signed | deny-list case; an ABSENT deny-list is a refusal, not an empty one |
| I4 | An incompatible build is refused BEFORE the swap | `update-compatibility.test.ts`; a manifest's own `declaredCompatible` is ignored in both directions |
| I5 | The pointer is only ever one of the two versions | `planUpdateSwap` returns a target from `{current, candidate}` on every path; `writeVersionPointer` never writes the destination directly |
| I6 | Health failure leaves the pointer untouched | failed-health case |
| I7 | Rollback points back; it does not reconstruct | `planRollback` REFUSES when the previous version is absent |
| I8 | The vault is never inside the install root | `assertVaultOutsideInstallRoot`, which now throws on a malformed root rather than reporting it unrelated |
| I9 | New leasing stops before drain, reusing the existing ordering | composition test comparing against `createLeaseLifecycleSteps`' own output |

**Mutation testing: 73 mutants, 72 killed, 1 documented equivalent.**
Lane A 10 · Lane B 7 · Lane C 33 + 11 (pointer) · Lane D 12.

---

## 4. What the adversarial pass caught that the first read did not

Every one of these came from attacking the work rather than re-reading it.

1. **`!flag` instead of `flag !== true`** on the swap gates. The truthy values include the
   *string* `"false"`; a verdict that had been through JSON, a query parameter or a shell
   argument would have swapped onto a build whose health check failed.
2. **Windows reserved device names** accepted as version segments. My first framing was
   wrong and measurement corrected it: Node's `fs` uses the `\\?\` prefix and creates a
   directory literally named `NUL.1.0`. The hazard is at the BOUNDARY — DSK-003 writes the
   install path into an autostart manifest that Task Scheduler consumes, and Win32
   normalization applies there, matching a reserved device on the name up to the first dot.
3. **A trailing dot**, which Win32 strips: the pointer would record `0.1.0.` while a
   launcher opened `0.1.0`, and rollback would call a present version absent.
4. **`assertVaultOutsideInstallRoot` failed OPEN** on a malformed root — `isPathInside`
   answers false for an empty path, which is the right answer to "is A inside B" and the
   wrong basis for "I have verified the vault is safe". *This programme keeps producing
   guards that pass because they could not evaluate anything.*
5. **The fix for (4) let `"   "` through**, because whitespace survives path normalization
   as a segment. Caught by its own test before the commit.
6. **`absent` and `unreadable` collapsed** in the pointer reader — a surviving mutant that
   was a real gap, because the corrupt-pointer case returned malformed JSON *successfully*
   and never exercised the `readFile` catch. A permission error would have been reported as
   "absent", inviting an installer to reinstall over a working install it could not read.

A seventh finding was **refuted by measurement rather than fixed**: the explicit
`isSymbolicLink()` check in the (separate) inventory walk is an equivalent mutant, because
a `Dirent` carries lstat semantics. Recorded rather than chased.

---

## 5. Honest deferrals

Nothing below is blocked on a decision; all of it is out of this ticket's reach.

- **No artifact to install.** DSK-003 recorded that no `pnpm deploy` invocation yields a
  shippable root, so there is no `.msi`/`.pkg` and therefore **no end-to-end update run**.
  Every lane here is unit-proven; none has been exercised against a real build. The
  unpack-and-verify step that would populate `versions/<v>` is consequently not built.
- **Health confirmation is an injected boolean.** DSK-003 ships `GET /healthz` and
  `GET /instance`; polling them from the update path — start the new version, wait, confirm
  — is not wired. `planUpdateSwap` consumes the verdict; nothing yet produces it.
- **`installedVersions` is an injected array.** Enumerating the versions directory is the
  caller's job and has no implementation here, so I7's "the previous version is on disk"
  is proven against a list, not against a filesystem.
- **Clause (2)'s policy-cancel / fence branch is not wired.** The update path stops leasing
  and drains. Cancelling or fencing active work instead — DSK-002's `fence-close-proxy`,
  JOB-007's revocation — remains a separate mechanism that the update does not invoke.
- **`runDrainBeforeSwap` awaits each step without a deadline.** A drain that never settles
  hangs the update. This matches `createShutdownHandler`'s existing behaviour, and failing
  to swap is the safe direction, but an operator-visible timeout is absent.
- **Signing roots remain REL-004's.** As in DSK-003, the admission verifier runs on a TEST
  trust root; certificates gate beta-gate evidence, not this code.
- **Staged rollout policy** is out of scope by design.

---

## 6. Behaviour changes worth a release note

1. **`@armyofagents/worker-keystore` exports the install layout and pointer** —
   `resolveInstallLayout`, `planUpdateSwap`, `planRollback`, `readVersionPointer`,
   `writeVersionPointer`, `assertVaultOutsideInstallRoot`. All additive.
2. **`@armyofagents/worker-daemon` exports `createUpdateDrainSteps` / `runDrainBeforeSwap`.**
   Additive; the existing shutdown exports are unchanged and are what these compose.
3. **The update path fails closed where shutdown fails open.** A failing step aborts the
   sequence and refuses the swap, rather than being swallowed as it is during shutdown.
   The difference is deliberate: an exiting process must exit regardless, while an updating
   one must not move the pointer over work that is still running.
4. **A version string is now validated as a path segment** — traversal, Windows reserved
   device names, trailing dots and over-long names are refused. A previously accepted (and
   dangerous) manifest value is now rejected at planning time.
