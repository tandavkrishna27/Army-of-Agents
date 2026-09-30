# DAT-005 Design — Egress policy and credential redaction

**Status:** `design` (reviewable artifact; implementation follows via per-slice fail-first TDD + distinct adversarial review)
**Epic:** `E5-workspaces-secrets` (fifth ticket). **Authoritative source:** `program-design.md:652-657`.
**Depends on (complete):** DAT-004 (the lease-scoped secret broker — `secret-broker.ts` `FenceResolvedMaterial{value,materialization,destination}`, per-request reauth) + WRK-004 (sandbox supervisor + `FenceCloseProxy.openEgress`). Frozen worker-protocol v1 SHA `b7a842870ce7509d8baa75409e0ab19da375c88a`.
**Grounded by:** the DAT-005 terrain-map (5 readers + synthesis); the load-bearing claims re-verified in `C:\e3` — the frozen `networkPolicyV1Schema`/`networkDeniedPayloadV1Schema` (no version field), the locate-only canary registry (`wire-safety.ts:95-150`, **no scrubber**), the `EventSequencer.#emit` redaction chokepoint (before the digest), and `job_secret_handles` having no policy-version column.

---

## 1. Scope + framing

**Outcome (program-design.md):** enforce a **default-deny** destination policy through the **fence-aware egress path**, block private/metadata/control-plane ranges + direct bypass, and **redact known secret values from events**.

**Zero new wire ops, zero worker-protocol edits** (frozen; verified — closed 10-op list, `network_denied` is `{destinationClass, reason}` only). The complete network-policy model is already frozen: `networkPolicyV1Schema` (`policy.ts:81-94`, `defaultAction: literal("deny")`, `allow[]` host+port+https, `denyPrivateNetworks`/`denyMetadata`/`denyControlPlane` all `literal(true)`, `version` + `digest`), carried on the job as `networkPolicyRefSchema{policyId, version, digest}`.

**The one architectural fact that decides the design (verified):** the resolved secret **value only ever exists server-side** (`secret-broker.ts` runs `runInTenant` + imports `@armyofagents/db`), and the **worker-daemon boundary forbids importing `server/*` or `@armyofagents/db`** (`worker-daemon-boundary.mjs` — only worker-protocol+pino+node:*). Therefore DAT-005 is a **two-component split**:

| Component | Runs | Holds value? | Responsibility |
|---|---|---|---|
| **Fence-aware egress proxy** | **server-side** (imports `secret-broker.ts` + `outbound-url-guard.ts`) | yes (never enters the sandbox for a network-use handle) | per-request reauth via `broker.resolve()`; default-deny destination eval; block RFC1918/metadata/control-plane + DNS-rebind pin; materialize value into request **headers** at delivery; persist applied policy version |
| **Worker-daemon egress gate + redaction** | **worker-daemon (hermetic)** | no | `FenceCloseProxy.openEgress` gate (exists) emits `network_denied`; **NEW in-place redaction scrubber** at `EventSequencer.#emit` before the digest |

**Like WRK-005/006/007 + the E5 tickets, DAT-005 is inert-until-wired:** the *live* cross-process channels (how the sandbox requests a governed egress; how `FenceResolvedMaterial.value` reaches the daemon's per-run canary set) are **unbuilt seams in the dormant distributed model** (verified: the canary registry's only consumers today are protocol tests). DAT-005 delivers the components + pure decisions + the scrubber, tested hermetically; the live channel wiring is E4-D12 live-wiring debt (flagged §7).

---

## 2. Security invariants (every one gets a fail-first test)

