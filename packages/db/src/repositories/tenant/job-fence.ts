// packages/db/src/repositories/tenant/job-fence.ts
//
// JOB-004 — the ONE common active-fence predicate + the CLOSED enumerated set of
// governed job-control mutators that MUST gate on it.
//
// Every governed worker-authenticated mutation on the distributed-execution path
// (event acceptance, ordinary artifact metadata/commit authorization, secret-handle
// read, attempt/job terminal completion, service-instance health, projection-receipt
// apply, control-command ACK) may proceed ONLY while the presenting worker still
// holds the ACTIVE lease fence. A lease that has been superseded (replaced fence,
// bumped generation), expired against fresh database time, revoked, or whose attempt
// reached a terminal state MUST NOT be able to mutate any governed surface.
//
// This module owns the shared vocabulary — the predicate `isActiveFence`, the fence
// identity shape, the terminal-status set, the guarded-mutator name list, and the
// typed `JobFenceError`. The repository (`job-control.ts`) builds a `tx`-bound guard
// (`guardActiveFence`) around this predicate that EVERY guarded mutator invokes
// before touching a row; `server/src/services/job-fencing.ts` re-exports the
// predicate + surface so server-side callers share the exact same seam. The static
// contract test (`job-fence-surface.contract.test.ts`) fails closed if a future
// ticket adds a governed mutator without the guard.
//
// Runtime storage for the not-yet-built surfaces (events, projection receipts,
// control commands) is filled by JOB-005/006/011 BEHIND this already-guarded
// interface; JOB-004 lands only the predicate, the closed interface, and the
// negative contract.

/**
 * The CLOSED, enumerated set of governed job-control mutators. Every name here is
 * a method on the tenant `JobControlRepository` that MUST call the common
 * active-fence guard before mutating (or reading) a governed surface. Adding a new
 * governed mutator requires appending it here AND wiring the guard — the static
 * surface contract test enforces both.
 */
export const GUARDED_JOB_MUTATORS = [
  "acceptEvent",
  "authorizeArtifactCommit",
  // DAT-009 slice 2 — the grant-INTENT write at upload-grant mint. Fence-guarded so the
  // mutator is safe for any caller, not only the mint (which already holds the lock).
  "recordArtifactGrantIntent",
  // DAT-002 — the fenced verified-commit of a rich artifact manifest (fence-first,
  // then verify hash/size/prefix/tenant, then idempotent committed insert).
  "commitArtifactVersion",
  // DAT-003 — the fenced apply/review of a committed workspace_patch (fence-first,
  // then base revalidation → advance the accepted base (applied) OR conflict
  // quarantine; NEVER auto-applies a mismatched base; idempotent).
  "recordPatchApplyState",
  "readSecretHandle",
  // DAT-004 — the fenced, lease-scoped resolve authorization of an opaque secret handle
  // (fence-first, then owner re-derive + membership re-check + the pure
  // authorizeSecretResolve invariant → audit-as-columns; returns the non-secret binding
  // only, NEVER a value).
  "resolveExecutionSecret",
  "completeAttempt",
  "recordServiceHealth",
  "applyProjectionReceipt",
  "ackControlCommand",
] as const;
export type GuardedJobMutator = (typeof GUARDED_JOB_MUTATORS)[number];

/** Job-attempt statuses in which the run has terminated; no governed fence may
 * mutate against a terminal attempt (it returns `attempt_terminal`). */
export const TERMINAL_ATTEMPT_STATUSES = ["succeeded", "failed", "cancelled", "expired"] as const;
export type TerminalAttemptStatus = (typeof TERMINAL_ATTEMPT_STATUSES)[number];

/** Why a governed mutation was refused. These map 1:1 onto the frozen worker
 * operation error codes surfaced by the leasing/fencing services. */
export type JobFenceErrorCode = "stale_fence" | "target_revoked" | "attempt_terminal";

/**
 * Raised by the common active-fence guard when the presenting fence is not the
 * current active fence. Never discloses payload, fence material, or foreign
 * identifiers — only the closed classification code.
 */
