# CLI-004 Design — E2B cleanup reconciliation

**Status:** `design` (reviewable artifact; implementation via fail-first TDD + distinct adversarial review). **Small ticket — a thin composition/wiring layer + keyed cases; NO new denial/redaction/convergence/rotation logic.** **Scope: no-key core (PR gate) + keyed real-E2B tail** (the `program-design.md:781` real-E2B tagged-resource reconciliation rides the operator-dispatched `keyed-e2b-conformance.yml`).
**Epic:** `E7 — Coding/CLI workload on E2B` (fourth ticket). **Authoritative source:** `program-design.md:776-782`.
**Depends on (status verified):** CLI-001 (E2B provider — landed) + JOB-006 (reaper/active-lease authority — landed). Frozen worker-protocol v1 + the frozen worker-daemon `SandboxProvider` port — never edited.
**Grounded by:** the CLI-004 terrain-map (4 readers + synth) with load-bearing claims **independently re-verified** in `C:\e3`: the entire security core already exists. `reconcile()` (`worker-daemon/src/supervisor/reconcile.ts:55`) is a single-op orphan sweep — `defaultIsOrphan = !hasLiveLease` (`:53`), skips live-lease resources (`:71`, never touched), calls `provider.reconcileCleanup` per orphan (`:73`), counts `CLEANUP_OUTCOME_METRIC{success|failed}` — but is tested only against the **in-process fake** (`reconcile-leaked.test.ts`). CLI-001's `E2bSandboxProvider` already implements `reconcileCleanup`(`:261`)/`list`(`:283`)/`inspect`(`:305`), stamps + parses the `ResourceLabels` tuple, maps `paused→stopped` (so a paused sandbox is a discoverable orphan, `hasLiveLease=false`), and reports a transient transport fault as `cleanupStatus:"failed"` (never thrown) so it survives to the next sweep. `CleanupAuthority` (`cleanup-authority.ts`) already provides the monotonic ladder + effect-op denial (`:127`) + no-existence-oracle uniform `ResourceNotAvailableError` (`:154`) + 5-key redacted projection (`:169`) + expiry/monotonic-epoch (`:119,241`). The DEP-008 `runSandboxIsolationConformance` cleanup cases already run GREEN against the E2B driver (via the E6-F008 per-op adapter, `conformance.test.ts`). CLI-004 owns no `DE-*`; it co-owns CM-010/CM-011.

---

## 1. Scope + framing

**Outcome (program-design.md:779):** reconcile leaked/paused sandboxes against active leases and terminate or quarantine them through WRK-004's monotonic cleanup authority.

**Acceptance (program-design.md:780):** every sandbox attributable to a job/attempt/resource/target-generation; repeated cleanup idempotent; cleanup cannot create/execute/resume/checkpoint/open-egress or inspect command/env/log/secret/customer bytes; list/inspect returns only ownership labels + opaque management IDs + lifecycle state + cleanup metadata for MATCHING resources; provider outage backs off with an alert; expired authority cannot be escalated or retargeted.

