# WRK-008 slice 2b — Result: dispatch gets COMPOSED (go-book Sprint 3)

**Status:** LANDED. **Sprint 3** of the go-book. **Epic:** `E4-worker-daemon`.
**Start SHA:** `a62b8e06a` (the Step 0 scoping-gate commit — no code).
**Commits:** `002432c01 … 90b463ffc` (Step 1 → 11), plus the commit that carries this file.
**Closes:** the daemon half of E4-D12 that slice 2a left open — `createPollLoop` and
`createSupervisor` get their **first production callers in the programme's history**.
**Findings:** transfers `E4-F008` → **WRK-012** and `E4-F009` → **WRK-013** (both filed as
on-disk scoping stubs). Neither is resolved here — both are honestly deferred.

---

## ★ 0. The headline, and the two things it does NOT mean

With a provider injected **and** `AOA_WORKER_DISPATCH_ENABLED=1` **and** a device identity **and**
`AOA_WORKER_EVENT_OUTBOX_PATH` set **and** a live session **and** an admin-ratified placement
profile, `bootstrapWorkerDaemon` now composes a real **poll loop + supervisor + lease-renewal
driver + durable event outbox** from a **provisioned, matchable** self-model, refreshes the server
snapshot so the scheduler will offer it work, and starts leasing. With **any** of those six absent
it is **provably inert**, and the default-OFF flag makes it inert on every shipped build.

**It does NOT mean "a worker leases, executes and reports."** This slice **composes** the loop; it
does not **demonstrate** a lease taken or a sandbox supervised in its own suite. The reason is **no
longer E4-F010** — WRK-011 (Sprint 2.75) closed it, so the composed worker IS matchable and its own
`offerSatisfiesWorker` admits a valid offer. `E4-1-leases-through-protocol` is therefore promotable
**on evidence** (a lease actually taken here), which this slice does not produce; it stays `unwired`.
Sprint 5 is the journey.

**It does NOT turn dispatch on.** Both shipped boot roots — the container and the desktop — refuse,
proven by executable artifacts (Step 8a/8b), not a paragraph.

---

## 1. Which renewal body the seam is pointed at (design §11 requires this in §1)

**Sprint 2.5 (WRK-010 slice 2) SHIPPED, and this slice composes ON TOP of its session lifecycle.**
The `renew` thunk is Sprint 2.5's **device-proof renewal client**, not the enrolment-code replay, so
there is **no ten-minute code-route ceiling** and **no WRK-010 ceiling WARN** (§7 row 19 — the WARN
is deleted, not emitted saying something false). This slice does **not** construct a `SessionStore`;
it threads Sprint 2.5's `lifecycle.store` (hoisted out of the enrolment block per Sprint 2.5 GAP-1)
into `createSessionProvider` → the poll loop. `E4-F007` was resolved by Sprint 2.5 and is untouched
here.

## 2. §1.1(c) including the worker-side self-check — and how the provisioning overturns it

The pre-2.75 fact was: a composed worker built with the BARE hello reports an **empty**
`reportedCapabilities` and a 64-zero `policyHash`, so `poll-loop.ts:538`'s own
`offerSatisfiesWorker` returns `false` for **100% of offers**. **This slice composes WRK-011's
PROVISIONED hello** (folded from the self-model read via `deriveHelloProvisioning`, built with
`buildDesktopHello({…, provisioning})`), so the composed `self.report` carries the ratified
capabilities/policy/capacity and `offerSatisfiesWorker` **ADMITS** a valid `workload.batch` offer —
proven in `dispatch-runtime.test.ts` (TRUE over the provisioned self-model, FALSE over an
unprovisioned negative control, using WRK-011's captured fixture offer parsed through the frozen
`leaseOfferV1Schema`).

## 3. The desktop root's three-landable-gate posture (§1.1(b))

