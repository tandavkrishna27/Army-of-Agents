import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ARTIFACT_COMMIT_OUTCOMES,
  ARTIFACT_TRANSFER_GRANT_OUTCOMES,
  AUTH_AUDIENCES,
  CONTROL_ACK_STATUSES,
  CONTROL_COMMAND_KINDS,
  CONTROL_RECEIVER_DECISIONS,
  EVENT_RECEIVER_DECISIONS,
  OPERATION_DESCRIPTORS,
  PERMISSION_DECISIONS,
  POLL_RESPONSE_OUTCOMES,
  PRODUCT_APPROVAL_DECISIONS,
  WORKER_PROTOCOL_OPERATIONS,
  WORK_QUESTION_OUTCOMES,
  artifactCommitOperationRequestV1Schema,
  artifactCommitOperationResponseV1Schema,
  artifactTransferGrantOperationRequestV1Schema,
  artifactTransferGrantOperationResponseV1Schema,
  controlCommandAckV1Schema,
  controlCommandV1Schema,
  decideControlReceiverV1,
  decideEventReceiverV1,
  enrollmentRequestV1Schema,
  enrollmentResponseV1Schema,
  eventUploadOperationRequestV1Schema,
  eventUploadOperationResponseV1Schema,
  isTransferGrantResponsePairedV1,
  leaseAckOperationRequestV1Schema,
  leaseAckOperationResponseV1Schema,
  leaseRenewOperationRequestV1Schema,
  leaseRenewOperationResponseV1Schema,
  matchRuntimeDecisionResultToRequestV1,
  pollRequestV1Schema,
  pollResponseV1Schema,
  productApprovalAuthorizesActionV1,
  productApprovalResultV1Schema,
  quarantineFinalizeOperationRequestV1Schema,
  quarantineFinalizeOperationResponseV1Schema,
  quarantineGrantOperationRequestV1Schema,
  quarantineGrantOperationResponseV1Schema,
  runtimeDecisionResultV1Schema,
} from "./transport.js";
import { PROTOCOL_ERROR_CODES } from "./errors.js";

// -----------------------------------------------------------------------------
// Shared valid fixtures. The heavy nested bodies (job, lease offer, event batch,
// worker hello/capacity) are loaded from the frozen conformance corpus; the
// lease/artifact/quarantine/control payloads are built inline with a coherent ID
// set so cross-field invariants hold.
// -----------------------------------------------------------------------------

const conformance = JSON.parse(
  readFileSync(new URL("../../../docs/contracts/worker-protocol/v1/conformance.json", import.meta.url)).toString("utf8"),
) as { cases: Array<{ name: string; schema: string; valid: boolean; input: Record<string, unknown> }> };

function conformanceInput(name: string): Record<string, unknown> {
  const c = conformance.cases.find((x) => x.name === name);
  if (!c) throw new Error(`missing conformance case: ${name}`);
  return structuredClone(c.input);
}

const validJob = () => conformanceInput("valid task-run batch job");
const validLeaseOffer = () => conformanceInput("valid lease offer");
const validEventBatch = () => conformanceInput("valid contiguous event batch");
const validTargetPair = () => conformanceInput("valid registered target plus worker hello intersection");

const ORG = "00000000-0000-4000-8000-000000000201";
const COMPANY = "00000000-0000-4000-8000-000000000202";
const WORKER = "00000000-0000-4000-8000-000000000203";
const JOB = "00000000-0000-4000-8000-000000000204";
const LEASE = "00000000-0000-4000-8000-000000000205";
const TARGET = "00000000-0000-4000-8000-000000000206";
const ARTIFACT = "00000000-0000-4000-8000-000000000207";
const CORRELATION = "00000000-0000-4000-8000-000000000208";
const IDEMPOTENCY = "00000000-0000-4000-8000-000000000209";
const REQUEST_ID = "00000000-0000-4000-8000-00000000020a";
const APPROVAL_ID = "00000000-0000-4000-8000-00000000020b";
const RECEIPT_ID = "00000000-0000-4000-8000-00000000020c";
const AGENT = "00000000-0000-4000-8000-00000000020d";
const FENCE = "fencePRT007AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SHA = "a".repeat(64);
const SHA_B = "b".repeat(64);
const T0 = "2026-08-09T00:00:00.000Z";
const T1 = "2026-08-09T01:00:00.000Z";
const T_LATE = "2026-08-09T02:00:00.000Z";
const AGENT_PRINCIPAL = { principalType: "agent", principalId: AGENT };

function requestBase(): Record<string, unknown> {
  return { protocolVersion: 1, correlationId: CORRELATION, issuedAt: T0, nonce: "nonce-1" };
}

const leaseAckBody = () => ({
  protocolVersion: 1,
  workerId: WORKER,
  jobId: JOB,
  attempt: 1,
  leaseId: LEASE,
  fenceToken: FENCE,
  ackedAt: T0,
});

