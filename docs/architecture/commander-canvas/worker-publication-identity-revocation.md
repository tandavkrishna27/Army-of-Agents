# Worker publication — output identity and revocation follow-up

**Planning proposal; security/CMD acceptance and runtime qualification remain open.** This adds concrete contracts for M1/M3 from the [received worker-publication review](worker-publication-review-report.md). It supplements the [publication plan](worker-publication-plan.md), not the accepted human-intake data classification. No code or tests have run.

## M1 — Stable action, slot and accepted-output binding

Use a server-persisted action identity independent of execution attempts:
- Commander generation: canonical conversationId + persisted userMessageId. E2.2's submission idempotency must resolve repeated transport submissions to the same message before creating a publication intent.
- Processing: persisted derivativeId + authorized processingAttempt number. Retrying a failed stage explicitly advances this number; transport/reconciliation retries never do.
- Other generation sources must provide an equivalently durable canonical action before admission; do not substitute runId, reply text, timestamp or array position.

Define canonicalActionIdentity as SHA-256 of UTF-8 JSON of the exact ordered tuple:
```ts
type PublicationAction =
  | ["universe-action-v1", string, "commander", string, string]
  // companyId, conversationId, userMessageId
  | ["universe-action-v1", string, "processing", string, number];
  // companyId, derivativeId, processingAttempt
```
Validate UUIDs and normalize to canonical lowercase UUID strings before encoding; attempt is a positive safe integer. JSON array encoding supplies unambiguous boundaries and type tags. Immutable intentHash separately binds source versions/hashes, processor/build/config, destination, output format and promotion-policy version. Reusing an action/slot with different intentHash conflicts. Never compute the action digest from mutable processor output.

Output slots are server-issued UUIDs persisted with the canonical action *before dispatch*, not ordinal positions discovered from returned results. An action has an immutable allowed slot set. Each slot carries its format/schema and promotion-policy identity. A requested additional output after admission requires a new explicit canonical action, or a separately reviewed canonical action-extension protocol; it cannot appear merely because a worker returned an extra file.

E2.2 owns proposed packages/db/src/schema/universe_output_bindings.ts and server/src/services/internal-agent/output-binding.ts. Bindings are application-owned, keyed uniquely by (companyId, canonicalActionIdentity, outputSlot), with server actor/destination, intentHash, state pending/accepted/cancelled, revision, immutable expected format/policy, accepted CommittedOutputRef nullable, acceptedAt and timestamps. Retain provenance independently of job deletion. E4.2 processing uses the same service with the processing action variant; the service module has no dependency on E4 publication or artifact UI. Add shared validators to the existing proposed universe-publication validator module; shared types create no reverse runtime dependency.

Only the canonical action owner can call the proposed acceptOutput(bindingId, expectedRevision, verifiedCompletion). Before the application transaction, its qualified adapter reads the exact committed jobArtifact row using the non-owner tenant repository and validates the canonical action/job/attempt/slot association, complete metadata and permitted result outcome. Verified completion is server-internal data, never trusted from a worker callback payload or model output. Within the application transaction, follow M3's credential/company/action/binding lock order, freshly recheck authorization, current canonical action ownership/claim and cancellation, lock the binding and persist the exact immutable accepted reference with a CAS. A pending binding accepts once. Same accepted reference replay returns it; another reference conflicts. A cancelled binding cannot accept. Copy/observation services cannot mark a binding accepted.

A committed worker object alone is not a verified completion. For Commander, the pinned conversation service exposes claimTurn/finishTurn with a claim token, but the current finishTurn only updates turnStatus; it is not this acceptance operation. E2.2 must introduce a transaction-aware canonical result-acceptance method that checks current turn-claim ownership and writes the output binding with the canonical result decision. Replatform distributed acceptance must provide its authoritative result adapter; a query of the latest attempt or successful-looking worker event is not equivalent. Result acceptance here means authoritatively accepting the worker output identity, not declaring an application artifact published or completing the reply. E4 later creates the canonical artifact and repairs the reply projection; this separation prevents an E2/E4 acceptance cycle. The exact integration is still CMD-gated. Processing admission likewise needs the actual permitted source adapter; no fabricated one_shot kind.

Final publication follows M3's global order, including binding before publication locks and verifies accepted reference/hash/intent match. Canonical cancellation before publication acquires those same locks, changes binding to cancelled and cancels preparation; after published it returns the saved result without replacing its accepted reference. No independent writer may supersede an accepted binding behind the publisher. A new refinement/retry uses a new action/slot identity; it does not mutate an existing published binding. This application acceptance decision is the publication authority, not an unsupported claim of atomicity with worker transactions.

Required M1 regressions: same submission replay resolves same action/slot; changed source/config under same key conflicts; distinct canonical actions do not collide; parallel accept of different attempts has one accepted result and a conflict; stale claim cannot accept; cancel-first rejects acceptance; accept-first/cancel-before-publication blocks publication; worker ordinal collisions do not affect identity; extra/unregistered slot denied; crash after accepted binding recovers the same first artifact/version; projection retry never creates a new action.

## M3 — Authorization barrier and writer coverage

