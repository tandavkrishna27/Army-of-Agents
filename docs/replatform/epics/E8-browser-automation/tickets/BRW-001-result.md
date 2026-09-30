# BRW-001 — Browser-session job and policy extensions — RESULT

**Epic:** E8 — Browser automation · **Lane:** B (`C:\e8`, local branch `lane-b`)
**Start SHA:** `949c0324b` (the design commit, per the §1 process)
**Plan-review commit:** `14711e813` · **Implementation:** `ed89a7255` + this commit
**Terrain mapped at:** `1334c8a90` · **Status:** COMPLETE

---

## 1. What changed, and what the ticket turned out to be

BRW-001's outcome reads "add browser engine/template, viewport, locale, download, trace,
session TTL, and interaction-approval capabilities as **additive protocol fields**." Terrain
established it is **not a protocol ticket at all**: every one of those fields is already in
frozen v1 (`BRW-001-design.md` §1.1), so the E4-D02 custodian STOP never fires, and
acceptance clause 1 is already implemented inside the frozen matcher.

The real defect, **measured** rather than reasoned (design §1.5): `buildJobEnvelope` passes
the raw untyped submission blob straight through as the workload, gated only by
`jobEnvelopeV1Schema.safeParse`, which returns `null` — and therefore **no lease** — on any
mismatch. So a browser job submitted through the already-mounted route was accepted at
submit and then **silently never leased**, failing far from its cause as an absence.

Three new lane-owned modules and one wiring block close it. **No frozen-package edit, no
migration, and no edit to any file on the §5.5 do-not-touch list.**

| File | Role |
|---|---|
| `server/src/services/browser-job-config.ts` | Normalises a caller's config into the frozen `browserWorkloadV1Schema` shape; server TTL ceiling beneath the frozen one; re-validates its own output against the frozen schema so it cannot drift |
| `server/src/services/workload-input-validators.ts` | The registry. **Declares** a slot for every frozen workload type; **enforces** only `browser_session` |
| `server/src/services/browser-artifact-retention.ts` | Retention as a total function of artifact kind, control-plane-owned |
| `server/src/services/job-submission.ts` | The wiring block — **its position is the security property** |

## 2. Acceptance clause → named executable artifact

Prose is not evidence. Every clause maps to a named artifact or is explicitly deferred.

| # | Acceptance clause | Named executable artifact | State |
|---|---|---|---|
| 1 | Old workers reject browser jobs by capability | `server/src/__tests__/browser-capability-rejection.test.ts` — worker without `workload.browser_session`; worker with the capability but zero `browserSessionSlots`; worker advertising past the server ceiling | ✅ 11 tests |
| 1b | …without seeing sensitive inputs | same file, "the matcher structurally CANNOT see the browser configuration" — `jobCapabilityRequirementsSchema` is `.strict()` and refuses a `workload` or `secretHandles` key, so the config **cannot** be part of the matching decision | ✅ proven structurally |
| 2a | Bounded TTL is mandatory | `server/src/__tests__/browser-job-config.test.ts` — omitted ⇒ bounded default; over-ceiling ⇒ typed reason; zero/negative/non-integer refused; server ceiling asserted ≤ frozen 43 200 | ✅ 29 tests |
| 2b | Artifact retention is mandatory | `server/src/__tests__/browser-artifact-retention.test.ts` — total over every frozen `ARTIFACT_KIND`; credential-bearing kinds pinned to `ephemeral`; unknown kind fails safe | ✅ 10 tests |
| Test | N-1 compatibility | `browser-capability-rejection.test.ts` "N-1 compatibility" — non-overlapping protocol range, stale policy hash, revoked target, unknown must-understand token | ✅ |
| Test | Validator fixtures | `browser-job-config.test.ts` accept/reject fixture tables, asserted against the **frozen** schema as the authority | ✅ |
| — | Submission no longer silently non-leases | `server/src/__tests__/job-submission-browser-input.test.ts` — an accepted browser job persists a frozen-valid workload; an invalid one is refused at submit | ✅ 9 tests |
| — | Registry does not disturb other workloads | `workload-input-validators.test.ts` + `job-submission-browser-input.test.ts` "a non-browser source is completely unaffected" | ✅ 17 tests |

**Command:** `cd server && npx vitest run src/__tests__/browser-job-config.test.ts
src/__tests__/workload-input-validators.test.ts src/__tests__/browser-artifact-retention.test.ts
src/__tests__/browser-capability-rejection.test.ts src/__tests__/job-submission-browser-input.test.ts`
→ **76 passed**. With the five job-control regression suites: **170 passed**.

## 3. Plan review (§1 step 4) — four findings

Full detail in `BRW-001-design.md` §7.

- **F1 [P1] — an authorization oracle. FIXED.** `inputHash` was computed at
  `job-submission.ts:121`, before the admission gate at `:139-153`. Validating there would
  have given an **unauthorized** caller two distinguishable outcomes. Validation now runs
  after **both** authorization stages, pinned by tests asserting the denied responses are
  **identical**, not merely both denials.