const leaseRenewRequestBody = () => ({
  protocolVersion: 1,
  workerId: WORKER,
  jobId: JOB,
  attempt: 1,
  leaseId: LEASE,
  fenceToken: FENCE,
  observedAt: T0,
});

const leaseRenewResponseBody = () => ({
  protocolVersion: 1,
  workerId: WORKER,
  jobId: JOB,
  attempt: 1,
  leaseId: LEASE,
  fenceToken: FENCE,
  expiresAt: T1,
  cancelRequested: false,
  cancelReason: null,
});

const attemptPrefix = `organizations/${ORG}/jobs/${JOB}/attempts/1`;
const quarantinePrefix = `quarantine/organizations/${ORG}/jobs/${JOB}/attempts/1`;

const eventBatchBody = () => ({
  protocolVersion: 1,
  organizationId: ORG,
  companyId: COMPANY,
  workerId: WORKER,
  jobId: JOB,
  attempt: 1,
  leaseId: LEASE,
  fenceToken: FENCE,
  events: [
    {
      protocolVersion: 1,
      eventId: "00000000-0000-4000-8000-000000000301",
      organizationId: ORG,
      companyId: COMPANY,
      workerId: WORKER,
      jobId: JOB,
      attempt: 1,
      leaseId: LEASE,
      fenceToken: FENCE,
      seq: 1,
      eventDigest: SHA,
      occurredAt: T0,
      extensions: [],
      eventType: "progress",
      payload: { message: "working", percent: 40 },
    },
  ],
});

const eventAck = () => ({
  protocolVersion: 1,
  organizationId: ORG,
  companyId: COMPANY,
  workerId: WORKER,
  jobId: JOB,
  attempt: 1,
  leaseId: LEASE,
  fenceToken: FENCE,
  acceptedThroughSeq: 1,
  expectedNextSeq: 2,
  status: "accepted",
});

const transferGrantRequestBody = (operation: "upload" | "download") => ({
  protocolVersion: 1,
  operation,
  workerId: WORKER,
  jobId: JOB,
  attempt: 1,
  leaseId: LEASE,
  fenceToken: FENCE,
  artifactId: ARTIFACT,
  expectedObjectKey: `${attemptPrefix}/out.txt`,
  expectedSha256: SHA,
  maxBytes: 4096,
});

const uploadGrant = () => ({
  protocolVersion: 1,
  operation: "upload",
  artifactId: ARTIFACT,
  method: "PUT",
  url: "https://storage.example.com/put",
  headers: {},
  issuedAt: T0,
  expiresAt: T1,
  maxBytes: 4096,
  expectedSha256: SHA,
  objectKey: `${attemptPrefix}/out.txt`,
  redaction: "secret",
});

const downloadGrant = () => ({ ...uploadGrant(), operation: "download", method: "GET", url: "https://storage.example.com/get" });

const artifactManifest = (objectKey: string) => ({
  protocolVersion: 1,
  organizationId: ORG,
  companyId: COMPANY,
  jobId: JOB,
  attempt: 1,
  artifactId: ARTIFACT,
  kind: "log",
  sensitivity: "restricted",
  retention: "run",
  objectKey,
  sizeBytes: 10,
  sha256: SHA,
  contentType: "text/plain",
  createdAt: T0,
});

const commitBody = () => ({
  protocolVersion: 1,
  workerId: WORKER,
  jobId: JOB,
  attempt: 1,
  leaseId: LEASE,
  fenceToken: FENCE,
  manifest: artifactManifest(`${attemptPrefix}/log.txt`),
});

const quarantineGrantBody = () => ({
  protocolVersion: 1,
  workerId: WORKER,
  targetId: TARGET,
  deviceGeneration: 1,
  organizationId: ORG,
  companyId: COMPANY,
  jobId: JOB,
  attempt: 1,
  observedLeaseId: LEASE,
  observedFenceToken: FENCE,
  reason: "late_output",
  artifactId: ARTIFACT,
  expectedObjectKey: `${quarantinePrefix}/orphan.txt`,
  expectedSha256: SHA,
  sizeBytes: 10,
});

const quarantineUploadGrant = () => ({
  protocolVersion: 1,
  operation: "quarantine_upload",
  artifactId: ARTIFACT,
  method: "PUT",
  url: "https://storage.example.com/quarantine",
  headers: {},
  issuedAt: T0,
  expiresAt: "2026-08-09T00:04:00.000Z",
  maxBytes: 10,
  expectedSha256: SHA,
  quarantineObjectKey: `${quarantinePrefix}/orphan.txt`,
  redaction: "secret",
});

