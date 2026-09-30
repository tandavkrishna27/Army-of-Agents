import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The CURRENT consumer (this package's source) and the FROZEN consumer (the
// hash-pinned independent v1 baseline) are imported INDEPENDENTLY. The frozen
// module is a self-contained ESM bundle with its OWN Zod runtime — it shares no
// object identity and no module instance with the current source.
import * as current from "./index.js";
// eslint-disable-next-line import/no-unresolved
import * as frozen from "../../../tests/fixtures/worker-protocol-consumers/v1/dist/index.js";
import { FIXTURE_SEGMENTS, recomputeManifestBytes } from "../../../scripts/check-frozen-worker-protocol-consumer.mjs";

// -----------------------------------------------------------------------------
// PRT-007 bidirectional cross-version harness.
//
// On the FIRST v1 freeze the two consumers intentionally implement the same
// contract, so the QA result is `baseline_established`: every vector accepted by
// the current producer is accepted by the frozen consumer, and every vector
// accepted by the frozen producer is accepted by the current consumer — over
// every execution-source/job combination, lease offer/ACK/renew, events + service
// events, artifacts, quarantine, secret/policy refs, registered target/worker
// capabilities, product approvals, runtime decisions, every control, and every
// error. On any later contract change these same tests run non-identical builds
// and classify each vector as common-and-accepted, safely-additive-and-preserved,
// or unsupported-critical-and-rejected during negotiation.
// -----------------------------------------------------------------------------

const sha256hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const repoRootUrl = new URL("../../../", import.meta.url);
const contractDir = new URL("docs/contracts/worker-protocol/v1/", repoRootUrl);
const conformance = JSON.parse(readFileSync(new URL("conformance.json", contractDir)).toString("utf8")) as {
  contractVersion: string;
  cases: Array<{ name: string; schema: string; valid: boolean; input: Record<string, unknown> }>;
};

type Mod = typeof current;

/** Route a conformance case through ONE consumer module (current or frozen). */
async function evaluate(mod: Mod, c: { schema: string; input: Record<string, unknown> }): Promise<boolean> {
  const input = c.input;
  switch (c.schema) {
    case "job":
      return mod.jobEnvelopeV1Schema.safeParse(input).success;
    case "lease_offer":
      return mod.leaseOfferV1Schema.safeParse(input).success;
    case "event_batch":
      return mod.workerEventBatchV1Schema.safeParse(input).success;
    case "enrollment_request":
      return mod.enrollmentRequestV1Schema.safeParse(input).success;
    case "enrollment_response":
      return mod.enrollmentResponseV1Schema.safeParse(input).success;
    case "poll_response":
      return mod.pollResponseV1Schema.safeParse(input).success;
    case "lease_ack_request":
      return mod.leaseAckOperationRequestV1Schema.safeParse(input).success;
    case "lease_renew_response":
      return mod.leaseRenewOperationResponseV1Schema.safeParse(input).success;
    case "event_upload_response":
      return mod.eventUploadOperationResponseV1Schema.safeParse(input).success;
    case "artifact_transfer_grant_response":
      return mod.artifactTransferGrantOperationResponseV1Schema.safeParse(input).success;
    case "artifact_commit_response":
      return mod.artifactCommitOperationResponseV1Schema.safeParse(input).success;
    case "quarantine_finalize_response":
      return mod.quarantineFinalizeOperationResponseV1Schema.safeParse(input).success;
    case "control_command":
      return mod.controlCommandV1Schema.safeParse(input).success;
    case "control_ack":
      return mod.controlCommandAckV1Schema.safeParse(input).success;
    case "runtime_decision_result":
      return mod.runtimeDecisionResultV1Schema.safeParse(input).success;
    case "protocol_error":
      return mod.protocolErrorV1Schema.safeParse(input).success;
    case "target_worker_pair": {
      const target = mod.registeredTargetProfileV1Schema.safeParse(input.registeredTarget);
      const worker = mod.workerHelloV1Schema.safeParse(input.worker);
      const requirements = mod.jobCapabilityRequirementsSchema.safeParse(input.requirements);
      if (!target.success || !worker.success || !requirements.success) return false;
      const verified = await mod.verifyAndBrandProviderConstraintProfileV1(input.providerProfile, sha256hex);
      if (verified === null) return false;
      return mod.workerSatisfiesRequirements(target.data, verified, worker.data, requirements.data);
    }
    default:
      throw new Error(`unknown conformance schema: ${c.schema}`);
  }
}

const caseByName = (name: string) => conformance.cases.find((c) => c.name === name)!;

describe("cross-version — source independence", () => {
  it("the frozen consumer is a distinct module instance with its own Zod runtime", () => {
    // Same public contract version, but NO shared object identity.
    expect(frozen.PROTOCOL_VERSION).toBe(current.PROTOCOL_VERSION);
    expect(frozen.jobEnvelopeV1Schema).not.toBe(current.jobEnvelopeV1Schema);
    expect(frozen.controlCommandV1Schema).not.toBe(current.controlCommandV1Schema);
    expect(frozen.protocolErrorV1Schema).not.toBe(current.protocolErrorV1Schema);
    // The frozen module exposes the full PRT-007 transport surface.
    for (const name of [
      "enrollmentRequestV1Schema",
      "pollResponseV1Schema",
      "controlCommandV1Schema",
      "runtimeDecisionResultV1Schema",
      "protocolErrorV1Schema",
      "decideEventReceiverV1",
      "WORKER_PROTOCOL_OPERATIONS",
    ]) {
      expect(name in frozen).toBe(true);
    }
  });
});

describe("cross-version — bidirectional corpus (baseline_established)", () => {
  it("declares the 42-case v1 corpus", () => {
    expect(conformance.contractVersion).toBe("1.0.0");
    expect(conformance.cases.length).toBe(42);
  });

  for (const c of conformance.cases) {
    it(`current⇄frozen agree on: ${c.name}`, async () => {
      // current producer → frozen consumer AND frozen producer → current consumer:
      // both consumers reach the SAME verdict as the corpus expectation.
      const byCurrent = await evaluate(current as Mod, c);
      const byFrozen = await evaluate(frozen as Mod, c);
      expect(byCurrent).toBe(c.valid);
      expect(byFrozen).toBe(c.valid);
      expect(byCurrent).toBe(byFrozen);
    });
  }
});

describe("cross-version — extension safety preservation and unknown-critical rejection", () => {
  const validJob = () => structuredClone(caseByName("valid browser-request job with safe optional extension").input);

  it("both consumers preserve a safe optional extension byte-semantically", async () => {
    const job = validJob();
    const c = current.jobEnvelopeV1Schema.safeParse(job);
    const f = frozen.jobEnvelopeV1Schema.safeParse(job);
    expect(c.success && f.success).toBe(true);
    if (c.success && f.success) {
      expect(c.data.extensions).toEqual(job.extensions);
      expect(f.data.extensions).toEqual(job.extensions);
      expect(c.data.extensions).toEqual(f.data.extensions);
    }
  });

  it("both consumers reject an unknown critical extension (fail closed)", () => {
    const job = validJob() as Record<string, unknown>;
    job.extensions = [{ namespace: "com.unknown.vendor", schemaVersion: 1, critical: true, value: { need: "this" } }];
    expect(current.jobEnvelopeV1Schema.safeParse(job).success).toBe(false);
    expect(frozen.jobEnvelopeV1Schema.safeParse(job).success).toBe(false);
  });
});

describe("cross-version — unknown state/control/error rejection", () => {
  it("both consumers reject an unknown poll outcome, control kind, and error code", () => {
    const unknownPoll = caseByName("reject poll response unknown outcome").input;
    const unknownControl = caseByName("reject unknown control command kind").input;
    const unknownError = caseByName("reject unknown protocol error code").input;
    for (const mod of [current, frozen]) {
      expect(mod.pollResponseV1Schema.safeParse(unknownPoll).success).toBe(false);
      expect(mod.controlCommandV1Schema.safeParse(unknownControl).success).toBe(false);
      expect(mod.protocolErrorV1Schema.safeParse(unknownError).success).toBe(false);
    }
  });
});

describe("cross-version — renewal identity echo", () => {
  it("both consumers echo the renewal identity on a renewed lease-renew response", () => {
    const input = caseByName("valid lease-renew response echoing the renewal identity").input;
    const c = current.leaseRenewOperationResponseV1Schema.safeParse(input);
    const f = frozen.leaseRenewOperationResponseV1Schema.safeParse(input);
    expect(c.success && f.success).toBe(true);
    if (c.success && f.success && c.data.outcome === "renewed" && f.data.outcome === "renewed") {
      for (const key of ["workerId", "jobId", "attempt", "leaseId", "fenceToken"] as const) {
        expect(c.data.body[key]).toBe(f.data.body[key]);
      }
    }
  });
});

describe("cross-version — receiver-decision agreement (idempotency + conflict)", () => {
  const FENCE = "fencePRT007AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const SHA = "a".repeat(64);
  const SHA_B = "b".repeat(64);

  it("both consumers agree: duplicate event ID + same digest replays, changed digest is hash_mismatch", () => {
    const base = { acceptedThroughSeq: 5, activeFenceToken: FENCE, terminalReached: false, priorDigestForEventId: SHA };
    const input = { eventId: "e1", seq: 6, fenceToken: FENCE, suppliedDigest: SHA, recomputedDigest: SHA };
    expect(current.decideEventReceiverV1(base, input)).toBe("replay");
    expect(frozen.decideEventReceiverV1(base, input)).toBe("replay");
    const changed = { ...base, priorDigestForEventId: SHA_B };
    expect(current.decideEventReceiverV1(changed, input)).toBe("hash_mismatch");
    expect(frozen.decideEventReceiverV1(changed, input)).toBe("hash_mismatch");
  });

  it("both consumers agree: duplicate control ID + same body replays, changed body conflicts", () => {
    const cmd = { commandId: "c1", commandSeq: 6, fenceToken: FENCE, bodyDigest: SHA };
    const same = { acceptedThroughSeq: 5, activeFenceToken: FENCE, priorForCommandId: { seq: 6, bodyDigest: SHA } };
    const diff = { acceptedThroughSeq: 5, activeFenceToken: FENCE, priorForCommandId: { seq: 6, bodyDigest: SHA_B } };
    expect(current.decideControlReceiverV1(same, cmd)).toBe("replay");
    expect(frozen.decideControlReceiverV1(same, cmd)).toBe("replay");
    expect(current.decideControlReceiverV1(diff, cmd)).toBe("conflict");
    expect(frozen.decideControlReceiverV1(diff, cmd)).toBe("conflict");
  });
});

describe("cross-version — exact manifest hashes + recorded baseline source revision", () => {
  it("the frozen-consumer manifest byte-for-byte matches an independent recomputation", () => {
    const dir = new URL(`${FIXTURE_SEGMENTS.join("/")}/`, repoRootUrl);
    const dirPath = decodeURIComponent(new URL(dir).pathname).replace(/^\/([A-Za-z]:)/, "$1");
    const recomputed = recomputeManifestBytes(dirPath);
    const committed = readFileSync(new URL("manifest.sha256", dir));
    expect(Buffer.compare(committed, recomputed)).toBe(0);
  });

  it("the dependency lock records the reviewed BASELINE_SOURCE_SHA from the ticket result", () => {
    const dir = new URL(`${FIXTURE_SEGMENTS.join("/")}/`, repoRootUrl);
    const lock = JSON.parse(readFileSync(new URL("dependency-lock.json", dir)).toString("utf8"));
    const result = readFileSync(new URL("docs/replatform/epics/E1-worker-protocol/tickets/PRT-007-result.md", repoRootUrl)).toString("utf8");
    const match = /^\*\*BASELINE_SOURCE_SHA:\*\*\s*`?([0-9a-f]{40})`?\s*$/m.exec(result);
    expect(match).not.toBeNull();
    expect(lock.sourceSha).toBe(match![1]);
    expect(lock.zodVersion).toBe("3.24.2");
  });

  it("the contract manifest pins the conformance corpus and the operation document", () => {
    const manifest = readFileSync(new URL("manifest.sha256", contractDir)).toString("utf8");
    for (const file of ["conformance.json", "operations.md"]) {
      const digest = sha256hex(readFileSync(new URL(file, contractDir)));
      expect(manifest).toContain(`${digest}  ${file}`);
    }
  });
});
