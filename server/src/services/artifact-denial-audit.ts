// server/src/services/artifact-denial-audit.ts
//
// DE-06, audit clause — the shared shape and reason vocabulary for the durable
// record an artifact object-operation refusal leaves behind.
//
// ★ WHAT THIS EXISTS FOR. `docs/architecture/distributed-execution-threat-controls.json`
// DE-06 asserts "object put/get and rejected-key attempts are audited". Before
// this module the grant path recorded NOTHING on any refusal (`rejected()` in
// `artifact-transfer-grant.ts` only constructed a response object), and the
// commit path emitted a COUNT-ONLY `metrics.artifactOp({outcome:"rejected"})`
// tick that is compile-closed against ids by deliberate design
// (`job-control-metrics.ts` — high-cardinality ids ride the logger spine, never
// a metric label). A count cannot answer WHO was refused, in WHICH tenant, on
// WHICH object key, or WHY, so a worker in org A that repeatedly asked for a
// presigned URL under org B's object prefix left the same durable trace as a
// worker that asked for nothing: a number going up. See `E0-F010`.
//
// ★ THE CLAUSE IS CONJUNCTIVE AND ONLY ONE CONJUNCT IS HERE. DE-06 reads "object
// put/get AND rejected-key attempts are audited". This module delivers the
// REJECTED-KEY half. ★ THE OTHER HALF LANDED ON 2026-09-10 AND IS NOT THIS
// MODULE'S: `artifact-object-access-audit.ts` records a SUCCESSFUL upload or
// download grant as an attributable `security.object_access.*` row. Both
// conjuncts of DE-06's AUDIT clause therefore now hold and DE-06 has left
// `E0-F010`'s cohort — but nothing HERE closes it, and this module must still
// not be cited as the closure. DE-06 also stays `partial` in the threat register
// for its separately-absent `authentication` clause (`E0-F012`).
// *(Superseded text, kept so the correction is visible: "The other half — a
// SUCCESSFUL object put/get — is NOT audited: a granted download presigns and
// returns from `artifact-transfer-grant.ts` (the sole production `presignGet`
// call site) writing no record at all, and a granted upload leaves only the
// operational `recordArtifactGrantIntent` row.")*
//
// ★ AND ONE REFUSAL SHAPE IS OUT OF REACH OF THE MECHANISM BELOW. The intent
// drain covers refusals that RETURN. `resolveWorkerFenceContext` instead THROWS
// `JobLeasingError("stale_fence"|"target_revoked"|"unauthorized")` before any
// intent exists, and those throws are not recorded. The blocker is not the
// transaction (a drain point outside `runInTenant` is a `try`/`catch`) but
// ATTRIBUTION: `workers`/`execution_targets` carry `organization_id` only, and
// the lease that carries `company_id` is exactly what failed to resolve, while
// `activity_log.company_id` was NOT NULL. ★ THE STORAGE HALF OF THAT BLOCKER IS
// GONE as of E0-F013 Decision 2, ruled option (a2) on 2026-09-09: `company_id` is
// nullable inside the `security.denied.` namespace and a nullable
// `organization_id` sits beside it, so five of the six throws can now record the
// organization they hold. THE WIRING IS STILL NOT DONE — these throws write no
// row today, and nothing here may be read as if they did. Both throws are driven
// and pinned as UNRECORDED in
// `server/src/__tests__/de-06-artifact-denial-audit.integration.test.ts`.
//
// ★ WHY A SEPARATE INTENT TYPE AND NOT A DIRECT CALL. Every refusal in both
// services happens INSIDE `runInTenant` — an open tenant transaction borrowed
// from the same `appDb` pool. `recordSecurityDenial` is documented as requiring
// a POOL-level handle, and calling it from inside that callback would borrow a
// SECOND connection from the pool while the first is still held, which on a
// small pool is a self-deadlock on the refusal path — i.e. an audit that turns a
// refusal into a hang. So the refusing branch records its INTENT into a local,
// the transaction returns normally (a `rejected` outcome is a RETURN, never a
// throw, so it commits), and the caller writes the row afterwards on the pool
// handle, before the response is returned. The refusal and its record are still
// atomic from the caller's point of view: `grant()`/`commit()` do not resolve
// until the row is written or the write has failed and been logged.
//
// ★ THE REASON CODES ARE THE POINT. The frozen wire vocabulary is deliberately
// coarse — six distinct refusal BRANCHES in the grant service all answer the
// worker `reason:"malformed"`, because a finer wire code would disclose whether
// a foreign object key exists. That coarseness is correct on the wire and fatal
// in an audit: it is exactly the "forensically indistinguishable" property
// `E0-F013` files against DE-29. So each branch carries its own stable machine
// code HERE, in the durable record, while the caller still sees the same opaque
// `malformed`. Non-disclosure is preserved; attributability is added.

