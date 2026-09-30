import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { NetworkPolicyV1 } from "@armyofagents/worker-protocol";
import {
  classifyEgressDestination,
  resolveControlPlaneDenySet,
  type ControlPlaneDenySet,
} from "../services/egress-policy.js";

// DAT-005 D1/D5 — the pure default-deny egress destination classifier +
// the fixture binding to the real classifier (the DAT-004 #D lesson).

function policy(allow: Array<{ host: string; port: number }>): NetworkPolicyV1 {
  return {
    policyId: "egress-test",
    version: 3,
    digest: "a".repeat(64),
    defaultAction: "deny",
    allow: allow.map((a) => ({ scheme: "https" as const, host: a.host, port: a.port })),
    denyPrivateNetworks: true,
    denyMetadata: true,
    denyControlPlane: true,
  };
}

const NOTION = policy([{ host: "api.notion.com", port: 443 }]);
const CP: ControlPlaneDenySet = { cidrs: ["203.0.113.0/24", "2001:4860:4860::/48"] };
// Note: 203.0.113.0/24 is TEST-NET-3 (isPrivateIP catches it too) — the classifier
// must still report control_plane (precedence) when it is a control-plane range.
const CP_PUBLIC: ControlPlaneDenySet = { cidrs: ["198.51.100.0/24", "8.8.8.8/32"] };

describe("classifyEgressDestination — default-deny allowlist", () => {
  it("allows an allowlisted https host resolving to a public IP", () => {
    expect(classifyEgressDestination("https://api.notion.com/v1", ["104.18.0.1"], NOTION)).toBe("allow");
  });

  it("denies a non-allowlisted host as not_allowlisted even if the IP is public", () => {
    expect(classifyEgressDestination("https://evil.example/x", ["104.18.0.1"], NOTION)).toBe("not_allowlisted");
  });

  it("denies http (non-https) as not_allowlisted", () => {
    expect(classifyEgressDestination("http://api.notion.com/v1", ["104.18.0.1"], NOTION)).toBe("not_allowlisted");
  });

  it("denies a wrong port as not_allowlisted", () => {
    expect(classifyEgressDestination("https://api.notion.com:8443/v1", ["104.18.0.1"], NOTION)).toBe("not_allowlisted");
  });

  it("denies an unparseable url as not_allowlisted", () => {
    expect(classifyEgressDestination("not a url", ["104.18.0.1"], NOTION)).toBe("not_allowlisted");
  });

  it("denies a url with embedded credentials pointing at an allowlisted host (host still matched, but creds stripped) — allowed by host", () => {
    // Embedded creds do not change the host; still allowlisted + public → allow.
    expect(classifyEgressDestination("https://user:pass@api.notion.com/v1", ["104.18.0.1"], NOTION)).toBe("allow");
  });
});

describe("classifyEgressDestination — IP-range block + DNS-rebind", () => {
  it("denies an allowlisted host that resolves to an RFC1918 address (rebind) as private", () => {
    expect(classifyEgressDestination("https://api.notion.com/v1", ["10.0.0.5"], NOTION)).toBe("private");
  });

  it("denies loopback / link-local as private", () => {
    expect(classifyEgressDestination("https://api.notion.com/v1", ["127.0.0.1"], NOTION)).toBe("private");
    expect(classifyEgressDestination("https://api.notion.com/v1", ["169.254.1.1"], NOTION)).toBe("private");
  });

  it("denies the cloud metadata address 169.254.169.254 as metadata (more specific than private)", () => {
    expect(classifyEgressDestination("https://api.notion.com/v1", ["169.254.169.254"], NOTION)).toBe("metadata");
  });

  it("denies the ECS task metadata address 169.254.170.2 as metadata", () => {
    expect(classifyEgressDestination("https://api.notion.com/v1", ["169.254.170.2"], NOTION)).toBe("metadata");
  });

  it("denies an IPv4-mapped-IPv6 metadata address as metadata", () => {
    expect(classifyEgressDestination("https://api.notion.com/v1", ["::ffff:169.254.169.254"], NOTION)).toBe("metadata");
  });

  it("denies the HEX-spelled IPv4-mapped-IPv6 metadata address as metadata (family canonicalization)", () => {
    // `::ffff:a9fe:a9fe` === `::ffff:169.254.169.254` === 169.254.169.254. Without
    // canonicalizing the hex spelling to family-4, the family-4 metadata CIDR misses it.
    expect(classifyEgressDestination("https://api.notion.com/v1", ["::ffff:a9fe:a9fe"], NOTION)).toBe("metadata");
  });

  it("denies a first-word-zero IPv6 address (::/16, IPv4-compatible) as private", () => {
    expect(classifyEgressDestination("https://api.notion.com/v1", ["::10"], NOTION)).toBe("private");
  });

  it("denies if ANY resolved address is private (multi-homed rebind), not just the first", () => {
    expect(classifyEgressDestination("https://api.notion.com/v1", ["104.18.0.1", "10.0.0.5"], NOTION)).toBe("private");
  });

  it("denies an empty resolution set fail-closed", () => {
    expect(classifyEgressDestination("https://api.notion.com/v1", [], NOTION)).not.toBe("allow");
  });
});

