# Universe — worker output publication design and planning addendum

September 12, 2026. **Proposed technical recommendation, awaiting independent review and security acceptance. Planning only.** Human intake A remains accepted and unchanged. This document does not authorize implementation, migrations, qualifications, provider calls or grant changes.

**Goal:** Turn one authorized, committed worker output into one recoverable canonical result without rerunning generation, exposing private sources or giving workers application-database authority.

**Architecture:** Keep distributed execution and its committed output ledger under existing non-owner tenant repositories. Keep application-facing processing records, search data and publication receipts under explicit company/actor/destination authorization. A control-plane coordinator observes committed output, copies verified permitted bytes into canonical storage, then publishes through one application transaction. These are separate transactions; this is not a distributed atomic commit.

**Tech stack:** Existing TypeScript, Express, Drizzle/PostgreSQL, tenant repositories, storage providers and canonical asset/artifact services. No new queue, provider SDK, worker wire shape or broad legacy DML grant is selected.

**Spec:** [Asset contract](artifact-contract.md), [E4.1](coding-plans/e4-1.md), [E4.2](coding-plans/e4-2.md), [E4.3](coding-plans/e4-3.md), [E5.2](coding-plans/e5-2.md), [decisions](final-planning-decisions.md).

## Source evidence and limits

All evidence is read-only at source 183e46a9c65fc3105c7e3d125629276814df7dbb; branch head before this proposal is 8b1dab34095af58fea17bc75c16b3d6809ce44b8.

| Source | Established behavior and implication |
|---|---|
| server/src/services/artifact-commit.ts: createArtifactCommitService | Resolves worker fence, verifies store-observed bytes, commits through runInTenant. Response artifactId is row.identifier, not assets.id or artifacts.id. It does not publish an application artifact. |
| packages/db/src/repositories/tenant/job-control.ts: commitArtifactVersion | Guards active fence before commit. Natural identity is organization/job/attempt/identifier. Replay returns the original stored row. versionNumber is explicitly best-effort and not uniquely constrained across attempts; never use it as publication identity. |
| packages/db/src/schema/job_artifacts.ts | Rich fields are nullable for older thin callers. Require a complete committed row. granted/quarantined/committed records have disjoint uniqueness; not every row is output. The job FK cascades: copy provenance into durable application receipt without making its lifetime depend on the job row. |
| packages/db/src/repositories/tenant/index.ts | jobArtifacts.findCommitted reads committed only; findEverCommitted also sees expired for immutability checks. Neither alone enforces application destination permissions. Use repos.jobs.getById to verify company and admitted source binding. |
| server/src/db/tenant-context.ts | Transactions/repositories never escape callbacks; only data may return. Use distinct supplied applicationDb and tenantDb handles. No owner-pool substitution inside runInTenant. |
| server/src/db/job-control-legacy-grants.ts | aoa_app has SELECT, not INSERT, on assets/artifacts/artifact_versions. Do not grant those writes to make publication appear atomic. |
| server/src/services/assets.ts and artifacts.ts | Canonical writers use a supplied Db. E4.3 must add locked/idempotent publication and transactional audit support; current source is not proof that the proposed combined publication already exists. |
| server/src/services/browser-artifact-retention.ts and artifact-retention-authority.ts | Kind determines retention; other defaults ephemeral. Do not prolong restricted worker objects by trusting a manifest or a user filename. Durable output requires an explicitly permitted promotion, separate from worker-object retention. |
| server/src/services/job-admission-bridge.ts and job-submission.ts | Existing admission and stable submission identity are available, but Commander bridge is described as inert. one_shot kinds in packages/worker-protocol/src/source.ts are only extraction/compaction/readiness_probe. Arbitrary conversion/generation cannot be disguised as readiness_probe or assumed supported. |

Frozen protocol and grant manifests remain unchanged. Processor admission, accepted output-slot binding and permission-revocation coordination are explicit upstream qualifications below.

## Alternatives and recommendation

