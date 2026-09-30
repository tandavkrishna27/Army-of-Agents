# DAT-005 Result — Fence-aware egress policy + credential redaction

**Status:** COMPLETE — implemented per the committed design, adversarial-reviewed, all local gates green. Epic completion is the Integration Gate Owner's call.
**Epic:** `E5-workspaces-secrets`. **Design:** [`DAT-005-design.md`](DAT-005-design.md). **Source:** `program-design.md` (E5 DAT-005).
**Process:** terrain-map Workflow → orchestrator re-verification → committed design → implementer subagent → adversarial-review Workflow (5 security-dimension finders → refute-by-default verifiers) → orchestrator re-verify all gates + read all 4 security-core files + reconcile every verdict (re-tracing refutations) + fix fail-first → this doc.

---

## 1. Outcome

The server-side default-deny egress layer that MATERIALIZES a DAT-004 broker value into a governed outbound request — plus the net-new worker-daemon secret-redaction scrubber. Zero worker-protocol edits (frozen); one nullable audit column widen (`applied_policy_version` on `job_secret_handles`, migration 0251) → zero keystone reconciliation.

- **`egress-policy.ts` (D1)** — the PURE `classifyEgressDestination(url, resolvedAddrs, policy, controlPlane?) → 'allow' | metadata | private | control_plane | not_allowlisted`. Layered default-deny: positive allowlist (https + host + port) THEN IP-range block (deny-if-ANY-resolved-addr-unsafe = DNS-rebind defense), with precedence metadata > control_plane > private. Config-sourced control-plane deny set (`AOA_CONTROL_PLANE_DENY_CIDRS`). Reuses `outbound-url-guard.isPrivateIP`.
- **`egress-proxy.ts` (D2/D3)** — `createFenceAwareEgressProxy`: policy-load (fail-closed) → DAT-004 `broker.resolve()` per-request fence reauth (persists `applied_policy_version` in the same audit UPDATE) → destination binding (requested URL origin == handle's bound destination, both allowlisted) → classify → materialize the value into request **HEADERS** at delivery through an **IP-pinned** socket. The value only ever exists server-side; the live outbound channel is the inert E4-D12 seam (`failClosedEgressDispatcher`).
- **`redaction.ts` (D4)** — net-new worker-daemon in-place scrubber (`scrubEventStrings`) over the frozen `visitWireStrings`/`findSecretCanaryStringMatches` traversal, marker `«redacted»`. Run in `EventSequencer.#emit` BEFORE the digest + `workerEventV1Schema.parse()`, so the WRK-006 durable outbox (seals verbatim, never re-digests) can only ever hold the marker. Per-run canaries passed explicitly (never a module singleton).
- **Vectors gate (D5)** — `check-egress-policy-vectors.mjs` (third independent re-derivation) + `.test.mjs`, bound to `tests/fixtures/egress-policy/v1/vectors.json`; the REAL classifier binds to the SAME fixture (`egress-policy.test.ts`). Wired into the always-on `policy` CI lane.

---

## 2. Adversarial review + fixes

The review (workflow `wf_62670089-2cb`; 5 dimensions; 1 CONFIRMED, 2 PLAUSIBLE, 1 REFUTED; 2 verifiers died on retry-cap, adjudicated by the orchestrator). Reconciling every verdict against my own read of `egress-policy.ts`, `egress-proxy.ts`, `redaction.ts`, and `events.ts` — **re-tracing the REFUTED finding** (the recurring lesson):

| # | Finding | Sev | Verdict | Disposition |
|---|---------|-----|---------|-------------|
| **3** | The vectors-gate reference `isPrivateIp` is materially WEAKER than the real classifier — only unwraps the DOTTED IPv4-mapped form, misses hex-mapped (`::ffff:a9fe:a9fe`) + first-word-zero (`::10`). The dual-driven "cannot silently diverge" invariant is VOID for that encoding class | MED | **CONFIRMED** | **FIXED** — strengthened the reference `parseIp` (hex-mapped canonicalization) + `isPrivateIp` (`::/16` first-word-zero); added 4 fixture deny vectors |
| **4** | Same root asymmetry in the REAL `parseIp` (dotted-only unwrap) — a hex-mapped PUBLIC control-plane IP evades the family-4 `control_plane` gate (isPrivateIP can't catch a public IP) | HIGH | **REFUTED** (not live via DNS) | **FIXED AT SOURCE (defense-in-depth)** — re-traced: the refutation is correct that Node's `dns.lookup`→`inet_ntop` emits only the DOTTED mapped form, so DNS cannot inject the hex spelling; but BOTH verifiers independently recommend the same source fix, and it closes #3's real side. Canonicalize EVERY IPv4-mapped IPv6 form to family-4 in `parseIp` |
| **1** | Redaction wired only to the fence-close proxy's aux denial sequencer — the supervisor's PRIMARY lifecycle sequencer (`supervisor.ts:227`) is built with NO canaries, so the highest-volume stream is a verbatim no-op; voids the design's "uniform across every sink" | MED | **PLAUSIBLE** (latent — every `terminal()` errorMessage is hardcoded null; seeding seam inert) | **FIXED** — made `redactionCanaries` REQUIRED on `EventSequencerDeps` (compile-time: no sequencer can be built unscrubbed by omission), plumbed into the supervisor sequencer |
| **2** | Resolved policy never bound to the job's frozen `networkPolicyRef` (policyId/version/digest) — the proxy classifies against + records whatever the inert `resolveNetworkPolicy` seam returns | MED | **PLAUSIBLE** | **DEFERRED (residual)** — the frozen ref is not plumbed onto `VerifiedWorkerOperation`/`EgressRequestV1`; the live resolver is the E4-D12 inert seam. The binding assertion belongs where that resolver is wired. Tracked (spawned task). |
| — | Live secret materialized into server memory (broker resolve) BEFORE classify — a denied/SSRF destination still triggers full resolution | LOW | ~REFUTED (verifier died) | No fix — the value never leaves server memory on a denied path (`material` is dropped at the classify-deny return; never logged/persisted/dispatched). Fence-first reauth is the intended discipline (classifying before proving the fence is live would be worse). |

**The #3+#4 fix is exactly why re-tracing REFUTED findings matters** — a HIGH SSRF verdict that was correctly refuted on live-reachability (DNS won't emit the hex spelling) still pointed to a real latent `parseIp` family asymmetry. Fixing it at the source turns a would-be secret delivery into a hard deny. **Fail-first proven:** reverting the source `parseIp` canonicalization, the real classifier returns `allow` for a hex-mapped PUBLIC control-plane IP (`expected 'allow' to be 'control_plane'` — the exact secret-delivery bypass) and `private` for hex-mapped IMDS (`expected 'private' to be 'metadata'`); both fixture-bound gates go red; then restored → 25 pass. The #1 fix's fail-first is the `tsc` compile error at `supervisor.ts:227` + `fence-close-proxy.ts:128` the required field surfaces.

---

## 3. Gate table (all GREEN, re-run after fixes)

| Gate | Result |
|------|--------|
| `db` / `server` / `worker-daemon` typecheck | clean |
| `egress-policy.test.ts` (real classifier + fixture binding) | 25 pass (incl. hex-mapped metadata/control-plane + first-word-zero) |
| `check-egress-policy-vectors.mjs` (+ `.test.mjs`) | PASS (4 allow, **19 deny**) / 11 pass |
| `egress-proxy.integration.test.ts` (`AOA_RUN_WIN_INTEGRATION=1`) | 9 pass |
| `redaction-before-outbox` + `durable-event-sink` | 13 pass |
| full `packages/worker-daemon` suite | **371 pass** (required-field change breaks nothing) |
| DAT-004 contracts (`secret-resolve-authz`, `job-fence-surface.contract`, `secret-broker.integration`, `secret-broker-dispatch`) | 49 pass |
| `check-secret-resolve-vectors.mjs` | PASS (5 admit, 14 reject) |
| `check:distributed-foundation` / `check:frozen-worker-protocol-v1` | PASS / OK (zero worker-protocol edits) |
| worker-daemon import-boundary | clean (`redaction.ts` imports only `@armyofagents/worker-protocol`) |
| migration/schema snapshot contract (0251 contiguous) | 33 pass |

---

## 4. Non-goals + residual risks

Non-goals (deferred): the **live outbound socket channel** (`failClosedEgressDispatcher` = E4-D12 inert seam), the **canary-seeding channel** that populates `redactionCanaries` at runtime (E4-D12 — until then every construction site passes `[]`), DAT-007 (tool surface).

Residuals:
- **(2) Frozen `networkPolicyRef` binding** — the proxy trusts the inert `resolveNetworkPolicy` seam; when the live resolver is wired (E4-D12) it must assert `policy.{policyId,version,digest}` == the job's frozen ref (loadable via `auth.organizationId` + `jobId`) BEFORE classify, so `applied_policy_version` cannot record a version the job was not admitted under. Tracked (spawned task).
- **Value materialized before classify** — accepted (server-memory only; dropped on deny). A future hardening could split authorize-from-materialize at the proxy layer (mirroring DAT-004's mutator returning `AuthorizedSecretResolution` with no value), classifying between authorize and materialize.

---

## 5. Doc drift to surface (not self-fixed)

`epics/README.md` says E5 = `DAT-001–DAT-006`; `program-design.md` defines `DAT-001–DAT-007`. Integration Gate Owner's reconciliation.