describe("classifyEgressDestination — control-plane range", () => {
  it("denies a PUBLIC control-plane address as control_plane (private would not catch it)", () => {
    expect(classifyEgressDestination("https://api.notion.com/v1", ["198.51.100.7"], NOTION, CP_PUBLIC)).toBe("control_plane");
    expect(classifyEgressDestination("https://api.notion.com/v1", ["8.8.8.8"], NOTION, CP_PUBLIC)).toBe("control_plane");
  });

  it("reports control_plane over private when a range overlaps a reserved block (precedence)", () => {
    expect(classifyEgressDestination("https://api.notion.com/v1", ["203.0.113.9"], NOTION, CP)).toBe("control_plane");
  });

  it("denies an IPv6 control-plane address as control_plane", () => {
    expect(classifyEgressDestination("https://api.notion.com/v1", ["2001:4860:4860::8888"], NOTION, CP)).toBe("control_plane");
  });

  it("denies a HEX-spelled IPv4-mapped PUBLIC control-plane IP as control_plane (isPrivateIP cannot catch it)", () => {
    // `::ffff:0808:0808` === `::ffff:8.8.8.8` === 8.8.8.8, a PUBLIC control-plane CIDR.
    // Only the family-4 control_plane gate stands here — the hex spelling must be
    // canonicalized to family-4 or it evades the gate (the ssrf-rebind-ipblock defect).
    expect(classifyEgressDestination("https://api.notion.com/v1", ["::ffff:0808:0808"], NOTION, CP_PUBLIC)).toBe("control_plane");
  });

  it("reports metadata over control_plane (precedence) when both would match", () => {
    const cpWithMeta: ControlPlaneDenySet = { cidrs: ["169.254.169.254/32"] };
    expect(classifyEgressDestination("https://api.notion.com/v1", ["169.254.169.254"], NOTION, cpWithMeta)).toBe("metadata");
  });

  it("does not deny a public non-control-plane address", () => {
    expect(classifyEgressDestination("https://api.notion.com/v1", ["8.8.4.4"], NOTION, CP_PUBLIC)).toBe("allow");
  });
});

describe("resolveControlPlaneDenySet", () => {
  it("parses a comma/space separated env var, ignoring blanks", () => {
    const set = resolveControlPlaneDenySet({ AOA_CONTROL_PLANE_DENY_CIDRS: " 10.1.2.0/24 , , 8.8.8.8 " });
    expect(set.cidrs).toEqual(["10.1.2.0/24", "8.8.8.8"]);
  });

  it("is empty when unset", () => {
    expect(resolveControlPlaneDenySet({}).cidrs).toEqual([]);
  });
});

// --- The DAT-004 #D lesson: bind the checked-in fixture to the REAL classifier. --
describe("egress-policy vectors fixture — bound to the real classifier", () => {
  const fixture = JSON.parse(
    readFileSync(join(__dirname, "../../../tests/fixtures/egress-policy/v1/vectors.json"), "utf8"),
  ) as {
    context: { allow: Array<{ host: string; port: number }>; controlPlaneCidrs: string[] };
    allowVectors: Array<{ name: string; requestedUrl: string; resolvedAddrs: string[] }>;
    denyVectors: Array<{ name: string; requestedUrl: string; resolvedAddrs: string[]; class: string }>;
  };

  const fixturePolicy = policy(fixture.context.allow);
  const fixtureCp: ControlPlaneDenySet = { cidrs: fixture.context.controlPlaneCidrs };

  it("every allow vector is admitted by the real classifier", () => {
    for (const v of fixture.allowVectors) {
      expect(
        classifyEgressDestination(v.requestedUrl, v.resolvedAddrs, fixturePolicy, fixtureCp),
        `allow vector ${v.name}`,
      ).toBe("allow");
    }
  });

  it("every deny vector is refused with its exact class by the real classifier", () => {
    for (const v of fixture.denyVectors) {
      expect(
        classifyEgressDestination(v.requestedUrl, v.resolvedAddrs, fixturePolicy, fixtureCp),
        `deny vector ${v.name}`,
      ).toBe(v.class);
    }
  });
});