| Approach | Assessment |
|---|---|
| Extend worker non-owner grants to write canonical assets/versions | Rejected recommendation: expands authority and changes existing legacy boundaries to save coordination work. No such grant is approved. |
| Add organization-owned processing ledgers plus a separate application writer receipt (original C) | Viable if a ledger is genuinely worker-owned; requires new security policies, repositories and duplicate projection reconciliation. Not automatically needed for application UI/search state. |
| Reuse existing organization-owned job/output ledger; application-owned processing and publication records | Recommended here. Uses C-style reconciliation across the existing distributed boundary, while selecting application scope separately for UI/search/grant records. It is not blanket A for jobs or blanket C for every new table. |

**Per-store proposal:** E4.1 intake/parts stay accepted A. Existing jobs/attempts/leases/job_artifacts stay organization-owned, non-owner only. Proposed universe_derivatives, universe_asset_index and the new universe_publications record are application-owned with mandatory company and live actor/destination checks. E5.2 universe_tool_grants and action-link metadata are also proposed application-owned because they describe authenticated user/frame capability, not worker execution. E1 checkpoint authority is unchanged. Workers cannot read/write any of these application tables directly. organization_id, where retained, is server-derived routing/integrity metadata, never the access predicate.

This recommendation supersedes the conditional proposed tenant/universe-derivatives repository path if accepted. Security review must validate the exact service predicates/roles and generated schema before coding. If evidence requires an organization-owned store, record that specific change and revise its receipt protocol; do not silently switch implementations.

## Reviewed follow-up

The [received review](worker-publication-review-report.md) found the proposal coherent for security review, not ready for execution. [Output identity and revocation follow-up](worker-publication-identity-revocation.md) defines the M1 action/slot/accepted-binding contract and M3 authorization-barrier proposal; these govern ordering below. Exact CMD adapters, production writer coverage and security/runtime qualification remain open. LOW-1's suggested source correction is rejected: the composite job FK explicitly cascades.

## Identities and proposed interfaces

The server records a publication intent before dispatch, or before observing an already-admitted generation output. It derives the requester, sources and destination from the canonical action. Client, worker and model output cannot supply an arbitrary company, storage key or publication audience.

Create packages/shared/src/validators/universe-publication.ts, packages/db/src/schema/universe_publications.ts and server/src/services/universe-publication.ts. E4.2/2 owns this common producer; E4.3/1 consumes it for artifact/version publication. All names below are proposed, not existing APIs.

```ts
export interface CommittedOutputRef {
  organizationId: string;
  companyId: string; // verified through the owning jobs row
  jobId: string;
  attempt: number;
  identifier: string;
  jobArtifactId: string; // immutable committed row ID, not wire artifactId
  sha256: string;
  byteSize: number;
}
export type PublicationResult =
  | { kind: "asset"; assetId: string }
  | { kind: "artifact_version"; artifactId: string; versionId: string }
  | { kind: "index_generation"; derivativeId: string; generation: number };
export type PublicationState =
  | "awaiting_output" | "preparing" | "published"
  | "cancelled" | "denied" | "unavailable";
export interface PublicationSnapshot {
  id: string; revision: number; state: PublicationState;
  result: PublicationResult | null;
  reason: string | null; // bounded allowlisted code, never raw worker output
}
```

universe_publications stores UUID id, companyId, server-derived organizationId and actorKey, immutable destination JSON, canonical action identity, outputSlot UUID and outputBindingId, protocolVersion and promotionPolicyVersion, intentHash, source-reference snapshot and source hashes, derivativeId nullable, canonicalJobId nullable, CommittedOutputRef nullable, state/revision, leaseEpoch/leaseExpiresAt, reservedObjectKey nullable, verified hash/length/content type, result nullable, publicationPayloadHash nullable, resultProjectedAt nullable, cancellationRequestedAt/cancellationAcknowledgedAt nullable, nextReconcileAt/lastReconcileCode nullable, timestamps. Job IDs/provenance are logical references checked via tenant repository, not cascading foreign keys into distributed tables. Application asset/version references retain canonical integrity checks. Use composite company/id integrity for application references where supported by their canonical schema; never treat a single foreign key as an authorization check. Validate destination/source immutability on every update and deny receipt reassignment. Unique (companyId, canonicalActionIdentity, outputSlot); changed intentHash returns 409. Canonical action identity uses the exact tagged action tuple and persisted server-issued slot in the identity/revocation follow-up. Source/build/config belong to immutable intentHash; never derive identity from a worker attempt, array position or ephemeral run label.

