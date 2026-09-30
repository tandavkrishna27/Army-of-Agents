# Design: Per-tenant managed execution + device-fleet management

**Status:** DESIGN / PLAN (docs-only). No code, schema DDL, or gate text is changed by this document.
**Author:** design unit (managed-exec + devices).
**Base:** `docs/replatform-program` (measured at the tip of that branch).
**Relates to (non-dispositional):** `E11-F004`, `E11-F005`, `E11-F006` in
`docs/replatform/epics/E11-hardening-release/findings.md`. This document is the product plan those
findings will *later* be measured against; it does **not** amend them, does **not** change any
release gate, and does **not** by itself close any of them. Each stays `open` and `unowned` until a
founder/protocol decision closes it.

> **Scope guard.** This is a plan. Where a change would need a Drizzle migration, this document says
> *"`db:generate` migration required here"* and writes no DDL. The frozen `packages/worker-protocol`
> v1 schema is **not** touched by any milestone below; device management is designed as a layer
> *above* it (see section 4.4 and E11-F005).

---

## 1. The confirmed product direction

The founder has confirmed a real product feature: **per-tenant managed execution plus a
device-fleet management surface.** In the founder's words, reduced to design requirements:

- **R1 - Per-tenant managed execution, tenant key first.** The managed execution path always tries
  the tenant's **own** E2B key first and falls back to the **platform** key. The platform key lives
  in GitHub secrets (as today, reaching the server as an environment default). Same code path; the
  key is resolved per tenant.
- **R2 - Platform-enforced usage limits per tenant (when subscription lands).** Once subscription
  ships, the platform enforces usage limits / quota per tenant, throttling at the platform level.
  The key used for the run may still be the tenant's own key; the *limit* is the platform's.
- **R3 - Device management as a full Settings surface.** Register / connect / verify / health for
  devices, wherever a user logs in from: a **local desktop machine**, a **server the app is
  installed on**, or a **cloud sandbox**. For this milestone (M1), at minimum: **record and display
  connected devices**, and resolve the per-tenant key. Verify / health and cross-device placement
  come later.
- **R4 - Ownership down to the individual (owner scope), not only per-org.** Cross-owner placement
  should be possible.
- **R5 - Placement across available devices.** Run locally if invoked locally; from the cloud, pick
  whichever device has capacity. Config-driven, exposed in Settings.

This document designs to **R1-R5** and grounds every claim in symbols that exist in the tree today.

---

## 2. What already exists in the schema and code

The important finding of the grounding pass is that **most of the primitives already exist.** The
feature is largely *wiring and surfacing*, not new substrate. Inventory, by symbol:

### 2.1 Per-org / per-owner execution-target registry (fleet inventory)

- `packages/db/src/schema/execution_targets.ts` - the `execution_targets` table. `scope` is a
  text enum enforced by the `execution_targets_authority_scope_check` constraint with exactly three
  arms:
  - `platform` -> `organization_id IS NULL AND owner_user_id IS NULL AND target_authority_key = 'platform'`
  - `organization` -> `organization_id IS NOT NULL AND owner_user_id IS NULL AND target_authority_key = 'organization:' || organization_id`
  - `owner` -> `organization_id IS NOT NULL AND owner_user_id IS NOT NULL AND target_authority_key = 'owner:' || organization_id || ':' || owner_user_id`
  - `organizationId` is a nullable FK to `organizations.id` (`ON DELETE CASCADE`; NULL = system /
    shared). `ownerUserId` is `text` with FK `execution_targets_owner_user_fk` to `authUsers.id`
    (`ON DELETE RESTRICT`). Uniqueness is `execution_targets_org_slug_uq` on `(organizationId, slug)`
    NULLS NOT DISTINCT; the org lookup index is `execution_targets_org_idx`. `kind` is one of
    `pooled_gvisor | dedicated_worker | e2b | local_host | desktop`.
  - **This already gives R4:** ownership descends from org to the individual owner today. There is
    **no `companyId`** on this table (see the tenancy decision, section 4).
