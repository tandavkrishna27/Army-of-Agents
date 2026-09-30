import { createHash, randomUUID } from "node:crypto";

/**
 * MIG-008 (E10 desktop-migration) — legacy E2B lease/resource RECONCILER.
 *
 * A pre-cutover, ADDITIVE reconciliation pass over the LIVE-deployed
 * `environment_leases` model (PR#320). It inventories every lease row (all 5
 * types) + the platform-default `environments` resource and emits exactly ONE
 * append-only crosswalk record per resource — a MAPPING or a TERMINAL cleanup
 * record — into `legacy_resource_reconciliation`.
 *
 * The core safety invariant (MIG-008 Invariant #2): an ACTIVE/live legacy lease
 * (a sandbox a legacy `adapter.execute` is running in) is NEVER assigned a
 * synthesized distributed `ResourceLabels` fence — it gets a MAPPING record
 * that carries ONLY a partial-attribution HASH (a string), never a leasable
 * fence object, and is left for drain. No legacy row is ever routed into
 * `EffectAuthority` (the reconciler has no dependency on it — the invariant
 * holds structurally). Only genuinely terminal / no-live-handle rows get a
 * terminal cleanup record; `cleanupStatus='failed'` composes CLI-004's reconcile
 * as the terminal record (no duplicate cleanup path).
 *
 * ★ OPTION R (MIG-010 Unit 2.3) — THE PASS IS READ-ONLY. It once claimed paused rows
 * via the same `AND status='paused'` compare-and-swap the warm reaper uses
 * (`expireLeaseIfPaused`, paused -> expired + `cleanup_status='pending'`). That CAS is
 * gone, and its removal is a PRECONDITION for the pass running at all, not a
 * preference: the CAS is an UPDATE on `environment_leases`, and
 * `OPERATOR_SERVING_RELATIONS` (job-control-legacy-grants.ts:319-321) grants
 * `aoa_operator` NO write there — nor any read. The pass raised 42501 on its first
 * statement, so it could not have run with a caller either
 * (`mig-010-unit-2-3-pass.integration.test.ts`).
 *
 * Two consequences worth stating plainly rather than discovering later:
 *
 *  1. **A paused snapshot rides a different lifecycle now.** The CAS was not
 *     bookkeeping — it was a deliberate handoff INTO a running sweeper: `expired` +
 *     `cleanup_status='pending'` is exactly the predicate `listTerminalUncleanedLeases`
 *     selects on (warm-sandbox-reaper.ts:291). Left `paused`, the row is no longer in
 *     that terminal set; it is reclaimed by the warm reaper's own paused paths instead —
 *     the idle-TTL sweep over `listPausedLeasesOlderThan` and the superseded-key scan
 *     over `listPausedLeasesWithKeyGeneration` (:234). A real target, already wired, but
 *     a DIFFERENT latency.
 *  2. **It is not "CLI-004".** The `delegated_cli004` outcome below names the DISTRIBUTED
 *     orphan sweeper over labelled provider resources
 *     (packages/worker-daemon/src/supervisor/reconcile.ts), which never reads
 *     `environment_leases`. It is not a promise to tear down a legacy lease row.
 *
 * The invariant gets STRONGER, not weaker: the pass no longer asserts terminality on a
 * row that might resume, and no longer destroys warm snapshots as a side effect of being
 * consulted.
 *
 * This module is deliberately DB-internals-free: it exposes pure classification +
 * record-building + closure helpers and a reconciler pass that drives an injected
 * {@link LegacyReconciliationStore} seam (drizzle wiring lives with the caller).
 */

export const LEGACY_RESOURCE_TYPES = [
  "ephemeral",
  "warm_org",
  "warm_commander",
  "workspace_ref",
  "platform_default_env",
] as const;
export type LegacyResourceType = (typeof LEGACY_RESOURCE_TYPES)[number];

export const RECONCILIATION_DISPOSITIONS = [
  "mapped",
  "terminal_cleanup",
  "unattributable",
] as const;
export type ReconciliationDisposition = (typeof RECONCILIATION_DISPOSITIONS)[number];