export class JobFenceError extends Error {
  constructor(public readonly code: JobFenceErrorCode) {
    super(`Job fence ${code}`);
    this.name = "JobFenceError";
  }
}

/** DAT-002 — why a fenced artifact commit was refused AFTER the fence admitted it
 * (i.e. the fence is active but the manifest fails verification). These are the
 * INTERNAL precise reasons; the server maps them onto the frozen closed protocol
 * error vocabulary for the wire (`wrong_prefix`/`size_mismatch`/`tenant_mismatch`
 * → `malformed`, `hash_mismatch` → `event_hash_mismatch`). Fence staleness always
 * precedes these (the guard runs first), so an active-but-mismatched manifest is
 * the only path here. */
export type ArtifactCommitRejectionReason = "wrong_prefix" | "size_mismatch" | "hash_mismatch" | "tenant_mismatch";

/** Raised by the fenced commit mutator when the active-fence guard admitted the
 * caller but the manifest fails hash/size/prefix/tenant verification. Distinct from
 * `JobFenceError` so the service maps it to a verification reject, never a fence
 * reject. Discloses only the closed classification reason. */
export class ArtifactCommitRejection extends Error {
  constructor(public readonly reason: ArtifactCommitRejectionReason) {
    super(`Artifact commit rejected: ${reason}`);
    this.name = "ArtifactCommitRejection";
  }
}

/** DAT-003 — why a fenced patch APPLY was refused AFTER the fence admitted it.
 * `patch_not_committed` = no committed `workspace_patch` row for the identity;
 * `object_key_mismatch` = the caller-presented object key does not equal the
 * committed row's object key (the parsed content is not bound to the committed,
 * immutable object). A base MISMATCH is NOT a rejection — it is an
 * `apply_status='conflict_quarantined'` disposition, surfaced for review. */
export type PatchApplyRejectionReason = "patch_not_committed" | "object_key_mismatch";

/** Raised by the fenced apply mutator when the active-fence guard admitted the
 * caller but the target patch row is missing/uncommitted or the presented object
 * key does not match the committed row. Distinct from `JobFenceError` so the
 * service maps it to a coarse, non-disclosing reject, never a fence reject. */
export class PatchApplyRejection extends Error {
  constructor(public readonly reason: PatchApplyRejectionReason) {
    super(`Patch apply rejected: ${reason}`);
    this.name = "PatchApplyRejection";
  }
}

// -----------------------------------------------------------------------------
// DAT-006 — device-authenticated ORPHAN quarantine rejection vocabulary. An orphan
// is a DEAD-FENCE output, so this path is device-authed (targetId + deviceGeneration),
// never fence-guarded. Refusals are `target_revoked` (a bumped/disabled/absent target
// authority) or `unknown_job` (the (org, job) does not exist in this tenant — folded to
// a coarse, non-disclosing `malformed` by the service). There is NO `stale_fence`
// reason: staleness is precisely why an orphan is quarantined, so it can never be a
// refusal. Distinct from `JobFenceError` so the finalize service maps it to the
// device-auth vocabulary (`target_revoked`/`malformed`), never a fence code.
export type OrphanQuarantineRejectionReason = "target_revoked" | "unknown_job";

export class OrphanQuarantineRejection extends Error {
  constructor(public readonly reason: OrphanQuarantineRejectionReason) {
    super(`Orphan quarantine rejected: ${reason}`);
    this.name = "OrphanQuarantineRejection";
  }
}

// -----------------------------------------------------------------------------
// DAT-004 — lease-scoped secret-resolve authorization vocabulary + pure decision.
//
// `resolveExecutionSecret` (the guarded mutator) runs `guardActiveFence` FIRST, then
// consults this PURE decision against the WIDENED `job_secret_handles` row's
// non-secret binding. The decision NEVER sees a secret value; the widened row stores
// NO bytes. Every refusal is a closed internal reason the service maps to a coarse,
// non-disclosing `malformed` (fence refusals stay `stale_fence`/`target_revoked`/
// `attempt_terminal` and are decided earlier by the guard).
// -----------------------------------------------------------------------------