- `server/src/routes/execution-targets.ts` - the create/list/rotate/revoke routes. The org create
  handler computes `const scope = input.ownerUserId ? "owner" : "organization"` and hard-codes
  `organizationId: orgId`. Registration mints a rotatable worker token (hash persisted,
  plaintext returned once).
- `server/src/services/execution-targets.ts` - `ensureControlPlaneExecutionTarget` is the **only**
  platform-scoped writer and hard-codes `kind: "local_host"`;
  `ratifyTenantExecutionTargetPlacementProfile` attaches a validated placement profile and
  explicitly refuses `target.scope === "platform"`.
- `ui/src/api/execution-targets.ts` + `ui/src/components/settings/sections/EnvironmentsSection.tsx`
  - the existing UI exposes `list`, `rotateToken`, `revoke` only. There is **no create UI** and
    **no device listing UI**.

### 2.2 Per-company BYO key with platform fallback (the R1 primitive, already built)

- `packages/db/src/schema/runtime_provider_keys.ts` - `runtime_provider_keys` is **per-company**:
  `companyId` FK to `companies.id` (`ON DELETE CASCADE`), `provider`, `secretId` FK to
  `company_secrets.id`, `isDefault`, with the partial unique
  `runtime_provider_keys_default_uq` on `(companyId, provider) WHERE is_default`. This is the BYO-key
  primitive.
- `server/src/services/environment-runtime.ts` - `resolveRuntimeProviderConfig({ companyId,
  provider: "e2b", ... })` is the credential chokepoint. It resolves the company's BYO key via
  `runtimeProviderKeys.resolveCredential(...)`; on a `404` (the company has no BYO key) it returns
  the config **unchanged** so the operator env default (`E2B_API_KEY`) fires at acquire time; any
  other error (bad ref, inactive secret, decrypt failure) throws loudly.
  **This is exactly R1's "tenant key first, platform key fallback" - already implemented, but wired
  to the environment run path, not to the managed placement-target path.**
- `server/src/services/e2b-credential-authority-wiring.ts` - `deriveE2bKeyGeneration(db, companyId)`
  derives a per-company monotonic key generation from
  `runtime_provider_keys -> company_secret_versions`; returns `null` when the company runs on the
  operator env default (ungenerationed).
- `server/src/services/one-shot-sandbox-cli.ts` - the `cloud_auth` extraction path already does
  per-company work: `preflightOneShotCliSpend({ companyId })`, `resolveCompanyProviderCredential(db,
  companyId, ...)`, and `runtimeProviderKeyService(db)` inside an isolated E2B environment. This is a
  live precedent for "resolve the tenant key, run in a sandbox."

### 2.3 Desktop-device projection and org-scoped listing (the R3 read half, already built)

- `server/src/services/execution-targets.ts` - `listDesktopDevices(db, organizationId)` joins
  `workers` to `execution_targets` of `kind = "desktop"`, org-scoped, returning seven projected
  fields. A `null` org returns `[]` and does not scan.
- `server/src/services/desktop-device-projection.ts` - `DESKTOP_DEVICE_PROJECTION_KEYS`
  (`deviceId`, `targetSlug`, `label`, `status`, `deviceGeneration`, `enrolledAt`, `lastSeenAt`),
  `DELIBERATELY_OMITTED_COLUMNS` (an exhaustiveness allowlist; `deviceThumbprint` is reasoned onto
  the omit list), and `projectDesktopDevice` (field-by-field, never spread-and-delete).
- `server/src/routes/desktop-devices.ts` - `GET /organizations/:orgId/desktop-devices`, gated on
  `execution_target:manage`.
- `packages/db/src/schema/workers.ts` - the enrolment rows: `executionTargetId` (no FK at E2),
  `devicePublicKey`, `deviceThumbprint`, `deviceGeneration`, `label`, and a scope check for
  `platform | organization | owner`. This is the join partner `listDesktopDevices` reads.
- **Gap:** the read exists server-side; there is **no Settings UI** consuming it, and no API client
  for `desktop-devices` in `ui/src/api/`.

