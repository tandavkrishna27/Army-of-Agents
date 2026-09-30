# WRK-008 slice 1 Result — serve a worker its own self-model

**Status:** LANDED. Closes E4-D12's **control-plane half**. Slice 2 (daemon assembly + composing
the loop) is NOT in this push and is where live dispatch actually begins.
**Epic:** `E4-worker-daemon`. **Start SHA:** `cb8f4d014`
([`WRK-008-slice-1-design.md`](./WRK-008-slice-1-design.md)).
**Terrain:** [`E4-D12-live-dispatch-terrain.md`](./E4-D12-live-dispatch-terrain.md).

---

## 1. What landed

`POST /api/execution-targets/self/placement-profile` — a worker reads its own registered target
profile + provider-constraint profile, behind the same middleware that already authenticates a
worker to its own target row. The URL carries **no target identifier, no org id, no slug**: the
target comes from the authenticated principal, so cross-tenant reach is answered by *construction*
rather than by a check that could drift out of agreement with the middleware.

| Commit | |
|---|---|
| `cb8f4d014` | design (Start SHA) |
| `88dda5596` | the target-status guard the design missed |
| `bb424330b` | the route + three adversarial findings |
| `bce028d0c` | D1 nonce + a correction to how that file describes itself |

## 2. Acceptance — every clause to a named artifact

| Clause | Artifact | State |
|---|---|---|
| A worker reads its own self-model | `worker-self-model-read.integration.test.ts` (6) | ✅ |
| No other target is reachable | route accepts **no identifier**; target from the principal | ✅ by construction |
| Payload survives storage intact | integration: profile **brands** after a live JSONB round trip, plus a mutated-field pair proving the check can fail | ✅ |
| Legacy credential refused | `worker-self-model-admission.test.ts` + refused again before the DB read | ✅ |
| Stale generation refused | same suite, both directions (behind AND ahead) | ✅ |
| Revoked / disabled target serves nothing | same suite | ✅ |
| Absent profile refuses | same suite | ✅ |
| Non-disclosing | every refusal answers the same coarse `unauthorized` | ✅ |
| Unreachable when distributed execution is off | route **not mounted** unless `opts.workerSession` | ✅ by absence |
| No protocol change | `packages/worker-protocol/` untouched | ✅ |

**Mutation: 13 mutants, 13 killed, 0 unanchored.** 16 unit tests + 6 integration tests.

## ★ 3. Three findings from attacking it — one would have shipped a route that never worked

**It was a GET.** `rawBody` is only captured when the body is non-empty (`app.ts:282`), and the
worker-session auth path *requires* `rawBody` to recompute the device proof's body digest. **A GET
can never authenticate as a worker session.** It typechecked, the unit tests passed (they cover the
pure decision), and it would have refused every legitimate caller at runtime. Now POST — which is
why all ten frozen worker ops are POST too.

**The route was mounted unconditionally** and merely refused when distributed execution was off,
while the design claimed it was "unreachable when the composition is off". False as built. Now
mounted only when `opts.workerSession` is set — absent rather than present-and-always-refusing.

**The legacy credential was refused only inside the decision function**, after the database read.
Now refused before it, so a token that was never going to be served causes no read on its behalf.
The decision function still refuses it too; that is where the guard is mutation-tested.

## ★ 4. Two claims of my own that were wrong, corrected rather than quietly dropped

**4.1 — "verbatim or the digest breaks" was overstated, and I nearly wrote a test around it.**
The design said key re-ordering would break verification. It would not: `canonicalizeJsonV1` **sorts
keys**, and a JSONB round trip does not preserve order anyway. The requirement that is real is that
every FIELD and VALUE survive — `verifyAndBrandProviderConstraintProfileV1` recomputes the digest
over every key except `digest`. The integration test now asserts the invariant that exists (it
brands after storage) rather than the ordering property that never mattered.

**4.2 — the design missed `execution_targets.status` entirely**, and the interesting part is that
the "safe" fix would itself be a bug. `disabled` refuses; `draining` and `offline` must **still
serve**. Drain means "no NEW work" — that is the poll response's job, and withholding the self-model
would break a worker legitimately finishing in-flight work. Offline is a *liveness* observation, not
an authorization one; refusing turns a transient outage into a permanent one. So the guard is
specifically `disabled`, not `!== "active"`, and mutant **W12** exists to kill the over-strict
direction.

## 5. A product statement this makes true

**Enrolment alone does not produce a dispatchable worker.** `PUT .../placement-profile` is
`assertOrgAdmin`-guarded and is the only writer, so a target can enrol successfully and still have
no profile. "Enrolled" and "can take work" are two different states.

Asserted deliberately here rather than left to surface as a confusing refusal later. **It belongs in
an operator runbook, and there is not one** — the operability gap named in the execution plan,
showing up concretely.

## 6. Deferred, honestly

- **Slice 2** — daemon self-model assembly, local branding, composing the loop and supervisor, and
  the worker-side dispatch flag. Including all three terrain open questions.
- **Nothing calls this route.** It is a door with no one walking through it until slice 2. Stated
  rather than implied.
- **No end-to-end HTTP test.** The integration suite proves the storage boundary
  (`loadWorkerSelfModel`); the auth path, the 304 and the wire shape are proven at unit level and by
  reuse of the existing middleware, not by an HTTP round trip with a signed device proof. That is a
  real gap and slice 2 — which must build a signing client anyway — is where it closes cheaply.

## 7. Verification

`tsc -p server` clean. 16 unit + 6 integration (embedded PostgreSQL; Windows needs
`AOA_RUN_WIN_INTEGRATION=1` or they silently skip and a mutation harness reports false survivors).
`check-guard-inventory`, `check-dependency-graph`, `check-d1-compose` all pass.

D1 nonce bumped **after** the last `server/src` change: the route registers on both replicas at
boot inside the distributed-execution block, and a bad registration or import edge there is a boot
failure no unit suite can observe.
