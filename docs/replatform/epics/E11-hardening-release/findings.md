# E11 Hardening & Release — findings

Findings filed against Epic E11. Every OPEN finding must have a declaration in
`scripts/finding-ownership.json` (the `check-finding-ownership` register fails otherwise:
a new open finding is born `undeclared_finding`). `unowned` with a reason is legitimate —
it makes an unscheduled item visible rather than impossible.

## E11-F001 — the "flip strict, two lines from honest" release-gate framing predates CI going green

**Status:** `open` · Severity: LOW · Filed 2026-08-27 by REL-FOUNDATION-GATE (S9 unit 1) terrain verification.

Two living documents describe the E0 release-test fix as a free "flip the checker strict,
accept honestly-red" change:

- `docs/replatform/qa/2026-08-27-breadth-terrain-audit.md` (Sprint 9 section): *"make the
  checker require the named release-test ticket to exist (flips E0 to honestly-red until E11
  lands)."*
- The same audit's *"30/30 Critical/High trust crossings name REL-001/002/003/005"* is
  imprecise. Parsed at tip, **6 of the 30 crossings name the WRITTEN REL-004** (and would pass
  a strict existence check); only **24** name *only* unwritten tickets. A strict flip reds 24,
  not 30.

Both were written when `ci-required` was already red (the GO-BOOK §2.0 60-min `verify`
timeout), so a foundation-checker red was **free** — it changed a gate that was red anyway.
**§2.0 was RESOLVED 2026-08-27 (PR #327): `ci-required` is green, and a red required check now
BREAKS the gate.** The foundation checker runs as a step of the always-on `policy` job
(`.github/workflows/pr.yml`), which `ci-required` requires unconditionally, so a hard-strict
"require the ticket to exist" flip would red a required check on **every** PR until all four
unwritten REL tickets land — a self-inflicted merge freeze, not "honest red". REL-001/002 are
blocked on Sprints 7/8 and REL-005 on all of them, so "until they exist" is the rest of the
programme.

**Resolution recorded, not owed.** REL-FOUNDATION-GATE (S9 unit 1) ships the *trackable-strict*
gate instead: a named REL ticket is admissible if its `<id>-design.md` exists on disk OR it is
declared, with a reason, in `docs/architecture/distributed-execution-release-tests.json`. That
ships **0-error at rest** (6 admit on written REL-004, 24 on manifest-deferral) while making the
24 unwritten release tests machine-tracked debt. GO-BOOK §4 Sprint 9 and §5 were corrected in
review round 2; this finding records that the **dated** 2026-08-27 terrain audit still carries
the pre-CI-green framing (a dated QA snapshot is not silently rewritten). Blocks nothing.

## E11-F002 — the database restore path has no operator entrypoint

**Status:** `open` · Severity: **MED** · Owner: **REL-003** · Filed 2026-08-27 by REL-003 (S9 unit 2) terrain verification.

`runDatabaseRestore` (`packages/db/src/backup-lib.ts`) is exported from that module and
unit-tested, but has **zero production/CLI callers** — verified at tip, the only references are
`*.test.ts` (`packages/db/src/__tests__/backup-lib-non-system-schemas.test.ts`) plus a string
reference in `server/src/__tests__/job-leasing-contract.test.ts`. It is **not** re-exported from
the `@armyofagents/db` barrel (`packages/db/src/index.ts` exports `runDatabaseBackup` but not the
restore), and there is **no `aoa db:restore` command** (`aoa db:backup` exists —
`cli/src/commands/db-backup.ts`). A DR ticket whose acceptance says "prove database … restore"
therefore has no operator invocation for the restore leg — the one clause satisfied by a function
nothing calls (the DSK-002 / REL-004 "count the callers" lesson).

**Resolution (in REL-003 scope):** the DR rehearsal runbook
(`docs/replatform/epics/E11-hardening-release/tickets/REL-003-dr-rehearsal-runbook.md`, step 4)
names the exact restore invocation — a thin harness calling `runDatabaseRestore({ connectionString,
backupFile })`, or `pg_restore` for the custom-format dump — since there is no `aoa db:restore`.
The finding resolves when a real operator restore entrypoint (an `aoa db:restore` command or an
exercised harness wrapper) lands **and** the live staging rehearsal exercises it (the owed leg).
Owned by REL-003.

## E11-F003 — E11-5's register reason asserts a second call site that does not exist: the warm-sandbox reaper calls a DIFFERENT function

**Status:** resolved_by_w16a · **Owner:** — (closed; the ownership entry is deleted in this commit)
**Severity:** MEDIUM (a register sentence describing source, refuted by source; the clause's
`wired` verdict is unaffected)
**Filed:** 2026-09-06 (W5U1), measured at `e1f723df2`.
**Resolved:** 2026-09-07 (W16A, branch `replatform/w16a-register-sentences`), re-measured at
`8075cd7a1`.

> ★ **HOW IT WAS RESOLVED, AND THE ONE THING THAT COULD UNDO IT.** W16A rewrote
> `E11-5-provider-kill-switch`'s `reason` to exactly what the "What would close it" section below
> prescribes: `evaluateKillSwitches` has ONE production caller (`job-leasing.ts:720`), the
> warm-sandbox reaper reaches the same policy document through the deliberately fail-OPEN
> `killedProviders`, and the inverse-polarity comment is quoted verbatim so a reader cannot infer
> the fail-closed property again. Nothing about the clause's `status`, `symbol` or
> `expectedReferences` moved; this was prose only, which is all this finding ever alleged.
>
> **This is a BRANCH STATE.** It is true on `replatform/w16a-register-sentences`. If that PR is
> not merged, the corrected sentence goes with it and this finding is `open` again — restore the
> `E11-F003` key in `scripts/finding-ownership.json` at the same time.
>
> ★★★ **A FALSE NEGATIVE SWEEP, CORRECTED 2026-09-07 (W16A-FIX) — recorded here because a false
> sweep inside a register-accuracy unit is the defect eating itself.** W16A's build report claimed
> that `grep -rn 'evaluateKillSwitches' docs --include=*.md` returned "only E11-F003 plus
> `REL-004-lane-C-design.md`". **Re-run at `75c3e42a2`: 46 hits across 8 files** —
> `E11-hardening-release/findings.md`, `REL-004-lane-C-design.md`, `REL-004-lane-C-result.md`,
> `REL-004-lane-D-design.md`, `REL-004-lane-D-result.md`, `REL-004-lane-D-terrain.md`,
> `REL-FOUNDATION-GATE-design.md` and `GO-BOOK.md`.
>
> **The sweep's CONCLUSION survives; its STATED BASIS did not.** All six previously-unnamed files
> were read: none repeats the "second caller" claim, and the three Lane-D documents refute it
> independently — `REL-004-lane-D-design.md:122,133` and `REL-004-lane-D-result.md:60` both set
> `evaluateKillSwitches` (fail-closed) against `killedProviders` (fail-open) as *two consumers of
> one parse*, and `REL-004-lane-D-terrain.md:115` tabulates `evaluateKillSwitches` at **1** caller.
> `GO-BOOK.md:1792` and `REL-FOUNDATION-GATE-design.md:223` name only the REL-005 write-path
> residual. So the correction is complete and no other document needed one — but that is now a
> **measured** statement rather than an asserted one, which is the whole difference this register
> exists to keep.

**What the register SAID.** `scripts/gate-clause-wiring.json` → `E11-5-provider-kill-switch`, as
filed (this text no longer exists in the file):

> "Genuinely wired: called on the real poll path (job-leasing.ts) **and by the warm-sandbox
> reaper**."

**Measured.** `evaluateKillSwitches` (`server/src/services/execution-kill-switches.ts:230`) has
exactly ONE production caller:

```
grep -rn "evaluateKillSwitches" --include=*.ts . | grep -v node_modules | grep -v __tests__ | grep -vi "\.test\."
```

→ `server/src/services/job-leasing.ts:49` (the import) and `:720` (the call), plus **five comment
lines across four other production files** (corrected from "four COMMENTS" 2026-09-07, W16A-FIX)
that name it (`packages/db/src/schema/instance_settings.ts:18`,
`server/src/services/execution-kill-switch-policy.ts:13,36`,
`server/src/services/execution-kill-switches.ts:206`,
`server/src/services/execution-target-resolver.ts:62`).
`node scripts/check-gate-clause-wiring.mjs --counts` measures it at **1**.

**What the reaper actually calls.** `server/src/services/warm-sandbox-reaper.ts:195` is:

```js
reclaimProviders = killedProviders(await readDocument(), EXECUTION_TARGET_KINDS);
```

`killedProviders` is a different function in the same module, and the comment two lines above says
it is deliberately the OPPOSITE polarity: *"Fail-OPEN, inverted from leasing: `killedProviders`
returns the empty set for an absent, malformed or unreadable document"* — where
`evaluateKillSwitches` "refuses" an unreadable document (`execution-kill-switch-policy.ts:13`). So
the register does not merely name the wrong symbol; it attributes to `evaluateKillSwitches` a second
site whose actual occupant has the inverse failure mode.

**What is NOT wrong.** `E11-5` is correctly `wired` — one real production caller is one, and
`job-leasing.ts:720` is genuinely on the poll path. The clause's verdict, its `wired` status and
its recorded REL-005 residual all stand. This finding is about the sentence beside them.

**Why it matters at MEDIUM.** This is the failure class W4U1 built `providerCapabilityClaims` for,
in the half that guard deliberately does not cover: the `symbol` field is machine-checked and has
stayed honest, while the `reason` PROSE is read by nobody and rots. A reader auditing kill-switch
coverage reads "and by the warm-sandbox reaper" and concludes the reaper refuses on an unreadable
policy document. It does the opposite, by design and with a comment saying so — an inverted safety
property inferred from a register string. No code is wrong; the map is.

**What would close it.** Correct E11-5's `reason` to say `evaluateKillSwitches` has one production
caller (`job-leasing.ts:720`) and that the warm-sandbox reaper reaches the same policy document
through the deliberately fail-OPEN `killedProviders`. Not done by W5U1: its charter forbids
changing an existing clause's declaration, and the `reason` is part of it. **DONE by W16A** —
see the resolution note at the top of this entry. W16A additionally measured one fact this finding
did not record: `killedProviders` returns only entries carrying `reclaim: true`
(`execution-kill-switches.ts:213-222`), so the reaper is not a consumer of the kill VERDICT under
any polarity, not merely a differently-polarised one.

## E11-F004 — the review's "enable one managed E2B execution target for one organization" names an object no code path can create, and is ambiguous with an object that is not an execution target

**Status:** `open` · Severity: **HIGH** · Filed 2026-09-08 by W18 (provability wave, gate-naming unit).

**What was proposed.** An independent documentation review proposed promoting to mandatory
release acceptance a clause reading, in part: *for one organization, enable one managed E2B
execution target*. The 5-agent provability wave rated this **CRITICAL**. This entry files it
**HIGH** — see "Why HIGH and not CRITICAL" below — and records the measurement, which was
re-derived at tip rather than inherited.

**The chain, re-verified link by link at `13caa3227`.** Each link is necessary; together they
make the named object unconstructible.

1. `server/src/services/execution-target-resolver.ts:52-56` — `TARGET_KIND_BY_CLASS` maps
   `managed_cloud → {pooled_gvisor, e2b}`. `e2b` appears in **no other** class, so a
   placement-eligible `e2b` row is `managed_cloud` or it is nothing.
2. `packages/worker-protocol/src/job.ts:88-94` — `PLACEMENT_MATRIX.managed_cloud` pins
   `targetScope: "platform"`, and `registeredTargetProfileV1Schema`'s refiner
   (`packages/worker-protocol/src/capabilities.ts:325-327`) rejects any profile whose `scope`
   is not the class's matrix scope.
3. `packages/worker-protocol/src/capabilities.ts:300-303` — `platform` scope **requires a null
   organization**: *"platform scope requires a null organization"*. (`:304-306` likewise
   requires a null owner.)
4. `server/src/routes/execution-targets.ts:176-186` — the org create route hard-codes
   `organizationId: orgId`, which is non-null by construction (`uuidParam.parse(req.params.orgId)`).

So *"for one organization"* and *"a managed E2B execution target"* are mutually exclusive by
schema. There is no configuration, flag or migration that satisfies both.

**Three further refusals the wave's four-link chain did not name, found by grepping the claim
rather than accepting the list.** My count against the brief's: **4 links given, 7 measured.**

5. The same create route (`:174`) computes `const scope = input.ownerUserId ? "owner" : "organization";`
   — it can produce **only** `owner` or `organization`, never `platform`. So the route is barred
   twice over, and removing the hard-coded `organizationId` would not unbar it.
6. `server/src/services/execution-targets.ts:124` — `ratifyTenantExecutionTargetPlacementProfile`
   explicitly refuses `target.scope === "platform"`, so the org-scoped ratification route cannot
   attach a placement profile to a platform row even if one existed. Without a ratified
   `registeredProfile` + `providerConstraintProfile`, `normalizePlacementRegistryTarget`
   (`execution-target-resolver.ts:131-133`) returns `null` and the row never enters placement at all.
7. **Corroboration by absence — there is no production creator of a `kind = "e2b"` row anywhere.**
   `grep -rn "insert(executionTargets)" --include=*.ts` returns exactly **two** non-test sites:
   `server/src/routes/execution-targets.ts:181` (the org route above) and
   `server/src/services/execution-targets.ts:433` `ensureControlPlaneExecutionTarget`, which is the
   only null-org/`scope: "platform"` writer in the tree and **hard-codes `kind: "local_host"`**.
   The UI has no create at all: `ui/src/api/execution-targets.ts` exposes `list`, `rotateToken`
   and `revoke` only. So the platform-scoped half of the object has no creator either — the clause
   is not merely mis-scoped, it names a row shape nothing in the repository can write.

**And the adapter path refuses it too.** `executionTargetToAdapterConfig`
(`execution-target-resolver.ts:322-327`) throws for **both** `desktop` and `e2b`:
*"has no control-plane adapter configuration … running it here would execute on the
control-plane host."* That is a deliberate fail-closed (DSK-001 Lane C / F28), and it means even
a hand-inserted row cannot execute through the legacy path.

**★ THE AMBIGUITY THE WAVE RESOLVED, AND BOTH READINGS FAIL.** The clause is ambiguous, and the
review does not say which it means:

- **Reading 1 — an `execution_targets` row of `kind = "e2b"`.** Structurally inexpressible for
  an organization (links 1–4), and uncreatable even at platform scope (links 5–7).
- **Reading 2 — the E2B that actually runs today.** That is a **different mechanism entirely**:
  an `environments` row named `"Platform default (E2B)"` with `metadata: { platformDefault: true }`
  (`server/src/services/platform-default-environment.ts:57,68`), `driver: "sandbox"`,
  `config.provider: "e2b"`. It carries **`executionTargetId: null`** (`:71`) and is resolved by
  `environment-run-orchestrator.ts:174`, never by `normalizePlacementRegistryTarget`. It is
  therefore **not an execution target and never enters job placement.**

So the clause is ambiguous between *an object that cannot exist* and *an object that is not an
execution target at all*. Neither reading yields a checkable acceptance condition. **Both are
stated here deliberately**, because resolving the ambiguity one way does not rescue the clause.

**Why HIGH and not CRITICAL.** Under `scripts/lib/finding-ownership.mjs`,
`CRITICAL` and `HIGH` are *identically* blocking (`SEVERITY_VOCABULARY`: both `blocking: true`;
both derived into `NOT_ACCEPTABLE`, so neither may ever be `accepted`), so the choice changes no
machine behaviour and no waiver right. It changes only the signal. This corpus has used
`CRITICAL` **zero** times across 149 findings — the measured distribution in that library's own
header is P1/HIGH/MEDIUM/LOW/MED/MINOR/P2/P0 — so minting the first one is a precedent, and the
direction of failure here is fail-closed: nothing mis-executes, an object simply cannot be
constructed. The wave's CRITICAL view is recorded above and is not being argued away; the
difference is a label, and both labels forbid acceptance.

**What would close it.** Either (i) the review's clause is withdrawn or rewritten against a
mechanism that exists (see the NOT-ADOPTED substitute in
`docs/replatform/epics/E11-hardening-release/decisions.md` → `E11-D01`), or (ii) a production
creator for a platform-scoped `kind = "e2b"` execution target ships **and** the org-binding
contradiction is resolved by a successor decision to `PLACEMENT_MATRIX`. Neither is owned by any
ticket on disk today, which is why this is `unowned` and not `owned`.

**Product plan (non-dispositional).** A founder-confirmed feature intended to relieve the product
need here is designed in `docs/replatform/design/per-tenant-managed-execution-and-devices.md` (see
its §5). That design neither amends this finding nor changes any gate; this finding stays `open` and
`unowned` until a founder/protocol decision closes it.

**Update 2026-09-11 — the E7-1-canary reachability half is unblocked (option (b)); this finding stays
`open`.** The E7-1 keyed-run canary no longer depends on the inexpressible platform/`managed_cloud`
target. Its production credential binding (`resolveCanaryCredentialBinding`,
`server/src/services/canary-credential-binding.ts`) now carries a well-known routing slug
`CANARY_EXECUTION_TARGET_SLUG` = `aoa-canary-e2b` (its three credential fields stay null), and
`chooseExecutionTargetRow` gained an arm that routes a non-subscription slug-bearing binding to
`active.find(t => t.kind === "dedicated_worker" && t.slug === slug) ?? null`
(`server/src/services/execution-target-resolver.ts`). An operator **can** create + ratify an
`organization_dedicated` (`dedicated_worker`) target at organization scope — links 4–7 above never
barred THAT, only the platform/`managed_cloud`/`e2b` shape — so a keyed run now yields a real
distributed, lease-eligible placement (`execution_owner="distributed"`) instead of
`placement_not_leasable` → legacy. The RUNBOOK's ★★★ blocker section is rewritten accordingly, and
`docs/replatform/RUNBOOK-e7-1-keyed-run.md` §7 gives the create/ratify/enroll steps.

This is option (b) of this finding's own "What would close it" (route the canary to a tenant-creatable
`organization_dedicated` target), applied to the E7-1 path. It does **not** close E11-F004: the
review's clause and Reading 1 (a `kind = "e2b"` / `managed_cloud` platform target) remain
structurally inexpressible (links 1–7 unchanged), option (a) is still unbuilt, and the `PLACEMENT_MATRIX`
org-binding contradiction is untouched. The arm is server-only, `dedicated_worker`-restricted, and
returns `null` on a miss (DE-29 preserved — no `owner_desktop` reachability, no `pooled_gvisor`
fall-through). No gate was flipped (the frozen `E7-1-coding-journey` gate still awaits a real keyed
`runId` + a separate prose PR). Follow-up **E11-F008** (per-org canary slug) is filed below.