### 2.4 The company <-> target bridge (already exists)

- `packages/db/src/schema/environments.ts` - `environments.companyId` is NOT NULL (to
  `companies.id`), and `environments.executionTargetId` is an **optional** FK to
  `execution_targets.id` (`ON DELETE SET NULL`). So a **company-scoped** environment can already
  point at an **org/owner-scoped** execution target. This is the natural join that lets a
  per-company run reach an org/owner target.
- `packages/db/src/schema/provider_connections.ts` - `provider_connections` carries
  `organizationId` (nullable), `companyId` (nullable), **and** `ownerUserId`. This is an existing
  precedent that a provider linkage can be scoped at org, company, or owner grain in one table.

---

## 3. The gaps

| # | Gap | Where it is pinned today | Which requirement it blocks |
|---|-----|--------------------------|-----------------------------|
| G1 | A managed E2B **execution target** cannot be created at any tenant scope. `PLACEMENT_MATRIX.managed_cloud` pins `targetScope: "platform"` (`packages/worker-protocol/src/job.ts`), the profile refiner rejects a non-matching scope and requires a null org for `platform` (`packages/worker-protocol/src/capabilities.ts`), the create route mints only `owner`/`organization` scope (`server/src/routes/execution-targets.ts`), ratification refuses `platform` scope (`server/src/services/execution-targets.ts`), and the only platform-scoped writer hard-codes `kind: "local_host"`. | frozen `worker-protocol` v1 + server routes | R1 (as a target), E11-F004 |
| G2 | The managed **placement-target** path does not resolve a **per-tenant** E2B key. Per-company resolution (`resolveRuntimeProviderConfig`) is wired to the **environment** run path, not to `normalizePlacementRegistryTarget` in `server/src/services/execution-target-resolver.ts`. There is also no **platform usage-limit** seam on the managed path. | `execution-target-resolver.ts` / acquire path | R1, R2 |
| G3 | Device management is **not surfaced in Settings** (no API client, no component), and the enrolment protocol carries **no machine identity** - `workerHelloV1Schema` is `.strict()` with ten fields and no hostname / MAC / GUID / serial, and a per-keystore thumbprint proves an *enrolment*, not a *machine*. | `ui/` absence + frozen `worker-protocol` v1 | R3, E11-F005 |
| G4 | The **D6-04 evidence contract** (`docs/replatform/test-gates.md`) has nine dimensions and **no device column**, so two owner-desktop devices collapse into one matrix row. | gate text (founder-owned) | E11-F006 |
| G5 | There is **no cross-device placement config** exposed anywhere. `placementV1Schema` / target-requirements exist in `packages/worker-protocol/src/job.ts`, but nothing in Settings drives them, and cross-target mobility (`fenced_restart`) is absent from the tree entirely (E11-F007 territory - out of scope here). | `ui/` absence + placement wiring | R5 |

---

## 4. The org <-> company / owner tenancy decision

This is the crux the feature turns on, and the code answers it cleanly.

### 4.1 The tenancy model, as the FKs actually define it

- **`organizations` is the kernel / Phase-1 tenant and the subscription unit.**
  `packages/db/src/schema/organizations.ts` gives `organizations` a globally-unique `slug`
  (`organizations_slug_uq`), a `plan` column (`.default("beta")`), and a `concurrencyCap` P5
  governance dial. Plan and concurrency governance live **on the organization**.
- **`companies` is the AoA primary tenant and belongs to exactly one organization.**
  `packages/db/src/schema/companies.ts`: `companies.organizationId` is **NOT NULL** with an FK to
  `organizations.id` (`ON DELETE RESTRICT`; injected by migration `0188`, fail-closed by `0210`
  which dropped the fail-open sentinel default). So the cardinality is **N companies : 1
  organization**. Company-grain money lives here: `budgetMonthlyCents` / `spentMonthlyCents`.
  Membership is `company_memberships` (per CLAUDE.md, the AoA primary tenant).