export interface LegacyLeaseInput {
  readonly id: string;
  readonly companyId: string;
  readonly environmentId: string | null;
  readonly status: string;
  readonly leasePolicy: string;
  readonly provider: string | null;
  readonly providerLeaseId: string | null;
  readonly agentId: string | null;
  readonly commanderConversationId: string | null;
  readonly executionWorkspaceId: string | null;
  readonly issueId: string | null;
  readonly heartbeatRunId: string | null;
  readonly cleanupStatus: string | null;
}

export interface LeaseClassification {
  /** null resourceType ⇒ the owner shape is unclassifiable (unattributable). */
  readonly resourceType: LegacyResourceType | null;
  readonly disposition: ReconciliationDisposition;
  readonly hasLiveHandle: boolean;
  // `requiresPausedClaim` lived here. Option R removed the only arm that set it true, and
  // a field nothing can set is a field nothing reads — the zero-caller shape this unit
  // exists to close. Removed rather than left pinned to false.
  readonly cleanupOutcome: string | null;
  readonly reason: string;
}

/** A crosswalk record shape (append-only). NEVER carries a fence or key material. */
export interface ReconciliationRecord {
  readonly companyId: string;
  readonly environmentLeaseId: string | null;
  readonly environmentId: string | null;
  readonly resourceKey: string;
  // A resolved 5-type value, or "unattributable" when the owner shape is unclassifiable.
  readonly resourceType: LegacyResourceType | "unattributable";
  readonly legacyStatus: string | null;
  readonly provider: string | null;
  readonly providerLeaseId: string | null;
  readonly disposition: ReconciliationDisposition;
  readonly resourceLabelsHash: string | null;
  readonly keyGeneration: string | null;
  readonly cleanupOutcome: string | null;
  readonly reason: string;
}

const TERMINAL_STATUSES = new Set(["released", "expired", "failed", "retained"]);

/** Determine the resource TYPE from lease policy + owner FKs (5-type model). */
function resolveResourceType(lease: LegacyLeaseInput): LegacyResourceType | null {
  if (lease.leasePolicy === "ephemeral") return "ephemeral";
  if (lease.commanderConversationId) return "warm_commander";
  if (lease.agentId) return "warm_org";
  if (lease.executionWorkspaceId) return "workspace_ref";
  return null;
}

/**
 * Pure classification of one legacy lease into a type + disposition. NEVER
 * synthesizes a fence: a live active row is `mapped` (drain, hash-only); a PAUSED row
 * is likewise `mapped` since Option R (it still holds a live provider handle and may
 * resume, so the pass observes it rather than asserting it terminal); terminal /
 * no-handle rows are `terminal_cleanup`; an unclassifiable owner shape is
 * `unattributable` (surfaced, never dropped).
 */