## E11-F005 — nothing in the enrolment protocol identifies a machine, so "two distinct owner-desktop devices" is unverifiable from any surface, projected or not

**Status:** `open` · Severity: **HIGH** · Filed 2026-09-08 by W18 (provability wave, gate-naming unit).

**The surface.** `listDesktopDevices` (`server/src/services/execution-targets.ts:531-554`) is the
**only** surface in the tree that reports enrolled desktops: `grep -rn listDesktopDevices` returns
the definition, its single route (`server/src/routes/desktop-devices.ts:50`) and tests, and nothing
else joins `workers` to a `kind = "desktop"` execution target. It projects exactly **seven**
fields — `deviceId`, `targetSlug`, `label`, `status`, `deviceGeneration`, `enrolledAt`, `lastSeenAt`
— through the `projectDesktopDevice` allowlist. **None of the seven discriminates a machine from a
process.** `deviceThumbprint` is on the deliberate omission list
(`server/src/services/desktop-device-projection.ts:83`), reasoned there as *"derived from credential
material; not needed to answer any question this listing exists to answer."*

*(One neighbouring surface, checked so the "only" is not overstated: `listExecutionTargets`
(`execution-targets.ts:556-566`) returns the org's `execution_targets` rows, which can include a
`kind = "desktop"` row. It does not join `workers`, so it reports the TARGET, never an enrolment,
and cannot say whether zero or five devices enrolled against it.)*