**The thesis.** Every guarantee in the acceptance is already built (WRK-004 `CleanupAuthority` + `reconcile()`, CLI-001's E2B provider, the DEP-008 conformance suite). CLI-004 is Small because it **composes** them against the E2B driver with leaked+paused fixtures and adds the real-infra proof — it must NOT re-derive denial/redaction/convergence/rotation semantics. The one genuine gap is an operator **alert** on a reconciliation-time provider outage (today: a `CLEANUP_OUTCOME_METRIC{failed}` counter + an info log only), which CLI-004 adds minimally.

| Workstream | Lane | Kind | Responsibility |
|---|---|---|---|
| No-key reconcile composition test | `packages/sandbox-e2b-provider` tests | new (compose) | run `reconcile()` against `E2bSandboxProvider(MockE2bTransport)` with running/paused/leaked fixtures; assert the acceptance invariants |
| Minimal reconciliation-outage alert | `worker-daemon` | thin new | a structured operator alert (`logger.error`/`warn` + the existing `CLEANUP_OUTCOME_METRIC{failed}`) when a sweep hits a provider outage — so "backs off with an alert" holds |
| Reuse CleanupAuthority + isolation suite | — | reuse | denial/redaction/expiry are the EXISTING guarantees (CLI-001 isolation suite already green vs the E2B driver); CLI-004 references, never re-implements |
| Keyed real-E2B `describeKeyed` block | `keyed-real-e2b.test.ts` | new (keyed) | real leaked/tagged-resource reconciliation + the real inspect-oracle guard (CLI-001 TODO) + lost-response replay + cleanup-survives-rotation + final real zero-resource |

**Additive.** No new CI wiring (the no-key test rides the `pr.yml` provider glob; keyed rides `keyed-e2b-conformance.yml`); no frozen worker-protocol or `SandboxProvider`-port edit; no `DE-*` threat edit.

---

## 2. Invariants (each gets a test; real-infra rerun is the keyed lane)

1. **Attribution.** Every discovered sandbox parses to a `ResourceLabels` tuple {org, target, worker, job, attempt, lease, deviceGeneration} + generation.
2. **Orphan selection.** Only `!hasLiveLease` orphans (the paused + the leaked/stopped fixture) are reconciled; a live-lease sandbox is NEVER touched.
3. **Idempotent repeat.** A second sweep finds zero (NotFound→`success`); reconciliation is convergent.
4. **Cleanup cannot effect + no-existence-oracle.** create/execute/resume/checkpoint/health/open-egress deny with `CleanupAuthorityDeniedError`; a cross-label/wrong-generation/absent target collapses to one byte-identical `ResourceNotAvailableError` (the EXISTING CleanupAuthority guarantees; asserted via the CLI-001 isolation suite already green vs the E2B driver).
5. **Redacted list/inspect.** `list`/`inspect` return only the redacted projection (ownership-hash/opaque-id/state/cleanup-metadata) — no command/env/logs/secrets (non-vacuous: `inspect()` internally holds full sensitive detail).
6. **Provider-outage backoff + alert.** A transient transport fault yields `cleanupStatus:"failed"` reported-not-thrown, the resource is left intact for the next (bounded) sweep, and a structured operator alert fires. The live periodic-loop delay is E4-D12/CLI-006 (documented).
7. **Expiry — no escalation/retarget.** Expired authority denies (ownership-denial + monotonic non-regressing epoch + terminal effect-withdrawal — the EXISTING enforcement; CLI-004 does NOT wire the dormant deadline timer).
8. **Final zero-orphan.** After the sweep, zero orphans remain.
9. **Real-E2B (keyed lane).** Real leaked/tagged-resource reconciliation + inspect-oracle guard + lost-response replay + cleanup-survives-rotation + final real zero-resource.

---

## 3. Decisions

### D1 — No-key core: `reconcile()` composed against `E2bSandboxProvider(MockE2bTransport)`
Seed the mock with a running (live-lease) sandbox, a paused sandbox, and a leaked/stopped sandbox (via `create` + the pause/fault directives), run `reconcile()` (the existing WRK-004 sweep) against `E2bSandboxProvider(mockTransport)`, and assert invariants §2.1–§2.8 in one run. This is the exact delta the terrain names: `reconcile-leaked.test.ts` proves the sweep against the in-process fake; CLI-004 proves it against the real E2B driver's provider path. The test lives in `packages/sandbox-e2b-provider` (or imports from worker-daemon) so it rides the provider-glob distributed-contract gate.

### D2 — Minimal reconciliation-outage alert (the one genuine gap)
Today a reconcile outage is a `CLEANUP_OUTCOME_METRIC{failed}` counter + an info log — no operator alert. Add a thin, structured operator alert (a `logger.error`/`warn` `"reconcile_provider_outage"` event carrying the ownership-hash + failed count, NOT any tenant/secret bytes) emitted from the reconciliation path when a sweep records ≥1 failed cleanup, so "provider outage backs off with an alert" is honestly satisfied. The **backoff** is the existing bounded retry (converge ≤3) + the resource surviving to the next sweep; the live periodic-sweep delay is deferred to the E4-D12 loop wiring. No new alert *infrastructure* — reuse the logger + the metric.

### D3 — Reuse the CleanupAuthority + isolation guarantees; expiry = denial, not the dormant timer
Denial (effect-op, no-existence-oracle), redaction (5-key projection), and expiry are the EXISTING `CleanupAuthority` guarantees, already proven GREEN against the E2B driver by the CLI-001 isolation suite. CLI-004 references these (and may add a focused assertion that reconciliation routes an orphan through the redaction+denial path), but re-derives nothing. "Expired authority cannot be escalated or retargeted" is satisfied by the EXISTING ownership-denial + monotonic-epoch + terminal effect-withdrawal — CLI-004 does NOT wire the dormant `isExpired()` deadline-timer (that live deadline-driven escalation stays a documented follow-up, per the CLI-003 result).

### D4 — Keyed real-E2B `describeKeyed` block
Append a CLI-004 `describeKeyed` block to `keyed-real-e2b.test.ts` (which already hosts CLI-001/002/003 keyed blocks + the create→destroy→reconcile→zero-resource shape): reconcile a genuinely leaked/discovered tagged resource, the real inspect-oracle guard (closing CLI-001-result.md:26 `TODO(CLI-004)`), lost-response replay against the real transport, cleanup-survives-rotation (the cleanup angle of the CM-012 rotation rehearsal), and a final real zero-resource assertion. SKIP-guarded off `E2B_API_KEY`, `e2b` dynamically imported; zero workflow changes.

---

## 4. Non-goals / scope honesty

1. **No live periodic reconciliation LOOP** — `reconcile()` is export-only and `startup-reconcile.ts` is inert until E4-D12; CLI-004 certifies the orchestration against the E2B driver, not a running loop.
2. **No durable persisted-lease-offer enumeration** (DAT-006 D5 gap) — reconciliation keys off the provider's `hasLiveLease` view + the JOB-006 reaper as the server authority; full server-lease-set matching is deferred.
3. **No new alert infrastructure** — a structured logger alert + the existing metric; a dedicated alert pipeline is out of scope.
4. **No dormant-deadline wiring**, **no legacy `environment_leases` reconciliation** (CM-011, co-owned MIG-008), **no artifact quarantine** (`runOrphanQuarantine` is artifacts, a different concern).
5. **No frozen worker-protocol or `SandboxProvider`-port edit; no `DE-*` threat edit.**

---

## 5. CI + acceptance mapping

| Acceptance clause (L780) | Where satisfied | Gate |
|---|---|---|
| every sandbox attributable | ResourceLabels parse in the sweep | `verify`/`distributed-contract` |
| repeated cleanup idempotent | NotFound→success + convergent sweep | `verify` |
| cleanup cannot effect + no-oracle | EXISTING CleanupAuthority (isolation suite green) | `distributed-contract` |
| redacted list/inspect | redacted projection asserted | `verify` |
| provider outage backs off with an alert | reported-failed + bounded retry + new structured alert | `verify` |
| expired authority no escalate/retarget | ownership-denial + monotonic epoch | `distributed-contract` |
| real tagged-resource reconciliation + rotation + zero-resource | real E2B | **keyed lane** |

**Gate recommendation for implementation:** fail-first — write the reconcile-composition assertions + the outage-alert test RED before the thin alert/composition, then GREEN; author the keyed `describeKeyed` cases SKIP-guarded + parse-verified; distinct adversarial review before the result doc. Disposition = scope-honest `pass` on in-process/mocked evidence for the no-key core, with the real-infra rerun runnable on operator key.
