# CLI-006 / D2 — Sprint 5b result: the staging-canary campaign (the E7-1 promoter)

**Status:** **campaign harness + runbook READY; the full distributed coding journey on real E2B is
UNPROVEN.** No dispatched run cites the DISTRIBUTED journey against real E2B, so **`E7-1-coding-journey`
stays `unwired`** — the honest "harness + runbook ready, staging run owed" end-state the go-book blesses
(§4 Sprint 5, Sprint 5b), not a failure.
**Epic:** E7 (exit gate). **Design / Start SHA:** `CLI-006-D2-legB2-design.md` + `CLI-006-staging-canary-runbook.md`, `040bef38a`.
**Frozen, untouched:** `packages/worker-protocol` (git diff empty), the worker-daemon `SandboxProvider`
port, the `DE-*`/threat docs. No new hosted-API call (Rule #11). No new `AOA_*` switch.

| Commit | What |
|---|---|
| `040bef38a` | Leg B Part 2 design + the operator staging-canary runbook (Start SHA) |
| `36114ca50` | Leg B Part 2 — `composed-loop-secret-resolve.integration.test.ts` (the live-fence resolve; mutation-proven) |
| *(this commit)* | Campaign result + GO-BOOK §3.1/§4 update (E7-1 held `unwired`) |

---

## 1. What this session did — and the boundary it stopped at

Sprint 5b is the **live-infrastructure campaign** that alone promotes E7-1: the JOINED distributed
journey (create→schedule→lease→execute→review) on a real E2B sandbox. That campaign needs a live staging
substrate, an armed canary Organization, and real E2B spend — none of which the session can reach or
authorize. So the session did the two things it **can** do without live staging or a key, and stopped at
the operator boundary:

1. **STEP 0 — sequence + substrate check (passed).** `E4-1`/`E4-2` are `wired`; `E7-1` is `unwired`
   (`expectedReferences: 2`); `E7-F001` is `resolved` and absent from `scripts/finding-ownership.json`.
   In sequence. Then established, from source + config, exactly what arming a canary Organization
   requires and **wrote it down as a runbook before touching anything** (`CLI-006-staging-canary-runbook.md`).
2. **Built the one buildable, session-verifiable, genuinely-missing hop — Leg B Part 2.** The credential
   resolve over a LIVE fence (DAT-008 slice 5 §8's residual), fail-first + mutation-proven, embedded-PG,
   no key, no spend (`composed-loop-secret-resolve.integration.test.ts`).
3. **Stopped at the campaign boundary.** The session did **not** stand up the staging fleet, arm a
   canary Org, supply an `E2B_API_KEY`, or run the distributed journey — all operator actions (real
   spend, live infrastructure). See §5.

---

## 2. Leg B Part 2 — the credential resolve over a LIVE fence (what landed)

`server/src/__tests__/composed-loop-secret-resolve.integration.test.ts` (embedded-PostgreSQL,
`AOA_RUN_WIN_INTEGRATION=1` on Windows / Linux CI) aligns the three pieces DAT-008 slice 5 §8 left at
**unit level** — *"the `resolved`-path value return … a full lease→resolved fixture needs an active fence
+ secret store"* — into ONE harness:

- **A real server-minted fence.** It reuses Leg B Part 1's recipe: `createPollLoop` (the real E4-1 symbol)
  polls the real `workerControlRoutes`, is offered the seeded lease-eligible attempt, and ACKs it → a
  genuinely `active` lease (only `activateLeaseAck` writes that). The captured handoff carries the
  server-minted `fenceToken` (`randomBytes(32)` at offer time, `job-leasing.ts`) and the advertised
  secret handles.
- **A minted `provider_key` handle, advertised in the offer.** A `job_secret_handles` row (the
  CLI-007-minted shape — `provider_key`/`env`/`ANTHROPIC_API_KEY`/`sandbox_local_only`, a REFERENCE never
  a value) is read by the offer path (`listActiveExecutionSecretHandles` → `toSecretHandleRefs`) and
  reaches `handoff.offer.job.secretHandles`.
- **A Company provider-key store.** `secretService.create(…, provider:"local_encrypted", value:<synthetic>)`
  writes the real AES-256-GCM-encrypted `company_secrets` row (master key `AOA_SECRETS_MASTER_KEY`, set
  in `beforeAll`, restored in `afterAll`).

It then drives the worker's **real** redemption — `createRedeemer` + `synthesiseRunSecrets`, replicating
`dispatch-runtime.ts:138-150`'s `materializeRunSecrets` verbatim — over the **real** resolve route on the
server-minted fence. **The worker gets a genuine `outcome:"resolved"` and the real decrypted value:**
`env.ANTHROPIC_API_KEY === <the exact per-run random synthetic key>`, one resolve, the value registered
as a redaction canary. Two fail-closed negative controls (a STALE fence token; a handle pointing at a
nonexistent Company key) both `deny` (HTTP 200) → `SecretMaterializationError`, isolating the live fence
and the value store as separately load-bearing.

**Boundary held (named, not hidden):** the provider-key value is a **synthetic random string** (never a
real key — Decision #104 containment), and there is **NO sandbox** — the value is asserted in `env`, not
forwarded to E2B. Whether a real coding CLI actually authenticates with it inside a real E2B sandbox is
**E7-1**, unproven here.

### 2.1 Mutation ledger — proving the harness is non-vacuous (DELETE / break, positive control first)

The production code already exists (resolve route + broker + `guardActiveFence` + `synthesiseRunSecrets`),
so — per the Step 1 / Leg B Part 1 precedent — the mutation discipline proves the **new test reddens if
the resolve broke**. Every mutant compiled, ran, was killed by an ASSERTION, and was reverted (production
files clean vs HEAD; worker-daemon dist rebuilt back).

| # | Mutation (DELETE / break) | Rebuild? | Result |
|---|---|---|---|
| M0 | **Positive control** — `synthesiseRunSecrets` returns `{env:{},canaries:[]}` | worker-daemon | **all 3 cases RED** (`expected undefined to be 'sk-ant-legb2-…'`; the two fail-closed cases `resolved "{ env: {}, canaries: [] }" instead of rejecting`) — the test drives the REAL redemption |
| M1 | `execution-secret-brokers.resolveProviderOrCompanySecret` returns a fixed non-key string | no (server-src) | **case 1 RED** (`expected 'MUTANT-M1-NOT-THE-REAL-KEY' to be 'sk-ant-legb2-…'`) + **case 3 RED** (no longer fails closed); **case 2 (stale fence) GREEN** — the fence guard runs BEFORE the broker (`secret-broker.ts` resolves the fence context first), so the fence and value paths are SEPARATELY load-bearing |
| M-neg | (built-in) case 2 redeems with a STALE `fenceToken`; case 3 points at a nonexistent Company key | — | both `deny`/throw — the LIVE FENCE and the value STORE each discriminate |

**Report line:** *3 mutants (M0/M1 + the two built-in negative controls), all killed by ASSERTION, 0
survivors, 0 false kills; every production mutation reverted and worker-daemon rebuilt clean (Exit 0).*
M2 (the resolve route returning a placeholder `value`) is **redundant with M1**, which already proves the
value assertion is non-vacuous end to end (broker → route → worker). No NEW production guard is added, so
there is no delete-the-guard obligation — the ledger proves non-vacuity of the demonstration.

---

## 3. Which hops are proven where (the honest evidence chain)

| Hop | Real E2B through the DISTRIBUTED journey? | Where the evidence actually terminates |
|---|---|---|
| create (task→job convert) | **No** | CLI-006 D1 40/40 + PR owner-decision matrix (`cli-006-run-execution-owner.test.ts`) |
| schedule (placement + CLI-007 mint) | **No** | `job-placement.integration.test.ts [CLI-007]` (mints one handle, replay-stable) |
| lease | **No (real E2B)** — proven on a REAL control plane | Leg B Part 1 (`composed-loop-real-server.integration.test.ts`) + CLI-006 D1 |
| stage (env into sandbox) | **No** | Step 1 composed-journey (fake provider) |
| **credential resolve (live fence)** | **No (real E2B), but PROVEN on a real embedded-PG fence** | **Leg B Part 2 (this sprint)** — real fence + minted handle + Company key, real `resolved` value |
| execute (run inside sandbox) | **Provider leg only** | keyed CLI-001/003 real-E2B run [32995765059](https://github.com/MeteoriteLabs/AoA/actions/runs/32995765059) — provider primitives, NOT the distributed journey |
| stream | **Provider leg only** | keyed CLI-003 (real E2B stdout) + Step 1 drain (fake plane) |
| produce (patch) | **Provider leg only** | keyed artifact-commit / patch-integrity case (run 32995765059) |
| review (projector) | **No** | CLI-006 D1 + `cli-006-canary-run-projector.test.ts` |
| cancel | **Provider leg only** | keyed CLI-003 `terminate` + CLI-006 D1 |
| audit (JOB-008) | **Provider leg only** | keyed inspect redacted/zero-leak + CLI-006 PR assertions |

**The honest answer to the go-book's completeness question — "does the evidence chain actually reach real
E2B through the DISTRIBUTED journey, or does it stop at a mock/keyed-lane/D1 boundary?"** It **stops
before the distributed journey on real E2B**, by design and by boundary. Leg B Part 2 advances the
credential-resolve leg from *unit level* to *a real embedded-PG fence with a real resolved value* — but
embedded-PG is not real E2B, and the resolve leg is not the whole journey. The provider PRIMITIVES are
proven on real E2B (run 32995765059); the **DISTRIBUTED journey** (create/schedule/lease/review through a
real control plane on a real E2B sandbox) is **owed to the operator campaign.**

---

## 4. E7-1 disposition — held `unwired`, deliberately

`E7-1-coding-journey` stays **`unwired`** (`scripts/gate-clause-wiring.json`; symbol `E2bSandboxProvider`,
`expectedReferences: 2`, untouched). It was **not** promoted, because no dispatched run completed the
**distributed** journey on real E2B. Promotion is owed to a **cited dispatched real-E2B run that
completes the distributed journey** — never a composed loop, the D1 fake provider, the keyed
provider-primitive lane (run 32995765059), or this embedded-PG live-fence harness. This is the
programme's central vacuous-green trap; **the sprint did not spring it.**

No gate-clause was promoted this sprint. `E5-5-redaction` was already `wired` (DAT-008 slice 5); Leg B
Part 2 is **additional evidence** for its "resolved-value proven only at unit level" residual, not a new
promotion.

---

## 5. The exact operator steps still owed (the campaign)

The full runbook is `CLI-006-staging-canary-runbook.md`. In brief, and in order:

0. **Stand up the distributed fleet** (`docker-compose.staging.yml`) against real external DB/S3/realtime
   with all `AOA_STAGING_*` set — including `AOA_STAGING_E2B_API_KEY` on `adapter-manager`. **This bring-up
   is itself owed to a deploy-pipeline / REL task** (`docs/deploy/staging.md` defers it; `deploy-testing.yml`
   deploys only the single-node cloud_auth app, not this fleet). This is the biggest owed piece.
1. **Pick a FRESH canary Organization** (no legacy `environment_leases`), ≥1 Company.
2. **Provision the per-Company default `e2b` key** so the preflight's `currentKeyGeneration !== null`
   (`POST /companies/:cid/secrets` → `POST /companies/:cid/runtime-provider-keys`, `provider:"e2b"`,
   `isDefault:true`).
3. **Arm the rollout dial:** add `AOA_DISTRIBUTED_EXECUTION_ROLLOUT` =
   `{"organizations":{"<orgId>":{"mode":"canary","workloads":["batch"]}}}` to BOTH control planes
   (`AOA_DISTRIBUTED_EXECUTION_ENABLED` is already `true` there).
4. **Enroll the workers** (`POST /organizations/:oid/execution-targets/:tid/enrollment-codes`, 10-min TTL).
5. **Set the canary Org concurrency cap `> 1`** (at cap 1 the transfer is structurally impossible —
   silent legacy fallback; seam-plan Task 5 / R4).
6. **Create ONE coding task** in a canary-Org Company and watch create→…→audit on real E2B.
7. **Capture the evidence** (runbook §4): `heartbeat_runs.execution_owner="distributed"`, the sandbox
   authenticated with the redeemed key, no key/redeemed value in any log, cancel→terminal, JOB-008
   redacted inspection.
8. **Promote E7-1 only on that cited run** (runbook §5).

**Until a dispatched run of the distributed journey on real E2B is cited, the real-E2B leg is UNPROVEN
and E7-1 stays `unwired`.** This is a legitimate, respected end-state — not a failure.

---

## 6. Registers + CI (honest)

- **Five registers green** on the tip: `check-gate-clause-wiring` (5 wired; E7-1 dormant/unwired,
  untouched), `check-finding-ownership` (10 open, unchanged), `check-ticket-graph-coverage`,
  `check-guard-inventory`, `check-execution-census` (no new `*.test.mjs`).
- `check-test-inventory` OK (2649 files; `server` is a **floor**, the one new integration test leaves it
  ≥ floor — no bump; `packages/worker-daemon` pin untouched). `check-worker-daemon-boundary` PASS. Frozen
  `worker-protocol` git-diff empty. `environment-variables.md` untouched (no new `AOA_*`;
  `AOA_SECRETS_MASTER_KEY` / `AOA_RUN_WIN_INTEGRATION` already documented).
- **Local proof:** the Leg B Part 2 suite is **3/3 green** at embedded-PG (`AOA_RUN_WIN_INTEGRATION=1`);
  the happy case resolves the real value over the server-minted fence in ~0.3s.
- **`verify` inherits the §2.0 red** (the pre-Sprint-0 CI timeout regression — NOT raised, NOT masked).

## 7. Adversarial review — what it caught

Four independent source-only reviewers, one per changed dimension; refute-by-default on any HIGH.
**No HIGH survived** — the programme's usual pattern (the review catches real-but-minor issues, the core
holds). Not delegated to a plan-writing or auto-fixing skill.

- **Harness fidelity + promotion honesty — 0 findings.** Verified all six load-bearing claims from source:
  the fence is genuinely server-minted (`job-leasing.ts` `randomBytes(32)` → the captured `handoff.fenceToken`),
  the lease is genuinely `active` (only `activateLeaseAck` writes it), the value cannot resolve vacuously
  (the per-run random `SYNTHETIC_PROVIDER_KEY` can only appear in `env` via a real decrypt of the seeded
  row), the test replicates `dispatch-runtime.ts:138-150` line-for-line, no gate-clause was promoted, and
  the offer genuinely advertises the seeded handle. **Independently confirmed the M1 ordering** — the
  fence guard runs strictly before the broker (`secret-broker.ts`), so M1 reddening case 1+3 while case 2
  (stale fence) stays green is correct.
- **Credential / no-leak security (Decision #104) — no leak constructible.** Traced the value end to end
  (broker → route response → worker `env`/canary); confirmed the audit is columns-only, the offer envelope
  carries only an opaque reference (`FORBIDDEN_WIRE_KEYS`-guarded), the seed uses real AES-256-GCM (no
  plaintext at rest), and `AOA_SECRETS_MASTER_KEY` is set/restored cleanly. **One LOW (fixed):** the design
  §3 no-leak row + §6 A4 claimed "the seeded plaintext appears in NO log line the harness captures," but the
  test implements NO log capture — an aspirational claim, not an implemented assertion. Corrected the design
  to describe the actual containment evidence (canary registration + audit-as-columns + no value column) and
  to scope it as a CONTAINMENT check, not a log-redaction proof (that mechanism is DAT-008's). The security
  posture is unchanged — no leak is reachable regardless.
- **Runbook accuracy — 0 factual errors on any load-bearing claim.** Verified every arming fact against
  source: the rollout dial (env names, `canary` accepted, ENABLED gates the map, `batch`, ROLLOUT absent
  from the compose), the preflight per-Company `e2b` key generation + provisioning routes, enrolment (route
  + 10-min TTL), the substrate-not-deployed honesty claim (all three sub-claims), the concurrency-cap trap,
  and the keyed-lane / D1 / E7-1-bar scope. **Two minor wording imprecisions (fixed):** "batch" is passed by
  the heartbeat seam (not `run-execution-owner.ts` itself); `deploy-testing.yml`'s default mode is
  `authenticated` (not `cloud_auth`) — corrected both; neither changed a conclusion.
- **Completeness critic (the go-book's central question) — chain does NOT reach real E2B, and says so
  honestly.** Verified E7-1 is still `unwired` (no commit touched `gate-clause-wiring.json`), the harness
  touches no real E2B / no sandbox / no `E2B_API_KEY`, and the boundary is stated plainly across the test
  header, design §1/§3.1/§7, and runbook §0/§0a/§5. Enumerated the six owed operator steps and confirmed the
  runbook captures all of them. **One MEDIUM (resolved):** the promised `CLI-006-campaign-result.md` (this
  doc) was flagged missing mid-review — now written.

No skeptic-refutation pass was needed (no HIGH to refute). The two fixes above (design A4 wording, two
runbook wordings) plus this result doc are the entirety of the review's actionable output.