/** The CLOSED set of value stores a handle's `ref_kind` may dispatch to. The first
 * four are legacy value stores; `run_jwt` (DAT-007 / CLI-008) is the mint-at-resolve
 * agent bearer — no value is stored, the broker MINTS it server-side at resolve. A
 * sixth would need a new resolver branch AND a new entry here. */
export const SECRET_REF_KINDS = ["company_secret", "connector_oauth", "provider_key", "device_local", "run_jwt"] as const;
export type SecretRefKind = (typeof SECRET_REF_KINDS)[number];

/**
 * The owner principal kinds that CAN hold a `company_memberships` row — i.e. the kinds
 * for which the rule-6 membership re-check is a REAL control. This is exactly
 * `packages/shared` `PRINCIPAL_TYPES`: the table's `principal_type` is only ever `user`
 * or `agent` (no CHECK enforces it, but every writer stamps one of these two).
 *
 * The distributed-execution SUBSTRATE kinds are deliberately ABSENT. Decision #121's
 * frozen executor authority stamps a task_run/crew_run/one_shot executor as
 * `worker`/`sandbox` (and system jobs `system`); `agent` is only ever a *requester* kind,
 * never an executor. `execution-secret-handle-mint-runner` owner-binds a handle to that
 * executor, so a distributed run's owner-bound handle carries a `worker`/`sandbox` owner
 * that can NEVER have a membership row. Re-checking membership for those kinds denied
 * EVERY agent-executed run with `owner_membership_lost` even though the owner==executor
 * routing held and `guardActiveFence` had already proven the principal's live lease
 * authority — the substrate's liveness IS the fence, not a company membership.
 *
 * Exempting ONLY these substrate kinds (rather than "everything but user") keeps the
 * membership re-check intact for a membership-capable `agent` owner, so the relaxation
 * changes behaviour ONLY for principals that could never have satisfied the check.
 *
 * Hardcoded, not imported: this is the dependency-minimal fence surface and the
 * policy-lane mirror (`scripts/check-secret-resolve-vectors.mjs`) re-derives the decision
 * WITHOUT importing it. A test pins this set equal to `PRINCIPAL_TYPES` so they cannot drift.
 */
export const MEMBERSHIP_CAPABLE_OWNER_KINDS = ["user", "agent"] as const;

/**
 * `ref_id` for a `device_local` handle: the `provider_credentials` uuid PK, lowercase
 * or upper. Anchored — a uuid embedded in a longer string is not a uuid.
 */
const DEVICE_CREDENTIAL_REF_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Non-secret facts read from the widened handle row (never a value). */
export interface SecretResolveHandleFacts {
  /** `active` | `revoked`. */
  status: string;
  /** company_secret | connector_oauth | provider_key | device_local | run_jwt (or unknown → deny). */
  refKind: string | null;
  /** The non-secret pointer into the chosen broker (never a value). A ref_kind with no
   * pointer is unresolvable → deny (fail-closed against a half-minted handle). */
  refId: string | null;
  /** proxy | env | file (mirrors the frozen wire ref for server-side re-check). */
  materialization: string | null;
  /** fence_proxy | remote_server_fenced | sandbox_local_only. */
  usePolicy: string | null;
  /** The bound egress destination/networkPolicyRef (DAT-004 binds; DAT-005 enforces). */
  destination: string | null;
  /** D5 — the placed target generation the handle is pinned to (null = unpinned). */
  boundTargetGeneration: number | null;
  /** Denormalized owner (device_local / owner-bound handles). */
  ownerPrincipalKind: string | null;
  ownerPrincipalId: string | null;
}

/** The dispatching owner re-derived from the LOCKED `jobs` row (never the wire). */
export interface SecretResolveJobOwner {
  executorPrincipalKind: string;
  executorPrincipalId: string;
}

/**
 * The `provider_credentials` row a `device_local` handle points at, read in the SAME
 * fenced transaction. `null` means the query ran and found NOTHING — or, outside a
 * `device_local` handle, that no query was needed.
 *
 * A STRUCT rather than three booleans on purpose. Booleans would make the caller
 * decide *why* a credential is unacceptable, and the caller is the transaction — the
 * one place that cannot be exercised by the vector lane. Passing the facts lets the
 * PURE function name the reason, so every branch is provable without a database.
 */
