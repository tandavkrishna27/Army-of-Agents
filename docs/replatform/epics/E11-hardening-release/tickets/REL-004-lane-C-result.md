# REL-004 Lane C — wire the kill switch (clause 3a) · result

**Start SHA** `db08fba1e` (the design commit) · **Design**
[`REL-004-lane-C-design.md`](./REL-004-lane-C-design.md) · **Branch** `docs/replatform-program`
(PR #323) · **Parent** [`REL-004-result.md`](./REL-004-result.md) §4.

**Status: clause 3a COMPLETE and WIRED.** The decision function that had zero callers now
decides whether a worker gets a lease, proven on the real poll path. Clause 3b (reconcile active
provider resources) is Lane D and is untouched.

| # | Commit | Scope |
|---|---|---|
| 1 | `f5e1f911d` | `EXECUTION_TARGET_KINDS`, derived from the class map |
| 2 | `bf5da42e8` | D2 + D6 precision in `evaluateKillSwitches` |
| 3 | `7779c18d9` | `instance_settings.kill_switches` (migration 0260) |
| 4 | `edec8eb66` | `aoa_app` SELECT grant + 5 manifest couplings (migration 0261) |
| 5 | `c476af0c2` | the policy reader, fail-closed |
| 6 | `451db1b11` | the poll answers `drain` |
| 7 | `94fd1c6f1` | the daemon's resumable drain |
| 8 | `75ad64d44` | separation guard, D1 nonce, test-inventory pin, this doc |
| 9 | `1cd3ad755` | adversarial-review findings (§2.3) |
| 10 | this commit | CI-red fix: the grant left the frozen 0213/0214 body (§2.4) |

**47 mutants: 44 killed, 1 documented equivalent, 1 explained-not-a-defect, 1 intentional
negative control.**

---

## 1. What was actually wrong

Clause 3a reads like a request to wire a decision function that was already built and
mutation-tested 18/18. Three things had to be fixed before it could be wired at all, and each
was found by trying rather than by reading.

### 1.1 The template axis is not knowable in the control plane

The parent result doc and the Wave-3 handoff both say the template axis is "the pinned E2B alias
in `packages/sandbox-e2b-provider`'s capability matrix". The pin is real
(`capability-matrix.ts:63`) and it is **worker-side**;
`scripts/check-sandbox-e2b-provider-boundary.mjs` keeps that package out of `server/src`. Nothing
the control plane holds carries a template: not the frozen `workerHelloV1Schema` (a desktop
worker's `policyHash` is all zeros), not `providerConstraintProfileV1Schema` (expressed "WITHOUT
provider-specific field names" by design), not `registeredTargetProfileV1Schema`, not
`execution_targets`. The one place a template IS known server-side is the **legacy** sandbox path
(`sandbox-provider-runtime.ts:530`, from `environments.config`), which creates no `leases` row.

That matters because `evaluateKillSwitches` separates `template: null` (DEFINITELY NONE) from
`template: undefined` (UNKNOWN, fail-closed). Wiring with `null` would make every template switch
a **silent no-op** — the exact hazard the module's own header refuses for a mistyped `dimension`,
and the exact failure class Lane A was written to kill. Wiring with `undefined` under the original
contract made *any* document unreadable, so killing `pooled_gvisor` would have drained the e2b
fleet too.

So the function gained one precision fix (D2): an unknown template refuses **only** a switch that
actually names the template dimension, with its own reason, `placement_unknown`. The consequence
is stated rather than hidden: **a template kill switch drains the entire fleet.** Over-broad and
loud beats narrow and false.

### 1.2 `instance_settings.general` silently erases unknown keys

The parent result doc specified `instance_settings.general.killSwitches`.
`instanceSettingsService.updateGeneral` writes `{ ...nextGeneral, ...operationalMetadata }`, where
`nextGeneral` is the **fixed four-field** output of `normalizeGeneralSettings` and the metadata
carve-out covers only `migrationSnapshots`. A `killSwitches` key there is deleted by the next
Settings PATCH: an operator throws a kill switch, someone toggles a checkbox, the switch
evaporates with no error. The switch got its own column instead.

**And the column is nullable with NO default**, which is the part that would have hurt. A
`DEFAULT '{}'::jsonb` is a document that EXISTS and cannot be understood, which the evaluator
correctly refuses — the default alone would have drained every fleet on every install. That is
integration case 4 and schema test I3.

### 1.3 A poll `drain` was a ONE-WAY fleet stop

`poll-loop.ts` set `drainRequested = true; stopLeasingRequested = true` for every drain, the loop
condition is `while (… && !stopLeasingRequested)`, and the protocol's `retryAfterMs` was parsed
and read by nothing. A drained worker never polled again.

The handoff's stated reason for building this before Wave 4 is that "a bad cutover is reversible
in seconds". With a one-way drain, lifting a kill switch meant restarting every worker process.
That is a grenade, not a switch — so `retryAfterMs: null` stays terminal and a hint now means
*pause*: finish in-flight work, wait the server's cadence, resume.

---

## 2. Two guards caught the plan, and both were right

This is the part worth reading.

### 2.1 `candidate:canonical-chain-dominates-return`

The plan put the kill check before `normalizePlacementRegistryTarget`, to save a candidate scan
for a killed provider. The JOB-003 contract guard refuses **any** return from the poll's tenant
transaction before the canonical authority chain has run, so that every poll outcome is provably
derived from the validated context.

The check moved to after `metrics.certificateScan(...)`. A drained poll now costs one extra
already-indexed query. The invariant is worth more than the query.

### 2.2 `service:no-context-or-guard-injection` — the one that mattered

The plan added `killSwitches?: KillSwitchPolicyReader` to `createJobLeasingService`. The guard
refuses it: service options are a closed allow-list (`ackTimeoutMs`, `appDb`, `leaseDurationMs`,
`maxHeartbeatAgeMs`, `metrics`, `operatorDb`, `scheduler`).

The tempting move was to add an eighth key — to widen a guard *named for exactly the thing I was
doing*. Its objection is substantive: **a reader the caller supplies is a reader the caller can
substitute**, and a substituted reader reporting "no policy" turns the stop button off for the
whole fleet with no trace. That is strictly worse than the hazard the option was meant to avoid,
and it would have been introduced by disabling the check that named it.

The reader is now built inside `createJobLeasingService` from the same `input.appDb` the authority
chain runs on. A permissive override is unrepresentable, the "composition root forgot to wire it"
hole is gone, `worker-control.ts` is unchanged, and the frozen service-option set stays frozen.

**The guard is still live after the one widening it did get.** `evaluateKillSwitches` is
registered as a reviewed call in `auditedProtectedCallPath` and `approvedContainer`, so mutant
M33 inserts an *unreviewed* call over a protected value into the same body — and
`binding:protected-value-escape` still fails. Registering a reviewed call did not retire the
guard.

### 2.3 The adversarial pass found one real defect of its own

Attacking the WIRE boundary rather than re-reading the code: the verdict's `reason` is
operator-authored free text and it is the only part of a switch that travels to the worker,
inside the frozen poll response, where `reason` is `z.string().max(1000).nullable()`.

Unbounded on our side, a 1001-character reason makes `pollResponseV1Schema.parse` **throw**
inside the poll. That is not a drain: the route maps the throw to `internal_unavailable`, the
daemon classifies 503 as TRANSIENT and merely backs off, and the kill switch silently degrades
into a 503 storm that never tells anyone why. The switch still stops leases, by accident, in the
worst available way.

Fixed by bounding the reason at `KILL_SWITCH_MAX_REASON_LENGTH`, tied to the frozen schema's own
limit, so an over-long reason is refused as a malformed entry — fail-closed AND still a drain.
The test asserts the constant against the frozen schema **in both directions**, so the two cannot
drift; mutants M43-M45 (bound removed, bound one over, off-by-one at the boundary) all die.

### 2.4 CI went red, and the cause was a SIXTH coupling surface the documentation omits

`verify` failed on the pushed tip: **21,743 passed, 2 failed**, both in
`tenant-rls-enforcement-unit.test.ts`. Everything else — `e2e`, `migrations`,
`distributed-contract`, `policy`, `brand-check`, and the live D1 lane — was green, so the
attribution was exact.

**The cause.** `server/src/db/rls-tenant.ts` RECONSTRUCTS the bodies of the already-applied,
IMMUTABLE migrations 0213 and 0214 by walking `JOB_CONTROL_LEGACY_GRANTS`, and byte-identity
tests assert the reconstruction matches the committed files. Adding one key to that object
therefore retroactively rewrites two migrations that have already run.

**Why I walked into it.** Migration 0259 is the precedent I followed, and its header carries an
explicit "MANIFEST COUPLING" list of the places that must agree. That list has five items and
does not include the reconstructors. It is wrong — and it is wrong in a particular way worth
naming: **DSK-001 Lane B, the ticket that wrote 0259, had already discovered this.** Its design
doc has a section titled *"D-B8 — a SEVENTH surface: the immutable-artifact reconstructions"*
which says verbatim *"The terrain map counted five artifacts for the grant. There are seven."*
That ticket hit the trap, added `GRANTED_AFTER_0213`/`GRANTED_AFTER_0214` to escape it, wrote it
up — and then shipped the stale five-item list into the migration header a successor actually
copies. The lesson generalizes past this ticket: **when a ticket learns something, the durable
artifact people read has to learn it too, or the next person repeats the mistake with the
document in their hand.**

**The fix is structural, not another list.** `instance_settings` moved OUT of
`JOB_CONTROL_LEGACY_GRANTS` into its own `KILL_SWITCH_POLICY_APP_GRANTS`, spread into
`appTablePrivileges()` and the `APP_SERVING_RELATIONS` union. That is the dominant convention for
every other post-0214 addition (`FOLDER_GRANTS_*`, `WORKER_ADMISSION_RATE_LIMITS_*`,
`LIVE_EVENT_LOG_*`, `LEGACY_RESOURCE_RECONCILIATION_*`), and the reconstructors never walk those
constants — so the hazard becomes unrepresentable instead of remembered. It is also the more
honest classification: `instance_settings` is an instance policy document read by the distributed
poll, not the "legacy company-scoped authorization fact" that justified putting
`provider_credentials` in the legacy bag.

Two further surfaces surfaced while fixing it, both now handled: the contract test independently
re-derives the serving-relation inventory in **two** places from the named constants, so a new
constant must be listed in both.

**A LATENT trap was found next door and closed.** `buildServingRoleHardeningMigrationSql` walks
`JOB_CONTROL_NEW_PATH_GRANTS` **unconditionally — there is no exclusion set for it at all**. A
table added there rewrites applied migration 0214 with no way to opt out, and nothing guarded it.
Verified by reading `rls-tenant.ts:442-449`.

**Guards added, both mutation-checked.** `job-control-legacy-grants.contract.test.ts` now pins the
exact key set of BOTH frozen constants, with failure messages that name the mistake and the fix.
Re-introducing the mistake fails the named guard (and the byte-identity tests); adding a probe
table to `JOB_CONTROL_NEW_PATH_GRANTS` fails the second pin. The byte-identity test always caught
this — as a forty-line SQL diff, thirty minutes into `verify`. The pins turn that into one line.

Migration 0261's header now carries the complete nine-item coupling list. Migration 0259's is
deliberately **not** edited, and the reason is mechanical rather than stylistic:
`loadRequiredMigrationIdentity()` (`packages/db/src/client.ts:153`) sha256s the **raw bytes of
every checked-in migration file** and folds them into a `ledgerSha256`;
`assertRequiredMigrationIdentity` compares that against the same hashes computed from
`__drizzle_migrations`, and a mismatch throws `distributed_execution_migration_identity` — a boot
refusal. **Editing an applied migration's COMMENT changes its hash and breaks boot on every
database where it has already run.** Editing 0261 is safe only because 0261 has never been
applied to a persistent database: CI and the D1 lane build from scratch every run. The guard now
catches the mistake regardless of what 0259's comment says, which is the better place for the
correction anyway.

---

## 3. Acceptance → named executable artifact

| Clause / invariant | Artifact | Result |
|---|---|---|
| **3a — a kill switch stops new leases** | `execution-kill-switch-poll.integration.test.ts` cases 1–6, 10 (real `poll()`, embedded PostgreSQL, non-owner `aoa_app`, asserts the `leases` table) | 10/10 |
| I2 — an absent document permits | same, case 1; `execution-kill-switch-policy.test.ts` | pass |
| I3 — the column default cannot kill | `instance-settings-kill-switches-schema.test.ts`; integration case 4 | pass |
| I4 — a failed read refuses, and is never an absent document | `execution-kill-switch-policy.test.ts` (symbol identity, not just the verdict) | pass |
| I5 — a template switch refuses rather than no-ops | `execution-kill-switches.test.ts` D2 block; integration case 5 | pass |
| I6 — a mistyped provider value refuses | `execution-kill-switches.test.ts` D6 block | pass |
| I7 — separation from JOB-007, both directions | integration case 7 (live: no status/generation change, no revocation row) + `job-leasing-kill-switch-wiring.test.ts` I7 block (structural, both directions) | pass |
| I8 — the switch is reversible without a fleet restart | `poll-drain-resumable.component.test.ts` | 5/5 |
| I9 — no repository selection added to the frozen chain | `job-leasing-contract.test.ts` | 20/20 |
| I10 — the widened guard still refuses an unreviewed call | mutant **M33** | killed |
| I11 — `aoa_app` can actually read the document | integration **case 0** (`has_table_privilege` asserted by name, and the read performed as `aoa_app`) + `job-control-legacy-grants.contract.test.ts` | pass |
| I11 — the grant and the manifest agree at BOOT | `distributed-execution-db-startup.integration.test.ts` | see §4.1 |
| I12 — in-flight work finishes | integration cases 8–10 (ack + renew succeed under a thrown switch; the same worker's next poll drains) | pass |
| every guard mutation-tested | §4 | 41 killed / 43 |

### 4.1 The startup-authority suite, stated honestly

`distributed-execution-db-startup.integration.test.ts` is the only artifact that proves the
migration's GRANT and `appTablePrivileges()` agree in a real database at boot — the contract test
compares manifest to manifest and would stay green with the migration missing.

Locally on Windows it reports **69 passed / 4 failed**.

**CORRECTION.** An earlier revision of this section said all four were in the `observeServer`
group. That was asserted before the names were in hand and it is wrong in detail — I had verified
one of them, not four. The actual four, captured with a working reporter:

1. `checks grant-option ACL tuples independently on every derived relation and non-dropped user column` — **a timeout**, not an authority failure
2. `keeps aoa_operator outside the drizzle migration schema`
3. `proves the module-load sentinel reaches every guarded module while enabled`
4. `threads the identical metrics instance through the real flag-on startup and app composition`

Three of the four do spawn a real server subprocess and fail with
`distributed_execution_app_authority`; the fourth is a timeout with a separate cause (§4.2). Run
in isolation, (4) PASSES, and the suite's earlier cases deliberately construct drifted roles
(`rejects an exact-named app role with inherited secret authority`, `rejects an exact-named
operator role with a stale table grant`), which is the ordering hazard. Nothing in the suite
knows about `instance_settings` at all.

It DID also surface a genuine local trap on the first attempt, worth recording: `pnpm db:generate`
writes to `packages/db/src/migrations` while `applyPendingMigrations` loads from
`packages/db/dist/migrations`. Until the db package is rebuilt, the manifest expects a grant the
database has never been given, and the real server subprocess crashes exactly this way. **Rebuild
`@armyofagents/db` before running any integration suite after generating a migration.** CI builds
first, so it does not see this.

**Settled by the LIVE lane, not by argument.** The D1 Merge Train ran on the pushed tip
(`4d5bcbead`, run `32560322510`) and is **green in 6m37s**: static topology preflight, split-image
build, two-replica bring-up, the live E6F campaign, teardown. Both replicas BOOTING is precisely
the assertion in question — `assertExactServingRoleAuthority` runs at startup against the real
migrated database, so a manifest/grant mismatch would have refused the bring-up. It did not. The
PR gate's `migrations` job is green on the same tip.

One attribution attempt is worth recording as a method failure. Reverting the code in place with
`git checkout <pre-lane-C-sha> -- server/src packages/db packages/worker-daemon` produced 58
failures, which looked alarming and meant nothing: `git checkout <sha> -- <path>` restores
modified files but does **not remove files added since**, so the tree still held every new Lane C
test and module while their imports had been reverted underneath them. An inconsistent tree
answers no question. The clean signals are the isolation run and the live D1 lane above.

### 4.2 The fix caused a SILENT coverage loss, which is the failure class itself

Found by an exhaustive grant-surface sweep run after the fix landed, and then verified directly.

`distributed-execution-db-startup.integration.test.ts` contains a grant-option ACL mutation sweep
that composes its relation list from a **hand-maintained partial spread of six grant constants**
(`:5188-5194`). While `instance_settings` lived in `JOB_CONTROL_LEGACY_GRANTS` it was swept.
Moving it to its own constant — the fix for §2.4 — dropped it straight out, and **nothing turned
red**: the assertion is `expect(acceptedMutations).toEqual([])`, and a relation that is never
probed contributes nothing to that array.

So the fix for one instance of "a check that nothing runs" created another. Coverage is restored
by adding the new constant to that spread. Restoring it pushed the test from ~170s to 246s on this
machine, over its 180s budget, so the budget is now 300s — every relation costs a full server-boot
attempt and every column costs another, and `instance_settings` has seven columns. Linux CI has
the headroom: the PR run at `4d5bcbead` had the relation covered (via the legacy constant) and
reported exactly two failures, both in a different file.

**Not absorbed, deliberately:** that spread still omits **ten** other app serving relations
(`folder_grants`, `worker_admission_rate_limits`, `live_event_log`, `live_event_sequences`,
`legacy_resource_reconciliation`, `job_events`, `job_projection_receipts`,
`job_control_commands`, `distributed_cutover_markers`, `execution_target_revocations`). Deriving
the list from `APP_SERVING_RELATIONS` would make it self-maintaining, but at ~8 boots per relation
that is a large addition to a test already at 246s, and it is a pre-existing gap rather than one
this ticket created. Recorded here and in a comment at the spread, not silently expanded.

Neighbouring suites re-run: `job-leasing.integration` 39/39, whole `worker-daemon` 669/669,
`tenant-app-db-startup` + `job-control-runtime` + `job-source-governance-matrix` +
`job-fence-surface.contract` + `job-lease-eligibility` 65/65, `pnpm tsc --noEmit` clean,
`check-guard-inventory` / `check-test-inventory` / `check-d1-compose` /
`check-forbidden-tokens` / `check-worker-daemon-boundary` /
`check-frozen-worker-protocol-consumer` all OK.

---

## 4. Mutation ledger

| Group | Mutants | Killed | Notes |
|---|---|---|---|
| Decision function (M1–M12) | 12 | 11 | M11 equivalent, documented in source |
| Grant manifest (M13–M19) | 7 | 7 | each of the 5 registration surfaces individually load-bearing |
| Policy reader (M20–M25) | 6 | 6 | incl. turning the sentinel into a plain object |
| Poll wiring (M26–M32) | 7 | 7 | incl. replacing the reader with a permissive stub |
| Frozen guard (M33–M35) | 3 | 1 | M33 killed = the point; M34/M35 explained below |
| Reason wire-bound (M43–M45) | 3 | 3 | the adversarial find, §2.3 |
| Comment-stripping separation guard | 1 | 1 | a real code reference fails it; prose does not |
| Both-branches projection guard | 1 | 1 | narrowing the platform projection fails it |
| Daemon drain (M36–M42) | 7 | 7 | incl. a pause silently becoming terminal |

**Survivors, honestly:**

- **M11** — dropping `template !== null` is an **equivalent mutant**: `value` is already
  guaranteed a non-empty string, so `null === value` can never hold. Kept and commented as
  defence-in-depth; it becomes load-bearing the moment the value check changes.
- **M34** — an extra return placed *after* the candidate binding survives. That is the guard's
  actual contract: it requires returns to be **dominated by** the canonical chain, not to be
  unique. It is why the drain return is admissible at all. Not a defect; recorded so the next
  reader does not mistake it for one.
- **M35** — an intentional **negative control**: a harmless statement must NOT trip the contract
  guard. "Survived" is the desired outcome.

**Three survivors in the first decision-function run were defects in MY OWN tests**, all closed:

1. the empty-vocabulary guard was untested because a provider switch refuses via the per-value
   check anyway — only a **template-only** document reaches the up-front guard;
2. no execution-target kind is a prefix of another, so `===` and `startsWith` were
   indistinguishable until a case used an **observed** provider outside the vocabulary
   (`e2b-staging`);
3. the value type check was **masked** by D6 on the provider dimension, so it needed a
   template-dimension case. (Lane B hit this same masking shape.)

**One harness defect, recorded because it is the recurring lesson.** The first mutation run over
the poll wiring reported M28 and M31 as survivors. Both were false: the harness did not set
`AOA_RUN_WIN_INTEGRATION=1`, so the integration suite was **skipped** and only the structural
wiring test ran. A skipped suite kills nothing. With the env var set, 7/7 died. *A kill — or a
survival — proves nothing until you have checked which tests actually ran.*

---

## 5. Deferrals, stated plainly

1. **Clause 3b — reconcile active provider resources on kill.** Lane D, next in Wave 3. It builds
   on MIG-008's `legacy-resource-reconciliation.ts` seam.

2. **There is no write path or UI for throwing a switch.** Parent design §5 puts it in
   REL-001/005. Today an operator sets `instance_settings.kill_switches` directly, e.g.
   ```sql
   UPDATE instance_settings SET kill_switches =
     '{"schema":1,"switches":[{"dimension":"provider","value":"e2b","reason":"provider incident"}]}'
     WHERE singleton_key = 'default';
   ```
   and lifts it with `SET kill_switches = NULL`. **`NULL`, not `'{}'`** — an empty object is an
   unreadable document and drains.

3. **The template axis is NOT enforceable at the poll.** It refuses loudly instead of no-opping
   silently (§1.1). Closing it properly needs a control-plane template fact; the natural home is
   an operator-declared pin in `execution_targets.config`, bound the way `registeredProfileHash`
   binds the rest of the placement profile. That is a placement-registry change, not a
   kill-switch change, and is out of scope here.

4. **The legacy sandbox seam is untouched.** `sandbox-provider-runtime.acquire` creates E2B
   sandboxes today from `environments.config.template`. That is correct for the Wave-4 gate — the
   switch exists to stop placement on the platform being cut over TO, with legacy as the fallback
   — but if a later ticket wants to kill legacy placement as well, that is a second seam and must
   be stated as such rather than assumed covered.

5. **No caching.** One indexed single-row read per poll, against a poll that already issues
   eight-plus statements. A cache would add per-replica staleness for a negligible saving.
   Revisit only with a measurement.

6. **The switch is instance-wide, not per-organization.** MIG-002's per-org dial is the other
   control and is deliberately separate (handoff §5).

7. **The reason string is broadcast to every worker on the instance.** It is the only field that
   crosses to the fleet, the switch is instance-wide, and on a multi-tenant deployment a
   dedicated worker may be operated by the tenant. Write reasons for that audience. Bounded at
   1000 characters (§2.3); not otherwise filtered.

8. **No LIVE platform-target kill-switch case.** The integration suite uses an
   organization-scoped `dedicated_worker`. The platform branch takes its target from
   `recheckPlatformTargetAuthority`, and the risk if that projection were narrowed to drop `kind`
   is specific and nasty — the switch would read `provider: undefined` and refuse, so throwing
   ANY switch would drain every platform worker regardless of what it named, and only once a
   switch existed. Pinned structurally instead (`job-leasing-kill-switch-wiring.test.ts`: both
   authority paths select the shared `placementTargetColumns`, which carries `kind`), and that
   guard is itself mutation-checked. A live platform case needs an operator-db fixture plus a
   physical/logical worker pair; it is worth adding when Lane D touches the same suite.

---

## 6. What this unblocks, and what it does not

Wave-4 gate clause 1 — "REL-004 clause 3 is complete and wired: a kill switch can actually stop
new leases, **proven by a test that exercises the poll path, not only the decision function**" —
is satisfied for **3a** by `execution-kill-switch-poll.integration.test.ts`. Clause 3 as a whole
is not complete until Lane D lands 3b.

The gate's other four clauses are untouched by this lane: shadow-comparison evidence for
MIG-005/006/007, a named rollback path per sink, D1 green on the candidate SHA, and the
provider-credential deferral (§6.1 of the handoff — a worker still receives no credential, and
that blocks ACTIVE cutover, not shadow).
