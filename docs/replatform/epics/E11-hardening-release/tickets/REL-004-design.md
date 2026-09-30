# REL-004 — Signed images, SBOM, vulnerability and provider kill gates (design)

**Depends on** DEP-001, DEP-008, CLI-004 — all landed.
**Outcome:** pin, scan, sign, and attest control-plane, worker, sandbox, and every enabled
desktop installer/updater artifact, and add provider/template/target kill switches.
**Acceptance:** (1) an unapproved digest cannot run; (2) critical vulnerability policy
blocks promotion; (3) a kill switch stops new leases and reconciles active provider
resources.

---

## 1. The finding that reframes the ticket

I opened this expecting clause (1) to mean "build a verifier". Three already exist, all
pure, fail-closed, mutation-tested and domain-separated:

| Verifier | Ticket | Payload type |
|---|---|---|
| `scripts/lib/image-admission.mjs` | DEP-001 | `cosign container image signature` |
| `scripts/lib/installer-admission.mjs` | DSK-003 | `aoa desktop installer signature` |
| `scripts/lib/update-admission.mjs` | DSK-004 | `aoa desktop update signature` |

**None of them has a caller.** Outside their own unit suites, `evaluateInstallerAdmission`
and `evaluateUpdateAdmission` are referenced nowhere at all, and `evaluateAdmission` is
reachable only through `scripts/verify-image-admission.mjs` — a CLI that no workflow, build
script, compose bring-up or test ever invokes. Two places document an enforcement that does
not happen:

- `docker/d1/.env.example`: images are "verified by `scripts/verify-image-admission.mjs` at
  bring-up" — nothing runs it at bring-up.
- `.github/workflows/d1-merge-train.yml`: "live admission is enforced by the split-image
  admission verifier (DEP-001), **not by this lane**" — delegating to a verifier with no
  caller.

(The "admission" in `tests/d1/e6f-11` is DEP-009's worker *rate-limit/capacity* admission,
a different mechanism entirely. Checked, because the word collides.)

**So clause (1) is vacuously true today: nothing can be refused, because nothing is
checked.** This is the DSK-002 lesson repeating — *count the callers before believing an
acceptance clause* — and two of the three orphans are my own work from DSK-003 and DSK-004.
Those result docs said "no artifact to install yet", which was true and much weaker than
"the verifier is never invoked".

REL-004's first job is therefore not to write a fourth verifier. **It is to put the three
on the promotion path and to make a missing check impossible to reintroduce.**

---

## 2. The decision the ticket turns on

**D1. A kill switch is a DENY-LIST over a placement dimension, not an identity
revocation.** Three different questions, deliberately not merged:

| Question | Mechanism | Status |
|---|---|---|
| May this *device* work? | JOB-007 `revokeExecutionTarget` — per-row, generation-fenced, with a durable record and a fan-out | exists |
| May work be *placed on this provider*? | provider deny-list, consulted at lease eligibility | **new** |
| May work *run from this template*? | template deny-list, same seam | **new** |

Conflating them would mean killing one bad E2B template required revoking every target that
uses it — and revocation is generation-fenced identity surgery, so that would also destroy
enrollment state to express a policy opinion. This is the same separation DSK-004 drew
between its version deny-list and JOB-007, and it is drawn the same way for the same reason.

**D2. An ABSENT deny-list is a REFUSAL, not an empty one.** Inherited from DSK-004
deliberately: treating "I could not load the policy" as "nothing is denied" is how a killed
provider keeps taking work during an outage of whatever serves the policy.

**D3. The release manifest binds ALL FIVE artifact classes to ONE candidate, and a missing
class is a refusal.** Control-plane, worker, sandbox, desktop installer, desktop updater.
Per-artifact verifiers answer "is this digest signed and allowlisted"; nothing today answers
"are these the five artifacts of candidate X, and are they all present". A promotion that
silently omits the sandbox image would otherwise pass every existing check.

**D4. The vulnerability policy consumes a scan REPORT and fails closed on absence.** An
unparseable or missing report is a refusal. Exceptions are explicit, scoped to a CVE *and*
an artifact, and **must carry an expiry** — an exception without one is refused, because a
permanent exception is an undocumented policy change.

**D5. Reuse, do not restate.** The manifest gate calls the three existing verifiers rather
than re-deriving signature logic; the kill switch composes into `evaluateStaticLeaseEligibility`
rather than adding a second refusal path beside `target_revoked`; the reconcile builds on
MIG-008's `legacy-resource-reconciliation` seam. Lane D of DSK-004 proved the composition
test that keeps this honest.

---

## 3. Lane split

| Lane | Scope | Clause |
|---|---|---|
| **A** | Release manifest + the gate that runs the three verifiers on the promotion path | 1 |
| **B** | Vulnerability policy over a scan report, with expiring exceptions | 2 |
| **C** | Provider + template kill switches — deny-lists at lease eligibility | 3a |
| **D** | Reconcile active provider resources when a switch is thrown | 3b |

Lane A first: it is the clause that is currently vacuous, and it is the one whose absence
would make every other gate in the program describe a check that does not run.

---

## 4. Invariants

| # | Invariant | Lane | Proven by |
|---|---|---|---|
| I1 | A release manifest missing any artifact class is refused | A | manifest unit |
| I2 | The manifest payload is domain-separated from all three per-artifact payloads | A | source-pinned type constants + cross-replay case |
| I3 | The gate refuses when any per-artifact verifier refuses | A | one case per verifier |
| I4 | Every admission verifier has a caller on the promotion path | A | the gate invokes all three; a meta-test fails if a verifier is orphaned again |
| I5 | A critical finding blocks promotion | B | policy unit |
| I6 | An absent or unparseable scan report is a refusal | B | fail-closed case |
| I7 | An exception without an expiry, or past it, is refused | B | expiry cases |
| I8 | A killed provider or template stops NEW leases | C | eligibility unit |
| I9 | A kill switch does not revoke targets, and revocation does not kill providers | C | separation case both ways |
| I10 | An absent deny-list is a refusal | C | fail-closed case |
| I11 | Active resources on a killed provider are reconciled, and in-flight work drains rather than being orphaned | D | reconcile unit |

Every guard is mutation-tested before its lane lands.

---

## 5. Out of scope

- **Production signing roots and notarization.** As in DSK-003/004, everything here runs on
  a TEST trust root; REL-004 replaces test roots with release roots as an operator step, and
  that substitution changes no logic.
- **Running an actual scanner.** `docker/images/sbom.sh` produces SBOMs today and nothing
  consumes them. Lane B builds the POLICY and the gate over a scan report; wiring a specific
  scanner binary (trivy/grype) into CI is an operator/infra choice and is recorded as an
  evidence tail, not a code dependency.
- **REL-005's beta matrix and evidence pack.**
- **A UI for throwing a kill switch.** The switch is a policy record and an API-level
  decision; surfacing it is REL-001/005 territory.
