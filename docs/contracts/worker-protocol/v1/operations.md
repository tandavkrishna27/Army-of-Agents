# Worker Protocol v1 — Operation Matrix

This document is the human-readable mirror of `OPERATION_DESCRIPTORS` in
`packages/worker-protocol/src/transport.ts`. There is exactly one row per
framework-neutral operation. The package contract test
(`src/contract.test.ts`) parses the operation column below and asserts it is
byte-for-byte the exported `WORKER_PROTOCOL_OPERATIONS` set — every exported
operation has a row and every row is an exported operation, so an operation can
never be silently undocumented.

Transport is framework-neutral: HTTP method/path/status live in the deployment,
not in the protocol package. Every request wrapper NESTS the strict PRT-003/004/
005 domain payload as `body`; a bare payload is never an authenticated request.
Every request carries `protocolVersion`, a correlation ID, an anti-replay
`issuedAt` timestamp + `nonce`, and its bound audience literal; a mutating
operation additionally carries an `idempotencyKey`. Responses carry `serverTime`,
and `retryAfterMs` where a retry is meaningful. Payload ceilings, client
timeouts, retry rules, and stable errors are contract facts recorded here and in
the descriptor registry, not wire fields.

Every operation's error envelope is the stable `ProtocolErrorV1` (`errors.ts`).
Error `detail` is bounded and redacted (`redaction: "secret"`), credential-
bearing keys are rejected recursively, and no error discloses whether a
foreign-tenant resource exists — an unauthorized caller and a missing resource
are indistinguishable. Only `throttled` and `internal_unavailable` carry a
bounded `retryAfterMs`.

| Operation | Request | Success / no-work response | Auth audience | Correlation / idempotency | Retry rule | Payload ceiling | Client timeout | Stable errors | Redaction / existence | Control ACK |
|---|---|---|---|---|---|---|---|---|---|---|
| `enrollment` | `EnrollmentRequestV1` nests `WorkerHelloV1` | `enrolled` \| `rejected` | `target_enrollment` | correlationId + idempotencyKey | idempotent_retry | 256 KiB | 15 s | malformed, unauthorized, incompatible_protocol, incompatible_policy, throttled, internal_unavailable | secret; no target-existence disclosure | n/a |
| `poll` | `PollRequestV1` (workerId + capacity) | `offer` (nests `LeaseOfferV1`) \| `no_work` (retryAfterMs) \| `drain` | `worker_poll` | correlationId only (safe read) | safe_read | 64 KiB | 30 s | malformed, unauthorized, incompatible_protocol, incompatible_capability, incompatible_policy, target_revoked, throttled, internal_unavailable | secret; no job/tenant disclosure | n/a |
| `lease_ack` | `LeaseAckOperationRequestV1` nests `LeaseAckV1` | `acknowledged` \| `rejected` | `worker_run` | correlationId + idempotencyKey | idempotent_retry | 64 KiB | 15 s | malformed, unauthorized, stale_fence, target_revoked, attempt_terminal, throttled, internal_unavailable | secret | n/a |
| `lease_renew` | `LeaseRenewOperationRequestV1` nests `LeaseRenewRequestV1` | `renewed` (nests `LeaseRenewResponseV1`, echoes identity) \| `rejected` | `worker_run` | correlationId + idempotencyKey | idempotent_retry | 64 KiB | 15 s | malformed, unauthorized, stale_fence, target_revoked, attempt_terminal, throttled, internal_unavailable | secret | n/a |
| `event_upload` | `EventUploadOperationRequestV1` nests `WorkerEventBatchV1` | `WorkerEventAckV1` (accepted \| gap \| hash_mismatch \| stale_fence \| target_revoked \| terminal) | `worker_run` | correlationId + idempotencyKey | idempotent_retry | 4 MiB | 30 s | malformed, unauthorized, stale_fence, sequence_gap, event_hash_mismatch, target_revoked, attempt_terminal, payload_too_large, throttled, internal_unavailable | secret | n/a |
| `artifact_transfer_grant` | `ArtifactTransferGrantOperationRequestV1` nests `ArtifactTransferGrantRequestV1` | `upload_granted` \| `download_granted` \| `rejected` (closed pairing) | `worker_run` | correlationId + idempotencyKey | idempotent_retry | 64 KiB | 15 s | malformed, unauthorized, stale_fence, target_revoked, payload_too_large, throttled, internal_unavailable | secret; grants carry `redaction: "secret"`, no credential headers | n/a |
| `artifact_commit` | `ArtifactCommitOperationRequestV1` nests `ArtifactCommitPayloadV1` | `committed` \| `rejected` (never converts to quarantine) | `worker_run` | correlationId + idempotencyKey | idempotent_retry | 256 KiB | 15 s | malformed, unauthorized, stale_fence, target_revoked, attempt_terminal, throttled, internal_unavailable | secret | n/a |
| `quarantine_grant` | `QuarantineGrantOperationRequestV1` nests `QuarantineGrantPayloadV1` | `quarantine_upload_granted` (≤5-min PUT grant) \| `rejected` | `device_session` | correlationId + idempotencyKey | idempotent_retry | 64 KiB | 15 s | malformed, unauthorized, target_revoked, payload_too_large, throttled, internal_unavailable | secret; distinct quarantine prefix, no live-lease claim | n/a |
| `quarantine_finalize` | `QuarantineFinalizeOperationRequestV1` nests `QuarantineFinalizePayloadV1` | `quarantined` (nests `QuarantineUploadReceiptV1`) \| `rejected` | `device_session` | correlationId + idempotencyKey | idempotent_retry | 256 KiB | 15 s | malformed, unauthorized, target_revoked, event_hash_mismatch, payload_too_large, throttled, internal_unavailable | secret; verifies stored hash/size/prefix before receipt | n/a |
| `control_command` | `ControlCommandV1` (cancel \| product_approval_result \| runtime_decision_result \| checkpoint \| graceful_stop \| drain) | `ControlCommandAckV1` (accepted \| completed \| rejected \| stale) | `control_channel` | correlationId + commandId/commandSeq + idempotencyKey | idempotent_retry | 256 KiB | 15 s | malformed, unauthorized, stale_fence, attempt_terminal, throttled, internal_unavailable | secret; product approvals and runtime decisions are separate, versioned, idempotent, not worker-creatable, not conflatable | `ControlCommandAckV1` echoes commandId + commandSeq; a lost ACK is safely re-delivered without duplicating the durable effect |
