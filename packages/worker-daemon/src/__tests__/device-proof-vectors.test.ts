import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  buildDeviceProofCanonical,
  DEVICE_PROOF_PREFIX,
  DeviceProofError,
} from "../identity/device-proof.js";

// E4-F001: consume the NEUTRAL shared fixture minted from + verified against the
// SERVER canonicalizer. A worker-local copy is forbidden (proves only
// self-consistency). From `src/__tests__/` the repo-root fixture is four levels
// up. This asserts SERVER compatibility, not worker self-consistency.
const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(here, "../../../../tests/fixtures/device-proof/v1/vectors.json");

interface CanonicalVector {
  name: string;
  input: {
    method: string;
    path: string;
    bodyDigest: string;
    correlationId: string;
    issuedAt: string;
    proofId: string;
  };
  canonical: string;
}
interface RejectInput {
  name: string;
  reason: string;
  input: CanonicalVector["input"];
}
interface Fixture {
  prefix: string;
  version: string;
  canonicalVectors: CanonicalVector[];
  rejectInputs: RejectInput[];
}

const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Fixture;

describe("device-proof canonicalizer — shared vector parity (E4-F001)", () => {
  it("loads the neutral shared fixture with the expected prefix + non-empty vectors", () => {
    expect(fixture.prefix).toBe(DEVICE_PROOF_PREFIX);
    expect(fixture.version).toBe("1");
    expect(fixture.canonicalVectors.length).toBeGreaterThan(0);
    expect(fixture.rejectInputs.length).toBeGreaterThan(0);
  });

  it("reproduces every positive vector's canonical string byte-for-byte", () => {
    for (const vector of fixture.canonicalVectors) {
      const derived = buildDeviceProofCanonical(vector.input);
      expect(derived, `vector ${vector.name}`).toBe(vector.canonical);
      // Structural sanity: prefix line + exactly seven newline-joined fields.
      expect(derived.startsWith(`${DEVICE_PROOF_PREFIX}\n`)).toBe(true);
      expect(derived.split("\n")).toHaveLength(7);
    }
  });

  it("rejects every reject-input vector (fail closed)", () => {
    for (const reject of fixture.rejectInputs) {
      expect(
        () => buildDeviceProofCanonical(reject.input),
        `reject ${reject.name} (${reject.reason})`,
      ).toThrow(DeviceProofError);
    }
  });
});