const quarantineFinalizeBody = () => ({
  protocolVersion: 1,
  workerId: WORKER,
  targetId: TARGET,
  deviceGeneration: 1,
  organizationId: ORG,
  companyId: COMPANY,
  jobId: JOB,
  attempt: 1,
  observedLeaseId: LEASE,
  observedFenceToken: FENCE,
  reason: "late_output",
  artifactId: ARTIFACT,
  quarantineObjectKey: `${quarantinePrefix}/orphan.txt`,
  expectedSha256: SHA,
  sizeBytes: 10,
  manifest: artifactManifest(`${attemptPrefix}/orphan.txt`),
});

const quarantineReceipt = () => ({
  protocolVersion: 1,
  receiptId: RECEIPT_ID,
  quarantineObjectKey: `${quarantinePrefix}/orphan.txt`,
  observed: {
    workerId: WORKER,
    targetId: TARGET,
    deviceGeneration: 1,
    jobId: JOB,
    attempt: 1,
    leaseId: LEASE,
    fenceToken: FENCE,
  },
  artifact: { artifactId: ARTIFACT, sha256: SHA, sizeBytes: 10, sensitivity: "restricted", provenance: "generated" },
  reason: "late_output",
  receivedAt: T0,
  disposition: "quarantined",
});

// --- Control command payloads -------------------------------------------------

function controlBase(commandKind: string): Record<string, unknown> {
  return {
    protocolVersion: 1,
    audience: "control_channel",
    commandId: "00000000-0000-4000-8000-000000000401",
    commandSeq: 1,
    idempotencyKey: IDEMPOTENCY,
    issuedAt: T0,
    nonce: "cmd-nonce",
    organizationId: ORG,
    companyId: COMPANY,
    workerId: WORKER,
    jobId: JOB,
    attempt: 1,
    leaseId: LEASE,
    fenceToken: FENCE,
    commandKind,
  };
}

const cancelCommand = () => ({ ...controlBase("cancel"), reason: "founder cancelled", graceful: true });

const productApprovalResult = () => ({
  approvalId: APPROVAL_ID,
  approvalKind: "spend_over_threshold",
  approvalVersion: 3,
  decision: "approved",
  decidedBy: { principalType: "user", principalId: "founder-1" },
  decidedAt: T0,
  idempotencyKey: IDEMPOTENCY,
  governedActionRef: { kind: "budget_release", id: "00000000-0000-4000-8000-000000000402" },
});

const permissionRequest = () => ({
  decisionKind: "permission",
  requestId: REQUEST_ID,
  nonce: "rt-nonce",
  requestDigest: SHA,
  schemaVersion: 1,
  sourceRevision: 0,
  expiresAt: T1,
  title: "Run rm -rf build?",
  summary: null,
  timeoutPolicy: "deny",
  defaultDecision: null,
  toolName: "bash",
  command: "rm -rf build",
  cwd: null,
  path: null,
  networkTarget: null,
  riskClass: "fs_write",
});

const permissionResult = () => ({
  decisionKind: "permission",
  requestId: REQUEST_ID,
  nonce: "rt-nonce",
  requestDigest: SHA,
  schemaVersion: 1,
  sourceRevision: 0,
  expiresAt: T1,
  decidedBy: { principalType: "user", principalId: "founder-1" },
  decidedAt: T0,
  idempotencyKey: IDEMPOTENCY,
  timeoutPolicy: "deny",
  decision: "allow_once",
});

const workQuestionRequest = () => ({
  decisionKind: "work_question",
  requestId: REQUEST_ID,
  nonce: "wq-nonce",
  requestDigest: SHA_B,
  schemaVersion: 2,
  sourceRevision: 1,
  expiresAt: T1,
  title: "Which environment?",
  summary: null,
  timeoutPolicy: "park_run",
  promptText: "Which deployment target should I use?",
  options: [],
});

const workQuestionResult = (overrides: Record<string, unknown> = {}) => ({
  decisionKind: "work_question",
  requestId: REQUEST_ID,
  nonce: "wq-nonce",
  requestDigest: SHA_B,
  schemaVersion: 2,
  sourceRevision: 1,
  expiresAt: T1,
  decidedBy: { principalType: "user", principalId: "founder-1" },
  decidedAt: T0,
  idempotencyKey: IDEMPOTENCY,
  timeoutPolicy: "park_run",
  outcome: "answered",
  answer: { region: "staging" },
  ...overrides,
});

// =============================================================================
// Registry + vocabulary.
// =============================================================================

