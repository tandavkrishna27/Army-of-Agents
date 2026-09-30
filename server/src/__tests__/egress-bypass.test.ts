import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { NetworkPolicyV1 } from "@armyofagents/worker-protocol";
import {
  classifyEgressDestination,
  type ControlPlaneDenySet,
} from "../services/egress-policy.js";

// DEP-008 §2.6 (D5) — the hostile egress-BYPASS corpus bound to the REAL
// classifier (the DAT-004 #D lesson: a vectors fixture is only meaningful bound to
// the production decision, never a private re-derivation). Extends the DAT-005
// egress-policy binding with adversarial SSRF/rebind spellings + an INJECTED
// control-plane deny set that must be load-bearing.

function policy(allow: Array<{ host: string; port: number }>): NetworkPolicyV1 {
  return {
    policyId: "egress-bypass-test",
    version: 3,
    digest: "a".repeat(64),
    defaultAction: "deny",
    allow: allow.map((a) => ({ scheme: "https" as const, host: a.host, port: a.port })),
    denyPrivateNetworks: true,
    denyMetadata: true,
    denyControlPlane: true,
  };
}

const fixture = JSON.parse(
  readFileSync(join(__dirname, "../../../tests/fixtures/egress-bypass/v1/vectors.json"), "utf8"),
) as {
  context: { allow: Array<{ host: string; port: number }>; controlPlaneCidrs: string[] };
  allowVectors: Array<{ name: string; requestedUrl: string; resolvedAddrs: string[] }>;
  denyVectors: Array<{ name: string; requestedUrl: string; resolvedAddrs: string[]; class: string }>;
};

const fixturePolicy = policy(fixture.context.allow);
const fixtureCp: ControlPlaneDenySet = { cidrs: fixture.context.controlPlaneCidrs };

describe("egress-bypass vectors fixture — bound to the real classifier", () => {
  it("every allow vector is admitted by the real classifier", () => {
    for (const v of fixture.allowVectors) {
      expect(
        classifyEgressDestination(v.requestedUrl, v.resolvedAddrs, fixturePolicy, fixtureCp),
        `allow vector ${v.name}`,
      ).toBe("allow");
    }
  });

  it("every hostile bypass vector is refused with its exact class by the real classifier", () => {
    for (const v of fixture.denyVectors) {
      expect(
        classifyEgressDestination(v.requestedUrl, v.resolvedAddrs, fixturePolicy, fixtureCp),
        `deny vector ${v.name}`,
      ).toBe(v.class);
    }
  });

  it("the injected control-plane deny set is load-bearing (empty set → the public IP would ALLOW)", () => {
    const empty: ControlPlaneDenySet = { cidrs: [] };
    for (const v of fixture.denyVectors.filter((d) => d.class === "control_plane")) {
      // With the injected CIDR the real classifier refuses it as control_plane…
      expect(classifyEgressDestination(v.requestedUrl, v.resolvedAddrs, fixturePolicy, fixtureCp), `injected ${v.name}`).toBe(
        "control_plane",
      );
      // …and WITHOUT it, the same public address must classify as `allow` — proving
      // the injected deny set is the SOLE reason it is refused, not a coincidence of
      // the private/metadata-range gate (which would make the injection inert).
      expect(
        classifyEgressDestination(v.requestedUrl, v.resolvedAddrs, fixturePolicy, empty),
        `un-injected ${v.name}`,
      ).toBe("allow");
    }
  });
});
