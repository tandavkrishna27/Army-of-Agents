# DEP-006 Design — Staging manifests and configuration contract

**Status:** `design` (reviewable artifact; implementation via fail-first TDD + distinct adversarial review; the live render/config check runs on Linux-CI). **LAST ticket of E6.**
**Epic:** `E6-deployment-test-harness` (remainder). **Authoritative source:** `program-design.md:725-731`.
**Depends on (all complete + CI-green):** DEP-003 (migration-first + readiness gate), DEP-008 (hostile isolation/cleanup conformance suite), DEP-009 (2nd replica + fail-closed shared admission). Frozen worker-protocol v1 SHA `b7a842870ce7509d8baa75409e0ab19da375c88a` (consumed, never edited).
**Grounded by:** the DEP-006 terrain-map (5 readers + synth) with the load-bearing claims **independently re-verified** in `C:\e3`: `docker-compose.d1.yml` today defines 2 control-plane (`control-plane`, `control-plane-b`) + 2 workers (`worker-a`, `worker-b`) + a `provider-ctl-net` already isolating provider-control traffic (`scripts/lib/d1-compose-invariants.mjs:18-51`, `PROVIDER_CTL_NET`); `e6f-12` is the next free `tests/d1` slot; the `policy` job in `.github/workflows/pr.yml:106` is the always-on static-check lane (`node scripts/check-*.mjs; node --test …`); the provider-control credential is the operator `E2B_API_KEY` read ONLY via `resolveE2bApiKey` (`sandbox-provider-runtime.ts:569-575`) from `process.env`, today injected into the whole hosted process (`docker-compose.yml:72`) with no separate adapter-management process yet; DEP-006 is a **co-owner** of crosswalk rows CM-010/CM-012 (`current-main-crosswalk.md:26,28`) but owns **no** `DE-*` threat, so `distributed-execution-threat-controls.json`/`…threat-model.md` are **not edited**; DEP-009's fail-closed `worker_admission_rate_limits` limiter is the shared-admission authority DEP-006 **asserts**, never rebuilds.

---

## 1. Scope + framing

**Outcome (program-design.md:728):** define a two-control-plane / four-worker staging deployment across two failure domains with external database/object storage, shared realtime + admission stores, managed provider-control secret injection confined to the adapter-management boundary, autoscaling limits, and rollout order.

**Acceptance (program-design.md:729-730):** migration runs first; N/N-1 control-plane and worker rollout works; workers drain before termination; shared admission cannot fall back to process memory; all mutable configuration is documented and validated; provider-control credentials are provider-account/audience scoped, mounted or brokered **only** to the adapter-management process, **absent** from tenant sandbox/protocol/env/metadata/evidence, rotatable without image rebuild, revocable through the provider/target kill path, and never retained in a leaked-resource record.

**The thesis that shapes the design.** Like the other E6 remainder tickets, most of DEP-006's substrate is **already landed** and DEP-006's job is to **render it as a staging deployment artifact + assert the contract statically**, not to build new orchestration:
- **Migration-first + rollout + drain** — DEP-003 already gives a dedicated `migrate` one-shot (`depends_on: service_completed_successfully`), a `/api/ready` gate (503-until-ready), and control-planes that run **no** migrations. Staging expresses N/N-1 rollout + worker drain over that.
- **Shared admission, no process-memory fallback** — DEP-009 already gives the fail-CLOSED `worker_admission_rate_limits` DB limiter with **no** per-process fallback + submit-time `admitAttemptCapacity`. DEP-006 **asserts** it is wired and that no process-local admission env/flag exists — it does **not** add a second counter.
- **Provider-control credential boundary** — the D1 topology already has a `provider-ctl-net` + a fake-provider control allowlist isolating provider-control traffic to a named peer set. DEP-006 expresses the operator `E2B_API_KEY` injection confined to that adapter-management surface and asserts its absence everywhere else.
- **Isolation/cleanup on rotation** — DEP-008's `runSandboxIsolationConformance` hostile reference already certifies credential/customer-byte absence + narrow monotonic cleanup authority. DEP-006's L730 rotation/revocation/old-key-denial half is satisfied by **contract against that reference + a documented CLI-001/D2 deferral** for real-E2B rehearsal (the DEP-008 scope-honesty precedent), not new real-provider runtime.

**What DEP-006 must actually build:** (a) an additive, dormant **staging deployment render**; (b) a pure **static config-contract validator** mirroring `check-d1-compose.mjs`, wired into `pr.yml`'s `policy` job; (c) a **live render/config validation** on `d1-merge-train`; (d) docs + crosswalk disposition updates.

