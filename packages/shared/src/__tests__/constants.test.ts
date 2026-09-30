import { describe, it, expect } from "vitest";
import {
  PLUGIN_CAPABILITIES,
  CAPABILITY_DESCRIPTIONS,
  LIVE_EVENT_TYPES,
  NOTIFICATION_PREFERENCES,
  NOTIFICATION_DIGEST_CADENCES,
  WORKER_CONTROL_HEADERS,
} from "../constants.js";
import type { PluginCapability } from "../constants.js";

describe("CAPABILITY_DESCRIPTIONS", () => {
  it("has a description for every capability in PLUGIN_CAPABILITIES", () => {
    for (const cap of PLUGIN_CAPABILITIES) {
      expect(
        CAPABILITY_DESCRIPTIONS[cap],
        `Missing description for capability: ${cap}`
      ).toBeTruthy();
    }
  });

  it("has no extra keys beyond PLUGIN_CAPABILITIES", () => {
    const capSet = new Set<string>(PLUGIN_CAPABILITIES);
    for (const key of Object.keys(CAPABILITY_DESCRIPTIONS)) {
      expect(capSet.has(key), `Unexpected key in CAPABILITY_DESCRIPTIONS: ${key}`).toBe(true);
    }
  });
});

describe("W2-L3 notification contracts", () => {
  it("includes metadata-only hub live event types", () => {
    expect(LIVE_EVENT_TYPES).toContain("hub.item.changed");
    expect(LIVE_EVENT_TYPES).toContain("hub.counts.changed");
    expect(LIVE_EVENT_TYPES).toContain("hub.digest.changed");
  });

  it("exposes notification preference modes and digest cadences", () => {
    expect(NOTIFICATION_PREFERENCES).toEqual(["silent", "digest", "realtime"]);
    expect(NOTIFICATION_DIGEST_CADENCES).toEqual(["daily"]);
  });
});

describe("WORKER_CONTROL_HEADERS", () => {
  // Server source of truth for the worker-control header names. The worker daemon
  // VENDORS these values (packages/worker-daemon/src/transport/headers.ts) and cannot
  // import @armyofagents/shared at runtime OR in its image (E4-D01 least-privilege
  // closure). This independent pin here — mirroring the worker's own DOCUMENTED literal
  // in transport-headers.contract.test.ts — is what makes a silent server-side rename
  // fail: both sides pin the same eight lowercase values, so drift on either fails.
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

  it("equals the documented lowercase worker-control set (drift fails)", () => {
    expect({ ...WORKER_CONTROL_HEADERS }).toEqual(DOCUMENTED);
  });

  it("declares exactly the eight worker-control headers, all lowercase HTTP tokens", () => {
    expect(Object.keys(WORKER_CONTROL_HEADERS).sort()).toEqual(Object.keys(DOCUMENTED).sort());
    expect(new Set(Object.values(WORKER_CONTROL_HEADERS)).size).toBe(8);
    for (const name of Object.values(WORKER_CONTROL_HEADERS)) {
      expect(name).toMatch(/^[a-z0-9-]+$/);
    }
  });
});
