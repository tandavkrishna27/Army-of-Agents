# WRK-008 slice 1 — Design: serve a worker its own self-model

**Epic:** `E4-worker-daemon`. **Closes:** E4-D12's control-plane half.
**Terrain:** [`E4-D12-live-dispatch-terrain.md`](./E4-D12-live-dispatch-terrain.md).
**Start SHA:** the commit that adds this file.
**Sequenced by:** [`WAVE-4-EXECUTION-PLAN.md`](../../../WAVE-4-EXECUTION-PLAN.md) §3, step 1.

**Slice 2 (daemon self-model assembly + composing the loop) is NOT in this design.** This slice is
deliberately inert: it adds a route nothing calls yet. That is the point — it lets the control-plane
half land and go green on its own, so a red on slice 2 is attributable to slice 2.

---

## 1. Goal

A worker that has enrolled can read **its own** execution target's `registeredProfile` and
`providerConstraintProfile` — the two fields `WorkerSelfModel` is missing — over a
worker-authenticated route, without learning anything about any other target.

## 2. Why this is not a protocol change

Terrain §4, in one line: the frozen enroll response is `.strict()` and adding to it would be an
E4-D02 STOP, but nothing requires that. The DAT-008 precedent — shipped in this session — is frozen
*schemas* over a non-frozen *transport* with a **local** descriptor, and E4's own WRK-005 non-goals
already assign such routes to the owning epic. `packages/worker-protocol/` is not touched.

## 3. The route

`POST /api/execution-targets/self/placement-profile`

**POST, not GET, and that is load-bearing.** `rawBody` is only captured when the body is non-empty
(`app.ts`), and the worker-session auth path REQUIRES `rawBody` to recompute the device proof's body
digest. A GET could therefore never authenticate as a worker session — which is why all ten frozen
worker ops are POST as well. *(The design originally said GET; the adversarial pass caught that it
would refuse every legitimate caller while typechecking and passing unit tests.)*

Mounted in `routes/execution-targets.ts` beside the existing worker heartbeat, behind the **same**
`requireWorkerHeartbeatAuthority` middleware that already authenticates a worker to its own target
row. That middleware's URL carries no org id and no slug precisely so *"a caller can never address
another tenant's row"* — this route inherits that property by construction rather than re-deriving
it, and `self` in the path makes it explicit that no identifier is accepted from the caller.

**Response**

```
200 { protocolVersion: 1, registeredProfile: {...}, providerConstraintProfile: {...}, serverTime }
```

Both bodies are returned **as stored** — no re-shaping, no field selection.

**Corrected during implementation, because the original rationale was wrong.** This design said key
re-ordering would break verification. It would not: `canonicalizeJsonV1` **sorts keys** before the
digest is computed, and a JSONB round trip does not preserve order anyway. The real requirement is
that every FIELD and VALUE survive intact — `verifyAndBrandProviderConstraintProfileV1` recomputes
the digest over every key except `digest`, so a dropped, added or coerced field fails the brand and
the worker refuses its own self-model. Serving the stored object untouched is how that is
guaranteed rather than reasoned about.

The integration test therefore asserts the invariant that is real — a profile brands successfully
**after** a live JSONB round trip — rather than the ordering property that never mattered.