| Workstream | Lane | Kind | Responsibility |
|---|---|---|---|
| `docker-compose.staging.yml` staging render | compose / static | additive, dormant | 2 CP + 4 workers across two failure domains; external DB/object-store + shared realtime/admission pointers; autoscaling limits; rollout order; drain; provider-control cred confined to the adapter-management surface |
| `check-staging-manifest.mjs` + `scripts/lib/staging-manifest-invariants.mjs` + `.test.mjs` | static | additive | assert every acceptance clause with lockstep `EXPECTED_*` pins; wired into `pr.yml` `policy` |
| `e6f-12` render/config validation (live) | `tests/d1` | test | parse + contract-check the staging manifest on `d1-merge-train`; NOT a full external-store bring-up (deferred) |
| Docs + crosswalk (CM-010/CM-012) dispositions | docs | additive | E6 README + staging/config-contract guide + env coverage; update CM dispositions (NO `DE-*` edits) |

**Additive + dormant.** The staging render is a template — never brought up by CI's self-contained lanes and never the default deploy. No frozen-protocol edit; no `DE-*` threat-register edit (DEP-006 is a CM-010/CM-012 co-owner, not a threat owner); no trigger-level `paths:` filter; the static check routes through `pr.yml` `policy` (always-on) and the live check through `d1-merge-train` so no required check is skipped.

---

## 2. Invariants (each gets a static assertion; the live lane render-validates)

1. **Migration runs first.** The staging render has a dedicated `migrate` one-shot; every control-plane + worker `depends_on` it with `condition: service_completed_successfully`; app processes run **no** migrations. (Mirrors DEP-003 / `checkMigrateGate`.)
2. **N/N-1 rollout.** Control-plane + worker services declare a rolling-update policy tolerating one version skew (bounded surge/unavailability); the shared session-signing key + host-agnostic device proof (DEP-009) make a mixed-version fleet interchangeable.
3. **Workers drain before termination.** Each worker sets a bounded `stop_grace_period` + a documented drain hook (stop polling, finish/relinquish in-flight leases within the visibility timeout) so no in-flight lease is hard-killed; the reaper (DEP-005) reclaims any that exceed the grace.
4. **Shared admission cannot fall back to process memory.** The render wires the DEP-009 fail-closed `worker_admission_rate_limits` limiter + submit-time `admitAttemptCapacity`; the validator asserts NO per-process admission env/flag and NO second counter — a process-local fallback is a contract violation.
5. **Provider-control credential confined + absent.** `E2B_API_KEY` is mounted/brokered ONLY to the adapter-management surface (on `provider-ctl-net`), account/audience-scoped, rotatable without image rebuild (a mounted secret / broker-fetch, not a baked layer); the validator asserts it is **absent** from the control-plane process env, every worker/tenant surface, protocol/metadata, and logs/support-bundle. Rotation/revocation/old-key-denial rehearsal is contracted against DEP-008 + deferred to CLI-001/D2.
6. **All mutable configuration documented + validated.** Every staging-render env key is in `docs/deploy/environment-variables.md` (extending brand-check coverage where it is one-directional/AOA_-only today) and validated by the contract check.
7. **Autoscaling limits bounded.** Worker/control-plane scaling min/max are explicit and bounded (no unbounded replica count); the validator pins them.
8. **Render parses + is non-vacuous.** The staging manifest is valid compose; the `.test.mjs` includes reject-clones (mutations that MUST fail each invariant) so the checks cannot pass vacuously.

---

## 3. Decisions

### D1 — A NEW `docker-compose.staging.yml` render (not a mutation of `docker-compose.d1.yml`)
`docker-compose.d1.yml` is the self-contained **live-test** topology (embedded postgres + minio + toxiproxy + fake provider). Staging is a **deployment-intent** artifact with **external** DB/object storage and two failure domains, so mutating d1 would either break the hermetic test lane or embed deploy intent into a test file. Author a **separate** `docker-compose.staging.yml`: 2 control-plane + 4 workers, split into two failure domains via a `x-failure-domain` label convention (domain-a: 1 CP + 2 workers; domain-b: 1 CP + 2 workers), with external DB/object-store + shared realtime/admission stores expressed as `x-external` config pointers (env-injected endpoints, not embedded services). It is a template — never a CI bring-up default. This keeps the d1 lane untouched and the staging contract independently validated.

### D2 — Static config-contract validator mirroring `check-d1-compose.mjs`
Add `scripts/lib/staging-manifest-invariants.mjs` (pure, exported `EXPECTED_*` pins + `check*` functions taking the parsed compose → violations, exactly like `d1-compose-invariants.mjs`), `scripts/check-staging-manifest.mjs` (loads + runs + prints), and `scripts/check-staging-manifest.test.mjs` (`node --test`: a valid fixture passes; per-invariant reject-clones fail). Assert §2's invariants 1–8. Wire it into `pr.yml`'s `policy` job (`node scripts/check-staging-manifest.mjs; node --test scripts/check-staging-manifest.test.mjs`) — the always-on lane, so no required check is skipped and it rolls up under `ci-required`. Lockstep discipline: the `EXPECTED_*` pins move in the SAME commit as any render change.