The desktop root injects both OS-custody stores on every boot, so **gate 3 (identity) is ALREADY
satisfied** — proven by Step 8b's refusal-token ladder rung 2 (`+provider+flag ⇒ exactly
no_event_outbox_path`, which is only reachable if gate 3 did not refuse). After DEP-010 (Sprint 2),
**none of the three landable gates is structural any more**: gate 1 is now an env resolution
(`AOA_WORKER_SANDBOX_PROVIDER` unset ⇒ `{kind:"none"}`), and the flag + outbox path are env edits.
E4-F011 (owned by DEP-010) records this posture. The container root, by contrast, keeps gate 1
STRUCTURAL (it runs `bin/worker-daemon.js`, which DEP-010 never gave a resolver — confirmed by the
Step 9a declaration).

## 4. `E4-F008` and `E4-F009` disposition (§11 gating action)

Both were `owned` by WRK-008 and neither is fixed by this slice. Leaving them on a shipped WRK-008
would read as owned-and-handled while nothing handled them (the `E4-F013` hole — the guard checks
only that `ownerStillOpen` is non-empty). **Transferred, not left:**

- **E4-F008** (self-model refresh channel) → **WRK-012** — a filed scoping stub (`WRK-012-design.md`
  + `#### WRK-012` program node, no result doc). LOW: the direction of failure is closed (a stale
  digest makes the worker unmatchable, not wrongly matched).
- **E4-F009** (durable lease-candidate source for the reconciler) → **WRK-013** — a filed scoping
  stub. MED: the reconciler is deferred here for the one real blocker (`leaseCandidates` has no
  durable local source — §4.2).

`check-finding-ownership.mjs` is green with both repointed to on-disk tickets that have not shipped.

---

## 5. Step 0 — the reformulation, confirmed against the tree

The four pre-DEP-010 assertions were reformulated in `WRK-008-slice-2b-step0.md` and confirmed on
disk: (1) `desktop-host.ts:297` now passes a `provider` key ⇒ Step 8b asserts `call.provider ===
undefined` (a VALUE, not `"provider" in call`); (2) the boot-roots guard asserts "no root constructs
a provider **unconditionally**; the shipped default resolves to none" — NOT "no root passes a
provider key" (which would be red on every PR in the always-on policy job); (3) §2's desktop gate-1
cell is an ENV RESOLUTION; (4) `AOA_WORKER_PROVIDER_URL` is DEAD env (zero code readers), declared as
present-and-dead by the Step 9a guard, not as a gate. The two places that reasoned from E4-F010 (the
§9 E4-1 row, the §2 gate story) were re-derived **on evidence**, not the removed premise.

---

## 6. What shipped (per step)