**★ THE OMITTED FIELD WOULD NOT HAVE ANSWERED IT EITHER, AND THAT IS THE REAL FINDING.** It would
be easy to read this as a projection problem with a one-line fix. Measured, it is not:

- `deviceThumbprint` is `sha256(SPKI DER)` of a key minted **per keystore**, by `loadOrCreateKey`
  (`packages/worker-daemon/src/enrollment/enroll.ts:131-137`). Two daemon *processes* on one
  machine with two keystore paths mint two keys and present two distinct thumbprints. Two
  thumbprints therefore prove two **enrolments**, never two **machines**.
- The enrolment hello itself carries no machine-identifying fact. `workerHelloV1Schema`
  (`packages/worker-protocol/src/capabilities.ts:366-379`) is `.strict()` with exactly ten fields —
  `protocolVersion`, `workerId`, `targetId`, `deviceGeneration`, `agentVersion`,
  `supportedProtocol`, `platform`, `reportedCapabilities`, `capacity`, `policyHash` — and
  `platform` is `{os, arch, runtime}`. No hostname, no MAC, no machine GUID, no board or disk
  serial. `buildDesktopHello` (`packages/worker-daemon/src/enrollment/desktop-hello.ts:109-155`)
  takes **no clock, no random and no `process`** by design, so it could not probe one without
  breaking the replay-identity property that prevents double-mint.

