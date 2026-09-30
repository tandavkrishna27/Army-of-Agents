# DSK-004 — Desktop signed update, drain, rollback, and repair

**Date:** 2026-08-22
**Branch:** `docs/replatform-program` (PR #323)
**Terrain SHA:** `b7ace872a`
**Depends on:** DSK-003 ✅, JOB-007 ✅, PRT-006 ✅, PRT-007 ✅

Committed **before any DSK-004 code**. Its commit SHA is the ticket's Start SHA.

---

## 1. What the ticket asks

**Outcome.** Signed update manifests/packages, compatibility checks, staged rollout, lease
drain, atomic replacement, health confirmation, interrupted-update recovery, and rollback.

**Acceptance**, numbered:

1. Only signed compatible builds install.
2. Update stops new leases before draining or policy-canceling/fencing active work.
3. Outbox and device identity survive.
4. Failed health confirmation rolls back.
5. Power loss recovers to one valid version.
6. Revoked versions cannot reconnect.
7. Source workspaces are untouched.

---

## 2. Terrain: most of the verbs already exist

Third ticket running where the outcome sentence names mechanisms that are already built.
Verified at `b7ace872a`, not assumed.

| Clause | Status | Where |
|---|---|---|
| (1) signature | **pattern built** (DSK-003) | `scripts/lib/installer-admission.mjs` — fail-closed, digest+version+platform bound, TEST trust root |
| (1) compatibility | **built** (PRT-006) | `negotiateProtocolVersion` (`worker-protocol/src/version.ts`), consumed by the matcher |
| (2) stop new leases | **built** (WRK-003/PRT-007) | `POLL_RESPONSE_OUTCOMES` carries `drain`; `poll-loop.ts` is documented "drain-before-lease-stop" |
| (2) drain in-flight | **built** (WRK-005) | `lifecycle/shutdown.ts` — `[lease-stop, renewal-stop, lease-drain]` ahead of health |
| (3) outbox survives | **built** (WRK-006/007) | encrypted outbox + startup reconciliation |
| (6) revocation | **built for TARGETS** (JOB-007) | `target_revoked` across errors/events/transport |
| — the artifact | **built** (DSK-003) | staging manifest + assembler, symlink-refusing |

**Genuinely new:** the update manifest itself, the replacement mechanics, health
confirmation, rollback, power-loss recovery, and **version**-level revocation — JOB-007
revokes a target, not a build.

---

## 3. The decision the whole ticket turns on

Clause (5) — "power loss recovers to one valid version" — is usually attacked with
crash-recovery logic: journals, resume-from-step, repair passes. That is the expensive
answer and it is the wrong one here, because Windows will not let you overwrite a running
executable anyway.

**D1. Replacement is a POINTER SWAP, never an in-place overwrite.** Versions install
side-by-side under their own directories; a single `current` pointer names the live one.

Everything else falls out of that:

- **Power loss is safe by construction.** The pointer is either the old value or the new
  one; there is no state in which half a version is live. Clause (5) stops needing recovery
  logic and becomes an invariant.
- **Rollback is not an undo.** The previous version is still on disk, so rolling back is
  pointing back — not reconstructing.
- **The running host is never modified.** Clause (7)'s "source workspaces are untouched"
  and the in-use-executable problem are the same problem, and this answers both.

**D2. Health confirmation gates the SWAP, not the unpack.** Order: unpack → verify
(manifest + admission) → start the new version → confirm health → *then* move the pointer.
A failed health check means the pointer never moved, so clause (4)'s "rolls back" is a
no-op rather than a compensating action. **A rollback that has to undo something is a
rollback that can itself fail.**

---

## 4. Compatibility is negotiation, not a version comparison

**D3. Reuse `negotiateProtocolVersion`.** A candidate build advertises
`supportedProtocol {min,max}`; compatibility is whether that range still intersects what
the control plane requires. Comparing build numbers would be a second, weaker notion of
compatibility beside the one the protocol already defines, and the two would drift.

**D4. Compatibility is checked BEFORE the swap, against the running server's
requirements** — not at manifest-authoring time. A build that was compatible when signed
may not be by the time it installs, and the check that matters is the one at install.

---

## 5. Signing extends, it does not duplicate

**D5. The update manifest reuses `installer-admission.mjs`'s construction** — a detached
signature over a canonical payload, fail-closed, on a test trust root that REL-004 swaps
for release roots. What differs is the payload: an update binds **fromVersion → toVersion**
in addition to digest and platform, so a signature authorizing 0.1.0→0.1.1 cannot be
replayed to authorize 0.1.0→0.9.9.

**D6. Version revocation is a DENY-LIST checked at admission**, separate from JOB-007's
target revocation. They answer different questions — "may this device work" versus "may
this build run" — and conflating them would mean revoking a bad build required revoking
every device running it.

---

## 6. What survives, and why it already does

Clause (3) is satisfied by the DSK-003 layout rather than by new code: the device identity,
the control token, the state record and the log all live under `%LOCALAPPDATA%\AoA\worker`
(`resolveControlPaths`), which is **not** the install directory. A version swap cannot
touch them because it never goes near them. That is worth stating explicitly so nobody
later "tidies up" by moving the vault under the install root.

---

## 7. Lane split

| Lane | Scope | Clauses |
|---|---|---|
| **A** | The update manifest + admission (D5/D6): from→to binding, version deny-list. | 1, 6 |
| **B** | Compatibility at install time (D3/D4). | 1 |
| **C** | The layout: side-by-side versions, the pointer, and the swap (D1/D2). | 4, 5, 7 |
| **D** | Drain-before-swap, wiring the existing mechanisms rather than re-deriving them. | 2, 3 |

Lane A first: it is the gate everything else runs behind.

---

## 8. Invariants

| # | Invariant | Lane | Proven by |
|---|---|---|---|
| I1 | An unsigned or wrongly-signed update is refused | A | admission unit |
| I2 | A signature for a different from→to pair is refused | A | replay case |
| I3 | A revoked version is refused even when correctly signed | A | deny-list case |
| I4 | An incompatible build is refused BEFORE the swap | B | negotiation case |
| I5 | The pointer is only ever one of the two versions | C | swap unit + interrupted case |
| I6 | Health failure leaves the pointer untouched | C | failed-health case |
| I7 | Rollback points back; it does not reconstruct | C | rollback unit |
| I8 | The vault is never inside the install root | C | path assertion |
| I9 | New leasing stops before drain, reusing the existing ordering | D | source-asserted composition |

Every guard is mutation-tested before its lane lands.

---

## 9. Out of scope

- **Production signing roots, notarization, vulnerability policy** — REL-004.
- **A `.msi`/`.pkg` package.** DSK-003 records that no `pnpm deploy` invocation yields a
  shippable root; DSK-004 updates an artifact, it does not solve packaging.
- **Staged rollout POLICY** (who gets a build when). The outcome names it; that is a
  control-plane rollout decision, and this ticket builds the mechanism it would drive.
- **Log rotation** — carried over from DSK-003 as a named residual.
