# Distributed Execution Authority and Synchronization

## Authority matrix

| State | Authority | Worker behavior |
|---|---|---|
| Organizations, memberships, policy, jobs, leases, costs, audit | Control-plane PostgreSQL | Read through scoped envelopes/APIs; append events only |
| Memory items, visibility, retrieval audit, actor scope | Control-plane PostgreSQL and memory services | Consume an authorized immutable context input or scoped API; never query memory tables |
| Connector OAuth grants, refresh leases, token bundles | Control-plane MCP OAuth broker | Request a lease-scoped opaque handle; never receive refresh-token authority |
| Source history | Customer-declared Git remote/repository | Stage declared base; return patch or commit metadata |
| Snapshots, logs, traces, downloads, checkpoints, artifacts | S3-compatible object storage | Transfer through short-lived prefix-scoped grants |
| Unacknowledged worker events | Encrypted worker SQLite outbox | Retain until cumulative ACK |
| Sandbox filesystem | Ephemeral cache | Never authoritative after lease loss or sandbox termination |

No AoA database is a peer replica. Desktop and cloud workers synchronize envelopes, authorized context inputs, events, manifests, patches, and artifacts—not database rows. Memory visibility remains governed by Decisions #118/#119. Connector discovery, token refresh, rotation, and revocation remain control-plane-owned.

## Single-writer cutover

Each run has `ExecutionOwner = legacy | distributed`. The owner is selected atomically before any execution side effect. Shadow mode may compare routing and policy but cannot lease, fetch secrets, start a sandbox, or emit externally visible effects. Cutover may be deployment- and Organization-scoped. Rollback stops new distributed jobs and explicitly drains or cancels active attempts; it never silently hands an active run to the other owner.

## Worker event synchronization

Workers append events identified by job, attempt, lease, event ID, and monotonically increasing sequence. PostgreSQL uniquely enforces event ID and sequence. The control plane returns cumulative acknowledgement. Duplicate batches are harmless; gaps are rejected with the next expected sequence.

## Workspace and artifact synchronization

Inputs use immutable manifests with base hashes. Large bytes move directly through object storage. Coding output is a patch or commit tied to a base hash. Browser state and service checkpoints have sensitivity and retention metadata. Artifact promotion requires the current fence and verified object prefix, size, and hash.

## Late and orphan output

Expired or replaced attempts cannot update authoritative state. A late patch, trace, or checkpoint may be uploaded only to a quarantine prefix and surfaced for human reconciliation. It is never auto-applied or selected as the service recovery checkpoint.