The source has multiple access authorities. Verified initial inventory at pinned 183e46a9c:
- server/src/routes/conversation-authz.ts: resolveActorRole/loadOwnedConversation preserve interactive-board founder/admin exceptions and restrict bearer callers to owner scope. Do not replace this with company membership alone or silently remove the existing founder policy.
- server/src/services/permissions.ts: userRoles determine effective role and are mutable.
- server/src/services/access.ts, team.ts, org-hierarchy.ts and server/src/board-claim.ts write membership/grant state.
- server/src/routes/internal-agent.ts hard-deletes conversations; conversation.ts resets/archives them. Archive is not automatically revocation: enforce the canonical access semantics.
- server/src/services/threads.ts writes/removes participants; server/src/routes/discussions.ts revokes share tokens.
- server/src/services/companies.ts performs company teardown and removes memberships/grants.
- server/src/routes/authz.ts and middleware/auth.ts supply deployment-dependent credential/session/admin authority. Their cached request actor is not sufficient for a later background publication.

This is a verified seed inventory, not an exhaustive writer certification. Include direct DB writers, bulk/admin/bootstrap and alternate routes, credential/session/API-key revocation and deployment authority changes when completing the migration plan. Tests/fixtures are separate from production coverage.

Recommended application authorization barrier: use the existing companies row as a company-wide shared/exclusive lock, avoiding a second ACL truth store. Publication obtains a shared row lock, then freshly evaluates canonical company/actor/destination/source permissions inside the same application transaction. Every application writer that can change those permissions obtains an exclusive company-row lock before changing authoritative rows and commits both together. For multi-company administrative mutations lock companies in sorted UUID order. Company deletion already conflicts with the row lock, but its surrounding role/grant cleanup must follow the same order. Publication checks existence; a deleted company never causes implicit recreation.

Global identity/session/key/admin authority cannot be protected by a company row alone. A supported credential mode must acquire shared locks on its actual authoritative credential/principal rows before the company barrier; revocation writers acquire conflicting locks on the same rows in the same order. If the authority is external, cached-only, or cannot participate atomically, bind a durable locally authoritative revocation mechanism with its real issuer before supporting background publication for that mode. Do not claim a stale req.actor or expiration timestamp proves current permission. This credential-mode mapping remains a security qualification, not a new global permission table or silent policy relaxation.

Lock order for participating application paths: credential/principal authority rows (stable type/id order), company rows (UUID order), canonical action/claim row, output binding, publication receipt, destination/source rows (stable type/id order), artifact/version/index rows. A writer requiring only a subset follows the same relative order. CAS checks occur after locking. No tenant DB transaction, converter or storage/network copy is opened while holding this final application transaction. Fresh role/destination queries follow the company lock, so deletion of an ACL row cannot bypass protection merely because there is no row left to lock.

The guarantee is ordering at the database decision: revoke commits first → publication denied; publication commits first → result was authorized at that instant, and subsequent reads are denied after revocation. Revocation cannot recall bytes already delivered. Authorized read/cache-hit paths recheck current policy before releasing new data; a long stream needs a separately qualified cancellation/chunk policy and cannot promise recall of bytes in flight. Do not hold DB locks over network streams.

For index publication, staged chunks stay invisible until the final generation switch under the same barrier; read queries require the committed receipt and current permission. Broad sharing is a separate canonical permission mutation and must not change private-source lineage/index audience. For raw asset/preview routes, E4.1's guard consumes the same canonical authorization service, including intended founder/bearer distinctions.

E4.1/E4.2 security work owns proposed server/src/services/universe-publication-auth.ts and server/src/__tests__/universe-publication-revocation.integration.test.ts; extract transaction-aware policy helpers from actual route/service owners rather than construct a fake Request or trust client fields. Before coding, record every production writer as file/function, authority rows, lock order, credential modes, owning upstream slice and negative test. If any active writer cannot join the barrier, that destination/credential mode remains gated. This requires explicit upstream changes and review; the current source is not claimed to implement the barrier.

Required M3 tests use two real application DB connections and deterministic pauses: publication-before-revoke and revoke-before-publication for role demotion, company removal, conversation deletion, participant removal, grant/share-token revocation and each supported credential mode; cached actor/cache-hit after revoke; denied same-company bearer impersonation of a founder; company teardown; sorted multi-company mutations; expired/replaced copy lease; index receipt switch; connection pool reuse. Assert allowed founder access separately from denied unrelated users. No sleeps as race proofs; use barriers and inspect committed records.

## Review disposition and acceptance boundary

M1 and M3 are now more concrete *proposed* contracts with exact identity, acceptance and lock ordering. Their production adapter/writer coverage, security acceptance and real concurrency evidence remain open. M2's strict promotion allowlist is tightened in the main worker-publication plan. LOW-1 is rejected: the composite job FK explicitly calls onDelete("cascade") at the pinned source. LOW-2 is accepted as a static registration/negative-dispatch implementation check.

No review or qualification gate is marked passed by writing this follow-up. Independent review should focus on cross-connection acceptance, lock order/coverage, source-policy preservation and whether any claimed guarantee exceeds the named prerequisites. No provider execution or implementation is authorized.

## Reconciliation review outcome

The [review of a033e17c0](worker-publication-reconciliation-review-report.md) confirms these proposed contracts are consistent. The [qualification record](worker-publication-qualification.md) supplies the expanded writer/credential inventory, precise existing-versus-missing Commander seams and contention checks. Lock order is a proposed safeguard, not proven deadlock freedom. No runtime gate is closed.