export interface DeviceCredentialFacts {
  /** `pending | verified | revoked | suspended` (text; no DB CHECK constrains it). */
  state: string | null;
  /** `provider_credentials.owner_user_id`. */
  ownerUserId: string | null;
  /**
   * `provider_credentials.execution_target_id` — the device whose OS keystore actually
   * holds this credential's value.
   */
  executionTargetId: string | null;
}

export interface SecretResolveAuthzInput {
  handle: SecretResolveHandleFacts;
  jobOwner: SecretResolveJobOwner;
  /** For an owner-bound handle: whether the owner still holds an ACTIVE company
   * membership (re-checked in the SAME tx). `null` when the handle is not
   * owner-bound (no membership query was needed). */
  ownerMembershipActive: boolean | null;
  /** The LIVE target generation of the active lease (proven by `guardActiveFence`). */
  liveTargetGeneration: number;
  /** The LIVE target of the active lease — the device the job is actually placed on. */
  liveTargetId: string;
  /**
   * D12(3)+(4) — the credential a `device_local` handle points at, read in the SAME
   * fenced transaction as the membership re-check. `null` for every other ref_kind
   * (no query is performed) and `null` when the row does not exist.
   *
   * NOT optional. An optional field would compile everywhere unchanged and silently
   * arrive as `undefined` — and `server/tsconfig.json` excludes `src/__tests__`, so
   * the test literals would not have complained either.
   */
  deviceCredential: DeviceCredentialFacts | null;
}

/**
 * Why a secret resolve was refused AFTER the fence admitted it. INTERNAL + precise;
 * the service maps every one of these to the coarse, non-disclosing `malformed`
 * (a resolve refusal must never disclose which invariant a foreign caller tripped).
 *
 * DECLARED AS AN ARRAY, and the union derived from it, for the same reason
 * `SECRET_REF_KINDS` above is: the vocabulary has to be ENUMERABLE AT RUNTIME so a
 * gate can prove every member is exercised.
 *
 * It was a bare union, and that left a hole in the gate itself: nothing anywhere
 * asserted exhaustiveness (four references repo-wide, none of them a check), so an
 * eleventh member with zero vectors would have left every lane green — on the one
 * surface whose entire job is to be exhaustively pinned. The policy-lane checker
 * now reads this array out of this file and refuses a fixture that misses any
 * member, so adding a reason without a vector fails CI.
 *
 * Deriving the type from the array rather than asserting the two agree means they
 * cannot disagree by construction.
 */
export const SECRET_RESOLVE_REJECTION_REASONS = [
  "handle_revoked",
  "unknown_ref_kind",
  "ref_pointer_missing",
  "materialization_policy_conflict",
  "ref_kind_policy_conflict",
  "sandbox_local_network_destination",
  "network_destination_missing",
  "target_generation_mismatch",
  "owner_binding_incomplete",
  "owner_membership_lost",
  "ref_pointer_malformed",
  "credential_not_found",
  "credential_unverified",
  "credential_owner_mismatch",
  "credential_target_mismatch",
  "owner_principal_kind_invalid",
] as const;

export type SecretResolveRejectionReason = (typeof SECRET_RESOLVE_REJECTION_REASONS)[number];

export type SecretResolveDecision = "admit" | SecretResolveRejectionReason;

/**
 * THE pure lease-scoped secret-resolve decision (D6). Consumed by the guarded
 * `resolveExecutionSecret` mutator AND independently re-derived by the `policy`-lane
 * vectors gate (`scripts/check-secret-resolve-vectors.mjs`) so the two cannot
 * silently diverge. Pure + side-effect free; sees only non-secret identifiers/enums.
 *
 * Order (fail-closed, each check independent): revoked → unknown ref_kind →
 * materialization×use_policy invariant (defense in depth vs a hand-built envelope) →
 * sandbox_local_only-with-network-destination → target-generation binding (D5) →
 * owner binding + membership re-check.
 */