export function classifyLease(lease: LegacyLeaseInput): LeaseClassification {
  const resourceType = resolveResourceType(lease);
  const hasLiveHandle =
    (lease.status === "active" || lease.status === "paused") &&
    typeof lease.providerLeaseId === "string" &&
    lease.providerLeaseId.length > 0;

  if (resourceType === null) {
    return {
      resourceType: null,
      disposition: "unattributable",
      hasLiveHandle,
      cleanupOutcome: null,
      reason: "unclassifiable owner shape — surfaced for manual attribution (never dropped)",
    };
  }

  const failedCleanup = lease.cleanupStatus === "failed";

  if (lease.status === "active" && hasLiveHandle) {
    // Live legacy execution — left for drain. Mapping record carries ONLY a
    // partial-attribution hash; NEVER a synthesized live fence (Invariant #2).
    return {
      resourceType,
      disposition: "mapped",
      hasLiveHandle: true,
      cleanupOutcome: null,
      reason: "active legacy execution — left for drain, no fence synthesized",
    };
  }

  if (lease.status === "paused") {
    // ★ OPTION R (MIG-010 Unit 2.3). A held warm snapshot is now `mapped` — recorded with
    // an attribution hash and LEFT ALONE — where it was once `terminal_cleanup` behind a
    // status='paused' CAS claim. The CAS was an UPDATE on `environment_leases`, which
    // `aoa_operator` cannot perform, so keeping it meant the pass could not run at all.
    //
    // EVERY paused row takes this arm, including one whose `provider_lease_id` is null:
    // `hasLiveHandle` is reported as computed rather than asserted true. That is deliberate
    // — a paused row is resumable by definition, and the pass's job here is to OBSERVE it,
    // not to adjudicate whether its handle is still good. Closure reads only `resourceKey`
    // and `disposition`, so this cannot change a verdict; what it changes is that the pass
    // never asserts terminality on a row that might come back.
    //
    // WHAT THIS CHANGES, SAID OUT LOUD: the pass no longer flips the row to
    // `expired` + `cleanup_status='pending'`, which is the predicate
    // `listTerminalUncleanedLeases` selects on (warm-sandbox-reaper.ts:291). So the
    // snapshot is no longer swept as terminal; it is reclaimed by the warm reaper's
    // PAUSED paths instead — idle-TTL (`listPausedLeasesOlderThan`) and the
    // superseded-key scan (`listPausedLeasesWithKeyGeneration`, :234). Both are real and
    // already wired; the latency differs. This is NOT handed to "CLI-004", which is the
    // distributed orphan sweeper over labelled provider resources and never reads
    // `environment_leases`.
    //
    // `legacyStatus` keeps the OBSERVED status ('paused') so the record still says what
    // was seen and cannot be mistaken for an active row; the distinction rides `reason`.
    return {
      resourceType,
      disposition: "mapped",
      hasLiveHandle,
      cleanupOutcome: null,
      reason: failedCleanup
        ? "paused warm snapshot with a failed prior cleanup — observed, left for the warm reaper's paused paths, no fence synthesized"
        : "paused warm snapshot — observed, left for the warm reaper's paused paths, no fence synthesized",
    };
  }

  // Terminal status OR no live handle. Any row reaching here has hasLiveHandle=false
  // (active+handle returns above; paused returns above), so the only non-failed outcome
  // is `no_handle` (the earlier `already_terminal` arm was dead — removed).
  const cleanupOutcome = failedCleanup ? "delegated_cli004" : "no_handle";
  return {
    resourceType,
    disposition: "terminal_cleanup",
    hasLiveHandle,
    cleanupOutcome,
    reason: failedCleanup
      ? "failed cleanup — terminal via CLI-004 reconcile composition"
      : TERMINAL_STATUSES.has(lease.status)
        ? "terminal lease — terminal cleanup record"
        : "no live provider handle — terminal cleanup record",
  };
}

/**
 * Deterministic partial-attribution HASH of a lease's owner FKs. This is the ONLY
 * distributed-attribution artifact a mapping record carries — never a leasable
 * `ResourceLabels` fence object (Invariant #2). No key material participates.
 */
