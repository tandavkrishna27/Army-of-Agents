import { describe, expect, it } from "vitest";

// The worker VENDORS the worker-control header names (transport/headers.ts) and must
// NOT depend on @armyofagents/shared — not at runtime, and not even as a test devDep,
// because a devDep reference leaks shared into the worker image's pnpm graph resolution
// (E4-D01 least-privilege closure; enforced by docker/images/__tests__/dockerfile-static
// + scripts/check-image-deps-stages). Parity with the server source of truth is proven
// WITHOUT importing shared: this test pins the vendored copy to the DOCUMENTED literal
// below, and packages/shared/src/__tests__/constants.test.ts pins the shared
// WORKER_CONTROL_HEADERS to the SAME literal — so a rename on either side fails.
import { WORKER_CONTROL_HEADERS } from "../transport/headers.js";

// The documented lowercase `aoa-*` worker-control set (WRK-002 constraint #5 /
// docs source of truth `packages/shared/src/constants.ts:452-460`). Duplicated
// literally here so a silent rename in BOTH the vendored copy and shared still
// fails against this independent third copy.
const DOCUMENTED = {
  enrollmentCode: "aoa-enrollment-code",
  proofVersion: "aoa-device-proof-version",
  publicKey: "aoa-device-public-key",
  signature: "aoa-device-signature",
  issuedAt: "aoa-device-issued-at",
  proofId: "aoa-device-proof-id",
  requestId: "aoa-device-request-id",
  session: "aoa-worker-session",
} as const;

describe("transport headers — vendored/shared parity", () => {
  it("the vendored worker-control header names equal the documented lowercase set", () => {
    expect({ ...WORKER_CONTROL_HEADERS }).toEqual(DOCUMENTED);
  });

  it("every header name is a lowercase HTTP token (no upper-case / underscores)", () => {
    for (const name of Object.values(WORKER_CONTROL_HEADERS)) {
      expect(name).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it("declares exactly the eight worker-control headers", () => {
    expect(Object.keys(WORKER_CONTROL_HEADERS).sort()).toEqual(Object.keys(DOCUMENTED).sort());
    expect(new Set(Object.values(WORKER_CONTROL_HEADERS)).size).toBe(8);
  });
});
