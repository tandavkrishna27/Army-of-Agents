import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  jobCapabilityRequirementsSchema,
  registeredTargetProfileV1Schema,
  verifyAndBrandProviderConstraintProfileV1,
  workerHelloV1Schema,
  workerSatisfiesRequirements,
} from "./capabilities.js";
import { protocolErrorV1Schema } from "./errors.js";
import { workerEventBatchV1Schema } from "./events.js";
import { jobEnvelopeV1Schema, leaseOfferV1Schema } from "./job.js";
import {
  WORKER_PROTOCOL_OPERATIONS,
  artifactCommitOperationResponseV1Schema,
  artifactTransferGrantOperationResponseV1Schema,
  controlCommandAckV1Schema,
  controlCommandV1Schema,
  enrollmentRequestV1Schema,
  enrollmentResponseV1Schema,
  eventUploadOperationResponseV1Schema,
  leaseAckOperationRequestV1Schema,
  leaseRenewOperationResponseV1Schema,
  pollResponseV1Schema,
  quarantineFinalizeOperationResponseV1Schema,
  runtimeDecisionResultV1Schema,
} from "./transport.js";
import { findSecretCanaryStringMatches } from "./wire-safety.js";

const sha256hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const contractDir = new URL("../../../docs/contracts/worker-protocol/v1/", import.meta.url);
const conformanceBytes = readFileSync(new URL("conformance.json", contractDir));
const conformance = JSON.parse(conformanceBytes.toString("utf8")) as {
  contractVersion: string;
  cases: ConformanceCase[];
};

type ConformanceSchema =
  | "job"
  | "lease_offer"
  | "event_batch"
  | "target_worker_pair"
  | "enrollment_request"
  | "enrollment_response"
  | "poll_response"
  | "lease_ack_request"
  | "lease_renew_response"
  | "event_upload_response"
  | "artifact_transfer_grant_response"
  | "artifact_commit_response"
  | "quarantine_finalize_response"
  | "control_command"
  | "control_ack"
  | "runtime_decision_result"
  | "protocol_error";

interface ConformanceCase {
  name: string;
  schema: ConformanceSchema;
  valid: boolean;
  preserveKeys?: string[];
  input: Record<string, unknown>;
}

/** The target_worker_pair validator: parse every part with its schema, verify +
 * brand the provider profile, then run the negotiation intersection. */
async function validatePair(input: Record<string, unknown>): Promise<{ success: boolean; data?: unknown }> {
  const target = registeredTargetProfileV1Schema.safeParse(input.registeredTarget);
  const worker = workerHelloV1Schema.safeParse(input.worker);
  const requirements = jobCapabilityRequirementsSchema.safeParse(input.requirements);
  if (!target.success || !worker.success || !requirements.success) return { success: false };
  const verified = await verifyAndBrandProviderConstraintProfileV1(input.providerProfile, sha256hex);
  if (verified === null) return { success: false };
  return { success: workerSatisfiesRequirements(target.data, verified, worker.data, requirements.data), data: input };
}

/** Every conformance schema tag maps to exactly one exported wrapper/response/
 * error schema (or the target/worker-pair validator). */
const SYNC_SCHEMAS: Record<Exclude<ConformanceSchema, "target_worker_pair">, { safeParse: (v: unknown) => { success: boolean; data?: unknown } }> = {
  job: jobEnvelopeV1Schema,
  lease_offer: leaseOfferV1Schema,
  event_batch: workerEventBatchV1Schema,
  enrollment_request: enrollmentRequestV1Schema,
  enrollment_response: enrollmentResponseV1Schema,
  poll_response: pollResponseV1Schema,
  lease_ack_request: leaseAckOperationRequestV1Schema,
  lease_renew_response: leaseRenewOperationResponseV1Schema,
  event_upload_response: eventUploadOperationResponseV1Schema,
  artifact_transfer_grant_response: artifactTransferGrantOperationResponseV1Schema,
  artifact_commit_response: artifactCommitOperationResponseV1Schema,
  quarantine_finalize_response: quarantineFinalizeOperationResponseV1Schema,
  control_command: controlCommandV1Schema,
  control_ack: controlCommandAckV1Schema,
  runtime_decision_result: runtimeDecisionResultV1Schema,
  protocol_error: protocolErrorV1Schema,
};