describe("transport.ts — operation registry and vocabulary", () => {
  it("locks the auth-audience vocabulary", () => {
    expect(AUTH_AUDIENCES).toEqual([
      "target_enrollment",
      "worker_poll",
      "worker_run",
      "device_session",
      "control_channel",
    ]);
  });

  it("locks the ten worker-protocol operations", () => {
    expect(WORKER_PROTOCOL_OPERATIONS).toEqual([
      "enrollment",
      "poll",
      "lease_ack",
      "lease_renew",
      "event_upload",
      "artifact_transfer_grant",
      "artifact_commit",
      "quarantine_grant",
      "quarantine_finalize",
      "control_command",
    ]);
  });

  it("every operation has a descriptor with a valid audience, bounded payload ceiling, timeout, and stable errors", () => {
    for (const op of WORKER_PROTOCOL_OPERATIONS) {
      const d = OPERATION_DESCRIPTORS[op];
      expect(d).toBeDefined();
      expect(d.operation).toBe(op);
      expect(AUTH_AUDIENCES).toContain(d.audience);
      expect(d.maxRequestBytes).toBeGreaterThan(0);
      expect(d.timeoutMs).toBeGreaterThan(0);
      expect(d.errors.length).toBeGreaterThan(0);
      for (const code of d.errors) expect(PROTOCOL_ERROR_CODES).toContain(code);
    }
  });

  it("locks the poll / grant / commit / control / receiver-decision vocabularies", () => {
    expect(POLL_RESPONSE_OUTCOMES).toEqual(["offer", "no_work", "drain"]);
    expect(ARTIFACT_TRANSFER_GRANT_OUTCOMES).toEqual(["upload_granted", "download_granted", "rejected"]);
    expect(ARTIFACT_COMMIT_OUTCOMES).toEqual(["committed", "rejected"]);
    expect(CONTROL_COMMAND_KINDS).toEqual([
      "cancel",
      "product_approval_result",
      "runtime_decision_result",
      "checkpoint",
      "graceful_stop",
      "drain",
    ]);
    expect(CONTROL_ACK_STATUSES).toEqual(["accepted", "completed", "rejected", "stale"]);
    expect(CONTROL_RECEIVER_DECISIONS).toEqual(["accept", "replay", "gap", "conflict", "stale"]);
    expect(EVENT_RECEIVER_DECISIONS).toEqual(["accept", "replay", "gap", "hash_mismatch", "stale_fence", "terminal"]);
    expect(PRODUCT_APPROVAL_DECISIONS).toEqual(["approved", "rejected", "expired"]);
    expect(PERMISSION_DECISIONS).toEqual(["allow_once", "allow_run", "allow_always", "deny", "expired", "cancelled"]);
    expect(WORK_QUESTION_OUTCOMES).toEqual(["answered", "expired", "cancelled"]);
  });
});

// =============================================================================
// Enrollment + poll.
// =============================================================================

describe("transport.ts — enrollment", () => {
  it("accepts a well-formed enrollment request nesting a worker hello", () => {
    const req = { ...requestBase(), audience: "target_enrollment", idempotencyKey: IDEMPOTENCY, hello: validTargetPair().worker };
    expect(enrollmentRequestV1Schema.safeParse(req).success).toBe(true);
  });

  it("rejects an enrollment request that carries the wrong audience", () => {
    const req = { ...requestBase(), audience: "worker_run", idempotencyKey: IDEMPOTENCY, hello: validTargetPair().worker };
    expect(enrollmentRequestV1Schema.safeParse(req).success).toBe(false);
  });

  it("rejects an enrollment request that sends a bare payload without an envelope", () => {
    expect(enrollmentRequestV1Schema.safeParse(validTargetPair().worker).success).toBe(false);
  });

  it("accepts enrolled and rejected enrollment responses", () => {
    const enrolled = {
      protocolVersion: 1,
      correlationId: CORRELATION,
      serverTime: T0,
      outcome: "enrolled",
      workerId: WORKER,
      targetId: TARGET,
      deviceGeneration: 1,
      providerConstraints: { profileId: "standard", version: 1, digest: SHA },
    };
    const rejected = {
      protocolVersion: 1,
      correlationId: CORRELATION,
      serverTime: T0,
      outcome: "rejected",
      reason: "unauthorized",
      retryAfterMs: null,
    };
    expect(enrollmentResponseV1Schema.safeParse(enrolled).success).toBe(true);
    expect(enrollmentResponseV1Schema.safeParse(rejected).success).toBe(true);
  });
});

