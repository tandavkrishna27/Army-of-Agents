> Current scope authority: [master scope](master-scope.md). Source revisions, tests and unresolved integration dependencies: [code evidence](code-evidence.md). This companion describes planned behavior unless explicitly evidenced.

# Artifact ingestion and processing contract — proposal

Extends the [format matrix](format-matrix.md), [request contract](request-contract.md) and existing canonical artifact/version services. This is a design contract, not a replacement storage implementation. Exact fields and transitions must be reconciled with AoA and replatform schemas before coding.

## Accepted human-upload experience

TK accepted reusing AoA's existing company-scoped asset system for human originals. The new E4.1 intake/parts records use the application boundary and canonical asset writer; company, initiating actor and current destination permissions remain required. Company membership alone never grants access to a private-conversation source. Original bytes stay downloadable after publication even when preview/extraction/indexing fails. Reopening a panel uses its canonical reference; editing/generation creates a distinct output/version. Sharing a derived presentation does not automatically share the private PDF used to create it; explicit broader publication records its own access/lineage decision.

The existing task-comment attachment adapter remains canonical where resumable asset references are not yet supported; do not bypass that route or pretend every destination already shares the new upload API. Source authorization is checked at read, processing admission and publication. Background workers use separately reviewed job grants/publication receipts; human-upload authority does not grant them arbitrary asset writes. These are accepted requirements and proposed implementation behavior, not claims that all current routes already enforce them.

## Ownership and entry paths

Accept files from user upload, authorized connector retrieval or governed worker generation. Each intake records company, initiating actor, conversation/task linkage, source, declared filename/type and request identity. Server authorization precedes upload-session issuance and is rechecked before publication. A connector or worker cannot choose an arbitrary company destination.

Large uploads use bounded resumable transfers. Temporary upload identity is distinct from published artifact identity. Verify actual bytes, size, completion and type before publishing; an extension or browser MIME declaration is only a hint. Incomplete uploads expire and are cleaned up. Retried finalization returns the same result through idempotency.

## Independent stages

| Stage | Outcome | Failure behavior |
|---|---|---|
| Transfer / generation | Candidate bytes staged | Retry safe transfer/generation behavior under the request contract; do not present incomplete output as ready |
| Validation | Type, limits and applicable policy checks passed | Reject or quarantine with an actionable reason; no active preview or extraction of rejected material |
| Canonical publication | Immutable authorized file/version and provenance recorded | Publication must not reference incomplete/unavailable bytes; reconcile orphaned storage objects on failure |
| Extraction | Text, metadata, timestamps or structured values | Mark understanding unavailable/partial; preserve allowed original |
| Preview / transcode | Displayable derivative and metadata | Mark preview unavailable; allow authorized original download; retry derivative independently |
| Indexing / discovery | Searchable authorized references | Do not imply successful indexing before acknowledgement; failure does not erase canonical file |

Extraction and preview may run independently after validation/publication. Not all formats support every stage. Generated artifacts must satisfy the same validation, provenance and access guarantees as uploads; their worker admission/commit protocol remains distinct from the human-intake transaction. A partial generation attempt is not silently promoted as a successful final artifact.

## Canonical and derived identity

Canonical versions preserve original bytes, integrity hash, MIME/type validation, size, source provenance and ownership links. Never overwrite an existing version during conversion. A derivative records source artifact/version, processor identifier/version, normalized configuration, output identity and status. Deduplicate processing by those inputs within authorized scope; content hashes must not become cross-tenant existence or access signals.

Use selected E4.1 A's storage reservation and canonical application transaction for human intake; use the separately reviewed worker artifact commit/receipt protocol for generated outputs; do not claim a single transaction across both systems. Cleanup must distinguish referenced canonical files from abandoned staging and obsolete derivatives.

## Worker processing

Dispatch converters/extractors through governed execution with resource limits for bytes, pages, pixels, frames, extracted text, archive expansion, time and concurrency. Report truncation explicitly. Restrict network access, disable macro/script execution and prevent archive path traversal and recursive expansion abuse. Extracted content remains untrusted data when delivered to Commander.

Select processors from the versioned format-capability registry, not arbitrary uploaded commands. Preserve processor/build identity for reproducibility. Unsupported codecs/fonts/features produce a declared limitation or fallback, not guessed success. Native export acceptance includes reopening and checking the generated file; a preview alone does not prove editability.

## Delivery and UX

Return the canonical reference as soon as safely published, with separate extraction/preview progress. Show file ready, preview processing, partial extraction or unsupported preview distinctly. Serve downloads/previews through current authorization checks or appropriately scoped short-lived delivery mechanisms. Derived content inherits source access; source revocation invalidates future retrieval and cached access where controllable.

Large documents render incrementally; media uses compatible derivatives/range access where supported. Preserve original downloads and indicate conversion fidelity limitations. Opening a file never executes its embedded code. Hidden panels may suspend rendering while processing jobs continue.

## Retry, cancellation and retention

Retries use a stable processing identity and bounded policy. A preview retry never regenerates a successful presentation or image. Provider generation timeouts require outcome reconciliation where possible before another potentially billable generation. Cancellation is stage-aware: terminate the selected work and report what already exists; do not delete published artifacts implicitly.

Retention and deletion follow company policy and canonical references, including derivatives, extraction/index data and temporary objects. Removing a canvas panel is not file deletion. Deleting a canonical version propagates to its derived-access paths; external downloaded copies cannot be recalled. Exact retention periods and provider deletion behavior remain policy/integration decisions.

## Acceptance tests

1. Upload interruption/resume and repeated finalization create one canonical result.
2. Forged MIME, malformed/encrypted/oversized input produces an honest state and safe fallback.
3. Publication/storage failure leaves no visible broken canonical reference; orphan cleanup is safe.
4. Preview failure preserves downloadable original and retries only preview.
5. Two workers processing the same version do not publish conflicting derivatives.
6. Unsupported codecs, missing fonts and output truncation are visible.
7. Cross-company references and revoked access deny canonical and derivative retrieval.
8. Archive traversal, excessive expansion and active embedded content cannot escape worker bounds.
9. Artifact revision preserves original and links new output to its source request/version.
10. Generated native files reopen correctly; preview, extraction and export capabilities are checked separately.
11. Cancelling processing does not delete an already published version or cancel unrelated tasks.
12. Long-session media/document rendering remains bounded while background processing continues.

The scope synthesis and replatform dependency map are now recorded in master-scope.md and code-evidence.md. Existing rendering tests do not validate this new processing pipeline. Implementation and its stage-recovery tests remain outstanding.

## Proposed worker-to-canonical publication boundary

The [worker-publication addendum](worker-publication-plan.md) recommends existing non-owner committed worker outputs feeding a separately authorized application publisher. It verifies exact admitted output identity, promotes permitted bytes into durable canonical storage, and commits one result/receipt/audit. Worker version numbers are not application version identity; temporary object retention is not canonical retention. Application processing/index/receipt state is proposed company/actor/destination-scoped; this needs independent/security acceptance. Cancellation, revocation, cleanup and result repair are explicitly specified there. Human intake A, task attachment authority and private-source guarantees remain unchanged.
