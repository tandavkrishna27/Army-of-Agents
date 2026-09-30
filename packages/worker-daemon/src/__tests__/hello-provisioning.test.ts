// packages/worker-daemon/src/__tests__/hello-provisioning.test.ts
//
// WRK-011 Step 8b/8c — deriving provisioning from a self-model response, and the daemon's
// own capability self-check ADMITTING the offer the server produced.
//
// The offer here is CAPTURED from the server integration suite (Step 7) into the SHARED
// fixture and parsed through the FROZEN `leaseOfferV1Schema` — not hand-built — so a drift
// between what the server offers and what the daemon accepts reds this test.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  leaseOfferV1Schema,
  registeredTargetProfileV1Schema,
  verifyAndBrandProviderConstraintProfileV1,
  type WorkerCapacity,
} from "@armyofagents/worker-protocol";
import { buildDesktopHello } from "../enrollment/desktop-hello.js";
import { deriveHelloProvisioning } from "../enrollment/hello-provisioning.js";
import { offerSatisfiesWorker, type WorkerSelfModel } from "../poll/capacity.js";

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../../tests/fixtures/worker-provisioned-target.json", import.meta.url)), "utf8"),
) as {
  ids: { targetId: string };
  registeredProfile: Record<string, unknown>;
  providerConstraintProfile: Record<string, unknown>;
  leaseOffer: unknown;
};

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const NAMEPLATE: WorkerCapacity = {
  batchSlots: 1, browserSessionSlots: 0, serviceSlots: 0,
  freeCpuMillis: 1_000, freeMemoryMiB: 512, freeDiskMiB: 1_024,
};

function selfModelResponse() {
  return {
    protocolVersion: 1,
    selfModelHash: "a".repeat(64),
    registeredProfile: fixture.registeredProfile,
    providerConstraintProfile: fixture.providerConstraintProfile,
    serverTime: new Date(0).toISOString(),
  };
}

describe("deriveHelloProvisioning (Step 8b)", () => {
  it("intersects the admin ceiling with what the device can provide (M16)", () => {
    const provisioning = deriveHelloProvisioning({ selfModelResponse: selfModelResponse(), isolation: "none", capacity: NAMEPLATE });
    expect(provisioning).not.toBeNull();
    expect(provisioning!.reportedCapabilities).toContain("workload.batch");
    // The ceiling ALSO permits sandbox.process_isolated, but a `none`-isolation device does
    // not provide it — reporting it would be the over-report D4 forbids.
    expect(provisioning!.reportedCapabilities).not.toContain("sandbox.process_isolated");
    expect(provisioning!.policyHash).toBe(fixture.registeredProfile.policyHash);
  });

  it("fails toward ABSENT (null, never throws) on a malformed self-model response", () => {
    expect(deriveHelloProvisioning({ selfModelResponse: null, isolation: "none", capacity: NAMEPLATE })).toBeNull();
    expect(deriveHelloProvisioning({ selfModelResponse: {}, isolation: "none", capacity: NAMEPLATE })).toBeNull();
    expect(deriveHelloProvisioning({ selfModelResponse: { registeredProfile: { nope: true } }, isolation: "none", capacity: NAMEPLATE })).toBeNull();
  });
});

describe("offerSatisfiesWorker over the CAPTURED offer (Step 8c)", () => {
  const registeredTargetProfile = registeredTargetProfileV1Schema.parse(fixture.registeredProfile);
  const targetId = fixture.ids.targetId;
  const base = { workerId: "b0000000-0000-4000-8000-000000000005", targetId, deviceGeneration: 1 };

  async function verifiedProvider() {
    const verified = await verifyAndBrandProviderConstraintProfileV1(fixture.providerConstraintProfile, sha256);
    if (!verified) throw new Error("fixture provider profile failed to verify — regenerate the fixture");
    return verified;
  }

  it("★ ADMITS the offer for a PROVISIONED self-model, and REFUSES it for an UNPROVISIONED one", async () => {
    expect(fixture.leaseOffer, "no captured offer — run the integration suite with AOA_WRK011_CAPTURE=1").not.toBeNull();
    const offer = leaseOfferV1Schema.parse(fixture.leaseOffer);
    const verifiedProviderConstraints = await verifiedProvider();

    const provisioning = deriveHelloProvisioning({ selfModelResponse: selfModelResponse(), isolation: "none", capacity: NAMEPLATE });
    const provisioned: WorkerSelfModel = {
      registeredTargetProfile,
      verifiedProviderConstraints,
      report: buildDesktopHello({ ...base, platform: "linux", arch: "x64", provisioning: provisioning! }),
    };
    expect(offerSatisfiesWorker(provisioned, NAMEPLATE, offer)).toBe(true);

    // The positive control's mirror: the UNPROVISIONED self-model must NOT admit the same
    // offer (its empty caps + all-zero policy fail the frozen matcher). Without this, the
    // assertion above cannot tell a working matcher from a permissive one.
    const unprovisioned: WorkerSelfModel = {
      registeredTargetProfile,
      verifiedProviderConstraints,
      report: buildDesktopHello({ ...base, platform: "linux", arch: "x64" }),
    };
    expect(offerSatisfiesWorker(unprovisioned, NAMEPLATE, offer)).toBe(false);
  });
});