/** The reserved `surface` slug for a refused transfer-grant → `security.denied.artifact_transfer_grant`. */
export const ARTIFACT_TRANSFER_GRANT_DENIAL_SURFACE = "artifact_transfer_grant";

/** The reserved `surface` slug for a refused commit → `security.denied.artifact_commit`. */
export const ARTIFACT_COMMIT_DENIAL_SURFACE = "artifact_commit";

/**
 * Every reason code either service may record, enumerated in one place so the
 * vocabulary is reviewable and so a test can assert the set is closed. Distinct
 * codes correspond to distinct BRANCHES in the refusing control — never to
 * distinct wire responses, which are coarser on purpose.
 */
export const ARTIFACT_DENIAL_REASONS = [
  // Governed-authority refusals (the fence guard), shared by both services.
  "stale_fence",
  "attempt_terminal",
  "target_revoked",
  // ★ The rejected-KEY attempts the DE-06 clause names by name.
  "foreign_object_prefix",
  "object_key_mismatch",
  "manifest_tenant_mismatch",
  // Governed refusals that are not key-shaped but are still refusals of a
  // privileged object operation.
  "declared_size_over_ceiling",
  "artifact_identity_already_committed",
  "artifact_not_committed",
  "object_size_over_ceiling",
  "object_missing",
  "object_integrity_unverifiable",
  "declared_size_mismatch",
  "declared_hash_mismatch",
] as const;

export type ArtifactDenialReason = (typeof ARTIFACT_DENIAL_REASONS)[number];

/**
 * ★ MEASURED, so the vocabulary is not read as a list of proven branches.
 * `manifest_tenant_mismatch` is the audit code for the commit mutator's
 * `tenant_mismatch` rejection, and that branch is **not reachable over the
 * frozen wire today**: `artifactManifestV1Schema`'s superRefine requires
 * `objectKey` to sit under `organizations/<manifest.organizationId>/jobs/<manifest.jobId>/…`,
 * so a manifest that declares a foreign organization must also carry a foreign
 * key — and the mutator checks PREFIX before TENANT, so such a manifest is
 * refused as `wrong_prefix` first. `manifest_tenant_mismatch` is therefore
 * defence-in-depth behind a schema invariant, and the DE-06 proving test does
 * not assert it, because a test that cannot provoke its own subject proves
 * nothing. The code exists so that if the invariant ever weakens, the refusal is
 * attributable on the day it starts firing.
 *
 * ★ AND THE REST OF THE LIST IS A VOCABULARY, NOT A LIST OF PROVEN BRANCHES.
 * Counted rather than asserted: FIVE of the fourteen codes are provoked end to
 * end in `server/src/__tests__/de-06-artifact-denial-audit.integration.test.ts`
 * — `foreign_object_prefix`, `declared_size_over_ceiling`,
 * `artifact_not_committed`, `stale_fence`, `declared_hash_mismatch`. The other
 * nine are compiled and reviewable but unprovoked here, and the DAT-002 suite
 * (`artifact-transfer-commit.integration.test.ts`) does not stand in for them
 * either: a grep of that file for the branch names finds only `attempt_terminal`
 * and `hash_mismatch`. An earlier version of this comment claimed the whole list
 * was covered by one file or the other; it was not, and that is the same
 * over-generalisation this module's own crossing exists to catch.
 */

/**
 * What a refusing branch records for the caller to write once the tenant
 * transaction has closed. `companyId` is the LOCKED LEASE's company
 * (`ResolvedFenceContext.companyId`), never a caller-supplied field: it is
 * resolved from the database under the refusing worker's own organization GUC,
 * so it is FK-valid and it names the tenant that REFUSED rather than any tenant
 * the request tried to reach. Writing a cross-tenant probe into the PROBED
 * tenant's activity stream would make the audit record the disclosure channel it
 * exists to avoid (the DE-19 precedent).
 */
export interface ArtifactDenialIntent {
  reason: ArtifactDenialReason;
  companyId: string;
  /** The artifact identifier the operation named. */
  artifactId: string;
  /** Free detail, redacted through `sanitizeRecord` by `recordSecurityDenial`. */
  details: Record<string, unknown>;
}