describe("transport.ts — poll (offer | no_work | drain)", () => {
  const pollReq = () => ({
    ...requestBase(),
    audience: "worker_poll",
    workerId: WORKER,
    targetId: TARGET,
    deviceGeneration: 1,
    capacity: validTargetPair().worker.capacity,
  });

  it("accepts a well-formed poll request (no idempotency key — a read)", () => {
    expect(pollRequestV1Schema.safeParse(pollReq()).success).toBe(true);
  });

  it("accepts an offer response nesting a full lease offer", () => {
    const res = { protocolVersion: 1, correlationId: CORRELATION, serverTime: T0, outcome: "offer", body: validLeaseOffer() };
    expect(pollResponseV1Schema.safeParse(res).success).toBe(true);
  });

  it("accepts a no_work response carrying a retry hint and server time", () => {
    const res = { protocolVersion: 1, correlationId: CORRELATION, serverTime: T0, outcome: "no_work", retryAfterMs: 3000 };
    expect(pollResponseV1Schema.safeParse(res).success).toBe(true);
  });

  it("accepts a drain response", () => {
    const res = {
      protocolVersion: 1,
      correlationId: CORRELATION,
      serverTime: T0,
      outcome: "drain",
      retryAfterMs: null,
      reason: "target decommissioned",
    };
    expect(pollResponseV1Schema.safeParse(res).success).toBe(true);
  });

  it("rejects an unknown poll response outcome (fail closed)", () => {
    const res = { protocolVersion: 1, correlationId: CORRELATION, serverTime: T0, outcome: "maybe_later", retryAfterMs: 1 };
    expect(pollResponseV1Schema.safeParse(res).success).toBe(false);
  });

  it("rejects a no_work response missing its retry hint", () => {
    const res = { protocolVersion: 1, correlationId: CORRELATION, serverTime: T0, outcome: "no_work" };
    expect(pollResponseV1Schema.safeParse(res).success).toBe(false);
  });
});

// =============================================================================
// Lease ack / renew.
// =============================================================================

describe("transport.ts — lease ack / renew operations nest the strict lease payloads", () => {
  it("accepts a lease-ack operation request and its acknowledged/rejected responses", () => {
    const req = { ...requestBase(), audience: "worker_run", idempotencyKey: IDEMPOTENCY, body: leaseAckBody() };
    expect(leaseAckOperationRequestV1Schema.safeParse(req).success).toBe(true);
    const ack = { protocolVersion: 1, correlationId: CORRELATION, serverTime: T0, outcome: "acknowledged", leaseId: LEASE, expiresAt: T1 };
    const rej = { protocolVersion: 1, correlationId: CORRELATION, serverTime: T0, outcome: "rejected", reason: "stale_fence" };
    expect(leaseAckOperationResponseV1Schema.safeParse(ack).success).toBe(true);
    expect(leaseAckOperationResponseV1Schema.safeParse(rej).success).toBe(true);
  });

  it("rejects a lease-ack request that omits the idempotency key (mutating retryable)", () => {
    const req = { ...requestBase(), audience: "worker_run", body: leaseAckBody() };
    expect(leaseAckOperationRequestV1Schema.safeParse(req).success).toBe(false);
  });

  it("accepts a lease-renew operation whose response body echoes the renewal identity", () => {
    const req = { ...requestBase(), audience: "worker_run", idempotencyKey: IDEMPOTENCY, body: leaseRenewRequestBody() };
    expect(leaseRenewOperationRequestV1Schema.safeParse(req).success).toBe(true);
    const res = { protocolVersion: 1, correlationId: CORRELATION, serverTime: T0, outcome: "renewed", body: leaseRenewResponseBody() };
    const parsed = leaseRenewOperationResponseV1Schema.safeParse(res);
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.outcome === "renewed") {
      expect(parsed.data.body.workerId).toBe(WORKER);
      expect(parsed.data.body.leaseId).toBe(LEASE);
      expect(parsed.data.body.fenceToken).toBe(FENCE);
    }
  });
});

// =============================================================================
// Event upload.
// =============================================================================

describe("transport.ts — event upload nests the batch and returns the cumulative ACK", () => {
  it("accepts a well-formed event-upload request and ack response", () => {
    const req = { ...requestBase(), audience: "worker_run", idempotencyKey: IDEMPOTENCY, body: eventBatchBody() };
    expect(eventUploadOperationRequestV1Schema.safeParse(req).success).toBe(true);
    const res = { protocolVersion: 1, correlationId: CORRELATION, serverTime: T0, ack: eventAck() };
    expect(eventUploadOperationResponseV1Schema.safeParse(res).success).toBe(true);
  });
});

// =============================================================================
// Artifact transfer grant + closed pairing.
// =============================================================================