- **BYO keys are per-company.** `runtime_provider_keys.companyId -> companies.id`
  (`packages/db/src/schema/runtime_provider_keys.ts`).
  - ★ **DECIDED 2026-09-11 (founder): BYO stays company-only; org- and agent-level BYO are DEFERRED
    as later follow-ups.** Company-level BYO is shipped and sufficient for now (the one-step "Add E2B
    key" flow, PR #436). There is **no** org-scoped or agent-scoped provider key today, and none is to
    be added speculatively. **When org-level BYO is eventually built, it MUST use a dedicated
    org-scoped secret store — NOT by reusing `company_secrets` under a designated owner company**,
    because `secretService.resolveSecretValue` hard-enforces `secret.companyId === companyId` as a
    company-isolation tenancy boundary, and the founder explicitly declined to weaken it for a
    convenience feature (grounded: no org-secret store exists today — every secret table is
    `companyId`-anchored). Resolution order if/when built: **company key -> org key -> platform
    fallback**. This is a deferral of scope, not a change to the R1 grain above.
- **Execution targets and devices are per-org, down to owner.**
  `execution_targets.organizationId` + `ownerUserId` (`packages/db/src/schema/execution_targets.ts`)
  - there is **no `companyId`** on the target or on `workers`.
- **The bridge already exists:** `environments.companyId` (NOT NULL) + optional
  `environments.executionTargetId` (`packages/db/src/schema/environments.ts`). A company-scoped
  environment references an org/owner target; the run therefore carries **both** a `companyId` and,
  through `companies.organizationId`, the org identity.

### 4.2 The decision

Anchor each concern at the grain the code already anchors it, and use the existing
`company -> organization` FK as the join:

| Concern | Grain | Anchored on | Why |
|---------|-------|-------------|-----|
| BYO provider key resolution (R1) | **company** | `runtime_provider_keys.companyId`; `resolveRuntimeProviderConfig(companyId)` | The primitive is per-company and already does tenant-first / platform-fallback. |
| Per-run spend preflight | **company** | `companies.budgetMonthlyCents`; `preflightOneShotCliSpend({ companyId })` | Company budget is where spend already accrues. |
| Subscription / platform usage limit (R2) | **organization** | `organizations.plan`, `organizations.concurrencyCap` | Plan and concurrency governance already live on the org; the subscription is the org's. |
| Device / execution-target ownership (R3, R4) | **org, down to owner** | `execution_targets.{organizationId, ownerUserId}`; `workers` | The registry already descends org -> owner and has no company grain. |
| Placement identity (R5) | **org / owner scope** | `PLACEMENT_MATRIX` target scope; `execution-target-resolver.ts` | The placement vocabulary is scoped platform/organization/owner, not by company. |

**Both "key + quota" concerns are per-tenant - they simply sit at two different tenant grains that
the code already distinguishes.** A single run resolves its key and spend at the company grain and
its target / device / subscription limit at the org grain, joined by `companies.organizationId`.

### 4.3 Where the code and the naive recommendation diverge - stated plainly

The brief's suggested anchoring was "key + quota per-company; device/target ownership down to owner;
placement identity via org/owner scope." Measured against code, that is **correct for the key**, and
**correct for device/target/placement**, but **quota splits**:

- The **spend budget** the naive phrasing implies is per-company (`companies.budgetMonthlyCents`) -
  true.
- The **subscription usage limit** R2 asks the *platform* to enforce is naturally the
  **organization's** (`organizations.plan` / `concurrencyCap`), because that is the billing tenant
  and the concurrency dial the kernel already reads. Enforcing a subscription limit at the company
  grain would let one org multiply its subscription by creating companies.

So the honest statement is: **key and per-run spend are per-company; the subscription/quota ceiling
is per-organization; device and placement identity are per-org down to owner.** The code supports
all three grains; the `company -> organization` FK is the join that keeps them coherent.

### 4.4 What this means for the frozen protocol (E11-F005)

Device *management* - registering, listing, labelling, health - is a control-plane concern and lives
**above** the frozen `packages/worker-protocol` v1 schema. **No milestone in this plan adds a
machine-identifying field to `workerHelloV1Schema`.** The protocol's inability to distinguish a
machine from a process (two keystores on one host mint two thumbprints; the `.strict()` hello carries
no hostname/MAC/GUID/serial) is a **separate protocol decision**, an N/N-1 compatibility event, not a
feature milestone. This feature can *record and display* the devices that enrol; it cannot, and this
plan does not pretend it can, *prove two enrolments are two physical machines*. That distinction is
carried forward as an open question (section 7) and remains E11-F005's to close.

---

## 5. How E11-F004 / F005 / F006 map onto this feature

Each finding names a real gap this feature's later milestones are meant to relieve. **None is amended
by this document, and none is closed by shipping M1.** The mapping is the plan of record for what
would eventually satisfy them; the *decision* to accept any such closure stays with the founder / gate
owner.

| Finding | The gap it measures | Which feature gap (section 3) | What in this plan addresses it | What it still needs (not owned here) |
|---------|---------------------|-------------------------------|--------------------------------|--------------------------------------|
| **E11-F004** (HIGH) | "one managed E2B execution target for one organization" is structurally inexpressible, and is ambiguous with the `environments` platform-default E2B, which is not a target. | G1 + G2 | The feature makes managed execution **per-tenant by resolving a per-company key with platform fallback on the managed path** (M1, section 6.2), which is the operative product need. It does **not** require an org-scoped `kind = "e2b"` target row. | Whether a per-tenant managed *target row* is wanted at all (vs. a per-tenant *key* on a platform-scoped target) is an open question (7.1). An actual org-scoped `kind = "e2b"` target would require a successor decision to `PLACEMENT_MATRIX` in the frozen protocol - deliberately out of scope. |
| **E11-F005** (HIGH) | Nothing in enrolment identifies a machine; "two distinct devices" has no evidence source; the omitted `deviceThumbprint` would not supply one. | G3 | The feature builds the **device-management surface** (record + display in Settings, M1) as a layer above the protocol, plus verify/health later (M2). | Machine-binding attestation is a **frozen-v1 protocol decision** (7.2). The Settings surface records enrolments, not machines; this feature does not manufacture the missing evidence. |
| **E11-F006** (HIGH) | The D6-04 support matrix has nine dimensions and no device column; two devices collapse into one row. | G4 | The feature supplies the **device inventory** a future D6-04 device dimension could reference (M1 read + M2 identity). | Adding a device/enrolment column to D6-04 - with its own probe and denial floors - is a **founder gate decision** (7.3). This feature writes no gate text. |

---

## 6. Milestone plan

### M1 - Record + connect devices, per-company key on managed execution, and a platform-limit seam

**Goal:** the smallest slice that is a real product increment and moves R1/R3 forward without
touching the frozen protocol or any gate.

**M1.1 - Device inventory in Settings (R3, read + connect).**
- Add a `desktop-devices` (rename-agnostic: "connected devices") API client in `ui/src/api/`
  consuming the existing `GET /organizations/:orgId/desktop-devices`
  (`server/src/routes/desktop-devices.ts`), plus the org-scoped `execution-targets` list already in
  `ui/src/api/execution-targets.ts`.
- Add a **Devices** section to Settings (sibling of `EnvironmentsSection.tsx`) that lists connected
  devices from the existing `listDesktopDevices` projection - the seven allowlisted fields only, no
  widening of `DESKTOP_DEVICE_PROJECTION_KEYS`.
- **"Connect"** in M1 means: display the three login contexts a device can present - a **local
  desktop machine**, a **server the app is installed on**, and a **cloud sandbox** - and show which
  execution target each maps to. It records what has enrolled; it does **not** re-enable the desktop
  installer (see the constraint below).
- No schema change: this consumes existing tables (`execution_targets`, `workers`). **No
  `db:generate` needed for M1.1.**

**M1.2 - Per-company key resolution on the managed execution path (R1).**
- Route the managed placement/acquire path through the **existing** `resolveRuntimeProviderConfig`
  chokepoint (`server/src/services/environment-runtime.ts`) so a managed run resolves the **company
  BYO key first, platform `E2B_API_KEY` fallback**, identical to the environment path today. The
  join is `run -> environment.companyId` (already present) and, where the run is target-driven,
  `environment.executionTargetId -> execution_targets`.
- Reuse `deriveE2bKeyGeneration(db, companyId)` for the generation stamp so old-key denial stays
  correct across rotation.
- **Crucially, M1.2 does not change the target's scope.** `managed_cloud` stays platform-scoped
  (`shared_isolated`) in the frozen matrix; per-tenant-ness is a **credential/broker** property,
  which the `managed_cloud` matrix row already admits (`credentials: [none, platform_brokered]`).
  This is the design's answer to E11-F004's practical half without a frozen-protocol change.
- **`db:generate` migration:** only if M1.2 chooses to persist a per-run key-generation stamp on an
  existing table; if it reuses `deriveE2bKeyGeneration` at resolve time, **no migration is needed.**
  The decision is recorded as open question 7.4.

**M1.3 - Platform usage-limit seam (R2, hook only, no enforcement).**
- Add a single **seam** at the managed-execution acquire path: a `checkTenantExecutionQuota({
  organizationId, companyId })` function that today returns "allow" unconditionally and is the one
  place a future subscription throttle will live. Co-locate it with the existing company-grain
  `preflightOneShotCliSpend` so the two preflights are visible together.
- The seam reads `organizations.plan` / `organizations.concurrencyCap` for its inputs but enforces
  nothing in M1. **No `db:generate` needed** (columns exist).

**M1 explicitly excludes:** any change to `workerHelloV1Schema` or `PLACEMENT_MATRIX`; any new
execution-target `kind`; any gate text; cross-device placement; device verify/health.

### M2 - Device verify + health (R3 completion)

> ★ **M2 shipped by PR #435 (`e11-m2-verify-health`)** — read-time computed liveness health
> (`classifyDeviceLiveness` in `server/src/services/device-liveness.ts`, mirroring
> SVC-003b's null-fail-open and strict-`>` boundary; deadline
> `DEVICE_LIVENESS_DEADLINE_MS_DEFAULT = 30 min`, a conservative multiple of the 15-min
> session TTL, overridable via `AOA_DEVICE_LIVENESS_DEADLINE_MS`) plus a read-only
> **enrolment-key verify** action (`verifyDeviceEnrolmentKey` in
> `server/src/services/device-verify.ts`, reusing the factored-out `deriveDeviceThumbprint`;
> route `POST /organizations/:orgId/desktop-devices/:deviceId/verify`). Verify re-derives
> `sha256(SPKI DER)` from the STORED key and checks it against the stored thumbprint and that
> the key is a valid Ed25519 SPKI — it describes the enrolment record's key integrity only.
> **No migration, no protocol change.** Machine attestation (E11-F005 / open question Q2)
> remains **open and NOT closed** — verify is explicitly not a machine attestation.

- **Verify:** re-verify a device's proof on demand using the existing
  `verifyDeviceProof` (`server/src/services/worker-device-proof.ts`), which re-derives
  `sha256(SPKI DER)` from the presented public key. Surface a verify action in the Devices section.
- **Health:** compute liveness from `workers.lastSeenAt` (and the enrolment `deviceGeneration`, to
  flag silent re-enrolment) against a configurable staleness deadline, reusing the liveness-deadline
  machinery already in the tree (SVC-003 terminalization by a clock).
- **May need `db:generate`** if a per-device health annotation is persisted rather than computed at
  read time; prefer computed (no migration). Still no protocol change - verify/health read enrolment
  facts, they do not add machine attestation.

### M3 - Cross-device placement config in Settings (R5)

- Expose placement policy in Settings driving the existing `placementV1Schema` /
  target-requirements vocabulary (`packages/worker-protocol/src/job.ts`): "run locally if invoked
  locally; from the cloud, pick a device with capacity."
- Config-driven target selection over the org's `execution_targets` (down to owner), honouring the
  closed `PLACEMENT_MATRIX` credential/locality rules already enforced by the resolver.
- **Out of scope even in M3:** cross-target *mobility* / handoff (`fenced_restart`). That vocabulary
  is absent from the entire source tree and is E11-F007's, not this feature's.
- **Likely `db:generate`** for a placement-policy config surface if it is persisted per org (a new
  column or small table). DDL authored by `db:generate` at build time, not here.

### M4 - Subscription quota enforcement (R2 completion)

- Turn the M1.3 seam into a real per-tenant throttle at the **platform level**, keyed to
  `organizations.plan` (and `concurrencyCap`). The key used for the run may still be the tenant's
  own; the *limit* is the platform's. Gated on subscription landing.
- **Likely `db:generate`** for durable per-tenant usage counters / windows (mirroring the existing
  `provider_quota_windows` pattern). No protocol change.

### Milestone dependency order

```
M1 (key + devices read + seam)  ->  M2 (verify/health)  ->  M3 (placement config)
                                 \
                                  ->  M4 (subscription enforcement, gated on subscription)
```

M4 depends only on the M1.3 seam and on subscription shipping; it does not depend on M2/M3.

---

## 7. Open questions for the founder

1. **E11-F004 - target row vs. per-tenant key.** M1 makes managed execution per-tenant by resolving
   a per-**company** key on a **platform-scoped** managed target (no frozen-protocol change). Is that
   the intended reading of "per-tenant managed execution target"? Or do you want an actual
   **org-scoped `kind = "e2b"` execution-target row**, which requires a successor decision to
   `PLACEMENT_MATRIX` in the frozen worker-protocol (an N/N-1 compatibility event)? The
   recommendation is the key-layer approach; the target-row approach is a larger, protocol-touching
   commitment.
2. **E11-F005 - machine attestation.** Recording enrolments (M1) does not prove two enrolments are
   two physical machines. Do you want to invest in a machine-binding attestation in the enrolment
   protocol (a frozen-v1 schema change), or is "independently-keyed enrolments" the property the
   product needs? This is the exact axis the NOT-ADOPTED `E11-D01` substitute turned on.
3. **E11-F006 - D6-04 device column.** Should the D6-04 support matrix grow a device/enrolment
   dimension with its own probe and denial floors (raising what every advertised row must carry and
   how many rows a partner staffs), or is per-device coverage deliberately out of the matrix's scope?
   This feature can supply the inventory either way, but the gate criteria are yours.
4. **Key-generation persistence (M1.2).** Resolve the per-tenant key generation at run time (no
   migration) or persist a per-run key-generation stamp (a `db:generate` migration)? Runtime
   resolution is simpler and reuses `deriveE2bKeyGeneration`; persistence gives an auditable stamp.
5. **Quota grain confirmation (R2).** Confirm the subscription/usage limit is enforced at the
   **organization** grain (billing tenant), with per-run **spend** staying at the **company** grain.
   The code points this way; the product intent should ratify it.
6. **Desktop installer.** M1 records devices without re-enabling the desktop installer, which
   `scripts/check-desktop-surface-disabled.mjs` still guards as absent (DSK-00 clauses 6/7). Does the
   device surface stay read-only over already-enrolled targets until a founder decision re-enables
   desktop distribution?

---

## 8. Non-goals (explicit)

- No change to `packages/worker-protocol` v1 (frozen). No `workerHelloV1Schema` field, no
  `PLACEMENT_MATRIX` edit.
- No new execution-target `kind`, no platform-scoped `kind = "e2b"` creator.
- No gate-text change (D6-04, DSK-00, D6-03, D6-05 untouched).
- No cross-target mobility / handoff (`fenced_restart`) - E11-F007.
- No amendment to E11-F004 / F005 / F006 or any register clause; only a one-line non-dispositional
  pointer to this document is added to each finding.
- No code, no migrations, no DDL authored in this change - this is a plan.