So *device distinctness is not omitted from a projection; it is absent from the protocol.* A
release clause requiring "two **distinct devices**" has no evidence source anywhere in the system,
and widening the allowlist would not create one.

**★ AND IT IS ABOUT US, NOT ONLY ABOUT THE REVIEW — the desktop host shares ONE hello producer with
the container daemon.** Traced: `packages/worker-keystore/src/bin/desktop-host.ts:26,120` calls
`bootstrapWorkerDaemon` → `packages/worker-daemon/src/bin/worker-daemon.ts:215` → `enrollOnce`
(`:332`) → `buildDesktopHello` (`enrollment/enroll-once.ts:265`). The container daemon reaches the
same producer. **Therefore U1-PROVENANCE's result already covers the desktop**:
`docs/replatform/FINDING-daemon-provenance-is-not-row-observable.md` measured that every
enrolment-committed fact a real daemon writes is byte-reproducible by a test runner holding an
enrolment code; with one shared producer, a desktop host writes the same facts and inherits the
same verdict. That document's new §8 records the trace.

**Desktop is STRICTLY WEAKER than the container case**, in the direction that matters: there is no
installer package for anyone to have run, and CI actively guards that absence.
`scripts/check-desktop-surface-disabled.mjs` enforces DSK-00 clauses 6 and 7 — the distribution
doc must still say *"no desktop installer"* / *"docker + npm only"* (`REQUIRED_DOC_PHRASES`, `:41`),
and no route may serve a desktop package, update, manifest or installer (`:54-59`). So a desktop
"device" today is a process someone started from a source checkout, which is precisely the object
the seven projected fields cannot distinguish from any other process.