describe("transport.ts — artifact transfer grant (upload_granted | download_granted | rejected)", () => {
  it("accepts an upload request and an upload_granted response", () => {
    const req = { ...requestBase(), audience: "worker_run", idempotencyKey: IDEMPOTENCY, body: transferGrantRequestBody("upload") };
    expect(artifactTransferGrantOperationRequestV1Schema.safeParse(req).success).toBe(true);
    const res = { protocolVersion: 1, correlationId: CORRELATION, serverTime: T0, outcome: "upload_granted", grant: uploadGrant() };
    expect(artifactTransferGrantOperationResponseV1Schema.safeParse(res).success).toBe(true);
  });

  it("accepts a download_granted response nesting a GET grant", () => {
    const res = { protocolVersion: 1, correlationId: CORRELATION, serverTime: T0, outcome: "download_granted", grant: downloadGrant() };
    expect(artifactTransferGrantOperationResponseV1Schema.safeParse(res).success).toBe(true);
  });

  it("enforces closed grant pairing: upload↔upload_granted, download↔download_granted, either↔rejected", () => {
    expect(isTransferGrantResponsePairedV1("upload", "upload_granted")).toBe(true);
    expect(isTransferGrantResponsePairedV1("upload", "download_granted")).toBe(false);
    expect(isTransferGrantResponsePairedV1("download", "download_granted")).toBe(true);
    expect(isTransferGrantResponsePairedV1("download", "upload_granted")).toBe(false);
    expect(isTransferGrantResponsePairedV1("upload", "rejected")).toBe(true);
    expect(isTransferGrantResponsePairedV1("download", "rejected")).toBe(true);
  });
});

// =============================================================================
// Artifact commit vs quarantine separation.
// =============================================================================

describe("transport.ts — artifact commit (committed | rejected) is closed and never converts to quarantine", () => {
  it("accepts a commit request and committed/rejected responses", () => {
    const req = { ...requestBase(), audience: "worker_run", idempotencyKey: IDEMPOTENCY, body: commitBody() };
    expect(artifactCommitOperationRequestV1Schema.safeParse(req).success).toBe(true);
    const committed = {
      protocolVersion: 1,
      correlationId: CORRELATION,
      serverTime: T0,
      outcome: "committed",
      artifactId: ARTIFACT,
      versionNumber: 1,
      committedAt: T0,
    };
    const rejected = { protocolVersion: 1, correlationId: CORRELATION, serverTime: T0, outcome: "rejected", reason: "stale_fence" };
    expect(artifactCommitOperationResponseV1Schema.safeParse(committed).success).toBe(true);
    expect(artifactCommitOperationResponseV1Schema.safeParse(rejected).success).toBe(true);
  });

  it("rejects any attempt to return a quarantine outcome from an ordinary commit (no auto-conversion)", () => {
    const quarantined = {
      protocolVersion: 1,
      correlationId: CORRELATION,
      serverTime: T0,
      outcome: "quarantined",
      receipt: quarantineReceipt(),
    };
    expect(artifactCommitOperationResponseV1Schema.safeParse(quarantined).success).toBe(false);
  });
});

// =============================================================================
// Quarantine grant + finalize (device-authenticated).
// =============================================================================

describe("transport.ts — quarantine grant/finalize use a device session, never a lease grant", () => {
  it("accepts a quarantine grant request (device_session) and its granted/rejected responses", () => {
    const req = { ...requestBase(), audience: "device_session", idempotencyKey: IDEMPOTENCY, body: quarantineGrantBody() };
    expect(quarantineGrantOperationRequestV1Schema.safeParse(req).success).toBe(true);
    const granted = {
      protocolVersion: 1,
      correlationId: CORRELATION,
      serverTime: T0,
      outcome: "quarantine_upload_granted",
      grant: quarantineUploadGrant(),
    };
    const rejected = { protocolVersion: 1, correlationId: CORRELATION, serverTime: T0, outcome: "rejected", reason: "target_revoked" };
    expect(quarantineGrantOperationResponseV1Schema.safeParse(granted).success).toBe(true);
    expect(quarantineGrantOperationResponseV1Schema.safeParse(rejected).success).toBe(true);
  });

  it("rejects a quarantine grant request carrying the worker_run lease audience", () => {
    const req = { ...requestBase(), audience: "worker_run", idempotencyKey: IDEMPOTENCY, body: quarantineGrantBody() };
    expect(quarantineGrantOperationRequestV1Schema.safeParse(req).success).toBe(false);
  });

  it("accepts a quarantine finalize request and its quarantined(receipt)/rejected responses", () => {
    const req = { ...requestBase(), audience: "device_session", idempotencyKey: IDEMPOTENCY, body: quarantineFinalizeBody() };
    expect(quarantineFinalizeOperationRequestV1Schema.safeParse(req).success).toBe(true);
    const quarantined = { protocolVersion: 1, correlationId: CORRELATION, serverTime: T0, outcome: "quarantined", receipt: quarantineReceipt() };
    const rejected = { protocolVersion: 1, correlationId: CORRELATION, serverTime: T0, outcome: "rejected", reason: "event_hash_mismatch" };
    expect(quarantineFinalizeOperationResponseV1Schema.safeParse(quarantined).success).toBe(true);
    expect(quarantineFinalizeOperationResponseV1Schema.safeParse(rejected).success).toBe(true);
  });
});

// =============================================================================
// Control commands + product/runtime separation.
// =============================================================================

