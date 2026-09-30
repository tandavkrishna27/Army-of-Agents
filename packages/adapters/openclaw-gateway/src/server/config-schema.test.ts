import { describe, expect, it } from "vitest";
import { getConfigSchema } from "./config-schema.js";

describe("openclaw gateway config schema", () => {
  it("exposes gateway connection and session fields for schema-driven UI", () => {
    const schema = getConfigSchema();
    const labels = schema.fields.map((field: { label: string }) => field.label);

    expect(schema.version).toBe(1);
    expect(labels).toContain("Gateway URL");
    expect(labels).toContain("Auth token");
    expect(labels).toContain("Session strategy");
    expect(labels).toContain("Timeout seconds");
  });
});
