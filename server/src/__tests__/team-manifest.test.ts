import { describe, expect, it } from "vitest";
import { parseManifest, serializeManifest, validateManifest } from "../services/team-manifest.js";
import { TeamManifestSchema } from "@armyofagents/shared";

const VALID_YAML = `
schemaVersion: 1
name: frontend-team
version: 1.0.0
displayName: Frontend Team
agents:
  - name: alice
    role: lead
    skillKeys: [react, css]
routing:
  defaultLead: "@alice"
  rules: []
`;

describe("parseManifest", () => {
  it("parses valid YAML to typed object", () => {
    const m = parseManifest(VALID_YAML);
    expect(m.schemaVersion).toBe(1);
    expect(m.name).toBe("frontend-team");
    expect(m.agents).toHaveLength(1);
    expect(m.agents[0]).toMatchObject({ name: "alice", role: "lead" });
  });

  it("rejects invalid schemaVersion", () => {
    const yaml = VALID_YAML.replace("schemaVersion: 1", "schemaVersion: 2");
    expect(() => parseManifest(yaml)).toThrow();
  });

  it("rejects missing required fields", () => {
    const yaml = `name: foo\nversion: 1.0.0\n`;
    expect(() => parseManifest(yaml)).toThrow();
  });

  it("rejects malformed YAML", () => {
    expect(() => parseManifest("this is: not: valid: yaml:::")).toThrow();
  });

  it("accepts $ref agent form", () => {
    const yaml = `
schemaVersion: 1
name: t
version: 1.0.0
agents:
  - $ref: "@aoa/junior@1.0.0"
    localName: bob
    role: member
routing:
  rules: []
`;
    const m = parseManifest(yaml);
    expect(m.agents[0]).toMatchObject({ $ref: "@aoa/junior@1.0.0", localName: "bob" });
  });

  it("rejects non-semver version", () => {
    const yaml = VALID_YAML.replace("version: 1.0.0", "version: latest");
    expect(() => parseManifest(yaml)).toThrow();
  });
});

describe("validateManifest", () => {
  it("validates a fully-formed object", () => {
    const m = parseManifest(VALID_YAML);
    expect(() => validateManifest(m)).not.toThrow();
  });

  it("rejects routing rule with invalid regex", () => {
    const yaml = `
schemaVersion: 1
name: t
version: 1.0.0
agents:
  - name: alice
    role: lead
    skillKeys: []
routing:
  rules:
    - match: "[unclosed"
      mention: "@x"
`;
    expect(() => parseManifest(yaml)).toThrow(/regex/i);
  });
});

describe("serializeManifest", () => {
  it("roundtrips: parse -> serialize -> parse equivalence", () => {
    const m1 = parseManifest(VALID_YAML);
    const yaml = serializeManifest(m1);
    const m2 = parseManifest(yaml);
    expect(m2).toEqual(m1);
  });
});

describe("TeamManifestSchema regex ReDoS hardening", () => {
  it("rejects pathological nested-quantifier regex patterns", () => {
    // The classic ReDoS shape: nested quantifier with ambiguity.
    const manifest = {
      name: "qa",
      description: "x",
      schemaVersion: 1,
      routing: {
        rules: [{ match: "(a+)+$", mention: "@x" }],
      },
      agents: [],
      version: "1.0.0",
      displayName: "QA",
    };

    expect(() => TeamManifestSchema.parse(manifest)).toThrow(/regex|pattern/i);
  });

  it("rejects regex patterns over 256 characters", () => {
    const longPattern = "a".repeat(257);
    const manifest = {
      name: "qa",
      description: "x",
      schemaVersion: 1,
      routing: {
        rules: [{ match: longPattern, mention: "@x" }],
      },
      agents: [],
      version: "1.0.0",
      displayName: "QA",
    };

    expect(() => TeamManifestSchema.parse(manifest)).toThrow(/256|length/i);
  });

  it("accepts simple, non-pathological patterns", () => {
    const manifest = {
      name: "qa",
      description: "x",
      schemaVersion: 1,
      routing: {
        rules: [{ match: "release|hotfix", mention: "@alice" }],
      },
      agents: [],
      version: "1.0.0",
      displayName: "QA",
    };

    expect(() => TeamManifestSchema.parse(manifest)).not.toThrow();
  });
});