**Conditional.** The body may carry `knownSelfModelHash`; a match answers **304**, so a worker can
re-check on every poll cycle instead of caching a self-model across a generation bump. The hash
composes the stored `registered_profile_hash` with the constraint profile's own `digest`, so a
constraint change written independently of the registered profile cannot slip past it. *(Added
during implementation: slice 2 codes against this contract, so a conditional added afterwards would
mean changing a shipped one — and it retires the terrain's "when does the worker re-read?" question.)*

**Every refusal answers the same coarse `unauthorized`** — including "no such target" and "never
configured" — so the route is never an oracle for target existence, generation or revocation state.

**Mounted only when `opts.workerSession` is set.** That value is already exactly the
distributed-execution flag, so the route is ABSENT rather than present-and-always-refusing:
unreachable by absence instead of by behaviour.

## ★ 4. Three decisions, each with the fail-closed direction chosen

**4.1 — Session auth only; the legacy token path is refused.**
`requireWorkerHeartbeatAuthority` admits two identities: a legacy bearer worker token
(`kind:"legacy"`) and the device-proof-bound session (`kind:"session"` →
`VerifiedTargetPrincipal`). A distributed worker always has the latter. This route **admits only
`session`** and refuses `legacy` with the same coarse `unauthorized` — the self-model is what lets a
worker lease and execute tenant work, and it should not be reachable by the weaker of two
credentials merely because the middleware happens to accept both.

**4.2 — The generation the caller proves must match the target's current generation.**
`VerifiedTargetPrincipal` carries `targetGeneration`, and `registeredTargetProfileV1` carries
`deviceGeneration`. If they differ, the worker's session predates a device-generation bump and it is
asking for a self-model it is no longer entitled to act on. Refuse rather than serve a profile the
caller will immediately act on with a stale identity.

**4.3 — A revoked target serves nothing.** `registeredTargetProfile.revokedAt` non-null means the
target is revoked. Serving its profile would hand a revoked worker exactly the artefact it needs to
start leasing.

**4.4 — `disabled` refuses; `draining` and `offline` do NOT.** *(Added during implementation: the
design missed `execution_targets.status` entirely, and it is an authorization property.)* `disabled`
is an operator saying "do not use this target". The other two are deliberately admitted, and the
reasoning matters more than the rule:

- **`draining` must still serve.** Drain means "take no NEW work" — that is the poll response's job.
  Withholding the self-model would break the drain semantics of a worker legitimately finishing
  in-flight work.
- **`offline` is a LIVENESS observation, not an authorization one.** A worker that was unreachable
  and came back must be able to recover; refusing here turns a transient outage into a permanent one.

The over-strict direction is a real bug, so it is mutation-tested too: a mutant widening the check to
`!== "active"` (which would strip a draining worker's self-model) must be killed.

All four are mutation-tested. 4.2's test must use a session that is otherwise **completely valid**
— a test whose session fails for another reason would pass whether or not the generation check
exists.

## ★ 5. The absent-profile case is a product statement, not an error path

A target with no admin-set placement profile has no `registeredProfile`. `PUT
.../placement-profile` is the only writer and it is `assertOrgAdmin`-guarded.

So: **enrolment alone does not produce a dispatchable worker.** An operator must also set its
placement profile. This slice makes that concrete by returning 404, and slice 2 will make the worker
fail closed on it.

That is worth asserting deliberately rather than discovering: it means "the worker enrolled
successfully" and "the worker can take work" are two different states, and any operator runbook has
to say so. Recorded here because this design is where it first becomes true.

## 6. Tests

| Area | Test |
|---|---|
| Happy path | a valid session for target T returns T's two profiles, byte-identical to storage |
| **Verbatim** | the response body re-verifies through `verifyAndBrandProviderConstraintProfileV1` — proving no normalisation broke the digest |
| **Tenancy** | a valid session for target A can never obtain target B's profile; the route accepts no identifier at all |
| **Auth (4.1)** | a *working* legacy worker token — one the middleware genuinely accepts — is refused here |
| **Generation (4.2)** | an otherwise-valid session whose `targetGeneration` is behind the target's is refused |
| **Revocation (4.3)** | a target with `revokedAt` set serves nothing |
| Absent profile | 404, and the response discloses nothing about whether the target exists |
| Dormancy | the route is unreachable when the distributed-execution composition is off |
| Mutation | every guard in §4, plus the verbatim property |

**Anti-vacuity, stated up front.** The tenancy test must use two targets that both genuinely exist
with different profiles — asserting that a caller cannot reach a target that does not exist proves
nothing. Same for 4.1: the legacy token has to be one the middleware would otherwise accept.

## 7. Out of scope

- **Slice 2** — daemon self-model assembly, local branding, composing the loop and supervisor, and
  the worker-side dispatch flag. All of it, including the three open questions in the terrain.
- **Any change to how the profile is WRITTEN.** `PUT .../placement-profile` stays as it is.
- **Serving any other target's profile.** There is no operator-facing read here; this route exists
  for one worker to learn one thing about itself.

## 8. Rollback

Remove the route. Nothing calls it until slice 2, so the rollback unit is the mount and there is no
data to unwind.
