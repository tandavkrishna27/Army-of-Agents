# E7-1 campaign PRE-FLIGHT — re-verified at HEAD (2026-09-14)

**Status:** read-only preflight audit · **Branch of record:** `docs/replatform-program`
**HEAD at audit:** `49d1cc2f9` (Merge PR #458)
**Scope:** everything standing between "now" and the operator dispatching ONE real-E2B
distributed coding run. No code changed; this document is the only output. No spend, no
keys, no deploys.

**Authority note.** `RUNBOOK-e7-1-keyed-run.md` is the current operator authority and
explicitly supersedes the TIER-0 framing of `qa/2026-08-28-c0-staging-deploy-scope.md`
("adapter-manager zero implementation" was true on 2026-08-28 and is FALSE at HEAD — the
campaign overlay `docker/campaign/docker-compose.campaign.yml` + `.env.campaign.example`
exist and the worker→adapter-manager→E2B wire is merged). §2 below extracts the runbook
into a single campaign card and folds in the C0-scope items that are still live
(one-DB/four-logins, compose-not-swarm, key confinement).

---

## §1 Verdict

**READY (operator-gated).** No session-code blocker stands on the canary dispatch path at
HEAD. Every remaining step is an operator act (infra, keys, one dispatch). Detail:

### 1.1 Blocker E-2 — "the reconciler has zero non-test callers" — **NO LONGER TRUE → RESOLVED**

- `reconcileCompanyLegacyResources` (`server/src/services/legacy-resource-reconciliation.ts:486`)
  now has a production caller chain: `reconcileOrganizationLegacyResources`
  (same file, calls it at `:588`) ← the operator CLI
  `server/src/cli/reconcile-legacy-resources.ts` ← package.json script
  `"reconcile:legacy-resources": "tsx server/src/cli/reconcile-legacy-resources.ts"`.
- Caller count outside tests: 1 CLI entrypoint + the intra-service org-level wrapper.
  This is deliberate (the CLI header: "NOT AN HTTP ROUTE AND NOT AUTOMATIC" — a cutover
  reconciliation is a deliberate operator act), and `scripts/gate-clause-wiring.json`
  holds a `wired` declaration naming `reconcileOrganizationLegacyResources`.
- Closed by MIG-010 Unit 2.3 (E10-F002). **The "boot-time caller" fix contemplated by the
  preflight brief is NOT the shipped design and is not needed** — the operator runs
  `pnpm reconcile:legacy-resources --organization <orgId>` as a campaign step (card step 9).
  Size of remaining work: **none (operator step only)**.

### 1.2 Blocker E-3 — "its inventory is a strict subset of the gate's by construction" — **NO LONGER TRUE → RESOLVED**

- Closed by MIG-010 Units 2.4a+2.4b. The preflight no longer re-derives an unbounded
  inventory: `canary-preflight.ts` narrows the lease inventory to the pass's DB-clock
  watermark (`CanaryPreflightStore.leaseInventory` returns leases narrowed to
  `snapshot_at` plus `unnarrowedTotal`; the churn guard refuses when
  `inventory.leases.length === 0 && inventory.unnarrowedTotal > 0`), and a missing/old/
  superseded pass refuses with the new reason `reconciliation_stale`
  (`CanaryPreflightRefusalReason`, `server/src/services/canary-preflight.ts`).
- The lease writer participates: `environment_leases.created_at` is deliberately NOT
  app-clock-stamped (`server/src/services/environments.ts`, comment at the insert —
  DB-clock default so the watermark comparison is single-clock;
  `environments-lease-created-at-db-clock.integration.test.ts` pins it).
- Size of remaining work: **none**.

### 1.3 Record discrepancy — GO-BOOK contradicts itself on E-2/E-3 (flagged, not fixed here)

`docs/replatform/GO-BOOK.md` "Forward sequence" item 1 (~line 248) still says
"E-2 … and E-3 … are OPEN (§9e.2.2)", while the backlog table row (~line 334) in the
SAME file says "E-2 ✅ RESOLVED (= E10-F002, closed by MIG-010 Unit 2.3, `597e77715`,
PR #336)" and "E-3 ✅ RESOLVED (= E7-F004, closed by MIG-010 Units 2.4a+2.4b)". Code at
HEAD agrees with the table row. The narrative line is stale. **XS doc fix, deliberately
not made in this read-only preflight** (see §3.1).

### 1.4 Other gates on the canary dispatch path — all verified present and operator-satisfiable

| Gate | HEAD state | Symbol |
|---|---|---|
| Preflight refusal set | `no_companies` · `reconciliation_incomplete` · `credential_authority_not_moved` · `reconciliation_stale` · `preflight_error` — all POLICY reasons; `preflight_error` is the fail-closed residual, not the expected path (E-1 fixed by migration `0267`) | `CanaryPreflightRefusalReason`, `server/src/services/canary-preflight.ts` |
| Deployment flag | `AOA_DISTRIBUTED_EXECUTION_ENABLED` default-off, checked at boot | `server/src/config/distributed-execution-rollout-source.ts` header |
| Rollout dial | `AOA_DISTRIBUTED_EXECUTION_ROLLOUT` — per-org JSON map; mode MUST be `canary` (not `active`/`shadow`) for the `batch` workload / `task_run` source; malformed value fails closed to legacy | `DISTRIBUTED_EXECUTION_ROLLOUT_ENV`, same file |
| E11-F004 canary routing | **RESOLVED for the E7-1 path**, confirmed at HEAD: `resolveCanaryCredentialBinding` (`server/src/services/canary-credential-binding.ts`, wired at `server/src/index.ts:1254`) sets `executionTargetSlug = CANARY_EXECUTION_TARGET_SLUG` (`aoa-canary-e2b`); resolver takes the `dedicated_worker` slug arm, never the `pooled_gvisor` fallthrough. E11-F004 itself stays open on the broader platform-target concern; E11-F008 (per-org slug) filed, not built | `CANARY_EXECUTION_TARGET_SLUG` |
| CLI-007 canary mint (company-key ride) | Wired: preflight `ok` emits `credentialAuthority: CANARY_CREDENTIAL_AUTHORITY` (`"company_api_key"`) — present ONLY on `ok`, so a refused canary cannot present a mint authority (fail-closed by shape) | `server/src/services/canary-mint-authority.ts` |
| Preflight wired on the dispatch path | `createCanaryPreflight` constructed and passed as `preflight:` in `server/src/index.ts:1263`; refusal reason interpolated by `run-execution-owner.ts` | `createCanaryPreflight` |

### 1.5 Evidence verifier — confirmed

- `pnpm verify:e7-1-distributed-run <runId> [--org …] [--company …]` exists
  (package.json:37 → `server/src/cli/verify-e7-1-distributed-run.ts`).
- Inputs: the `runId`, plus `DATABASE_URL` in the verifier's OWN environment — the
  **owner** login (FORCE RLS blinds `aoa_app`/`aoa_operator` with no tenant GUC; the
  verdict then fails safe-closed, reading as a spurious FAIL). Absent → exit 2.
- `--require-capability` is **off by default and must NOT be passed** at this campaign
  (E7-F018: both `capabilityProven` arms structurally unreachable; ruling
  `E7-D-CAPABILITY-DISCLOSURE`, founder 2026-09-09: it stays a printed disclosure and
  gates nothing). Verified: no workflow, script, or gate clause passes the flag — the
  only non-doc references are the CLI itself and `finding-ownership.json` measurements.
- Exit codes: 0 = mechanism corroborated · 1 = not corroborated · 2 = no DATABASE_URL ·
  3 = only if `--require-capability` was passed (don't).

### 1.6 What I could not verify (honest residuals)

- **Live-fleet behaviour.** Everything above is static verification at HEAD. Nothing here
  proves the compose overlay boots, that E2B egress works, or that the seven-conjunct
  `[CLI-006]` block resolves on real infra — that IS the campaign.
- **PR #336 / commit `597e77715` provenance** for the E-2 fix: I verified the code and
  register state at HEAD, not the merge history of that specific PR.
- **The exact preflight ordering of `reconciliation_stale` vs the other refusals** beyond
  what the file's own comments state; the reason SET is pinned by
  `cli-006-canary-preflight.test.ts` (present at HEAD), which I did not execute.

---

## §2 The campaign card (operator, copy-pasteable)

**Key rule (absolute):** the E2B key (`E2B_API_KEY` / `AOA_CAMPAIGN_E2B_TEMPLATE`'s
account) lives ONLY in the adapter-manager's env via `docker/campaign/.env.campaign` on
the operator host, or in repo/org secrets — **never in chat, never committed, never in
the control-plane's auth env file** (Decision #104; `staging-manifest-invariants.mjs
checkProviderControlBoundary` reds a worker-held key). `.env.campaign` is gitignored;
verify before filling it.

Full detail for every step: `docs/replatform/RUNBOOK-e7-1-keyed-run.md` (§ numbers below
are ITS sections). The card is the checklist; the runbook is the manual.

1. **Build the E2B template** (runbook §1): `cd e2b && e2b template create aoa-base -d
   e2b.Dockerfile --memory-mb 2048 --cpu-count 2` (NOT the deprecated `template build`).
   Record the template id → `AOA_CAMPAIGN_E2B_TEMPLATE`.
2. **Mint the CP↔AM ed25519 keypair** (§2): `openssl genpkey -algorithm ed25519 …` into
   `docker/campaign/secrets/` **from the repo root** (compose resolves secret paths
   against the first `-f` file's directory); run the shipped keypair smoke probe. A
   half-wired pair boots clean and silently collapses every create.
3. **Provision Postgres — ONE database, FOUR role logins** (§3): owner
   (`DATABASE_URL` + migration URL), `aoa_app`, `aoa_operator`. Migrations create the
   serving roles NOLOGIN; set `AOA_APP_DB_PASSWORD` + `AOA_OPERATOR_DB_PASSWORD` on the
   control-plane so `maybeProvisionDistributedExecutionRoles` grants LOGIN at boot
   (passwords must match the two serving-role URLs). Blank serving URLs with the flag on
   → boot throws (`assertHostedExecutionStartupSafe`).
4. **Fill `.env.campaign`** (§4) from `.env.campaign.example`: image tags, deployment
   mode + hostnames, 4 DB URLs + 2 serving passwords, session signing key, truth bearer,
   keypair + ticket file paths, `E2B_API_KEY` + template. **Leave
   `AOA_CAMPAIGN_DISTRIBUTED_EXECUTION_ROLLOUT` EMPTY for now.** Never commit the file.
5. **Bring up CP + AM + migrate ONLY** (§5) — plain compose, NEVER swarm (swarm ignores
   `depends_on`, breaking migrate-first):
   `docker compose -f docker-compose.staging.yml -f docker/campaign/docker-compose.campaign.yml --env-file docker/campaign/.env.campaign up --wait migrate control-plane adapter-manager`
   Health: CP `/api/health` ok; AM `/healthz` ok **plus** the reaper line
   `reaper: sweep complete { reaped: 0 … }` (the healthcheck does not probe E2B;
   `EAI_AGAIN api.e2b.app` = missing egress net).
6. **Arm the rollout dial** (§6):
   `AOA_CAMPAIGN_DISTRIBUTED_EXECUTION_ROLLOUT={"organizations":{"<ORG_UUID>":{"mode":"canary","workloads":["batch"],"sources":["task_run"]}}}`
   — mode MUST be `canary`. Recreate the control-plane. Pre-verify conjunct 4:
   `SELECT organization_id FROM companies WHERE id='<COMPANY>'` = `<ORG_UUID>` (NULL
   kills the canary with no log).
7. **Create + ratify + enroll the canary target** (§7): create org execution target with
   slug **exactly `aoa-canary-e2b`**, `kind: dedicated_worker`,
   `trustClass: dedicated_tenant`; ratify the placement profile (all 8
   `CORE_PROVIDER_OPERATIONS` mandatory; `credentialCeiling: "none"`; digest over the
   unsigned provider profile; `policyHash` must equal the worker's); enroll ONE worker
   with an `aoa_tkt_…` ticket (exact `{v:1,targetId,code}` shape, 10-min TTL — bring the
   worker up promptly), on a durable `worker-state` volume, in a **fresh org**.
8. **Company E2B provider key + concurrency** (§8): set a per-Company default `e2b`
   provider key (Settings → Secrets → Sandbox Providers) — the AM's env key does NOT
   satisfy the preflight (`credential_authority_not_moved` otherwise). Raise the agent's
   `heartbeat.maxConcurrentRuns` above 1 if it would block.
9. **Run the reconciliation pass** (E-2's operator half — the crosswalk the preflight
   reads is written by this, and staleness refuses `reconciliation_stale`):
   `DATABASE_URL=<aoa_operator URL> pnpm reconcile:legacy-resources --organization <ORG_UUID>`
   — must exit 0 (every Company closed). Run it AFTER step 8 (the pass must postdate the
   authority move) and shortly before step 10 (freshness window).
10. **Dispatch ONE `task_run`** (§9): create a task in the canary org and **assign** it
    to the org agent (a mere @-mention silently skips the canary block — the wake must be
    `issue_assigned`). **NO instructions bundle** (staged files → the networked driver
    throws `UnsupportedProviderOperation` → `stage_input_failed`). Watch CP logs for
    `[CLI-006] rollout resolved … rolloutState: "canary"`. Capture the `runId`.
11. **Verify** (§10): on the host,
    `export DATABASE_URL="<OWNER login, host-reachable>"` then
    `pnpm verify:e7-1-distributed-run <runId>`. Do **NOT** pass `--require-capability`.
    Expect exit 0: `PASS (mechanism) — distributed journey corroborated`, with the
    always-printed `CAPABILITY: NOT PROVEN` beside it.
12. **Manual confirmations the verifier does not do** (§11): (a) the provider was REAL
    E2B — check the E2B dashboard / AM logs for the sandbox and its reaping; (b) read the
    `produced:` line yourself (clause 3 is terminal-agnostic — `failed`/`timed_out` PASS).
13. **Cite and flip**: cite exactly
    "**PASS (mechanism) | CAPABILITY: NOT PROVEN** — runId `<runId>`", never "the agent
    can work". Then a session flips `E7-1-coding-journey` `unwired → wired` in
    `scripts/gate-clause-wiring.json` in a **SEPARATE prose PR citing that runId** — never
    from a prep PR; the gate checker validates the symbol's reference count, not the run.

**Step count: 13** (10 deploy/arm + 1 dispatch + 1 verify + 1 confirm-cite-flip).

---

## §3 Keyless session work buildable NOW to shorten the operator's session (sized, NOT built)

1. **GO-BOOK E-2/E-3 stale-narrative fix (XS).** Reconcile the "Forward sequence" item 1
   (~line 248, "E-2 … E-3 … are OPEN") with the table row that records both RESOLVED and
   with code at HEAD (§1.3 above). One-paragraph doc PR; a summary line currently
   contradicts its own detail in the programme's master document.
2. **A campaign preflight dry-run entrypoint (S).** A read-only CLI (precedent:
   `verify-cp-am-keypair.ts`, `reconcile-legacy-resources.ts`) that runs
   `createCanaryPreflight(...).check({organizationId})` against a given DB and prints the
   `ok`/refusal verdict — so the operator learns `credential_authority_not_moved` /
   `reconciliation_stale` BEFORE dispatching, instead of reading it out of a legacy
   fallback log line. Caveat to design around: the evidence functions are
   `aoa_operator`-granted (`0267`), so the CLI must assert that role like the reconciler
   does. I did not verify whether an equivalent probe already exists; check before
   building.
3. **E11-F008 per-org canary slug (S–M).** `CANARY_EXECUTION_TARGET_SLUG` is one global
   constant, so concurrent canary orgs collide. Filed, not built; not needed for ONE run.
4. **Campaign-card rehearsal harness (M — optional, likely NOT worth it now).** A
   compose-level dry-run (fake provider) of steps 5–7 to smoke the overlay before the
   keyed session. The D1 lane already covers most of this; build only if the operator's
   first keyed session stalls on compose mechanics.

Recommendation: do §3.1 immediately (record honesty), §3.2 if the operator wants a
pre-dispatch verdict, defer §3.3/§3.4.
