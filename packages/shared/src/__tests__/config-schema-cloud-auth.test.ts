import { describe, it, expect } from "vitest";
import { DEPLOYMENT_MODES } from "../constants.js";
import { paperclipConfigSchema } from "../config-schema.js";

const base = {
  // configMetaSchema requires updatedAt/source; the plan's fixture omitted them.
  $meta: { version: 1, updatedAt: "2026-07-30T00:00:00.000Z", source: "configure" },
  database: { mode: "postgres", url: "postgres://x" },
  logging: { mode: "file", logDir: "/tmp" },
  storage: undefined,
  secrets: undefined,
} as any;

describe("cloud_auth deployment mode", () => {
  it("is a member of DEPLOYMENT_MODES (owned by Phase 1 — this asserts the prerequisite is present)", () => {
    expect(DEPLOYMENT_MODES).toContain("cloud_auth");
  });

  it("requires public exposure + explicit base URL", () => {
    const bad = paperclipConfigSchema.safeParse({
      ...base,
      server: { deploymentMode: "cloud_auth", exposure: "private", host: "0.0.0.0", port: 3101, allowedHostnames: [], serveUi: true },
      auth: { baseUrlMode: "auto" },
    });
    expect(bad.success).toBe(false);

    const good = paperclipConfigSchema.safeParse({
      ...base,
      server: { deploymentMode: "cloud_auth", exposure: "public", host: "0.0.0.0", port: 3101, allowedHostnames: [], serveUi: true },
      auth: { baseUrlMode: "explicit", publicBaseUrl: "https://app.example.com" },
    });
    expect(good.success).toBe(true);
  });
});
