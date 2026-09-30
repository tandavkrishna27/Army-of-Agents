# REL-004 Lane D — clause 3b terrain (reconcile active provider resources on kill)

**Status: TERRAIN ONLY. No design, no code.** Written while Lane C's CI settled, because clause
3b's parent instruction — *"Lane D's reconcile builds on MIG-008's `legacy-resource-reconciliation`
seam"* ([REL-004-design.md](./REL-004-design.md) D5) — points at a seam that, followed literally,
makes things worse. That is worth knowing before a design is written, not after.

Every claim below was verified by opening the file. Line references are to
`docs/replatform-program` at `cd04b3ae7`.

---


> **CORRECTION (revision 2 of the design).** Two claims below are WRONG and are struck where they
> appear: that `server` declares `@armyofagents/worker-protocol` **only** (it declares
> `"e2b": "^2.30.5"` at `server/package.json:67` and kills sandboxes by id at
> `sandbox-provider-runtime.ts:823-827`), and that the control plane holds **no handle** to a
> distributed sandbox (the id is durably held via `attemptStartedPayloadV1Schema.sandboxId` ->
> `job_events.event`). Only the `leases`-table half was accurate. The check that produced the
> error grepped dependency NAMES for `sandbox`/`worker`, which cannot match a package called
> `e2b`; its silence was read as evidence. The conclusion (ship nothing distributed) survives for
> DIFFERENT reasons — see the design's section 2 — but it is a CHOICE, not an impossibility.

## 1. The finding that reframes the ticket

**Wiring MIG-008's reconciler as instructed would make a reclaimable paused E2B sandbox
permanently unreachable, while it keeps running and billing.** Three legs, each verified:

1. `legacy-resource-reconciliation-store.ts:57-65` — `casClaimPaused` claims a paused lease by
   calling `expireLeaseIfPaused(leaseId, { cleanupStatus: "pending" })`. Its own comment is
   explicit: *"No provider kill here: the reconciler records a terminal disposition; the actual
   sandbox teardown is CLI-004's job at cutover."*
2. `environments.ts:310-326` — `expireLeaseIfPaused` sets `status: "expired"` **WHERE
   `status = 'paused'`**.
3. `environments.ts:373-386` — `listPausedLeasesOlderThan`, the query behind the warm-sandbox
   reaper (the only scheduled force-kill in the system, started at `index.ts:1292`), selects
   **only** `eq(environmentLeases.status, "paused")`.

And the row cannot be found any other way: `cleanupStatus` appears in `environments.ts` at lines
160, 177, 189, 312, 322, 334 and 345 — **every one a write; not one a `WHERE`**. Nothing in the
service reads it back.

So the sequence is: reconciler claims `paused` → row becomes `expired` with
`cleanupStatus='pending'` → the reaper's query can never match it again → no other query looks
for it → the provider sandbox is never killed.

**The mitigation the comment names is unverified and probably does not apply.** "CLI-004's job at
cutover" refers to `E2bSandboxProvider.reconcileCleanup(sandboxId, ctx)`
(`packages/sandbox-e2b-provider/src/e2b-provider.ts:261`), which reclaims a **specific sandbox id**
you already hold, and `list()` (`:283-292`), which enumerates provider-side and parses
`resourceLabels` / `deviceGeneration` from provider metadata. A LEGACY lease's sandbox is created
by `server/src/services/sandbox-provider-runtime.ts`, not by `E2bSandboxProvider`, so whether it
carries labels that sweep can recognise is **exactly the question Lane D must answer first**. Do
not assume it does.

**Severity today: LATENT.** `reconcileCompanyLegacyResources` has **zero production callers**
(verified: only its own test suite references it). Nothing can fire this. It becomes real the
moment Lane D does what the parent design says.

---

## 2. Four more reasons the obvious shape does not work

Each of these was raised by an adversarial pass and then re-verified against source.

**2.1 Coverage inversion — a poll-triggered reconcile runs over a structurally empty set.**
The poll exists only behind `AOA_DISTRIBUTED_EXECUTION_ENABLED`, which defaults **false**
(`server/src/config/distributed-execution.ts:22`) and gates `workerControlRoutes` at
`app.ts:438-451`. But the only provider resources the control plane can actually destroy are
LEGACY `environment_leases` rows, and the path that mints them
(`environment-run-orchestrator.ts:320` → `environment-runtime.ts:463`) is entirely
flag-independent. On any deployment with E2B sandboxes and no distributed fleet, a poll-triggered
reconcile never fires once. Worse, its coverage is proportional to worker *health* while the need
is inversely proportional: only a worker healthy enough to poll produces a verdict, and orphans
belong to workers that stopped polling.

