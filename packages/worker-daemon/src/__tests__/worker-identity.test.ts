import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import {
  leaseOfferV1Schema,
  registeredTargetProfileV1Schema,
  verifyAndBrandProviderConstraintProfileV1,
  type WorkerCapacity,
} from "@armyofagents/worker-protocol";
import { createHash } from "node:crypto";

import { createWorkerIdentity } from "../identity/worker-identity.js";
import {
  generateDeviceKey,
  exportDevicePrivateKeyPkcs8Der,
} from "../identity/device-key.js";
import type { DeviceIdentityRecord } from "../identity/device-identity-store.js";
import { buildDesktopHello } from "../enrollment/desktop-hello.js";
import { deriveHelloProvisioning } from "../enrollment/hello-provisioning.js";
import { offerSatisfiesWorker, type WorkerSelfModel } from "../poll/capacity.js";

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../../tests/fixtures/worker-provisioned-target.json", import.meta.url)),
    "utf8",
  ),
) as {
  registeredProfile: Record<string, unknown>;
  providerConstraintProfile: Record<string, unknown>;
  leaseOffer: unknown;
};

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const NAMEPLATE: WorkerCapacity = {
  batchSlots: 1,
  browserSessionSlots: 0,
  serviceSlots: 0,
  freeCpuMillis: 2000,
  freeMemoryMiB: 4096,
  freeDiskMiB: 8192,
};

function selfModelResponse() {
  return {
    selfModelHash: "a".repeat(64),
    registeredProfile: fixture.registeredProfile,
    providerConstraintProfile: fixture.providerConstraintProfile,
  };
}

function recordFor(): { record: DeviceIdentityRecord; thumbprint: string } {
  const key = generateDeviceKey();
  const record: DeviceIdentityRecord = {
    v: 1,
    workerId: fixture.registeredProfile.targetId as string, // any stable id; ids come from the record
    targetId: fixture.registeredProfile.targetId as string,
    deviceGeneration: 1,
    privateKeyPkcs8Der: exportDevicePrivateKeyPkcs8Der(key),
  };
  return { record, thumbprint: key.deviceThumbprint };
}

describe("createWorkerIdentity", () => {
  it("POSITIVE CONTROL: re-derives the device key from the PERSISTED DER (same thumbprint)", () => {
    const { record, thumbprint } = recordFor();
    const provisioning = deriveHelloProvisioning({
      selfModelResponse: selfModelResponse(),
      isolation: "none",
      capacity: NAMEPLATE,
    });
    const identity = createWorkerIdentity({ record, platform: "linux", arch: "x64", provisioning });
    // Killed by: use generateDeviceKey() instead of the persisted DER (a fresh, different key).
    expect(identity.key.deviceThumbprint).toBe(thumbprint);
    expect(identity.workerId).toBe(record.workerId);
    expect(identity.targetId).toBe(record.targetId);
    expect(identity.deviceGeneration).toBe(1);
  });

  it("builds the hello from buildDesktopHello with the FOLDED provisioning (byte-identical to a direct call)", () => {
    const { record } = recordFor();
    const provisioning = deriveHelloProvisioning({
      selfModelResponse: selfModelResponse(),
      isolation: "none",
      capacity: NAMEPLATE,
    });
    const identity = createWorkerIdentity({ record, platform: "linux", arch: "x64", provisioning });
    const direct = buildDesktopHello({
      workerId: record.workerId,
      targetId: record.targetId,
      deviceGeneration: record.deviceGeneration,
      platform: "linux",
      arch: "x64",
      provisioning: provisioning ?? undefined,
    });
    // The composed hello is production data, not a fixture — equal to a direct builder call.
    expect(identity.hello).toEqual(direct);
  });

  it("★ the provisioned hello is MATCHABLE — offerSatisfiesWorker ADMITS the captured offer", async () => {
    expect(fixture.leaseOffer, "no captured offer — WRK-011 fixture missing").not.toBeNull();
    const { record } = recordFor();
    const provisioning = deriveHelloProvisioning({
      selfModelResponse: selfModelResponse(),
      isolation: "none",
      capacity: NAMEPLATE,
    });
    const identity = createWorkerIdentity({ record, platform: "linux", arch: "x64", provisioning });
    const verified = await verifyAndBrandProviderConstraintProfileV1(
      fixture.providerConstraintProfile,
      sha256,
    );
    const self: WorkerSelfModel = {
      registeredTargetProfile: registeredTargetProfileV1Schema.parse(fixture.registeredProfile),
      verifiedProviderConstraints: verified!,
      report: identity.hello,
    };
    const offer = leaseOfferV1Schema.parse(fixture.leaseOffer);
    // Killed by: drop the provisioning fold (an unprovisioned hello refuses every offer).
    expect(offerSatisfiesWorker(self, NAMEPLATE, offer)).toBe(true);
  });

  it("NEGATIVE CONTROL: provisioning=null yields the unprovisioned (unmatchable) hello", async () => {
    const { record } = recordFor();
    const identity = createWorkerIdentity({ record, platform: "linux", arch: "x64", provisioning: null });
    const bare = buildDesktopHello({
      workerId: record.workerId,
      targetId: record.targetId,
      deviceGeneration: record.deviceGeneration,
      platform: "linux",
      arch: "x64",
    });
    expect(identity.hello).toEqual(bare);
    const verified = await verifyAndBrandProviderConstraintProfileV1(
      fixture.providerConstraintProfile,
      sha256,
    );
    const self: WorkerSelfModel = {
      registeredTargetProfile: registeredTargetProfileV1Schema.parse(fixture.registeredProfile),
      verifiedProviderConstraints: verified!,
      report: identity.hello,
    };
    const offer = leaseOfferV1Schema.parse(fixture.leaseOffer);
    expect(offerSatisfiesWorker(self, NAMEPLATE, offer)).toBe(false);
  });
});