**Why this EXTENDS U1 rather than being a separate provenance finding.** The desktop claim is a
strict corollary of U1's own measured chain (one shared producer ⇒ identical committed rows ⇒
identical indistinguishability), and duplicating that premise in a second register is how two
copies drift apart — the failure this programme has filed repeatedly. So the *mechanism* is
recorded as a new section in U1's document, where its chain already lives, and the *release-gate
consequence* is recorded here, where the ownership guard can see it. U1's document is a top-level
`FINDING-*.md` with no register entry and no ownership declaration, so an extension there alone
would have been invisible to `check-finding-ownership`; this entry is the declared half.

**What would close it.** Either the acceptance clause stops asserting device distinctness (the
NOT-ADOPTED substitute in `E11-D01` replaces "devices" with *independently-keyed enrolments*,
which the system CAN evidence), or the enrolment protocol grows a machine-binding attestation —
a `WorkerHelloV1` field change against a FROZEN v1 schema, i.e. a protocol decision, not a ticket
line. No ticket on disk owns either, hence `unowned`.

**Product plan (non-dispositional).** A founder-confirmed feature intended to relieve the product
need here is designed in `docs/replatform/design/per-tenant-managed-execution-and-devices.md` (see
its §5 and §4.4). That design records device enrolments as a layer above the frozen protocol; it does
not add machine attestation, does not amend this finding, and changes no gate. This finding stays
`open` and `unowned` until a founder/protocol decision closes it.