For processing retries: failed/cancelled attempts get a new authorized attempt identity only after prior outcome is known; successful output remains immutable. A transport retry uses the existing identity. An explicit refinement is a new action/version, not an idempotent replay.

The proposed service methods are:
- prepareIntent(authenticatedContext, immutableIntent): Promise<PublicationSnapshot>
- observeOutput(authenticatedContext, publicationId): Promise<PublicationSnapshot> — lookup only, no dispatch/copy/publication.
- reconcilePublication(internalAuthority, publicationId): Promise<PublicationSnapshot> — scheduled/control-plane mutation, not a GET handler.
- cancelPublication(authenticatedContext, publicationId, expectedRevision): Promise<PublicationSnapshot>
- getPublication(authenticatedContext, publicationId): Promise<PublicationSnapshot> — reauthorizes access, does not retry work.

authenticatedContext and internalAuthority are server-resolved capabilities passed by owning routes/services, never request-body objects accepted as credentials. Implementation must bind them to existing actor/permission types in the owning source routes before coding. No public worker-to-application publication endpoint is added. Only the coordinator composition root receives both DB handles; it never nests one connection's transaction inside another.

## Ordered publication protocol

1. **Durable intent and admission.** Authorize sources and destination, store the intent in an application transaction, then leave it before canonical admission. Persist the canonical submission identity/digest before dispatch. If admission reply is lost, query/replay that same canonical submission according to its existing idempotency contract; never generate a fresh key. A missing qualified converter source is a blocker, not permission to create a synthetic task or source enum. Closing a panel is not cancellation.

2. **Observe committed output.** The internal coordinator loads its authorized intent, derives organization from the company, and calls runInTenantReadOnly(tenantDb, organizationId, ...). Load the jobs row and verify company, authenticated source identity and persisted admission binding; load findCommitted for the exact job/attempt/identifier. Require complete immutable object metadata, positive bounded length, expected output slot, allowed kind and matching source/action. Return data only. The wire acknowledgement and versionNumber are insufficient. Consume E2.2's accepted output binding and exact action/slot tuple from the follow-up, not a publisher-created winning attempt. A committed row is necessary but not sufficient: the owning CMD/processor result contract must identify the accepted attempt/output slot. Until that contract is bound, generated publication remains blocked.

3. **Claim preparation.** In an application transaction acquire the required credential/company/action/binding/publication locks in the follow-up's global order, freshly check current authority, accepted binding and state/revision, then record the exact output snapshot and reserve a canonical object key, increase leaseEpoch and set a bounded lease. Leave the transaction before storage I/O. Epoch and payload hash must match on completion; a stale copier cannot publish. Parallel reconcilers may redo the same verified copy but cannot choose different bytes under one receipt.