export function authorizeSecretResolve(input: SecretResolveAuthzInput): SecretResolveDecision {
  const h = input.handle;

  // 1. A revoked handle never resolves (re-check-at-resolve; revoke takes effect
  //    without rebuilding the dispatched envelope).
  if (h.status !== "active") return "handle_revoked";

  // 2. ref_kind must be a KNOWN store: a legacy value store or the run_jwt bearer.
  if (!h.refKind || !(SECRET_REF_KINDS as readonly string[]).includes(h.refKind)) return "unknown_ref_kind";

  // 2b. The broker pointer must be present — a ref_kind with no ref_id is a
  //     half-minted, unresolvable handle (fail-closed).
  if (!h.refId) return "ref_pointer_missing";

  // 3. materialization×use_policy invariant — mirrors the frozen `secretHandleRefSchema`
  //    cross-field refinement, re-checked server-side against the persisted binding so a
  //    hand-built envelope cannot smuggle a sandbox capability onto a network policy.
  //    proxy ⟺ fence_proxy; env/file ⟹ NOT fence_proxy.
  const m = h.materialization;
  const u = h.usePolicy;
  if (m !== "proxy" && m !== "env" && m !== "file") return "materialization_policy_conflict";
  if (u !== "fence_proxy" && u !== "remote_server_fenced" && u !== "sandbox_local_only") {
    return "materialization_policy_conflict";
  }
  if (m === "proxy" && u !== "fence_proxy") return "materialization_policy_conflict";
  if ((m === "env" || m === "file") && u === "fence_proxy") return "materialization_policy_conflict";

  // 3b. ref_kind × policy binding — fail-closed against a hand-built/corrupt envelope
  //     whose ref_kind's security model disagrees with the persisted policy. A
  //     `connector_oauth` token is HEADERS-ONLY and must NEVER reach the sandbox, so it
  //     resolves ONLY as the fence proxy (`fence_proxy` + `proxy`). A `device_local`
  //     OS-keystore credential resolves ONLY as `sandbox_local_only` or `fence_proxy`
  //     (never a remote-server materialization). Without this, a connector_oauth row
  //     mislabelled `env`/`sandbox_local_only` would leak the OAuth value into the sandbox.
  if (h.refKind === "connector_oauth" && (u !== "fence_proxy" || m !== "proxy")) {
    return "ref_kind_policy_conflict";
  }
  if (h.refKind === "device_local" && u === "remote_server_fenced") {
    return "ref_kind_policy_conflict";
  }
  // A `run_jwt` is a fresh, agent-authenticating bearer MINTED at resolve for the
  // sandbox env ONLY (`AOA_API_KEY`). It has no egress form, so it resolves ONLY as
  // `sandbox_local_only` + `env` — never a network seam. Same defense-in-depth as the
  // two above: a corrupt or hand-built envelope cannot route a run JWT to a
  // remote-server / proxy destination.
  if (h.refKind === "run_jwt" && (u !== "sandbox_local_only" || m !== "env")) {
    return "ref_kind_policy_conflict";
  }

  // 4. A sandbox_local_only handle can NEVER carry a network destination — it has no
  //    egress path, so a bound destination is a contradiction (no-value-to-sandbox for
  //    a network handle, enforced from the policy side).
  if (u === "sandbox_local_only" && h.destination !== null && h.destination !== "") {
    return "sandbox_local_network_destination";
  }

  // 4b. Conversely a NETWORK-use handle (fence_proxy / remote_server_fenced) MUST carry a
  //     bound egress destination — DAT-004 BINDS it so the DAT-005 fence-aware proxy can
  //     ENFORCE it; dispatching a raw value to an unbound network seam is fail-closed.
  if ((u === "fence_proxy" || u === "remote_server_fenced") && (h.destination === null || h.destination === "")) {
    return "network_destination_missing";
  }

  // 5. Target-generation binding (D5): when pinned, the handle resolves ONLY on its
  //    placed generation. A re-placed job on a bumped generation must mint a fresh
  //    handle rather than reuse one bound to the replaced generation.
  if (h.boundTargetGeneration !== null && h.boundTargetGeneration !== input.liveTargetGeneration) {
    return "target_generation_mismatch";
  }

  // 5b. device_local HANDLE SHAPE (D12/1 + D12/4). Pure, and deliberately ahead of the
  //     owner-binding check: both are properties of the handle ALONE, so they hold
  //     regardless of who the job executor happens to be. Putting them after rule 6
  //     would make `owner_principal_kind_invalid` unreachable whenever the job's
  //     executor is itself a non-user principal — exactly the case that motivates it.
  if (h.refKind === "device_local") {
    // `ref_id` IS `provider_credentials.id`, a uuid PK. The column comment sanctioned
    // "id-or-slug"; for this ref_kind the slug reading is retired. A DB-level FK is not
    // available — job_secret_handles is org-scoped and provider_credentials is
    // company-scoped, and a cross-scope FK is the cross-tenant existence oracle E2-F013
    // already removed once — so the shape is checked here, where the vector lane can
    // prove it without a database.
    if (!DEVICE_CREDENTIAL_REF_RE.test(h.refId)) return "ref_pointer_malformed";
    // `provider_credentials.owner_user_id` references the `user` table, so a worker or
    // agent principal can never be the owner of a device credential. Without this the
    // comparison below would be between a user id and a worker id and could only ever
    // fail — with a reason that misdescribes the fault.
    // Only when a kind is actually present: a handle with NO owner at all is
    // "owner_binding_incomplete" at rule 6, which is the more precise fault. Checking
    // it here unconditionally would swallow that case under a misleading reason.
    if (h.ownerPrincipalKind && h.ownerPrincipalKind !== "user") return "owner_principal_kind_invalid";
  }

  // 6. Owner binding + membership re-check. device_local is ALWAYS owner-bound; any
  //    handle that denormalizes an owner is re-validated against the LOCKED job's
  //    executor (routing, for every owner) + — for a MEMBERSHIP-CAPABLE owner only — a
  //    live, active company membership.
  const ownerBound = !!(h.ownerPrincipalKind && h.ownerPrincipalId);
  if (h.refKind === "device_local" && !ownerBound) return "owner_binding_incomplete";
  if (ownerBound) {
    if (h.ownerPrincipalKind !== input.jobOwner.executorPrincipalKind
      || h.ownerPrincipalId !== input.jobOwner.executorPrincipalId) {
      return "owner_binding_incomplete";
    }
    // The company-membership re-check (invariant #5) applies ONLY to a MEMBERSHIP-CAPABLE
    // owner (user/agent): such a principal removed from the company must lose access on the
    // next resolve. The execution SUBSTRATE (worker/sandbox/system) is never a company
    // member, so requiring a membership row for it denies EVERY agent-executed distributed
    // run with `owner_membership_lost` — even though the owner==executor routing above
    // (DE-29) already holds and `guardActiveFence` has already proven the principal's LIVE
    // lease authority. A substrate owner's liveness is the fence, not a membership. See
    // MEMBERSHIP_CAPABLE_OWNER_KINDS above.
    //
    // The routing check above proved `h.ownerPrincipalKind === executorPrincipalKind`, and
    // the latter is a guaranteed non-null string, so it IS the owner's kind (used here to
    // stay type-safe without asserting away `ownerPrincipalKind`'s nullable type).
    if ((MEMBERSHIP_CAPABLE_OWNER_KINDS as readonly string[]).includes(input.jobOwner.executorPrincipalKind)
      && input.ownerMembershipActive !== true) {
      return "owner_membership_lost";
    }
  }

  // 7. device_local CREDENTIAL BINDING (D12/3 + D12/4). The facts come from the same
  //    fenced transaction as the membership re-check; the decision stays here so the
  //    vector lane proves every branch with no database.
  if (h.refKind === "device_local") {
    const credential = input.deviceCredential;
    // Fail-closed on absence: a handle pointing at a credential that does not exist in
    // the LOCKED lease's company is unresolvable, never resolvable-by-default.
    if (!credential) return "credential_not_found";
    // Only a VERIFIED credential may be activated. `state` is plain text with no CHECK
    // constraint, so this is a positive equality test, never "not revoked".
    if (credential.state !== "verified") return "credential_unverified";
    // The OWNER TRIPLE. Rule 6 already proved handle owner === the LOCKED job executor;
    // these two close it over the credential and the device it lives on.
    if (credential.ownerUserId !== h.ownerPrincipalId) return "credential_owner_mismatch";
    // THE CREDENTIAL MUST LIVE ON THE DEVICE THE JOB IS RUNNING ON.
    //
    // The design's third owner leg compared `execution_targets.owner_user_id`. That is
    // both weaker and wrong-shaped, and implementing it showed why: it says nothing
    // about WHICH device holds the value, and it can never hold for an
    // organization-scoped target (owner_user_id is NULL there), so it would reject
    // every handle on a shared worker instead of the ones that are actually
    // mis-bound.
    //
    // The real invariant is direct: a `device_local` value sits in ONE machine's OS
    // keystore, named by `provider_credentials.execution_target_id`. If the job is
    // placed anywhere else, that machine cannot read it — so the credential is bound to
    // its device, and the lease's LIVE target must be that device. This subsumes the
    // owner comparison, because a credential and a target that disagree about the
    // device are mis-bound whoever owns them.
    if (credential.executionTargetId !== input.liveTargetId) return "credential_target_mismatch";
  }

  return "admit";
}

