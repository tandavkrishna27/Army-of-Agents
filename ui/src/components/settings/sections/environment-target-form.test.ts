import { describe, expect, it } from "vitest";
import { buildGvisorConfig, normalizeExecutionTargetId, parseGvisorConfig } from "./environment-target-form";

describe("buildGvisorConfig", () => {
  it("produces a valid gvisor sandbox config with runsc + isolation defaults", () => {
    const cfg = buildGvisorConfig({ image: "aoa/agent-base:latest", memory: "2g", cpus: "2", pidsLimit: "512" });
    expect(cfg).toEqual({
      provider: "gvisor",
      image: "aoa/agent-base:latest",
      runtime: "runsc",
      network: "none",
      isolation: {
        user: "1000:1000",
        capDropAll: true,
        noNewPrivileges: true,
        readOnlyRootfs: true,
        memory: "2g",
        cpus: "2",
        pidsLimit: 512,
      },
    });
  });

  it("falls back to 2g/2/512 when memory/cpus/pidsLimit are blank or non-numeric", () => {
    const cfg = buildGvisorConfig({ image: "aoa/agent-base:latest", memory: "", cpus: "", pidsLimit: "" });
    expect(cfg.isolation).toEqual(
      expect.objectContaining({ memory: "2g", cpus: "2", pidsLimit: 512 }),
    );
  });

  it("trims the image and numeric-string fields", () => {
    const cfg = buildGvisorConfig({ image: "  aoa/agent-base:latest  ", memory: " 4g ", cpus: " 4 ", pidsLimit: "1024" });
    expect(cfg.image).toBe("aoa/agent-base:latest");
    expect(cfg.isolation).toEqual(
      expect.objectContaining({ memory: "4g", cpus: "4", pidsLimit: 1024 }),
    );
  });
});

describe("parseGvisorConfig", () => {
  it("round-trips a persisted gvisor config back into editable form fields", () => {
    const persisted = buildGvisorConfig({ image: "aoa/agent-base:latest", memory: "4g", cpus: "4", pidsLimit: "1024" });
    expect(parseGvisorConfig(persisted)).toEqual({
      image: "aoa/agent-base:latest",
      memory: "4g",
      cpus: "4",
      pidsLimit: "1024",
    });
  });

  it("defaults to empty image + 2g/2/512 for a missing or empty config", () => {
    expect(parseGvisorConfig(undefined)).toEqual({ image: "", memory: "2g", cpus: "2", pidsLimit: "512" });
    expect(parseGvisorConfig(null)).toEqual({ image: "", memory: "2g", cpus: "2", pidsLimit: "512" });
    expect(parseGvisorConfig({})).toEqual({ image: "", memory: "2g", cpus: "2", pidsLimit: "512" });
  });
});

describe("normalizeExecutionTargetId", () => {
  it("turns blank input into null (unpinned = route by credential)", () => {
    expect(normalizeExecutionTargetId("")).toBeNull();
    expect(normalizeExecutionTargetId("   ")).toBeNull();
  });

  it("trims a real id", () => {
    expect(normalizeExecutionTargetId("  11111111-1111-1111-1111-111111111111  ")).toBe(
      "11111111-1111-1111-1111-111111111111",
    );
  });
});
