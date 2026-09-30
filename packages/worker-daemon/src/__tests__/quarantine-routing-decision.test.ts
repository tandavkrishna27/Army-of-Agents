import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { QUARANTINE_REASONS } from "@armyofagents/worker-protocol";

import {
  buildQuarantineFinalizeRequest,
  buildQuarantineGrantRequest,
  classifyOrphanOutput,
} from "../lease/quarantine.js";

import { quarantineArtifact, quarantineIdentity } from "./support/renewal-fixtures.js";

function envelopeInput() {
  return {
    identity: quarantineIdentity(),
    artifact: quarantineArtifact(),
    reason: classifyOrphanOutput({ fenceClosed: true }),
    correlationId: randomUUID(),
    issuedAt: "2026-08-13T00:00:00.000Z",
    nonce: randomUUID(),
    idempotencyKey: randomUUID(),
  };
}

describe("quarantine-routing-decision — post-close orphan output routes ONLY to quarantine, never a commit", () => {
  it("classifies orphan conditions to the frozen reason vocabulary", () => {
    expect(classifyOrphanOutput({ fenceClosed: true })).toBe("late_output");
    expect(classifyOrphanOutput({ hashMismatch: true })).toBe("hash_mismatch");
    expect(classifyOrphanOutput({ wrongPrefix: true })).toBe("wrong_prefix");
    expect(classifyOrphanOutput({ sizeMismatch: true })).toBe("size_mismatch");
    expect(classifyOrphanOutput({ corruptCheckpoint: true })).toBe("corrupt_checkpoint");
    expect(classifyOrphanOutput({})).toBe("late_output");
    for (const reason of [classifyOrphanOutput({}), classifyOrphanOutput({ hashMismatch: true })]) {
      expect(QUARANTINE_REASONS).toContain(reason);
    }
  });

  it("builds a device-authenticated grant under the DISTINCT quarantine prefix with no promote field", () => {
    const { request } = buildQuarantineGrantRequest(envelopeInput());

    // Device-session audience, NOT a fenced worker_run commit.
    expect(request.audience).toBe("device_session");
    // Authenticated by targetId + deviceGeneration (a DEVICE), not a live lease.
    expect(request.body.targetId).toBeDefined;
    expect(request.body.deviceGeneration).toBe(1);
    // The observed lease is recorded but NON-authoritative.
    expect(request.body.observedLeaseId).toBeTruthy();
    // The object key is under the DISTINCT quarantine/ prefix, never the ordinary one.
    expect(request.body.expectedObjectKey.startsWith("quarantine/organizations/")).toBe(true);
    // The grant carries no manifest (that is a commit/finalize concern).
    expect(request.body).not.toHaveProperty("manifest");
    // NON-PROMOTION (CAV-004): no apply/promote/select field exists anywhere.
    const json = JSON.stringify(request);
    expect(json).not.toMatch(/"promote"|"apply"|"select"/i);
  });

  it("builds a finalize with a matching manifest and no promote/apply disposition", () => {
    const { request } = buildQuarantineFinalizeRequest(envelopeInput());

    expect(request.audience).toBe("device_session");
    expect(request.body.quarantineObjectKey.startsWith("quarantine/organizations/")).toBe(true);
    // The manifest's ordinary object key is where it WOULD have gone (distinct prefix).
    expect(request.body.manifest.objectKey.startsWith("organizations/")).toBe(true);
    expect(request.body.manifest.sensitivity).toBe("restricted");
    // NON-PROMOTION (CAV-004): the finalize has no apply/promote/select disposition.
    const json = JSON.stringify(request);
    expect(json).not.toMatch(/"promote"|"apply"|"disposition":"appl|"select"/i);
  });
});