/** Raised by `resolveExecutionSecret` when the active-fence guard admitted the caller
 * but the widened handle binding fails `authorizeSecretResolve`. Distinct from
 * `JobFenceError` so the service maps it to a coarse, non-disclosing `malformed`
 * (never a fence reject, never a disclosing reason). */
export class SecretResolveRejection extends Error {
  constructor(public readonly reason: SecretResolveRejectionReason) {
    super(`Secret resolve rejected: ${reason}`);
    this.name = "SecretResolveRejection";
  }
}

/** The complete lease identity a governed mutation binds to. Every field is
 * matched under a row lock before any governed row is touched. */
export interface ActiveFenceRequest {
  organizationId: string;
  companyId: string;
  jobId: string;
  attemptId: string;
  attemptNumber: number;
  leaseId: string;
  workerId: string;
  targetId: string;
  targetAuthorityKey: string;
  targetGeneration: number;
  profileHash: string;
  providerConstraintHash: string;
  fence: string;
}

/** The locked lease + attempt snapshot the predicate decides against, plus the
 * freshly-evaluated `expires_at > clock_timestamp()` fact (computed in SQL inside
 * the same transaction — never a transaction-start or JavaScript wall-clock time). */
export interface ActiveFenceSnapshot {
  leaseStatus: string;
  attemptStatus: string;
  /** `expires_at > clock_timestamp()` evaluated with a FRESH database clock. */
  expiresFresh: boolean;
}