4. **Promote permitted bytes.** Use internal storage access to the verified committed key, never a worker-supplied URL or signed browser link. Stream with byte/hash/type bounds into a reserved canonical asset object under existing company/organization storage conventions; verify the destination bytes. Reuse E4.1 reservation mechanics through an internal wrapper extended for server-recorded publication keys, without invoking human intake routes or granting worker writes. Promotion is default-deny against an immutable server-owned allowlist tuple: (processorId, processorBuild, registeredOutputSlotSchema, validatedContentType, contentValidatorVersion, hashPolicyVersion, promotionPolicyVersion). No wildcard tuple and no policy supplied by model/worker. Hash policy verifies the exact accepted bytes and durable copy; it is not a content-safety detector. The trusted slot contract must bind permitted source lineage, output schema and retention. Missing tuple or unsupported validation rejects promotion. Always reject browser_cookie_state/browser_storage_state, workspace snapshots/patches, logs, traces and service checkpoints as ordinary user artifact promotion. other is not an exception: it can carry a generated document only after every allowlist predicate and content/provenance validation passes. Add negative fixtures for credential, log and trace material labelled other with spoofed filename/MIME; known forbidden lineage or failed validator must deny. Do not promise detection of arbitrary secrets from a checksum or MIME sniff; an output contract without a defensible validator/source boundary remains unavailable.

5. **Final application commit.** Acquire the authorization barrier, canonical action/claim, accepted output binding and publication locks in the follow-up's global order; freshly reauthorize destination and every required private source inside that transaction and verify the exact accepted reference. Check leaseEpoch, payload hash and state. Asset + derivative pointer or immutable artifact/version + publication receipt + mutation audit commit in one authorized application transaction. E4.3 adds transaction-aware canonical version publication; it must not commit independently of the outer transaction. Unique publication receipt protects first artifact creation as well as later versions; artifact_id/publicationKey alone does not protect duplicate creation of two artifacts. No worker-version number becomes a user artifact version number.

6. **Index publication.** A converter may produce a bounded extraction/index payload; the trusted application service validates and writes chunks in its application-owned universe_asset_index. Staged generation chunks are invisible until the same-DB transaction publishes the generation receipt and active-generation pointer. Large imports may stage in bounded batches; final receipt switch is atomic and read queries require that receipt. For an index result, step 5 must not mark the receipt published with an intermediate asset result: retain preparing until the validated chunks, any canonical backing asset and final index_generation result can be committed together at this final switch. Earlier staged batches never establish readiness. E4.2 owns scoped search/authorization; no worker SQL, Memory write or company-wide fallback. Keep indexing result distinct from preview/asset readiness.

7. **Result projection and recovery.** The receipt is the durable result. E4.1 stage status and E2.2 linked result projection use its exact asset/artifact/version ID. Update projections idempotently after publication; failed notification or reply update leaves published with resultProjectedAt null for reconciliation. Do not repeat generation. If canonical outputRefs already names an authorized exact version, reuse it and record the linkage rather than create another version. A latest-version lookup is never a substitute for missing provenance.

New lookup surfaces return only authorized snapshots. Internal object keys, raw fence tokens, extracted text and private input hashes are excluded from logs/UI. Copy provenance to receipt so deleting a terminal job does not delete a published artifact.

## Cancellation, revocation and retention

The application publication row is the serialization point for publication-versus-stage-cancel. cancelPublication follows the same credential/company/action/binding/publication lock order as final commit: before published, mark cancelled and invalidate the preparation epoch; persist cancellationRequestedAt in that same transaction, then request canonical job cancellation using the same action identity. A reconciler scans cancelled rows with an unacknowledged cancellation request and retries only the stop/observation path; cancellationAcknowledgedAt records canonical acknowledgment or observed terminal completion. This repairs a crash between the local decision and remote stop. Worker cancellation acknowledgment is separate; failure to stop the worker cannot resurrect the publication. After published, return the existing published result; cancellation is not deletion. Canonical generation cancel entry points must coordinate through this decision or provide an equivalent durable accepted-output/cancellation contract before generated publication can ship.

Source/destination revocation must block final publication and every subsequent original/derivative/index read. A preflight check alone is insufficient. The follow-up proposes company-row shared/exclusive authorization barriers plus actual credential/principal-row coordination and ordered final locks. Its initial writer inventory is not exhaustive; all supported writers and credential modes must be bound and tested before acceptance. Current conversation helpers do not already implement that protocol. Direct raw-asset routes apply E4.1 access checks. Broader artifact publication requires an explicit authorized audience decision; it never broadens source or private-source index access.