describe("transport.ts — control commands keep product approvals and runtime decisions separate", () => {
  it("accepts a cancel control command", () => {
    expect(controlCommandV1Schema.safeParse(cancelCommand()).success).toBe(true);
  });

  it("accepts a product_approval_result control command and its governed-action binding", () => {
    const cmd = { ...controlBase("product_approval_result"), result: productApprovalResult() };
    expect(controlCommandV1Schema.safeParse(cmd).success).toBe(true);
    expect(productApprovalResultV1Schema.safeParse(productApprovalResult()).success).toBe(true);
    expect(
      productApprovalAuthorizesActionV1(productApprovalResult() as never, { kind: "budget_release", id: "00000000-0000-4000-8000-000000000402" }),
    ).toBe(true);
    // Cannot authorize a DIFFERENT governed action.
    expect(
      productApprovalAuthorizesActionV1(productApprovalResult() as never, { kind: "budget_release", id: "00000000-0000-4000-8000-0000000004ff" }),
    ).toBe(false);
  });

  it("accepts a runtime_decision_result control command (permission and work_question)", () => {
    const perm = { ...controlBase("runtime_decision_result"), result: permissionResult() };
    const wq = { ...controlBase("runtime_decision_result"), result: workQuestionResult() };
    expect(controlCommandV1Schema.safeParse(perm).success).toBe(true);
    expect(controlCommandV1Schema.safeParse(wq).success).toBe(true);
  });

  it("rejects an unknown control command kind (fail closed)", () => {
    const cmd = { ...controlBase("self_destruct"), reason: "x" };
    expect(controlCommandV1Schema.safeParse(cmd).success).toBe(false);
  });

  it("rejects conflating a product-approval payload into a runtime-decision command", () => {
    const cmd = { ...controlBase("runtime_decision_result"), result: productApprovalResult() };
    expect(controlCommandV1Schema.safeParse(cmd).success).toBe(false);
  });

  it("rejects a control command carrying a worker (non-control) audience — controls are not worker-creatable", () => {
    const cmd = { ...cancelCommand(), audience: "worker_run" };
    expect(controlCommandV1Schema.safeParse(cmd).success).toBe(false);
  });

  it("recursively rejects a credential-bearing key even inside an opaque work-question answer (defense in depth)", () => {
    const cmd = { ...controlBase("runtime_decision_result"), result: workQuestionResult({ answer: { environment: "prod" } }) };
    expect(controlCommandV1Schema.safeParse(cmd).success).toBe(false);
  });

  it("accepts a control-command ACK and rejects an unknown ACK status", () => {
    const ok = {
      protocolVersion: 1,
      correlationId: CORRELATION,
      commandId: "00000000-0000-4000-8000-000000000401",
      commandSeq: 1,
      status: "completed",
      observedAt: T0,
      detail: null,
    };
    expect(controlCommandAckV1Schema.safeParse(ok).success).toBe(true);
    expect(controlCommandAckV1Schema.safeParse({ ...ok, status: "in_progress" }).success).toBe(false);
  });
});

// =============================================================================
// runtime_decision_result strict union + request pairing.
// =============================================================================

describe("transport.ts — runtimeDecisionResultV1Schema is a strict permission | work_question union", () => {
  it("accepts each of the six permission decisions", () => {
    for (const decision of PERMISSION_DECISIONS) {
      expect(runtimeDecisionResultV1Schema.safeParse({ ...permissionResult(), decision }).success).toBe(true);
    }
  });

  it("requires an answer only for an answered work question and forbids it otherwise", () => {
    expect(runtimeDecisionResultV1Schema.safeParse(workQuestionResult()).success).toBe(true);
    expect(runtimeDecisionResultV1Schema.safeParse(workQuestionResult({ outcome: "answered", answer: null })).success).toBe(false);
    expect(runtimeDecisionResultV1Schema.safeParse(workQuestionResult({ outcome: "expired", answer: null })).success).toBe(true);
    expect(runtimeDecisionResultV1Schema.safeParse(workQuestionResult({ outcome: "cancelled", answer: { x: 1 } })).success).toBe(false);
  });

  it("rejects a work-question answer that exceeds the 16 KiB canonical bound", () => {
    const huge = workQuestionResult({ answer: { blob: "z".repeat(20_000) } });
    expect(runtimeDecisionResultV1Schema.safeParse(huge).success).toBe(false);
  });

  it("rejects cross-kind fields via strict (a permission cannot carry an outcome)", () => {
    expect(runtimeDecisionResultV1Schema.safeParse({ ...permissionResult(), outcome: "answered" }).success).toBe(false);
  });

  it("matches a result to its bound request and fails closed on any mismatch", () => {
    expect(matchRuntimeDecisionResultToRequestV1(permissionRequest() as never, permissionResult() as never).ok).toBe(true);
    expect(matchRuntimeDecisionResultToRequestV1(workQuestionRequest() as never, workQuestionResult() as never).ok).toBe(true);
    // missing request state
    expect(matchRuntimeDecisionResultToRequestV1(null, permissionResult() as never).ok).toBe(false);
    // cross-kind
    expect(matchRuntimeDecisionResultToRequestV1(permissionRequest() as never, workQuestionResult() as never).ok).toBe(false);
    // nonce/digest/version/sourceRevision/expiry mismatch
    expect(matchRuntimeDecisionResultToRequestV1(permissionRequest() as never, { ...permissionResult(), nonce: "other" } as never).ok).toBe(false);
    expect(matchRuntimeDecisionResultToRequestV1(permissionRequest() as never, { ...permissionResult(), requestDigest: SHA_B } as never).ok).toBe(false);
    expect(matchRuntimeDecisionResultToRequestV1(permissionRequest() as never, { ...permissionResult(), schemaVersion: 9 } as never).ok).toBe(false);
    expect(matchRuntimeDecisionResultToRequestV1(permissionRequest() as never, { ...permissionResult(), sourceRevision: 7 } as never).ok).toBe(false);
    expect(matchRuntimeDecisionResultToRequestV1(permissionRequest() as never, { ...permissionResult(), timeoutPolicy: "escalate" } as never).ok).toBe(false);
    // a late answer (decided after expiry) fails closed
    expect(
      matchRuntimeDecisionResultToRequestV1(workQuestionRequest() as never, workQuestionResult({ decidedAt: T_LATE }) as never).ok,
    ).toBe(false);
  });
});