- **F2 [P2] — duplication into SVC-001. FIXED** by the registry, with declared ≠ enforced.
- **F3 [P1] — cross-lane. NOT FIXED, by decision.** Reported directly to the programme
  owner; deliberately not written up on the branch at their instruction. It is the stated
  reason the `batch` slot is declared `not_enforced`.
- **F4 [P2] — status unspecified. FIXED.** 400 for a malformed config, against the existing
  403 for authorization denial.

## 4. Adversarial review (§1 step 6) — two real defects in my own work

Attacked rather than re-read. Both were real, both fixed, both now pinned by tests that
failed first.

1. **The ceiling guard did not cover the parameter I had exposed.** The module-load
   assertion checked only the default constant, but `normalizeBrowserJobInput` takes a
   `ceilings` argument — so an injected ceiling was never checked. Not exploitable today
   (the frozen schema still backstops at 43 200, and the production caller passes no
   argument), but a guard that only covers the value nobody passes is weaker than it looks.
   The predicate is now a shared function applied at module load **and** on every call.
2. **`isPlainObject` admitted class instances.** `typeof x === "object" && !Array.isArray(x)`
   accepts a `Date`, and since `Object.keys(new Date())` is empty it passed the
   unknown-field check and **normalised into a fully-defaulted valid browser workload**.
   Unreachable through the JSON route today, but the registry is shared and SVC-001 will
   reuse it. Now requires a plain-or-null prototype.

## 5. Mutation testing (§1 step 8) — 21 mutants, 20 killed, 1 documented equivalent

Every guard was mutated: both session-ceiling bounds and the integer check, the TTL
comparison (including an off-by-one `>` → `>=`), the plain-object prototype check, the
unknown-field check, the frozen re-validation, the injected-ceiling guard, the registry
dispatch and its fail-closed unknown-type branch, the declared-vs-enforced discriminator,
the retention fail-safe, the credential-bearing mapping, the null-prototype lookup, the
400/403 status, `inputHash`'s source, the persisted input, **and the ordering itself**.

The harness declares which tests each mutant must fail, so a mutant killed by anything else
is reported as a suspect rather than a kill — the false-kill note has fired repeatedly on
this programme and was right every time. **Result: 20 killed, 1 survived, 0 suspect.**

**The ordering mutant was killed.** M21 moves the validation block above the admission gate
— literally reintroducing finding F1 — and the three F1 tests fail. That is what makes the
security property a tested invariant rather than a comment.

**M02 survived first, and it was a defect in MY OWN TEST.** With the ceiling's lower bound
relaxed from `>= 1` to `>= 0`, a ceiling of `0` becomes "valid" and the call still fails —
but as `max_session_seconds_above_ceiling`, a completely different guard. The test asserted
only `ok === false`, so it could not see the bound it existed to test. Fixed by pinning the
**reason**; the mutant now dies. (This is the recurring shape on this programme: first-round
survivors are usually defects in the test, not the code.)

**M07 is a genuine EQUIVALENT MUTANT, and it refuted my own explanation of my own fix.**
Removing `Array.isArray(value)` changes nothing: an array's prototype is `Array.prototype`,
so it already fails `proto === null || proto === Object.prototype`. The prototype check I
added for the Date defect **subsumes** the array check. `Array.isArray` is retained only as
a fast path, and the source now says so explicitly, so nobody later deletes the
load-bearing prototype check believing arrays are handled above it.

## 6. Deferrals — stated honestly, including what is built but not wired

- **`browserArtifactRetention` is built and has no production caller yet.** It is consumed
  by BRW-003, which stamps artifact manifests. Declaring this plainly because an unwired
  correct mechanism is this programme's signature defect; BRW-001's clause is that retention
  is *mandatory and always available*, which the totality tests prove, not that it is
  already applied to a stored manifest.
- **`batch` and `service` registry slots are declared, not enforced.** Deliberate (§F2/F3).
  `service` is SVC-001's to wire. Enforcing `batch` from this lane would change the live
  cutover path's behaviour.
- **Download/upload policy enforcement is BRW-004's**, not claimed here. BRW-001 establishes
  only the retention class over the frozen `download` artifact kind.
- **Pausing a browser action for approval is BRW-004's**; the operator experience is
  BRW-006's. BRW-001 establishes that PRT-007's approval and runtime-decision surfaces exist
  and are correctly separated.
- **Template selection is BRW-002's.** It is registry-side by a locked frozen decision
  ("provider-native regions/templates never enter the wire"). Whether `e2b/e2b.Dockerfile`
  carries a Chromium layer has **not** been checked and is BRW-002's first question.
- **No D1/D3 lane work.** BRW-005 owns both; the D3 lane does not yet exist.

## 7. `docker/d1/campaign.env`

Bumped. The change alters runtime behaviour on the `server/src` path (`job-submission.ts` is
live), and `server/src` is not on the D1 lane's push filter, so without a bump the live
two-replica lane would not exercise it. The behaviour change for the paths D1 actually
drives is nil **by construction** — `batch` is a `not_enforced` passthrough — which is
precisely the claim worth proving on a real lane rather than asserting.

Coordination note (§5.7): a bump is last-writer-wins across lanes. Lane A's most recent
campaign already ran green on `39fa9fe34` before this bump, so nothing of theirs is left
unproven by it.