**2.2 The kill verdict cannot name what to reconcile, and one of its values is a DB blip.**
`evaluateKillSwitches` returns `{killed:true, dimension:null, value:null, reason:"policy_unreadable"}`
whenever the policy read throws (`execution-kill-switches.ts:92-94`), and the identically-shaped
`placement_unknown` on every template switch. Fail-closed is right for *leasing* — stop offering
work. It is fail-**destructive** for a reconcile: a two-second database hiccup would trigger a
fleet-wide teardown, and the verdict object carries `dimension:null, value:null`, so the reconcile
could not even learn which provider was killed.

**2.3 The grants do not exist, and the crosswalk reads EMPTY from inside a tenant transaction.**
`environment_leases` and `environments` each appear **0 times** in
`server/src/db/job-control-legacy-grants.ts` — `aoa_app` cannot so much as SELECT a legacy lease,
and `assertExactServingRoleAuthority` enforces exact ACLs. Separately,
`0256_dizzy_bedlam.sql:100-103` creates the crosswalk's app-read policy as
`USING (current_setting('aoa.organization_id', true) IS NULL)`, commented *"aoa_app may READ the
crosswalk ONLY outside a tenant transaction"*. The kill verdict is computed **inside**
`runInTenant` (`job-leasing.ts:513`), where that GUC is set — so from there the crosswalk is not
merely unwritable, it reads as zero rows. Reaching these resources means new grants, and Lane C
just established what that costs: see §2.4 of [the Lane C result](./REL-004-lane-C-result.md).

**2.4 Any distributed-side reclaim contradicts clause 3a.** The one existing precedent for
converging live distributed leases against a policy decision — the JOB-007 revocation fan-out
(`execution-target-revocation-fanout.ts:96-108`) — flips `offered|active` leases to `revoked` and
then calls `requestCancellation(..., graceful: false)` (`:184-190`). A revoked lease fails
`renew`'s revalidation and throws `target_revoked`, killing a run already executing inside its
sandbox. Lane C's `job-leasing-kill-switch-wiring.test.ts` pins the opposite. And there is no
gentler option available: `server/package.json` declares `@armyofagents/worker-protocol` only — no
worker-daemon, no sandbox provider — and the `leases` table carries no sandbox id, so **the
control plane holds no handle to release.** A `cancel`/`drain` command is an intent, not a
reconcile.

---

## 3. What is built vs. what is wired

| Symbol | File | Production callers |
|---|---|---|
| `reconcileCompanyLegacyResources` | `services/legacy-resource-reconciliation.ts:324` | **0** |
| `createJobControlSweeper` | JOB-006 | **0** (also recorded as inherited deferral #2 in the Wave-3 handoff) |
| `evaluateKillSwitches` | `services/execution-kill-switches.ts` | 1, as of Lane C |
| warm-sandbox reaper | `services/warm-sandbox-reaper.ts` | 1 — scheduled at `index.ts:1292`, and the **only** scheduled force-kill |

---

## 4. The question the design has to answer first

Not "how do we trigger a reconcile" but:

> **When a provider is killed, what can the control plane actually reclaim — and is reclaiming it
> compatible with clause 3a's guarantee that in-flight work finishes?**

On the evidence above the honest answer looks like: *for the distributed platform, nothing, by
construction* (no handle, no sandbox id, and any forceful convergence contradicts 3a); and *for
legacy E2B, only via the warm-sandbox reaper's `paused` path, which the MIG-008 seam would
destroy rather than use.*

If that survives scrutiny, clause 3b's honest shape is narrow: make the killed provider's
resources **enumerable and attributable** (the crosswalk records MIG-008 already builds), leave
live work to drain, and let the existing reaper reclaim paused snapshots — explicitly **not**
expiring them out of its reach. That is a much smaller ticket than "reconcile", and it should be
stated as a scoped limit rather than dressed up as full reclamation.

---

## 5. Traps

- **Do not wire `casClaimPaused` without fixing §1 first.** It is the single instruction the
  parent design gives, and following it is worse than doing nothing.
- **Do not hang the reconcile off the kill verdict.** §2.2 — the verdict shape cannot name a
  provider and fires on a transient database error.
- **A new grant is not cheap.** Lane C's grant touched 21 coupling surfaces across four failure
  directions (BOOT / LOAD / TEST / silently-OPEN). The complete list is in migration
  `0261_instance_settings_app_select.sql`'s header; the frozen-constant pins are in
  `job-control-legacy-grants.contract.test.ts`.
- **`environment_leases` has no `aoa_app` grant at all**, so any control-plane reconcile running
  on the serving role needs one — with everything that implies.