// =============================================================================
// Pure receiver-decision functions.
// =============================================================================

describe("transport.ts — decideControlReceiverV1 (accept | replay | gap | conflict | stale)", () => {
  const base = { acceptedThroughSeq: 5, activeFenceToken: FENCE, priorForCommandId: null } as const;
  const cmd = { commandId: "c1", commandSeq: 6, fenceToken: FENCE, bodyDigest: SHA };

  it("accepts the next contiguous sequence on the active fence", () => {
    expect(decideControlReceiverV1(base, cmd)).toBe("accept");
  });
  it("returns replay for the same command id + same body digest", () => {
    expect(decideControlReceiverV1({ ...base, priorForCommandId: { seq: 6, bodyDigest: SHA } }, cmd)).toBe("replay");
  });
  it("returns conflict for the same command id + changed body digest", () => {
    expect(decideControlReceiverV1({ ...base, priorForCommandId: { seq: 6, bodyDigest: SHA_B } }, cmd)).toBe("conflict");
  });
  it("returns gap for a skipped sequence", () => {
    expect(decideControlReceiverV1(base, { ...cmd, commandSeq: 8 })).toBe("gap");
  });
  it("returns replay for an already-accepted sequence", () => {
    expect(decideControlReceiverV1(base, { ...cmd, commandSeq: 4 })).toBe("replay");
  });
  it("returns stale for a superseded fence", () => {
    expect(decideControlReceiverV1(base, { ...cmd, fenceToken: "fenceOTHER0000000000000000000000000000000" })).toBe("stale");
  });
});

describe("transport.ts — decideEventReceiverV1 (accept | replay | gap | hash_mismatch | stale_fence | terminal)", () => {
  const base = { acceptedThroughSeq: 5, activeFenceToken: FENCE, terminalReached: false, priorDigestForEventId: null } as const;
  const input = { eventId: "e1", seq: 6, fenceToken: FENCE, suppliedDigest: SHA, recomputedDigest: SHA };

  it("accepts the next contiguous sequence when the recomputed digest matches", () => {
    expect(decideEventReceiverV1(base, input)).toBe("accept");
  });
  it("returns hash_mismatch when the supplied digest differs from the recomputed digest", () => {
    expect(decideEventReceiverV1(base, { ...input, suppliedDigest: SHA_B })).toBe("hash_mismatch");
  });
  it("returns stale_fence for a superseded fence", () => {
    expect(decideEventReceiverV1(base, { ...input, fenceToken: "fenceOTHER0000000000000000000000000000000" })).toBe("stale_fence");
  });
  it("returns terminal once the attempt is terminal", () => {
    expect(decideEventReceiverV1({ ...base, terminalReached: true }, input)).toBe("terminal");
  });
  it("returns replay for the same event id + same recomputed digest", () => {
    expect(decideEventReceiverV1({ ...base, priorDigestForEventId: SHA }, input)).toBe("replay");
  });
  it("returns hash_mismatch for the same event id + changed recomputed digest", () => {
    expect(decideEventReceiverV1({ ...base, priorDigestForEventId: SHA_B }, input)).toBe("hash_mismatch");
  });
  it("returns gap for a skipped sequence", () => {
    expect(decideEventReceiverV1(base, { ...input, seq: 8 })).toBe("gap");
  });
});