**M2 shipped (2026-09-11, non-dispositional).** The design's M2 milestone landed (PR #435,
`e11-m2-verify-health`): read-time liveness health plus a read-only "Verify enrolment key" action
that re-derives `sha256(SPKI DER)` from the STORED public key and checks the stored thumbprint and
Ed25519 structure. Verify reads ENROLMENT-RECORD key integrity only — it explicitly does NOT prove a
device is live-right-now or a distinct physical machine, and its UI label and reason strings say so.
No protocol change, no migration, no new gate. **E11-F005 is NOT closed by M2**: the machine-binding
attestation this finding turns on (open question Q2) is still unbuilt, so this stays `open` and
`unowned`.

## E11-F006 — the D6-04 evidence contract has no device column, so two owner-desktop devices collapse into one matrix row

**Status:** `open` · Severity: **HIGH** · Filed 2026-09-08 by W18 (provability wave, gate-naming unit).

**Measured against the actual contract**, `docs/replatform/test-gates.md` D6-04, quoted verbatim:

> Each immutable row has a stable row ID and names Organization, workload, target class, provider,
> OS/version or `not_applicable`, credential-binding mode, locality mode, allowed fallback, and
> mobility mode.

That is the complete column list — **nine dimensions and no device**. Two owner-desktop devices
belonging to the same Organization, running the same workload on the same target class, provider,
OS/version, credential-binding mode, locality mode, fallback and mobility mode are therefore
**one row**, not two, and every quantity D6-04 attaches to a row (≥200 normal scheduled probes,
availability ≥99.5%, ≥3 deliberate fail-closed samples) is computed over that single row.