1. **Default-deny egress** — a destination is allowed ONLY if its host∈`networkPolicyV1.allow` (https, host+port) AND its resolved IP ∉ deny-ranges; else denied with the exact frozen class.
2. **IP-range block + DNS-rebind** — resolve the host (`dnsLookup{all:true}`), reject any resolved address in RFC1918/loopback/link-local/metadata(169.254.169.254)/control-plane, and **pin the socket to the resolved IP** (preserving Host+SNI) so a rebind can't swap it post-check.
3. **No bypass** — the sandbox has no direct socket (WRK-004 provider exposes no socket method; OS netns is the sandbox provider's job, a documented non-goal of the daemon core); `CleanupAuthority.openEgress` is `never`; a post-fence-close egress denies + emits exactly one `network_denied`.
4. **Redaction-before-outbox** — known secret values are scrubbed from EVERY event string (incl. the free-text `network_denied.reason` + terminal `errorMessage`) **before** the `#emit` digest, so the WRK-006 durable sink (which seals verbatim + never re-digests) can't persist a value.
5. **Fail-closed** — missing authorization, an unrecordable policy version, or an unredactable/telemetry fault → deny; the outbox fault propagates out of `emit()` (a visible failed run beats a silent gap).

---

## 3. Decisions

### D1 — Server-side destination-policy decision (default-deny + IP-block + control-plane + DNS-rebind)
Reuse `server/src/services/outbound-url-guard.ts` — `isPrivateIP` (RFC1918/loopback/link-local/IPv6), `validateAndResolveFetchUrl` (dns-lookup-then-check), `buildPinnedRequestOptions` (socket-pin, rebind defence). **Net-new:** (a) the **positive default-deny allowlist evaluator** (outbound-url-guard is a blocklist; DAT-005 adds "host∈`policy.allow` (https/host/port) else `not_allowlisted`"); (b) the **control-plane deny range source** (`isPrivateIP` catches metadata only incidentally; `denyControlPlane` needs an authoritative control-plane/metadata address set). Expose the whole thing as a pure `classifyEgressDestination(requestedUrl, resolvedAddrs, policy) → 'allow' | NetworkDenialClass` so it drives both the proxy and a `policy`-lane vectors gate. **Server-side only** (outbound-url-guard is in `server/src`, boundary-forbidden to the daemon).

### D2 — Fence-aware egress proxy (assembled, inert-until-wired)
A server-side `createFenceAwareEgressProxy({ appDb, brokers })` that, per governed egress request `{fenceIdentity, handleId, requestedUrl}`: (1) `broker.resolve()` → full per-request fence reauth in one tenant tx (drift → `stale_fence`/`target_revoked`/`attempt_terminal`); (2) on `resolved`, `classifyEgressDestination` (D1) → deny with the class if not allowed; (3) materialize `material.value` into request **headers at delivery** (never a spec/env for a network-use handle — generalizing the `mcp-connectors.ts` header-injection-below-the-branch discipline); (4) dispatch via the pinned socket; (5) persist `appliedPolicyVersion` (D3). Any broker/materialization fault → coarse `malformed` deny, never a value leak. The **request channel** (how the sandbox reaches the proxy) is an inert seam (§7).

### D3 — Policy-version persistence: widen `job_secret_handles` (DAT-004 zero-keystone precedent)
`network_denied` cannot carry a version (frozen), and the version is a frozen wire concept on the job (`networkPolicyRef.version`). Record it server-side: add a nullable additive `applied_policy_version integer` to `job_secret_handles` (migration `0251`, C14 `IF NOT EXISTS`; zero keystone reconciliation — proven 4×), written in the `resolveExecutionSecret` tenant tx alongside the existing audit columns. No new table, no wire field.

### D4 — Worker-daemon redaction scrubber (net-new; hermetic)
The canary registry is **locate-only** (`findSecretCanaryStringMatches` returns paths; no rewrite). Add an **in-place scrubber** built on `visitWireStrings` that replaces canary substrings with a fixed marker (e.g. `«redacted»`), run in `EventSequencer.#emit` **before** `eventDigest = sha256Hex(...)` so the digest + `.parse()` cover the scrubbed bytes and the sealed outbox row can never hold a value. **Per-run scoping:** pass the run's canaries explicitly (the `findSecretCanaryStringMatches` second-arg pattern) rather than mutating the module singleton, to avoid cross-run bleed. Covers ALL event strings — structured fields + the free-text `network_denied.reason` + terminal `errorMessage`. Boundary-clean (worker-protocol `visitWireStrings` + node only). The **canary-seeding channel** (how the server-resolved value reaches this daemon-side registry) is an inert seam (§7).

### D5 — Pure vectors gate (dual-driven)
`classifyEgressDestination` (D1) + the scrubber's decision drive `scripts/check-egress-policy-vectors.mjs` (+`.test.mjs`) + `tests/fixtures/egress-policy/v1/vectors.json`, independently re-deriving default-deny + IP-range + DNS-rebind classification, wired into the always-on `policy` job (cross-platform-honest). A test also binds the fixture to the REAL classifier (the DAT-004 #D lesson).

---

## 4. Slice plan (fail-first TDD)

1. **S1 vectors corpus + independent verifier** — default-deny + RFC1918/metadata/control-plane + DNS-rebind classification; RED first.
2. **S2 destination classifier (server)** — allowlisted-public ALLOW; non-allowlisted → `not_allowlisted`; RFC1918 → `private`; 169.254.169.254 → `metadata`; control-plane addr → `control_plane`; public-A→private-resolved (rebind) → deny + pin. Reuse `outbound-url-guard` + net-new allowlist + control-plane source.
3. **S3 per-request reauth at the proxy** — replaced/expired/terminal fence mid-stream → deny; nothing baked into an envelope.
4. **S4 materialize-at-delivery** — value ONLY in request headers, never in a spec/env/log; broker-failure → `malformed`.
5. **S5 redaction-before-outbox (daemon)** — artifact-leak corpus: a known value in `network_denied.reason`/`errorMessage`/any string → scrubbed before the digest; the sealed outbox row holds the marker, not the value; digest covers scrubbed bytes. **The scrubber is the net-new piece.**
6. **S6 bypass denial** — post-fence-close `openEgress` denies + emits exactly one `network_denied`; `CleanupAuthority.openEgress` is `never`.
7. **S7 policy-version persistence** — widen `job_secret_handles` (0251); write in `resolveExecutionSecret`; RLS/serving-role inheritance test (e2-serving-role).
8. **S8 fail-closed** — missing auth / unrecordable version / telemetry fault → deny; outbox fault propagates.

---

## 5. Gate + verification profile (dual)

**Hermetic (daemon, always-on `policy`):** new `check-egress-policy-vectors.mjs` (+`node --test`); `worker-daemon` vitest; `check:worker-daemon-boundary` (the scrubber imports only wp+pino+node); `check:frozen-worker-protocol-v1` + no-dist-doubles. **Server+DB:** `migrations` (0251 apply-from-scratch); `distributed-contract` (widen inherits the grant — no drift); `e2-serving-role-correction` (widened column under FORCE RLS). CI `ci-required`: `policy` + `verify` + `e2e` + `migrations` + `brand-check` + `worker-protocol-contract-bytes` + `distributed-contract`. Blast-radius: schema-sibling column-list (job_secret_handles ALTER) + no mutator-set change (reuse `resolveExecutionSecret`).

---

## 6. Non-goals (deferred)

- **New wire op / frozen-schema extension** (no `policyVersion` on `network_denied`, no CIDR on the wire) — version is server-side DB.
- **OS-level network isolation** (netns/seccomp/toxiproxy) in the daemon core — the sandbox provider's job (documented non-goal); D1 network-partition is the live proof.
- **`device_local` egress** — inert until DSK/E10 (no value).
- **DAT-006 (reconcile)** + **DAT-007 (tool surface)**.
- **The live cross-process channels** (egress-request channel; canary-seeding channel) — inert seams wired at E4-D12 (§7).
- Managed-E2B best-effort allowlist path (not the fence-aware enforcement path).

---

## 7. Residual risks / open decisions

- **Inert cross-process seams (E4-D12):** the egress-request channel (sandbox→proxy) and the canary-seeding channel (server value→daemon registry) don't exist in the dormant model — DAT-005 builds the components + a documented inert seam, like WRK-005/006/007. Flag for the reviewer that the live wiring is out of scope.
- **`destination` (single string) vs `networkPolicyV1.allow` (list):** confirm whether `FenceResolvedMaterial.destination` is a single host that must ALSO be in `policy.allow`, or the policy supersedes it. Design default: the policy allowlist is authoritative; the per-handle `destination` must be a member of it (both checked).
- **Control-plane address source:** net-new; must be an authoritative, config-sourced set (the control-plane's own address(es) + cloud metadata), not hardcoded incidentally.
- **Redaction completeness:** substring replacement over `visitWireStrings` covers string fields; a value split across encodings (base64/url-encoded) is a documented residual (register both forms where known).

---

## 8. Decisions ledger

| ID | Decision |
|----|----------|
| DAT-005-D1 | Server-side pure `classifyEgressDestination` (default-deny allowlist + IP-block via `outbound-url-guard` + net-new control-plane source + DNS-rebind pin). |
| DAT-005-D2 | Server-side fence-aware egress proxy: per-request `broker.resolve()` reauth → classify → materialize value into headers → dispatch (pinned socket) → persist version; inert request channel. |
| DAT-005-D3 | Widen `job_secret_handles` with nullable `applied_policy_version` (0251); write in `resolveExecutionSecret`; zero keystone reconciliation. |
| DAT-005-D4 | Net-new worker-daemon in-place redaction scrubber on `visitWireStrings`, at `#emit` before the digest, per-run-scoped canaries; covers all event strings. |
| DAT-005-D5 | Pure egress-policy vectors gate + a fixture-binding test to the real classifier (DAT-004 #D lesson). |
| DAT-005-D6 | Inert-until-wired: components + pure decisions + scrubber now; live cross-process channels deferred to E4-D12. |