/**
 * THE common active-fence predicate. A fence is active iff the lease is `active`,
 * its stored expiry is still ahead of a FRESH database clock, and its attempt has
 * not reached a terminal state. Pure and side-effect free: the caller supplies the
 * locked snapshot (identity is matched by the guard's locking read) and the
 * freshly-computed expiry fact.
 */
export function isActiveFence(snapshot: ActiveFenceSnapshot): boolean {
  return (
    snapshot.leaseStatus === "active" &&
    snapshot.expiresFresh &&
    !(TERMINAL_ATTEMPT_STATUSES as readonly string[]).includes(snapshot.attemptStatus)
  );
}

/**
 * Classify a locked snapshot into the refusal code (or `null` when the fence is
 * active). Terminal attempts are `attempt_terminal`; everything else non-active
 * (wrong status, expired against fresh time) is `stale_fence`. Fence/identity
 * MISMATCH and a missing row are `stale_fence` too, but that is decided by the
 * guard's locking read (a non-match returns no row), not here.
 */
export function classifyFence(snapshot: ActiveFenceSnapshot): JobFenceErrorCode | null {
  if ((TERMINAL_ATTEMPT_STATUSES as readonly string[]).includes(snapshot.attemptStatus)) {
    return "attempt_terminal";
  }
  if (!isActiveFence(snapshot)) return "stale_fence";
  return null;
}