async function evaluate(c: ConformanceCase): Promise<{ success: boolean; data?: unknown }> {
  if (c.schema === "target_worker_pair") return validatePair(c.input);
  const schema = SYNC_SCHEMAS[c.schema];
  if (!schema) throw new Error(`unknown conformance schema: ${c.schema}`);
  return schema.safeParse(c.input);
}

describe("worker-protocol v1 conformance corpus", () => {
  it("declares contractVersion 1.0.0 with 42 uniquely named cases", () => {
    expect(conformance.contractVersion).toBe("1.0.0");
    expect(conformance.cases.length).toBe(42);
    const names = conformance.cases.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("every conformance case routes to a known transport/domain/error schema", () => {
    const known = new Set<ConformanceSchema>([
      "target_worker_pair",
      ...(Object.keys(SYNC_SCHEMAS) as ConformanceSchema[]),
    ]);
    for (const c of conformance.cases) expect(known.has(c.schema)).toBe(true);
    // The original four PRT-003..006 families remain present.
    for (const family of ["job", "lease_offer", "event_batch", "target_worker_pair"] as ConformanceSchema[]) {
      expect(conformance.cases.some((c) => c.schema === family)).toBe(true);
    }
    // The new PRT-007 transport/control/error families are present.
    for (const family of ["control_command", "control_ack", "runtime_decision_result", "protocol_error", "poll_response"] as ConformanceSchema[]) {
      expect(conformance.cases.some((c) => c.schema === family)).toBe(true);
    }
  });

  for (const c of conformance.cases) {
    it(`${c.valid ? "accepts" : "rejects"}: ${c.name}`, async () => {
      const result = await evaluate(c);
      expect(result.success).toBe(c.valid);
      if (c.valid && c.preserveKeys && result.data) {
        const data = result.data as Record<string, unknown>;
        for (const key of c.preserveKeys) {
          expect(data[key]).toEqual(c.input[key]);
        }
      }
    });
  }

  it("rejects the argv canary in case 10 via the producer-safety helper (separate from schema rejection)", () => {
    const canaryCase = conformance.cases.find((c) => c.name === "reject nested plaintext api key and known secret canary");
    expect(canaryCase).toBeDefined();
    const matches = findSecretCanaryStringMatches(canaryCase!.input, ["CANARY-SECRET-9"]);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.some((path) => path.startsWith("workload.args"))).toBe(true);
  });
});

describe("worker-protocol v1 operation-document coverage", () => {
  const operationsMd = readFileSync(new URL("operations.md", contractDir)).toString("utf8");

  it("operations.md documents exactly the exported operation set (no operation silently undocumented)", () => {
    // Each table row's first cell is the operation id in backticks: | `enrollment` | …
    const documented = [...operationsMd.matchAll(/^\|\s*`([a-z_]+)`\s*\|/gm)].map((m) => m[1]);
    expect(new Set(documented).size).toBe(documented.length); // no duplicate rows
    expect([...documented].sort()).toEqual([...WORKER_PROTOCOL_OPERATIONS].sort());
  });
});

describe("worker-protocol v1 manifest integrity", () => {
  it("manifest.sha256 pins the exact bytes of every hashed contract input (conformance.json + operations.md)", () => {
    const manifest = readFileSync(new URL("manifest.sha256", contractDir)).toString("utf8");
    const lines = manifest.split("\n").filter((line) => line.length > 0);
    const documented = new Map<string, string>();
    for (const line of lines) {
      const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
      expect(match).not.toBeNull();
      documented.set(match![2], match![1]);
    }
    // Every hashed input's recorded digest matches its actual bytes.
    for (const [file, digest] of documented) {
      const actual = sha256hex(readFileSync(new URL(file, contractDir)));
      expect(actual).toBe(digest);
    }
    // The corpus vectors AND the operation document are both pinned.
    expect(documented.has("conformance.json")).toBe(true);
    expect(documented.has("operations.md")).toBe(true);
  });
});