| Step | Files | What |
|---|---|---|
| 1 | `poll/host-probes.ts` | `createHostCapacityProbes` — every probe `zeroOnThrow` (fail-closed). |
| 2 | `identity/worker-identity.ts` | `createWorkerIdentity` — key from the PERSISTED DER + the PROVISIONED hello. Re-scoped thin: Sprint 2.5 owns the store. |
| 3 | `identity/self-model-read.ts` + fake self-model route | `readWorkerSelfModel` — never throws; ONE 401-recovery; 401/403/404→no_profile; terminal→session_terminal. |
| 4 | `lifecycle/compose-dispatch.ts` | SIX-gate decision; retire `no_self_model_reader`; add `no_worker_identity`/`no_event_outbox_path`; split read→`no_session`/`no_self_model`. |
| 5 | `config/config.ts` | `AOA_WORKER_EVENT_OUTBOX_PATH` (null when absent, `|| null` not `??`). |
| 6 | `lifecycle/dispatch-runtime.ts` | `composeDispatchRuntime` — poll loop leases through the DRIVER; ONE event sink to both supervisor and driver; recover-before-supervisor; KEK from the device key; capacity clamped; `redactionCanaries:[]` + no `observeRun`. |
| 7 | `bin/worker-daemon.ts` + `identity/self-hello-refresh.ts` + fake self-hello route | Two-pass decision; provisioning fold + `refreshSelfHello` (WRK-011's daemon caller, first production use); zero residue; double-lifecycle refusal; the `composeDispatch` observation seam. |
| 8a | `__tests__/shipped-binary-refuses.test.ts` | the CONTAINER root refuses (D1 env parsed from compose) + a positive control proving the spy is reachable. |
| 8b | keystore `__tests__/desktop-host-refuses-dispatch.test.ts` | the DESKTOP root refuses; the refusal-token ladder proves gate 3 is already satisfied. |
| 9 | `check-d1-dispatch-declared.mjs`, `check-boot-roots-provider-free.mjs` (+ libs, expectations, self-tests) | the two declaration guards (always-on policy job). |
| 10 | `gate-clause-wiring.json` | E4-4→wired; E4-1/E4-2/E4-3 stay unwired with evidence-based reasons. |
| 11 | env-doc, test-inventory, finding disposition | §11 closure. |

---

## 7. Mutation sweep — every guard DELETED, run RED, reverted

Positive control first per file; anchor-match printed; `git checkout` reverts between mutants (all
work committed before mutating — a `git checkout` on an uncommitted new file eats it).

| Step | Mutants | Killed | Notes |
|---|---|---|---|
| 1 | 4 | 4 | ★ the positive control first asserted `MILLIS_PER_CORE` (the constant) — a TAUTOLOGY the M4 mutant survived; fixed to a LITERAL (4000). |
| 2 | **2** | 2 | ★ RE-SCOPED from the design's 6: Sprint 2.5 owns the SessionStore, so the store-construction mutants (`fabricate initial`, `Date.now`, `EnrollmentError`, terminal-wrap, eager-code-read) target code this slice no longer writes. The 2 that remain are the code it DOES write: key-source and the provisioning fold. A denominator that changes for a stated reason is a denominator. |
| 3 | 6 | 6 | recovery branch, second attempt, 404-classification, null-check, terminal mapping, wrong-path. |
| 4 | 8 | 8 | 5 gate reorders + message-collapse + outbox-delete + session-mapping. |
| 5 | 2 | 2 | `\|\| null`→`?? null`; default `"outbox.db"`. |
| 6 | 6 | 6 | supervisor→driver seam, recover-before-supervisor, ceiling clamp, sink-KEK, driver-eventSink, live-limiter. |
| 7 | **6 + 1 N/A** | 6 | reason-guard, second-decision, await-the-loop, double-lifecycle-refusal, identity-above-branch, `drain.start()` (killed via Step 6's start() test). ★ The design's 7th (delete the WRK-010 ceiling WARN) is **N/A** — Sprint 2.5's device-proof client is wired, so there is no ceiling and no WARN to delete (§7 row 19). |
| 8a | 3 | 3 | provider-gate reorder, composeDispatch-seam bypass, parser-integrity (hardcoded env). |
| 8b | 4 | 4 | provider-default, delete-identityStore-arg, control-fall-through, gate-3/4 reorder (via a container-contrast case). |
| 9 | 6 (+CLI fail-closed) | 6 | 9a: invert absent/present directions, check-only-dispatchEnabled; 9b: accept-undeclared-root, skip-resolver-marker, pass-on-unreadable. The CLIs' parse/read fail-closed is structural + covered by the lib's fail-closed self-test cases. |

**Report line:** *47 mutants across the slice's own guards, 47 killed, 0 survivors, 1 documented
N/A (the WRK-010 warn, made moot by Sprint 2.5), 0 false kills.* Every mutant COMPILES and RUNS and
is killed by an ASSERTION, never a suite deadline (the "await the loop" mutant is killed by a
`Promise.race` asserting bootstrap RESOLVES while a never-settling `run()` is pending — not by a
timeout). Arithmetic note vs the design's 53: Step 2 dropped 6→2 (Sprint 2.5 ownership, stated
above), and Steps 3/6/7 gained the self-hello-refresh + provisioning wiring §5 did not budget for;
the design's 53 was pre-re-scope.

---

## 8. Registers + CI

All five registers pass: `check-gate-clause-wiring` (E4-4 wired; E4-1/E4-2/E4-3 dormant, printed on
the green run), `check-finding-ownership` (E4-F008→WRK-012, E4-F009→WRK-013; 10 open findings),
`check-ticket-graph-coverage` (WRK-012/013 nodes added), `check-guard-inventory` (the two new
checkers), `check-execution-census` (the two new self-tests). Plus `check-test-inventory`
(worker-daemon 137→144, keystore 20→21). Typecheck clean both packages; worker-daemon 792 tests +
keystore 263 tests green (integration suites RUN under `AOA_RUN_WIN_INTEGRATION=1`; a plain Windows
`pnpm test` skips them — a local-verification gap, not a CI one).

**`verify` inherits the pre-Sprint-3 RED** (go-book §2.0: the job hit its 60-minute cap on five
consecutive runs, on SHAs pushed before any Sprint-0 commit). The timeout was **NOT** raised. This
slice's own code is green; its definition of done inherits that pre-existing red, stated out loud
per §2.0.

---

## 9. What I could not prove / honest residuals

- **A composed daemon that leases, executes and supervises** — Sprint 5, on real E2B.
  `composeDispatchRuntime` is exercised only through injected factories (the wiring is proven; the
  real factories are the defaults and typecheck). No production boot reaches it (dispatch off).
- **`refreshSelfHello`'s real-server round trip** — WRK-011 proved the server side end-to-end; this
  slice proves the daemon caller over the fake control plane (real socket, real proof). The real
  daemon→real-server refresh is Sprint 5.
- **The D1 re-baseline** — D1's "worker" is a harness script, not the daemon; this slice changes
  nothing D1 observes (the container root stays inert — Step 8a proves it, Step 9a declares it), so
  no re-baseline was needed. The go-book's "budget time to re-baseline" was a risk that did not fire,
  for the reasons §8 of the design enumerates (all five verified).
- **DAT-008 slice 5 is not here** — between this slice and slice 5 a composed daemon would start a
  CLI with no credential and the run would fail auth. Both the distributed flag and the rollout dial
  are default-off, so there is no production exposure — but the intermediate state is real.

---

## 10. The adversarial review

**Four INDEPENDENT reviewers, one per changed dimension, each verifying claims by opening source.
ZERO HIGH/BLOCKING/confirmed defects across all four** — so no skeptic/refute pass was required (the
refute step applies only to HIGH/BLOCKING). What surfaced was a handful of non-defect observations,
all either design-accounted or fixed below.

| Reviewer | Dimension | Result |
|---|---|---|
| R1 | security of the read/refresh callers + I13 | **0 defects.** Confirmed: never-throws, proof signed over the SAME path it POSTs to, one-shot 401 recovery, 401/403/404→no_profile (no oracle), terminal→session_terminal, no token/proof/code reaches any `logger.*`, the refreshed session IS stored via `store.set`. |
| R2 | composition correctness (all 9 wiring points + Step 7 threading) | **0 defects.** Every dep the composition passes is accepted by the REAL factory signature; no required dep omitted; poll loop leases through the driver; same sink to both; recover-before-supervisor; live capacity clamp. |
| R3 | inertness + declaration guards + gate-clause register | **0 defects.** No env-only path to `compose:true`; both proof suites non-vacuous; both guards fail-closed and check all four gates / a real marker; `expectedReferences: 2` counts verified against the checker's own counting rules. |
| R4 | completeness vs the plan (§5, §0.2, §7, retirements) | **0 silent gaps.** `no_self_model_reader` fully retired (only `.not.toContain`/`undefined` assertions survive); the composed hello is PROVISIONED not bare; `AOA_WORKER_PROVIDER_URL` has zero code readers; the re-scoped Step-2 mutant drop is documented. |

**Observations (NOT defects — no fix warranted, recorded for the next reader):**

- **R2/R3 — a bad `AOA_WORKER_EVENT_OUTBOX_PATH` fails the boot loud** rather than degrading to
  "healthy and inert": `composeDispatchRuntime` awaits `openEventOutboxStore` with no try/catch, so a
  DatabaseSync fault rejects the boot. **Accepted as correct fail-loud:** this path is reached ONLY
  when an operator has explicitly set the flag + a provider + an outbox path, so a mis-set outbox
  path is a misconfiguration worth failing on, not a transient to swallow. No contract promises
  store-open is best-effort (unlike the refresh, which IS).
- **R3-A — 8b's desktop `composeDispatch` spy is non-vacuous only via 8a's positive control.** This
  is the **deliberate** split the design's Step 8b spells out: the keystore package has no fake
  control plane, so a positive control that reaches the spy cannot live there; 8b's ladder pins exact
  refusal tokens (itself non-vacuous), and spy-reachability is 8a's job on the daemon side.
- **R3-B — the boot-root scan covers two hardcoded, non-recursive bin dirs.** Acknowledged in
  `boot-roots-expectation.json`: a root in a new package's bin would need a `BIN_DIRS` edit — itself a
  reviewable, attributable change, and no such root exists today.
- **R4 — `expectedReferences` is `2`, not the design's stated `1`.** The design's §7 rows 12/13,
  Step 10 and Step 0 §D all say `1`; the mechanical caller counter sees **two** textual references to
  each of `createPollLoop`/`createSupervisor` in `dispatch-runtime.ts` (the `import` line + the
  `?? createPollLoop`/`?? createSupervisor` seam default), and `check-gate-clause-wiring.mjs` fires
  `unwired_but_now_has_caller` on `count > expected`, so `1` would break the build. `2` is the
  correct, forced value; the register's `reason` field says why. This result doc is the correction of
  record — the design's `1` was written before the seam-default reference existed.

**Fixed during review:** the `E4-F013` register entry's example list still named E4-F008/E4-F009 as
owned by WRK-008 (stale after their transfer); reworded to describe the guard-hole class without the
stale pointers.
