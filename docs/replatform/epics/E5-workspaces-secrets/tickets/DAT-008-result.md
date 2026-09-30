# DAT-008 Result — slices 1–4 (control-plane half of the credential path)

**Status:** slices 1–4 LANDED. Slices 5–7 (worker redemption, deferral #3 closure check, warm
resume) NOT in this push — see §6.
**Epic:** `E5-workspaces-secrets`. **Owns:** inherited deferral #1.
**Start SHA:** `2f553e38e` ([`DAT-008-design.md`](./DAT-008-design.md), revision 1 at `60864244a`).
**Terrain:** [`DAT-008-terrain.md`](./DAT-008-terrain.md) (revision 1 retracts its §3).
**Implements:** the CM-013 target state (`current-main-crosswalk.md:29`).

---

## 1. What landed

| Slice | Commit | What |
|---|---|---|
| 1 | `f38d176d3` | Mint the handle in the placement transaction; migration 0262 |
| 2 | `880934fa6` | Advertise active handles in the lease envelope |
| 3+4 | `8dbf472ef` | The real value store, and the sandbox-local resolve route; migration 0263 |
| review | this commit | HTTP-log-policy registration + result doc + D1 nonce |

**The chain now has a boot root.** `resolveExecutionSecret` is a shipped, hardened, fence-first
mutator whose only constructor chain (`createFenceAwareEgressProxy` → `createSecretBrokerService`)
has **zero callers**, so none of it had ever executed. `POST /worker-control/execution-secrets/resolve`
→ `createSecretBrokerService` → `resolveExecutionSecret` closes that.

## 2. Acceptance — every clause to a named artifact