### D3 — Provider-control credential boundary: express + assert absence; defer real-E2B rehearsal
Express `E2B_API_KEY` injection ONLY into the adapter-management surface on `provider-ctl-net` (a mounted secret file / broker-fetch — rotatable without image rebuild), and assert via the validator that it is absent from the control-plane process env, all worker/tenant services, and (by reusing DEP-008's egress-bypass + DEP-005 redaction posture) from protocol/metadata/logs. The L730 rotation overlap/cutoff, old-key denial, revocation, and post-rotation cleanup-reconciliation **rehearsal** is contracted against DEP-008's `runSandboxIsolationConformance` hostile reference and **explicitly deferred** to CLI-001/D2 (which owns the real-E2B provider and is a CM-012/CM-010 co-owner) — the DEP-008 scope-honesty precedent. Update the CM-010/CM-012 dispositions in `current-main-crosswalk.md` to record DEP-006's manifest-boundary contribution + the deferral. **Do NOT edit** `distributed-execution-threat-controls.json`/`…threat-model.md` (DEP-006 owns no `DE-*`).

### D4 — Live render/config validation as `e6f-12`, NOT a full external-store bring-up
The "staging smoke deployment" (program-design.md:731) cannot be a true multi-host / external-store bring-up in the self-contained d1 lane, and DEC-03 gives no multi-host local substrate. Scope-honest live proof: `tests/d1/e6f-12-staging-render.test.mjs` (foundation glob; SKIP off `AOA_D1_LIVE`) render-validates the staging manifest inside the Linux-CI lane — `docker compose -f docker-compose.staging.yml config` parses, the failure-domain split + 4-worker + migrate-gate + drain + provider-ctl isolation resolve, and the same invariant module agrees with the rendered config. The full multi-host external-store staging bring-up is **documented as deferred** to the deploy pipeline (`scripts/deploy/*`) / a REL ticket — not silently dropped.

### D5 — Config documentation + validation completeness
Add every new staging env key to `docs/deploy/environment-variables.md`; where brand-check's env coverage is one-directional / AOA_-prefix-only, the staging validator closes the gap for the render's surface (asserts each render env key is documented). Add a `docs/deploy/staging.md` (or E6 README section) describing the topology, rollout order, drain, autoscaling limits, and the provider-control boundary. This satisfies "all mutable configuration is documented and validated" for the staging surface.

---

## 4. Non-goals / scope honesty

1. **No real multi-host / external-store staging bring-up.** DEP-006 renders + statically/CI-validates the manifest; the live external-store deployment is deferred to the deploy pipeline / a REL ticket (documented, not dropped).
2. **No real-E2B provider-control rotation/revocation runtime.** Contracted against DEP-008's hostile reference + deferred to CLI-001/D2 (co-owner). DEP-006 owns the manifest-boundary expression + absence assertions only.
3. **No second admission counter / no process-local admission.** DEP-006 asserts DEP-009's fail-closed limiter; it never rebuilds admission.
4. **No frozen-protocol edit; no `DE-*` threat-register edit** (CM-010/CM-012 co-owner only); **no trigger-level `paths:` filter**; the static check routes through `pr.yml` `policy` and the live check through `d1-merge-train`.

---

## 5. CI + acceptance mapping

| Acceptance clause (L729-730) | Where satisfied | Gate |
|---|---|---|
| Migration runs first | staging render migrate one-shot + `depends_on` | `check-staging-manifest` (policy) + `e6f-12` (live) |
| N/N-1 control-plane + worker rollout | rolling-update policy + shared session key | `check-staging-manifest` |
| Workers drain before termination | `stop_grace_period` + drain hook | `check-staging-manifest` |
| Shared admission cannot fall back to process memory | assert DEP-009 limiter wired + no process-local admission | `check-staging-manifest` |
| All mutable config documented + validated | env-doc coverage + contract check | `check-staging-manifest` + brand-check |
| Provider-control cred scoped / mounted-only-to-adapter-mgmt / absent / rotatable / revocable / not in leak record | `provider-ctl-net` boundary + absence asserts; rotation contracted to DEP-008 + deferred to CLI-001/D2 | `check-staging-manifest` + DEP-008 reference + crosswalk disposition |

**Gate recommendation for implementation:** fail-first — write `check-staging-manifest.test.mjs` reject-clones RED before authoring the render + invariants; land the static check in `pr.yml` `policy` + `e6f-12` on `d1-merge-train`; distinct adversarial review before result.
