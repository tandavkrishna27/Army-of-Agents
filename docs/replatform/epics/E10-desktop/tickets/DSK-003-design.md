# DSK-003 — Desktop host, background worker, and signed installers

**Date:** 2026-08-21
**Branch:** `docs/replatform-program` (PR #323)
**Terrain SHA:** `7f251f966`
**Depends on:** DSK-002 ✅, WRK-007 ✅, DEP-004 ✅

Committed **before any DSK-003 code**. Its commit SHA is the ticket's Start SHA.

---

## 1. What the ticket asks

**Outcome.** Package the worker as a least-privilege desktop background host with signed
Windows/macOS installers, notarization where required, explicit enrollment, OS-key-store
identity, autostart, diagnostics, repair, and uninstall.

**Acceptance**, numbered so every later section maps to a clause:

1. No credential is embedded.
2. The host runs without administrator privileges after install where possible.
3. Restart preserves encrypted outbox state.
4. Status / log / drain / revoke controls are available.
5. Uninstall stops work and explicitly retains or revokes identity by policy.

---

## 2. Terrain: what already exists

Applying DSK-002's lesson before writing a build list.

| Clause | Status | Where |
|---|---|---|
| (3) restart preserves outbox | **built** (WRK-006 + WRK-007) | `events/` + `supervisor/startup-reconcile.ts`, `lifecycle/startup-steps.ts` |
| (4) *drain* | **built and correctly ordered** (WRK-003/005) | verified in code, not comments: `worker-daemon.ts:280` composes `[...leaseSteps, ...outboxSteps, health-server]`, and `createLeaseLifecycleSteps` returns `[lease-stop, renewal-stop, lease-drain]` |
| explicit enrollment | **built** (DSK-001) | `enrollment/`, `bin/desktop-host.ts` |
| OS-key-store identity | **built** (DSK-001) | `packages/worker-keystore` |
| identity destruction | **built** (DSK-001 Lane A) | `--reset-identity --i-understand-this-is-permanent` |
| signed-artifact admission | **pattern built** (DEP-001) | `scripts/lib/image-admission.mjs` — fail-closed, pure, `node:crypto` only, TEST trust root |

**Not built at all:** any packaging or installer scaffolding (grep for
electron-builder / WiX / pkgbuild / notarytool / signtool returns nothing), autostart
manifests, the `status` / `logs` / `revoke` / `uninstall` commands, the uninstall
identity policy, an embedded-secret scan, and any least-privilege assertion.

DSK-001 said this explicitly and pointed here: the current host is "unpackaged, unsigned,
has no autostart, and enters no container image … DSK-003 replaces it with the signed
installer host."

---

## 3. The central security decision: the control surface is not one surface

`health-server.ts` binds loopback-only and exposes `GET /healthz` and `GET /metrics`.
It has **no authentication of any kind** — and that is correct, because it is read-only
liveness plus payload-free counters and "exposes no tenant data".

Clause (4) asks for `drain` and `revoke` alongside `status`. Hanging those off the same
server would be a category change: from unauthenticated read-only liveness to
**unauthenticated mutating control that any local process can reach**. On a shared
desktop, any local user — or any code the user runs, including a browser tab's helper
process — could revoke the worker's identity or drain its work. Loopback is a *network*
boundary; it is not an *authorization* boundary on a multi-user machine.

**D1. Split the control surface by mutation, not by convenience.**

| Control | Transport | Why |
|---|---|---|
| `status` | loopback HTTP, unauthenticated | same category as `/healthz`; reveals no tenant data |
| `logs` | local file read, OS-permissioned | the OS already decides who may read the log |
| `drain`, `revoke`, `uninstall` | **local subcommand + a 0600 control token** | mutating; must not be reachable by every local process |

**D2. The control token reuses DSK-001's custody discipline** — a file written `0600`,
Windows-ACL-aware, fail-closed on group/other-readable — rather than inventing a second
notion of "protected local file". `MountedSecretKekStore` and the keystore already
implement exactly this check, and a second implementation is a second thing to get wrong.

**D3. `revoke` is local-authority only, and says so.** A desktop cannot revoke its own
server-side target — that authority lives in the control plane. `revoke` destroys the
LOCAL identity (the DSK-001 path) and stops work; the server-side row is revoked by an
operator through the control plane. Naming this precisely matters, because "revoke"
that silently only did half the job would read as a security control it is not.

---

## 4. Signing: DSK-003 is not blocked on production certificates

This looked like the ticket's hard external dependency. It is not, because **REL-004
owns it**: "Pin, scan, sign, and attest control-plane, worker, sandbox, and every enabled
desktop installer/updater artifact."

And the precedent is already in the tree. DEP-001 ships `image-admission.mjs` — a pure,
fail-closed, `node:crypto`-only detached-signature verifier over a canonical payload,
signed with a **TEST** cosign key, and its own ticket text says "REL-004 later replaces
test roots with release roots."

**D4. DSK-003 builds the installer-artifact ADMISSION verifier in that same shape, with a
test trust root.** Packaging/signature-tamper is then provable in CI today, and REL-004
swaps the root without touching the verifier. What genuinely needs an operator —
production certificates, Apple notarization, and real install/uninstall on macOS
hardware — is *evidence for the desktop beta gate*, not code, and §8 lists it as such.

---

## 5. Least privilege (clause 2)

**D5. "Where possible" is a per-OS answer, and the honest one is: always, for the host.**
The worker needs the user's own files (the granted folders of DSK-002) and the user's own
keychain. It needs no system-wide privilege at run time. So:

- The **host runs as the installing user**, never as SYSTEM/root, on both OSes.
- Autostart is per-user (`launchd` LaunchAgent, not LaunchDaemon; Windows per-user
  Task Scheduler / Run key, not a service), which is what makes that true rather than
  aspirational.
- An installer *may* need elevation to write into a machine-wide location. That is an
  install-time cost, not a run-time privilege, and the two must not be conflated: the
  acceptance clause is about the **host**, not the installer.

**D6. Assert it, do not assert about it.** A generated autostart manifest is a file with
contents, so the property is testable: the manifest must not request elevation, must not
name a system domain, and must point at the per-user host. That is a real check; "we
intend to run unprivileged" is not.

---

## 6. Clause (1): no credential is embedded

**D7. A scan of the BUILT artifact, not the source.** Scanning source proves nothing
about what packaging swept in — a `.env` next to the entry point, a test fixture, a
keystore file from the developer's own machine. The gate walks the packaged file set.

**D8. The scan needs CI test identities to be non-vacuous**, exactly as the ticket's test
list says. A scanner that finds nothing is indistinguishable from a scanner that looks
for nothing, so the gate plants known test credential shapes and asserts they ARE found,
then asserts the real artifact contains none. The DSK-001 `aoa_enr_…` enrolment-code
regex and the frozen `FORBIDDEN_WIRE_KEYS` are existing, tested vocabularies to reuse
rather than a new list of guesses.

---

## 7. Governance: H.D1 must be reconciled, not contradicted

`docs/deploy/distribution.md` carries decision lock **H.D1 — "Docker + NPM only. No
desktop installer in Phase H."** DSK-003 builds a desktop installer.

This is not a conflict to steamroll:

- H.D1 is scoped to **Phase H**. `docs/architecture/decisions.md` contains no locked
  decision about desktop installers — checked, not assumed.
- `program-design.md` schedules DSK-003 and names "installed-desktop targets" in the
  definition of foundation completion; `accepted-caveats.md` states it is "subordinate to
  locked product decisions and `program-design.md`".

**D9. DSK-003 amends `distribution.md` to record that H.D1 is superseded for the
re-platform program**, with the reason and the pointer. Leaving two committed documents
disagreeing is how a future reader concludes the installer was built by mistake.

---

## 8. Lane split

| Lane | Scope | Clauses |
|---|---|---|
| **A** | The control surface + its authorization boundary (D1–D3): `status`, `logs`, `drain`, `revoke`. `drain` INVOKES the existing shutdown handler; it does not re-derive the ordering. | 4 |
| **B** | Uninstall + the retain-or-revoke identity policy (D3). | 5 |
| **C** | Packaging manifest, per-user autostart generation, least-privilege assertions (D5/D6), and the H.D1 amendment (D9). | 2 |
| **D** | Installer-artifact admission verifier (D4) + the embedded-secret scan gate (D7/D8). | 1 |

Lane A first: it is the clause with a live security decision in it, and Lane B's
uninstall depends on the same authorization boundary.

**D10. `drain` is a caller, not an implementation.** The ordering already exists and is
already tested; a second copy inside a CLI command is how the two drift until one of them
stops renewing during drain. The command's job is to reach the running host and trigger
the handler it already has.

---

## 9. Invariants

| # | Invariant | Lane | Proven by |
|---|---|---|---|
| I1 | A mutating control is refused without a valid control token | A | unit + a no-token case |
| I2 | The control token is refused when group/other-readable | A | permission test (POSIX; Windows ACL note) |
| I3 | `status` exposes no tenant data and no credential | A | key-allowlist test, Lane-D-of-DSK-001 shape |
| I4 | `drain` REUSES the existing shutdown ordering rather than reimplementing it | A | source-asserted composition + ordering test |
| I5 | `revoke` destroys local identity and does NOT claim server-side revocation | A | message + behaviour test |
| I6 | Uninstall stops work before touching identity | B | ordering test |
| I7 | Uninstall retains or revokes identity by an EXPLICIT policy, never a default | B | both arms + a no-policy refusal |
| I8 | The autostart manifest requests no elevation and no system domain | C | generated-manifest assertions per OS |
| I9 | A tampered installer artifact is refused | D | admission verifier, fail-closed |
| I10 | The embedded-secret scan is non-vacuous | D | planted test identities ARE found |
| I11 | The built artifact contains no credential | D | scan over the packaged file set |

Every guard is mutation-tested before its lane lands.

---

## 10. Out of scope

- **Signed update / drain / rollback / staged rollout** — DSK-004.
- **Production signing roots, notarization, vulnerability policy, kill switches** —
  REL-004 (§4).
- **Real macOS install/uninstall evidence** — operator hardware; the desktop beta gate.
- **Any change to `packages/worker-protocol`** — frozen.

### Operator prerequisites, stated early

These block *evidence*, not this ticket's code:

1. **Code-signing certificates** (Windows Authenticode, Apple Developer ID) — REL-004.
2. **Apple notarization credentials** and **macOS hardware** for the advertised-OS matrix.

Lane D's verifier and CI gate run on a test trust root, so DSK-003 can reach CI-green
without any of the above; the release-root swap is REL-004's, by its own text.