export function computeResourceLabelsHash(lease: LegacyLeaseInput): string {
  const canonical = JSON.stringify([
    lease.companyId,
    lease.environmentId,
    lease.agentId,
    lease.commanderConversationId,
    lease.executionWorkspaceId,
    lease.provider,
    lease.providerLeaseId,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

export function resourceKeyForLease(leaseId: string): string {
  return leaseId;
}

export function resourceKeyForPlatformDefaultEnv(environmentId: string): string {
  return `platform-default-env:${environmentId}`;
}

/** Build the append-only crosswalk record for a classified lease. */
export function buildLeaseRecord(
  lease: LegacyLeaseInput,
  classification: LeaseClassification,
  opts: { keyGeneration: string | null },
): ReconciliationRecord {
  // A mapping record carries the attribution hash; a terminal/unattributable
  // record does not need it (no live handle to attribute).
  const resourceLabelsHash =
    classification.disposition === "mapped" ? computeResourceLabelsHash(lease) : null;
  return {
    companyId: lease.companyId,
    environmentLeaseId: lease.id,
    environmentId: lease.environmentId,
    resourceKey: resourceKeyForLease(lease.id),
    // A null resourceType only reaches here for an `unattributable` disposition —
    // record the honest "unattributable" sentinel (never a misleading real bucket).
    resourceType: classification.resourceType ?? "unattributable",
    legacyStatus: lease.status,
    provider: lease.provider,
    providerLeaseId: lease.providerLeaseId,
    disposition: classification.disposition,
    resourceLabelsHash,
    keyGeneration: opts.keyGeneration,
    cleanupOutcome: classification.cleanupOutcome,
    reason: classification.reason,
  };
}

/** Build the append-only record for the platform-default env resource. */
export function buildPlatformDefaultEnvRecord(input: {
  companyId: string;
  environmentId: string;
  keyGeneration: string | null;
}): ReconciliationRecord {
  return {
    companyId: input.companyId,
    environmentLeaseId: null,
    environmentId: input.environmentId,
    resourceKey: resourceKeyForPlatformDefaultEnv(input.environmentId),
    resourceType: "platform_default_env",
    legacyStatus: null,
    provider: "e2b",
    providerLeaseId: null,
    disposition: "mapped",
    // No live handle to attribute; the operator key is NEVER stored (parity with
    // platform-default-environment.ts, which keeps E2B_API_KEY out of the row).
    resourceLabelsHash: null,
    keyGeneration: input.keyGeneration,
    cleanupOutcome: null,
    reason: "platform-default environment resource — accounted, operator key never persisted",
  };
}

// --- closure gate ------------------------------------------------------------

export interface ClosureResult {
  readonly ok: boolean;
  readonly unmapped: readonly string[];
  readonly unattributable: readonly string[];
  readonly duplicates: readonly string[];
}

/**
 * Assert every inventoried resource has EXACTLY one crosswalk record and surface
 * any `unattributable` disposition. `ok` is false if any resource is unmapped,
 * duplicated, or unattributable (none is ever silently tolerated).
 */
export function assertClosure(input: {
  inventoryKeys: readonly string[];
  records: readonly { resourceKey: string; disposition: string }[];
}): ClosureResult {
  const countByKey = new Map<string, number>();
  const unattributableSet = new Set<string>();
  for (const record of input.records) {
    countByKey.set(record.resourceKey, (countByKey.get(record.resourceKey) ?? 0) + 1);
    if (record.disposition === "unattributable") unattributableSet.add(record.resourceKey);
  }
  const unmapped: string[] = [];
  for (const key of input.inventoryKeys) {
    if (!countByKey.has(key)) unmapped.push(key);
  }
  const duplicates: string[] = [];
  for (const [key, count] of countByKey) {
    if (count > 1) duplicates.push(key);
  }
  const unattributable = [...unattributableSet];
  return {
    ok: unmapped.length === 0 && duplicates.length === 0 && unattributable.length === 0,
    unmapped,
    unattributable,
    duplicates,
  };
}

// --- the completed-pass marker (MIG-010 Unit 2.4) ----------------------------

/**
 * ★★★ THE SENTINEL THAT MAKES A NULL UNREPRESENTABLE ON THE MARKER.
 *
 * A company's key generation is `<secretId>:<version>` (`formatKeyGeneration`) or NULL --
 * NULL being a perfectly normal value for a company with no default e2b
 * `runtime_provider_keys` row. Design §13 measured what that NULL does to the comparison the
 * gate makes: with SQL `<>` a NULL marker escapes the filter entirely, and the shipped gate's
 * own `keyGeneration !== null && ...` guard already treats a NULL RECORD as "not superseded"
 * (filed as E7-F005).
 *
 * On the marker the NULL is replaced by this sentinel, so the column is `NOT NULL` and the
 * hole is unrepresentable rather than merely avoided. It cannot collide with a real
 * generation, which always contains a colon after a uuid.
 *
 * ★ Belt AND braces: every comparison against it still uses `IS DISTINCT FROM` semantics
 * (Unit 2.4b), so a future nullable input cannot silently re-open the hole.
 */
export const UNGENERATIONED_KEY_GENERATION = "ungenerationed";

/** Fold a possibly-absent key generation onto the marker's NOT NULL column. */
export function markerKeyGeneration(keyGeneration: string | null): string {
  return keyGeneration ?? UNGENERATIONED_KEY_GENERATION;
}

/**
 * What the pass durably records for ONE company once it has finished that company.
 *
 * The columns are derived from §11.4's sentence -- *"latest marker" only means "latest
 * COMPLETED pass" if the marker records completion, scope and identity* -- not from
 * convenience. `completedAt` is deliberately ABSENT here: the store stamps it from the
 * DATABASE clock, because §11.4 also records that comparing a marker against a JavaScript
 * `Date` reintroduces the two-clock bug §3.3 exists to close.
 */
export interface ReconciliationPassMarker {
  /** IDENTITY: one value per pass INVOCATION, shared by every company marker it writes. */
  readonly passId: string;
  /** SCOPE: the organization the pass ran for. */
  readonly organizationId: string;
  /** SCOPE: the company this marker completes. */
  readonly companyId: string;
  /**
   * THE WATERMARK. Read from the DATABASE clock BEFORE the pass listed anything, so every
   * lease inside it (`created_at <= snapshotAt`) is a lease any later listing must have
   * seen. A lease whose transaction opened before this instant and committed after it stays
   * IN scope and may lack a record -- the gate then refuses, which is the fail-CLOSED
   * direction (measured in mig-010-unit-2-4-probes.integration.test.ts).
   */
  readonly snapshotAt: Date;
  /** NEVER null -- {@link markerKeyGeneration} folds an absent generation onto the sentinel. */
  readonly keyGeneration: string;
}

// --- reconciler pass ---------------------------------------------------------

/**
 * ★ EVERY MEMBER IS `(organizationId, companyId)` SINCE MIG-010 UNIT 2.3, matching
 * `CanaryPreflightStore`'s shape. That is not cosmetic symmetry: the owner-owned
 * SECURITY DEFINER functions these reads go through (`0267`, `0268`) are ALL
 * organization-bound, and `0267` ships an org->companies lookup and NO company->org
 * reverse. A company-scoped pass therefore structurally cannot call any of them
 * (design §4.2, F1).
 */
export interface LegacyReconciliationStore {
  /** Every Company under the Organization — the enumeration the pass now folds over. */
  listOrganizationCompanyIds(organizationId: string): Promise<readonly string[]>;
  /** All `environment_leases` rows for the company (owner-served). */
  listLeases(organizationId: string, companyId: string): Promise<readonly LegacyLeaseInput[]>;
  /** The materialized platform-default env row id, or null when none exists. */
  platformDefaultEnv(
    organizationId: string,
    companyId: string,
  ): Promise<{ environmentId: string } | null>;
  /** The current per-company key generation (D3 attribution tag), or null. */
  currentKeyGeneration(organizationId: string, companyId: string): Promise<string | null>;
  // `casClaimPaused` lived here. Option R removed it: it was an UPDATE on
  // `environment_leases`, which `aoa_operator` holds no write grant on, so the pass could
  // not run while it existed. The only remaining WRITE this store performs is the
  // append-only crosswalk insert below, on the one relation the operator role is granted.
  /** Append-only insert; false when a record for that resourceKey already exists. */
  insertRecordIfAbsent(record: ReconciliationRecord): Promise<boolean>;
  /**
   * MIG-010 Unit 2.4 — the DATABASE's clock, read once at the start of a pass and carried
   * into every marker it writes. It is a store member rather than `new Date()` because the
   * watermark is compared against `environment_leases.created_at`, which is a database
   * value: an application-clock snapshot would make that a cross-clock comparison (§3.3).
   */
  readSnapshotInstant(): Promise<Date>;
  /**
   * MIG-010 Unit 2.4 — record that the pass COMPLETED for one company. This is the pass's
   * LAST write for that company: nothing may observe a completed marker for a company whose
   * records are not all on disk, so a crash between the records and this call leaves
   * "records, no marker", which the gate reads as NOT reconciled and a re-run completes.
   */
  recordCompletedPass(marker: ReconciliationPassMarker): Promise<void>;
}

export interface ReconcileResult {
  readonly closure: ClosureResult;
  readonly insertedKeys: readonly string[];
  // `skippedResumed` lived here. There is no lost CAS any more, so there is no unrecorded
  // row — which also closes E-3's second asymmetry (design §1.2(2)) by construction rather
  // than by a fix: every lease the pass sees now gets a record.
  readonly unattributableKeys: readonly string[];
  /**
   * MIG-010 Unit 2.4 — the provider-control generation this company's records were tagged
   * with, surfaced so the org-level pass can write it onto the company's MARKER. Design §12:
   * the generation belongs to the marker, because the crosswalk is append-only
   * (`onConflictDoNothing`) and a re-run therefore cannot re-tag an existing record — so a
   * key rotation at ANY distance after a clean pass would otherwise brick the company
   * permanently. Null here means "this company has no current generation"; the marker folds
   * that onto the `'ungenerationed'` sentinel.
   */
  readonly keyGeneration: string | null;
}

/** The org-wide result: one per-company outcome, plus the folded totals. */
export interface OrganizationReconcileResult {
  readonly organizationId: string;
  /** Per-company, in enumeration order. The unit of CLOSURE is still the company. */
  readonly companies: readonly (ReconcileResult & { readonly companyId: string })[];
  /** True only when EVERY company closed — the same bar `canary-preflight.ts` applies. */
  readonly ok: boolean;
  readonly insertedKeys: readonly string[];
  readonly unattributableKeys: readonly string[];
  /** MIG-010 Unit 2.4 — the identity every marker this invocation wrote carries. */
  readonly passId: string;
  /** MIG-010 Unit 2.4 — the DB-clock instant every marker this invocation wrote carries. */
  readonly snapshotAt: Date;
}

/**
 * Reconcile one company's legacy E2B leases + platform-default env resource into
 * the append-only crosswalk. Idempotent (append-only insert-if-absent).
 *
 * READ-ONLY against tenant data since Option R: the only write is the crosswalk insert.
 * A paused row is observed and recorded, never claimed.
 *
 * ★ NO LONGER THE ENTRY POINT (MIG-010 Unit 2.3). It stays the unit of CLOSURE — closure
 * is a per-company property and `canary-preflight.ts` refuses per company — but the pass
 * is driven org-wide by `reconcileOrganizationLegacyResources` below. Exported for the
 * unit tests that pin its per-company semantics; production calls the org function.
 */
export async function reconcileCompanyLegacyResources(
  organizationId: string,
  companyId: string,
  deps: { store: LegacyReconciliationStore },
): Promise<ReconcileResult> {
  const { store } = deps;
  const [leases, platformDefault, keyGeneration] = await Promise.all([
    store.listLeases(organizationId, companyId),
    store.platformDefaultEnv(organizationId, companyId),
    store.currentKeyGeneration(organizationId, companyId),
  ]);

  const inventoryKeys: string[] = [];
  const records: ReconciliationRecord[] = [];
  const insertedKeys: string[] = [];

  for (const lease of leases) {
    const classification = classifyLease(lease);
    // Option R: no CAS, no `continue`. EVERY lease read is inventoried and recorded, so
    // the pass's inventory can no longer differ from the gate's by a lost race.
    inventoryKeys.push(resourceKeyForLease(lease.id));
    const record = buildLeaseRecord(lease, classification, { keyGeneration });
    records.push(record);
    if (await store.insertRecordIfAbsent(record)) insertedKeys.push(record.resourceKey);
  }

  if (platformDefault) {
    const record = buildPlatformDefaultEnvRecord({
      companyId,
      environmentId: platformDefault.environmentId,
      keyGeneration,
    });
    inventoryKeys.push(record.resourceKey);
    records.push(record);
    if (await store.insertRecordIfAbsent(record)) insertedKeys.push(record.resourceKey);
  }

  const closure = assertClosure({ inventoryKeys, records });
  return {
    closure,
    insertedKeys,
    unattributableKeys: closure.unattributable,
    // Read ONCE per company above and threaded into every record for that company
    // (verified against :410-414 before relying on it), so there is exactly one value to
    // report and the marker cannot disagree with the records it accompanies.
    keyGeneration,
  };
}

/**
 * ★ THE PRODUCTION ENTRY POINT (MIG-010 Unit 2.3, E10-F002). Reconcile EVERY Company under
 * one Organization.
 *
 * WHY ORG-SCOPED, given closure is a per-company property. Every read the pass makes now
 * goes through an owner-owned SECURITY DEFINER function, and every one of those — `0267`'s
 * three and `0268`'s one — is ORGANIZATION-BOUND. `0267` ships org->companies and no
 * company->org reverse, so a company-scoped pass holds no `organizationId` and structurally
 * cannot call any of them (design §4.2, F1). Minting a reverse lookup whose only caller
 * would be this pass is strictly worse than moving the scope: org-scope matches the gate's
 * own scope (`canary-preflight.ts:21-26`) and the operator's framing — "reconcile this org
 * before flipping it".
 *
 * Sequential by Company on purpose. The reads are owner-authority definer calls on a single
 * operator pool; fanning them out buys nothing an operator pass needs and makes a partial
 * failure harder to attribute.
 *
 * `ok` is the same bar the gate applies: EVERY Company must close. A single unmapped or
 * unattributable resource anywhere under the Organization leaves it false. The pass does not
 * short-circuit on the first failure — an operator wants the whole picture, not the first
 * company alphabetically.
 */
export async function reconcileOrganizationLegacyResources(
  organizationId: string,
  deps: { store: LegacyReconciliationStore },
): Promise<OrganizationReconcileResult> {
  const { store } = deps;

  // ★ THE SNAPSHOT INSTANT IS READ FIRST, AND ONCE, FROM THE DATABASE.
  //
  // Before any listing, deliberately. Every lease inside the watermark
  // (`created_at <= snapshotAt`) is then a lease that any listing performed AFTERWARDS must
  // already have been able to see, so the pass records it. Reading the instant after listing
  // would invert that: a lease created in between would fall inside the gate's narrowed
  // inventory with no record, and the gate would refuse a company that was in fact reconciled.
  //
  // Once, not per company: a per-company instant would be later for companies enumerated
  // later, which is the same inversion at a smaller scale.
  //
  // From the DATABASE, not `new Date()`: probe 5 established that `now()` is transaction
  // start, and that a lease whose transaction began before this instant but commits after it
  // still carries `created_at <= snapshotAt` — it stays IN scope and the gate demands a record
  // for it. That is the fail-CLOSED direction; an application clock running fast would push
  // such leases OUT of scope, which is the fail-open.
  const snapshotAt = await store.readSnapshotInstant();
  // IDENTITY (§11.4). One value for the whole invocation, so every company marker this pass
  // writes is attributable to the same run rather than inferred from adjacent timestamps.
  const passId = randomUUID();

  const companyIds = await store.listOrganizationCompanyIds(organizationId);

  const companies: (ReconcileResult & { companyId: string })[] = [];
  for (const companyId of companyIds) {
    const result = await reconcileCompanyLegacyResources(organizationId, companyId, { store });
    // ★ THE MARKER IS THE PASS'S LAST WRITE FOR THIS COMPANY, and it is written whatever the
    // closure VERDICT was. Those are different facts: the marker says "a pass ran to
    // completion here, at this instant, under this authority", and closure is a property the
    // gate re-derives for itself. Withholding the marker from an unclosed company would make
    // the gate answer `reconciliation_stale` for a company whose real problem is an unmapped
    // resource — replacing an accurate refusal with a misleading one (§9.3).
    //
    // An EXCEPTION mid-company skips this line, leaving "records, no marker": the gate reads
    // that as not reconciled, which is the fail-closed direction, and a re-run completes it.
    await store.recordCompletedPass({
      passId,
      organizationId,
      companyId,
      snapshotAt,
      // §12: the generation belongs HERE, not to each record. A rotation after a clean pass
      // then makes the MARKER stale — recoverable by re-running, which writes a new marker —
      // instead of permanently bricking the company, which is what per-record comparison does
      // against an append-only crosswalk that cannot re-tag.
      keyGeneration: markerKeyGeneration(result.keyGeneration),
    });
    companies.push({ ...result, companyId });
  }

  return {
    organizationId,
    passId,
    snapshotAt,
    companies,
    // An Organization with NO companies is not closed. It is the `no_companies` refusal the
    // gate already makes (`canary-preflight.ts:131-137`), and answering `ok: true` here for
    // an empty enumeration would be the vacuous-closure fail-open in a second place.
    ok: companies.length > 0 && companies.every((company) => company.closure.ok),
    insertedKeys: companies.flatMap((company) => company.insertedKeys),
    unattributableKeys: companies.flatMap((company) => company.unattributableKeys),
  };
}