| Clause | Artifact | State |
|---|---|---|
| The key never crosses the frozen wire | `execution-secret-handle-envelope.test.ts` (12) — only a handle ref is emitted; `packages/worker-protocol/` untouched, `check:frozen-worker-protocol-v1` green | ✅ |
| Resolution is authorized per-attempt behind an active fence | route → `createSecretBrokerService.resolve` → `resolveExecutionSecret` (`guardActiveFence` first); `secret-resolve-authz.test.ts` unchanged and green | ✅ |
| Per-agent overrides are never rewritten | `execution-secret-handle-mint.test.ts` three-way split (20); `execution-secret-handle-mint-runner.test.ts` (21) | ✅ |
| Self-hosted stages no key (Rule #11) | mint refuses `not_cloud_deployment`; `isCloudSandboxMode` is the single mode predicate | ✅ |
| A wrong tenant/job/fence is denied without disclosure | `execution-secret-resolve.test.ts` (14) — every failure path returns the same coarse shape | ✅ |
| An `owner_desktop` target never receives a Company key | mint refuses on two independently-derived authorities; mutant M09 restores the tautology and is killed | ✅ (mint side; see §6) |
| Re-resolve on every new lease | the handle is a reference; resolution happens per redemption, never at mint | ✅ |
| Governed surfaces stay closed | `job-fence-surface.contract.test.ts` registers the three new repo methods **with** their classification | ✅ |
| Credential-bearing route logs no payload | `http-log-policy.test.ts` (+3 cases) | ✅ |

**Mutation:** 48 mutants across four guard modules — **46 killed, 2 documented equivalents**.

| Module | Mutants | Result |
|---|---|---|
| `execution-secret-handle-mint.ts` | 20 | 20 killed |
| `execution-secret-handle-mint-runner.ts` | 16 | 15 killed, 1 equivalent |
| `execution-secret-resolve.ts` | 12 | 11 killed, 1 equivalent |

Both equivalents are the same shape — **a stricter later check subsumes an earlier
defense-in-depth one**. R16: a `plain` canonical result never carries a `secretId`, so the
`secretId` guard already covers the type check. S05: a `device_handoff` outcome has no `seam`, so
the seam check already denies it. Neither is contorted into a false kill.

## 3. Defects this found, in itself

**A real one, found by mutation testing.** `canonicalizeBinding` does not *validate*: a malformed
non-string binding (a number, `{}`, `{type:"bogus"}`) falls through to its `secret_ref` arm and
yields `secretId: undefined`. The runner would have minted a `company_secret` handle pointing at
nothing, surfacing much later as an opaque resolve denial. The `catch` block was the wrong guard;
the fix validates the canonical result. Mutant R03 now covers it.

**A laundering bug in my own mapper, found by its own test.** `toSecretHandleRefs` discarded the
target for a `proxy` row, so a malformed proxy row that wrongly carried one was normalized into a
valid-looking ref — the exact thing the function's header says it must not do. The frozen proxy arm
is `.strict()` precisely so such a row can be rejected by name.

**One found by the adversarial pass.** A new credential-bearing worker route — fence token inbound,
resolved provider credential outbound — was never registered with `PAYLOAD_OMITTED_PATHS`, the HTTP
log policy that exists for exactly that class and already covers `/worker-control/enroll`.

## 4. Corrections to the design, made while building

1. **`gateCodingAdapterDispatch` is not a deployment-mode gate.** It admits on the adapter's v1
   disposition bucket and uses the mode only to phrase its rejection (`sandbox-coding-disposition.ts:157-169`).
   The design's R4 said to reuse it as the mode gate. It is now used for what it does, and
   `isCloudSandboxMode` is exported from the same module so there is one definition of the cloud
   mode set. *Reused a helper by name without reading it — the recurring lesson, caught this time.*
2. **Two columns the design had not anticipated.** `materialization_target` (0262): the frozen ref
   is `{kind:"env", target}` and `{kind:"env"}` alone is not a valid schema member, and for an
   agent's own secret the env-var name is not derivable from `ref_id`. `ref_version` (0263): the
   legacy runtime path honours an explicitly pinned version, so resolving `latest` would silently
   move a pinned agent onto a different secret version. Both nullable additive widens of an
   already-distributed table — existing grant and RLS policy inherited, no keystone reconciliation,
   C14 `IF NOT EXISTS` guards hand-appended.
3. **An overstatement of mine, corrected before it shipped in a comment.** I claimed a
   `worker_poll` session could redeem secrets. Sessions are **not** audience-scoped:
   `verifyWorkerOperationProof` returns no audience, and the frozen operations pin theirs as a
   `z.literal` on the *request*. Cross-route replay is already prevented by the device proof, which
   signs over method, path and body digest. What a descriptor-less route genuinely loses is the
   size ceiling, the timeout, the typed error emitter and the audience declaration — all four of
   which the local descriptor restores.

## 5. Two governed contracts caught this change; both were EXTENDED, not loosened

- **JOB-003's poll-shape contract** pins `tryOffer`'s statement count and the envelope's exact key
  set. The new statement and field are declared, and pinned: `storedHandles` must be an awaited
  `repos.jobControl.listActiveExecutionSecretHandles` keyed on the candidate's own
  `organizationId`/`jobId`, and `secretHandles` must be exactly `toSecretHandleRefs(storedHandles)`.
  The contract's own synthetic valid-poll fixture was updated too, so it still refuses a poll shaped
  any other way. The new read is registered in both `protected-value-escape` allowlists with its
  justification — those lists document themselves as "a register of reviewed calls, not a freeze".
- **JOB-004's closed repository surface** now names the three new methods with their classification.
  The mint pair is **deliberately unguarded**: it runs inside the placement transaction, before any
  lease and therefore any fence exists, so a fence guard there would be *unsatisfiable rather than
  stricter*. The fenced surface is the resolve, which is where a value is produced.

## 6. Deferred, honestly

- **Slice 5 (worker redemption + env synthesis + canary seeding), slice 7 (warm resume).** Not in
  this push, by the Integration Gate Owner's landing decision: slices 1–4 are inert, so they can go
  green independently and a red stays attributable.
- **Deferral #3 is closed on the MINT side only.** The mint refuses unless two independently-derived
  owner authorities agree. The *original* tautological comparison in the placement path is untouched
  — DAT-008 stops relying on it; it does not delete it.
- **`connector_oauth` stays fail-closed** by construction. It belongs to the `fence_proxy` class,
  and wiring it here would make it reachable from the sandbox-local route — the coercion DAT-004's
  own review had to fix once.
- **Nothing redeems yet.** The route has no production caller until slice 5. Stated rather than
  implied: this push adds a boot root and a door, and no one walks through it.
- **Agents with a plain-literal provider key outside strict secret mode** cannot be cut over. Count
  them before MIG-005.

## 7. Verification

`tsc -p server` / `-p packages/db` clean. 44 job/worker/secret/placement/egress/fence test files,
**435 passed**, 25 skipped (Windows integration guards — they run on Linux CI).
`check-distributed-execution-foundation` PASS, `check-guard-inventory` OK (30 scripts),
`check-test-inventory` OK, `check-d1-compose` PASS.

`docker/d1/campaign.env` bumped to `dat-008-slices-1-4` **after** the last `server/src` change: every
lease now performs one extra tenant read inside the offering transaction, and two migrations touch an
already-distributed table whose grants `assertExactServingRoleAuthority` compares against the live
role at boot.

### CI — watched to green on the exact candidate SHA `4840c04e1`

**PR gate** (run `32619755898`) — every job green, including the required verdict:

| Job | | Job | |
|---|---|---|---|
| `ci-required` | ✅ **the verdict** | `verify` | ✅ |
| `migrations` | ✅ | `e2e` | ✅ |
| `policy` | ✅ | `e2e-pgvector` | ✅ |
| `brand-check` | ✅ | `lint` | ✅ |
| `distributed-contract` | ✅ | `changes` | ✅ |
| `worker-protocol-contract-bytes (ubuntu-latest)` | ✅ | `(windows-latest)` | ✅ |

**D1 Merge Train** (run `32619751656`) — ✅ green on the same SHA, so the live two-replica
topology exercised the extra per-lease read and both migrations against the real serving role.

Two of these are worth naming rather than leaving in a table. `migrations` green means 0262 and
0263 both applied, and `migration-idempotency` did not trip on the hand-appended C14 guards.
`worker-protocol-contract-bytes` green on BOTH platforms confirms the frozen package's bundled
bytes are unchanged — the claim "no protocol change" is verified, not asserted.