Worker retention stays owned by existing control-plane policy. A durable canonical copy is a separately authorized promotion with canonical retention; it must never be a pointer into an expiring worker object. If retention removes the source before copying finishes, return unavailable with a specific source-expired reason; do not manufacture success or rerun generation. If bytes were fully copied and verified while authorized, policy/result validity must still allow final commit; expired credentials or forbidden retention cannot be bypassed by a copy. Qualified processor output retention must be long enough for the supported publication window or that processor stays unavailable.

Proposed unmeasured limits reuse E4's 50 MiB output ceiling: 2-minute copy lease, no unbounded buffering, two reconcilers/company and bounded batches of 25 due receipts every 15 seconds while work is pending, 15-minute cleanup sweep. Retry transient observation/copy failures with 2/5/15/30-second backoff capped at 30 seconds and the source's permitted lifetime; surface delayed status after 2 minutes. Never retry validation/access/retention denial automatically. Startup resumes only persisted company-scoped intents, not a scan of all organizations. Cleanup needs an expired lease, no published receipt/reference and a locked tombstone preventing revival; delete reserved objects only. Keep published receipts/provenance for the canonical result lifetime. These limits require capacity/security evidence, not new user budget defaults.

## Qualification bindings still required

| Gate | Exact remaining evidence | Owning existing slice |
|---|---|---|
| Application authority | Approved roles/predicates/schema for derivatives/index/publications/tool grants; generated migration/export order; no aoa_app grant expansion | E4.2/2, E5.2/2 with BASE |
| Processor admission | Real source kind, allowed operation, stable submission identity and authenticated cancellation/result adapter; no fake one_shot operation | E4.2/2 and CMD |
| Accepted generated output | Qualify the follow-up's exact action/UUID slot and accepted binding with real CMD/processor owner adapters, claim/CAS and cancellation tests | E2.2 + E4.3/1 |
| Revocation serialization | Complete follow-up barrier coverage for every production permission/credential writer and prove two-connection ordering | E4.1/E4.2/E4.3 security |
| Retention/promotion | Exact permitted kind/type/processor mapping and supported storage lifetime; reject credential material; durable-copy cleanup race evidence | E4.2/2 + DAT |
| Isolated host grants | Application-scope proposal plus actual frame/host identity, policies and revocation; no authority inferred from publication receipt | E5.2/2 + HOST |

Do not report these as resolved by the design. No user-facing feature scope is cut when a gate is open.

## Implementation ownership and planned tests

E4.2/2 creates the publication schema/validator/service and server/src/__tests__/universe-publication.integration.test.ts, plus existing derivative/index files. It extends server/src/storage/service.ts and types.ts for reserved publication keys, server/src/services/index.ts and packages/db/src/schema/index.ts/shared exports, and wires bounded reconciliation at the actual server lifecycle composition point in server/src/app.ts (disposal on shutdown required). Receipt-only tests do not require E4.3. E4.3/1 supplies the canonical artifact/version writer integration and server/src/__tests__/universe-artifact-publication.integration.test.ts. E2.2 owns durable reply linkage. No reverse dependency requires E4.2's common producer to wait for artifact UI. E4.2 implements the asset/index publisher; E4.3 supplies a statically registered trusted artifact/version transaction callback at the composition root, using the same application transaction and receipt lock. It is never a model- or worker-selected callback. Common producer tests use asset results until the E4.3 integration is available.

E5.2/2 retains its files but proposes application-scoped grants/action links with explicit user/company/conversation/instance checks. It receives no direct publication, DB or provider capability from this change. E4.1 human API and task attachment adapter remain unchanged.

Planned regression matrix, run only after authorization and implementation:

| Scenario | Required observation |
|---|---|
| Two reconcilers / lost publication response | One asset/version and one audit/receipt; lookup returns identical result; generator invoked zero additional times |
| Different payload under same intent | 409 and no overwritten bytes/reference |
| Worker ordinal collision / multiple attempts | Exact committed-row identity and admitted slot used; wrong/superseded attempt denied |
| granted / quarantined / expired / thin row | No publication, no false ready |
| Cancel before copy, during copy, before commit | No canonical result; stale epoch denied; canonical stop retried without restarting work |
| Cancel after commit | Existing result remains; no deletion |
| Crash after intent, admission, reservation, copy, canonical commit, result projection | Recover same operation; no silent loss, duplicate output, or paid retry |
| Worker source expires / job deleted | Before complete copy: unavailable; published canonical result stays recoverable independently |
| Same organization, different company; same company, different user | Deny raw bytes, metadata, preview, index counts/snippets and receipt lookup |
| Revoke during copy/commit or cached read | Serialized decision and immediate read denial; no late republish |
| Shared derived artifact | Explicit audience sees output only; private original and private index remain denied |
| other-kind credential/log/trace payload with spoofed filename/type, missing policy tuple or forbidden lineage | Default-deny tuple/content/provenance checks; checksum alone never establishes safety |
| Stale copy lease versus cleanup | Either receipt/reference protects object or tombstone prevents publish; never published missing bytes |
| Projection failure after commit | Durable receipt remains published, reply repairs idempotently |
| Index crash before/after receipt switch | No partial generation visible; prior generation stays consistent or new whole generation appears |

Use real Linux PostgreSQL with application and actual non-owner pools, authenticated identities, local disk and S3/MinIO fault fixtures. Existing artifact-transfer-commit.integration.test.ts supplies protocol expectations, not permission to import its private fixtures. Qualify application transaction rollback including canonical writer savepoints/audit. Then run owning integration suites, authenticated E4 UI journeys and repository typecheck/tests/build under the later approved execution scope. No such tests have run for this proposal.

Static callback verification: implementation review must trace the artifact/version publisher registration to trusted source imports at the composition root. Negative tests submit forged publisher names/operation tags in worker/model/frame data and prove they cannot select a callback or gain a different writer. No dynamic import/eval/plugin registry is introduced here.

## Migration and rollback boundary

Generate all new tables/columns/indexes/FKs with Drizzle, export through the canonical DB/shared registries, and rehearse mixed readers before enabling reconciliation. No job schema, frozen worker protocol, legacy grant manifest or tenant repository surface changes are part of this proposal. If an actual producer qualification requires one, bring it back as a separate upstream change instead of including it implicitly. Application security acceptance must identify the exact connection role and every route/service predicate.

Rollback disables new intent/admission/promotion, while retaining authorized reads, receipt lookup, cancellation delivery, already-published result projection repair and safe reserved-object cleanup. Do not turn off lookup with the worker dispatcher or delete receipts on downgrade. Record policy/version on each intent so an unsupported pending operation stays visibly blocked rather than being interpreted using new rules. Premature implementation stays excluded.

## Author self-review and handoff

Checked source: existing committed natural identity and ordinal collision; nullable/thin rows; company lookup under tenant boundary; canonical writers and SELECT-only legacy grants; control-plane retention; frozen one_shot kinds; callback-local transactions. Chose per-store application records rather than new organization ledgers merely because processing uses a worker. Added explicit publication/cancel ordering, first-artifact deduplication, expiring-source copy, private-serving checks, index receipt visibility and projection repair.

This is a detailed proposal with named qualifications, not a claim all coding bindings are complete. Security reviewer and upstream owners remain unassigned. TK-managed independent review should challenge the proposed application data classification, exact output authority, cancellation/revocation races and durability before acceptance. No implementation is authorized.

## Reconciliation review closure

The [follow-up review](worker-publication-reconciliation-review-report.md) closes the consistency review at a033e17c0. The [qualification record](worker-publication-qualification.md) controls remaining CMD binding, writer/credential coverage, dependency-direction and contention evidence. M2 is design-resolved; actual processor contracts still require validation. M1/M3 remain qualification-gated. No runtime or implementation approval follows.
