# REL-004 — Signed images, SBOM, vulnerability and provider kill gates (result)

**Start SHA** `52ac0e4f5` (the design commit) · **Branch** `docs/replatform-program` (PR #323)
· **Design** [`REL-004-design.md`](./REL-004-design.md).

| Lane | Scope | Clause | SHA | Status |
|---|---|---|---|---|
| A | Release manifest + the gate that CALLS the three verifiers | 1 | `60e658c07` | **Done** |
| B | Vulnerability policy with expiring exceptions | 2 | `d90ffe68b` | **Done** |
| C | Provider + template kill switches | 3a | `2b7ccc3f2` | **Decision built, NOT WIRED** — see §4 |
| D | Reconcile active provider resources on kill | 3b | — | **Not built** — see §4 |

**42 mutants across the two landed lanes, 41 killed, 1 documented equivalent.**

---

## 1. The finding this ticket turned on

Clause (1) reads like a request to build a verifier. Three already existed — image
(DEP-001), installer (DSK-003), update (DSK-004) — all pure, fail-closed, mutation-tested
and domain-separated.

**None had a caller.** Outside their own unit suites `evaluateInstallerAdmission` and
`evaluateUpdateAdmission` were referenced nowhere at all; `evaluateAdmission` was reachable
only through `scripts/verify-image-admission.mjs`, which no workflow, build script, compose
bring-up or test ever invoked. So "an unapproved digest cannot run" was **vacuously true**:
nothing could be refused, because nothing was checked.

Two of the three orphans were my own work. DSK-003's and DSK-004's result docs said "there
is no artifact to install yet", which was true and much weaker than "the verifier is never
invoked".

Two documents asserted an enforcement that did not happen, and both are corrected:

- `docker/d1/.env.example` — images "verified by `scripts/verify-image-admission.mjs` at
  bring-up". Nothing ran it at bring-up.
- `.github/workflows/d1-merge-train.yml` — "live admission is enforced by the split-image
  admission verifier (DEP-001), not by this lane", delegating to the verifier with no
  caller.

**A false claim of enforcement is worse than a missing check**, because it tells the next
engineer the check already exists.

---

## 2. What landed

### Lane A — the promotion gate (I1–I4)

`scripts/lib/release-manifest.mjs` + `scripts/check-release-admission.mjs`.

The manifest answers a question no per-artifact verifier can: not "is this digest signed
and allowlisted" but "are these the five artifacts of candidate X, and are they ALL here".
A promotion silently omitting the sandbox image passed every pre-existing check.

- A missing artifact class is a refusal naming the class; an **unknown** class is also a
  refusal, because "ignore the part I do not understand" is not a safe reading of a
  manifest that disagrees with the gate about what a release contains.
- Completeness is checked **before** the signature. Both are refusals, so there is no
  security difference — but "the sandbox artifact is missing" sends an operator to the
  promotion pipeline while `signature_invalid` sends them to the signing key.
- The manifest payload is domain-separated (`aoa release manifest signature`), so a
  per-artifact signature cannot authorize a whole release.

**The test that matters most is `no admission verifier is orphaned`**: it walks
`scripts/lib` for `*admission*.mjs`, imports each, and fails if any exported `evaluate*`
function is unreachable from the gate. Both unwire-a-verifier mutants are killed by it, so
the guard is real rather than decorative. A future fourth verifier cannot be built and
forgotten.

A 9-case end-to-end CLI suite proves a *real invocation* refuses — tampered, incomplete,
unsigned, unpromoted, revoked — and that invoking the gate wrongly exits 2, not 0, so a
misinvoked gate cannot look like a gate that passed.

### Lane B — the vulnerability policy (I5–I7)

`scripts/lib/vulnerability-policy.mjs`. SBOMs have been produced since DEP-001 and never
read; an inventory nobody evaluates is not a control.

Scanner-agnostic by design: it consumes a normalized report, so changing scanner is an
infra decision rather than a policy rewrite. Every shrug is a refusal — absent, malformed
or wrong-candidate report; an unscanned artifact class; an unparseable exceptions document;
no clock to evaluate expiries against.

- **An unrecognized severity blocks.** Reading it as benign would make the gate depend on a
  vocabulary this repository does not control, so a scanner upgrade renaming "critical"
  would silently switch it off.
- **An exception must expire**, and one without an expiry is *refused* rather than dropped
  — a permanent exception is a policy change nobody approved. Exceptions are scoped to a
  CVE **and** an artifact; a wildcard in either is refused; each carries a stated reason.
  An expired exception is simply dropped: that is the system working.

**Clause 2 runs on the same invocation as clause 1.** Two commands would be two chances to
run only one, and the one skipped would be the one that failed.

---

## 3. Mutation testing

| Lane | Mutants | Killed | Notes |
|---|---|---|---|
| A | 21 | 20 | 1 documented equivalent: `=== true` vs truthiness, equivalent while all three verifiers return a boolean; kept as defence against a fourth that does not |
| B | 21 | 21 | — |

Five survivors were real and are fixed:

1. The manifest-level digest check was untested (the per-artifact verifier masked it).
2. `absent` vs `invalid` signature was collapsed into one reason.
3. **The domain-separation test was too weak** — asserting the payloads merely *differ*
   passes even when the type strings collide, because the structures differ anyway. It now
   asserts the type string is unique across schemes.
4. Every wrong-schema report case was also caught by a later structural check, so the
   schema check itself was unpinned.
5. The exception-expiry boundary was untested, so `<=` and `<` were indistinguishable.

---

## 4. Lanes C and D — not built, and exactly where they go

Neither is blocked. Both are specified below with the terrain verified, so a successor
implements rather than re-derives.

**The storage is `instance_settings.general`** — a singleton JSONB table that already
exists, so a kill-switch document needs **no migration and no new distributed table**.

**CORRECTION (2026-08-22), because the first version of this section was wrong.** It also
claimed "none of the keystone reconciliation". That does not hold, and a successor
following it would have hit a wall. `instance_settings` is absent from
`appTablePrivileges()` in `server/src/db/distributed-execution-databases.ts`, and
`assertExactServingRoleAuthority` requires EXACT ACLs across every non-system table — so
`aoa_app`, the role the lease path runs as, must have *zero* privileges on it, enforced
fail-closed. Reading the document from a poll therefore requires a grant entry (a
`SELECT`-only surface) plus whatever policy the table needs for a non-owner role. Less work
than a new distributed table; not none. The lesson is the programme's own: **check that the
consuming path can reach a store before recommending it.**

**The dimension already exists too**: `execution_targets.kind` carries
`pooled_gvisor | dedicated_worker | e2b | local_host | desktop`, which is the provider axis.
The template axis is the pinned E2B alias in `packages/sandbox-e2b-provider`'s capability
matrix (`templateId: "aoa-base"`).

**The enforcement seam is the poll response's `drain` outcome, and this was verified rather
than assumed.** Two things share the name and are not the same:

- `job-operations.ts:213` `drainJob` is a *job-level* graceful stop, and its comment ("there
  is no worker-fleet drain seam") documents the gap a kill switch fills.
- The frozen protocol's poll outcome `{outcome: "drain", retryAfterMs, reason}` is exactly a
  worker-level "stop asking for work, here is why" — and **nothing in the poll path emits it
  today**, so the protocol has an outcome with no producer.

A killed provider or template therefore answers its workers' polls with `drain` + a reason:
new leases stop, in-flight work finishes rather than being orphaned, and clause (3)'s two
halves fall out of one mechanism.

**Do NOT enforce inside `evaluateStaticLeaseEligibility`'s loop.** That loop records
`static_requirements_mismatch` negative certificates, and a kill switch is not a
requirements mismatch; routing it there would corrupt the eligibility certificates that
JOB-* relies on.

**A kill switch stays separate from JOB-007 target revocation** (design D1). "May this
device work", "may work be placed on this provider" and "may work run from this template"
are three questions; merging them would mean killing one bad template required revoking
every target using it — destroying enrollment state to express a policy opinion.

Lane D's reconcile builds on MIG-008's `legacy-resource-reconciliation.ts` seam.

---

## 5. Other deferrals

- **Production signing roots.** Everything runs on a TEST root, as DEP-001 and DSK-003/004
  do. Swapping in release roots is an operator step that changes no logic here.
- **Running an actual scanner.** Lane B evaluates a normalized report; producing that report
  from trivy/grype is infra wiring, deliberately outside the policy module.
- **The gate is not yet on the publish path.** `docker.yml` is a plain build-and-push and a
  hard gate there needs a release key. Note also that signing and verifying within one
  merge-train lane would be theatre: the lane builds its own images, so a self-signed
  verification proves nothing about approval. The gate runs on every PR and is ready for a
  promotion pipeline that has a recorded allowlist.