**Consequence for the proposed clause.** A release condition of the form "enroll two distinct
owner-desktop devices … jobs placed and executed across all three" cannot be *expressed* in the
frozen support matrix that D6-04 requires be committed before the canary starts. There is nowhere
to write the second device down, and D6-04's own closing sentence — *"aggregation across rows
cannot hide an untested or unreliable combination"* — is the rule that would be violated by
recording two devices as one row. This is independent of E11-F005: even if the system could prove
device distinctness, the evidence contract could not record it.

**Not a proposal to add a column.** Adding a tenth dimension to D6-04 changes what every advertised
row must carry and how many rows every partner must staff — a gate criteria change, which is a
founder decision. This entry records the gap only; no D6-04 text was edited by the unit that filed it.
The NOT-ADOPTED substitute in `E11-D01` avoids the gap by not claiming per-device coverage at all.

**What would close it.** A founder decision either (i) adding a device/enrolment dimension to D6-04
with its own probe and denial floors, or (ii) recording that per-device coverage is deliberately
out of the matrix's scope. Neither is owned by a ticket on disk, hence `unowned`.

**Product plan (non-dispositional).** A founder-confirmed feature intended to relieve the product
need here is designed in `docs/replatform/design/per-tenant-managed-execution-and-devices.md` (see
its §5 and §6). That design supplies the device inventory a future D6-04 dimension could reference but
writes no gate text and adds no column; it neither amends this finding nor changes any gate. This
finding stays `open` and `unowned` until a founder gate decision closes it.

## E11-F007 — cross-target handoff has no mechanism in either direction, and re-placement is declared out of scope in the source

**Status:** `open` · Severity: **HIGH** · Filed 2026-09-08 by W18 (provability wave, gate-naming unit).

The review's clause (i) asks for *desktop-to-cloud and cloud-to-desktop handoff*. **Both directions
were checked; neither exists.**

**The vocabulary is absent from the entire source tree.**
`grep -rni "fenced_restart\|mobility" --include=*.ts --include=*.tsx server/ packages/ ui/` returns
**zero** hits. D6-05 defines mobility as `disabled` or `fenced_restart`; neither token appears in
any TypeScript file, so there is no flag, no route, no state and no branch to exercise.

**Re-placement is refused in the source, in a comment on the line that would do it.**
`packages/db/src/repositories/tenant/job-control.ts:1375-1376`, on the retry-attempt insert:

> `// Copy the reaped attempt's immutable placement snapshot verbatim so N+1 is`
> `// dispatchable to the same target (re-placement is JOB-009, out of scope).`

The following 14 lines copy `placementTargetId`, `placementTargetClass`, `placementTargetScope`,
`placementTargetGeneration`, `placementProfileHash`, `placementProviderConstraintHash` and the rest
verbatim. So attempt N+1 is **pinned to the same target by construction** — the one place a job
could change targets is the place that deliberately does not.

*(Citation correction: the brief located this at `job-control.ts:1374`. Ten files match
`job-control*.ts`; the one carrying this comment is
`packages/db/src/repositories/tenant/job-control.ts`, at `:1375-1376`. Recorded so the next reader
does not grep the wrong file.)*

**`markRunHandedOffToDistributed` is not the forward direction, and there is no reverse one.**
`server/src/services/heartbeat.ts:6921-6946` marks a legacy `heartbeat_runs` row as handed off to a
distributed attempt (`buildHandoffRunPatch` + a `distributed_execution_handoff` lifecycle event).
That is **monolith → distributed control**, a CLI-006 canary seam — not a move between execution
targets, and it happens *before* any target is chosen. `grep -rni "handoff|handed_off|handedOff"`
over `server/src` and `packages/*/src`, excluding tests, returns no distributed → legacy inverse and
no target-to-target transfer of any kind; the other hits are the DAT-004 `DeviceLocalHandoff` secret
broker, task/scope context handoffs, and deployment-mode board-claim handoff — none of them job
mobility.

**What would close it.** MIG-004 (the conditional handoff ticket named by D6-05 and the E11 README)
shipping a real directed handoff, in at least the direction a gate advertises. Until then the only
honest D6-05 posture is `disabled` with negative evidence, which is what the gate already permits.
**MIG-004 has NO file on disk** — `find docs/replatform/epics -name "MIG-004*"` returns zero, so it
is not a `findTicketIds` ticket and declaring it as owner would red `owner_ticket_missing`. Hence
`unowned`. (MIG-001, also named by the E11 README as a desktop precondition, is likewise zero files.)

## E11-F008 — the canary execution-target slug is a single global constant, so every canary org must name its dedicated_worker target identically

**Status:** `open` · Severity: LOW · Filed 2026-09-11 by the E11-F004 canary org-routing unblock.

The E7-1 canary org-routing unblock (E11-F004 update, 2026-09-11) gave the production canary
credential binding a well-known routing slug so it resolves a tenant-creatable
`organization_dedicated` target. That slug is a **single module constant**:

- `CANARY_EXECUTION_TARGET_SLUG = "aoa-canary-e2b"` (`server/src/services/canary-credential-binding.ts`).
- The binding resolver (`resolveCanaryCredentialBinding`) takes **no inputs, no `db` handle and reads
  no config/env** — that no-inputs property is load-bearing for placement replay (the binding is
  hashed into the placement digest; a per-attempt-varying value would throw `placement_already_decided`)
  and is deliberately preserved. So the slug **cannot be per-organization today** without a broader
  change to how the binding is resolved.

**Consequence.** Every organization that runs an E7-1-style canary must create + ratify its
`dedicated_worker` execution target with **exactly** the slug `aoa-canary-e2b`. Two canary orgs
cannot use distinct target slugs, and a canary org that names its target anything else routes to
`null` (the arm is `dedicated_worker` + slug-exact) → `unmapped_execution_target` → legacy. This is
adequate for the first distributed proof (one operator, one org) but not for concurrent multi-org
canarying.

**What would close it.** A per-org canary slug or a per-org binding resolver that preserves the
replay-stability + no-side-effect properties (e.g. a slug derived deterministically from the
organization id, still constant across a run's attempts, still read from no mutable source). This is
a deliberate follow-up, not a regression: the single-slug design is the minimal change that unblocked
the E7-1 keyed run.

**Not `owned`.** No ticket on disk carries multi-org canary slugging. LOW may be `accepted` in
principle, but it is filed `open`/`unowned` so the multi-org limitation stays visible rather than
implicit. Resolve = a per-org slug/resolver ships (or a decision records single-slug canarying as
deliberate); then flip this Status + DELETE the `finding-ownership.json` key in the SAME commit.
