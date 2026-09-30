import { beforeEach, describe, expect, it, vi } from "vitest";

describe("env-compat", () => {
  // env-compat runs its mirror once at module load. Use vi.resetModules()
  // in each test so we get a fresh evaluation.
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Reset module registry so each test reimports env-compat fresh,
    // causing the side-effect mirror to run again with the test's env.
    vi.resetModules();

    process.env = { ...originalEnv };
    // Strip every PAPERCLIP_ / AOA_ key so each test sets exactly what it needs.
    for (const k of Object.keys(process.env)) {
      if (k.startsWith("PAPERCLIP_") || k.startsWith("AOA_")) delete process.env[k];
    }
  });

  it("mirrors PAPERCLIP_FOO into AOA_FOO when AOA_FOO is unset", async () => {
    process.env.PAPERCLIP_FOO = "bar";
    await import("../env-compat.js");
    expect(process.env.AOA_FOO).toBe("bar");
  });

  it("does NOT overwrite AOA_FOO when both are set", async () => {
    process.env.PAPERCLIP_FOO = "from-paperclip";
    process.env.AOA_FOO = "from-aoa";
    await import("../env-compat.js");
    expect(process.env.AOA_FOO).toBe("from-aoa");
  });

  it("readAoaEnv prefers AOA_FOO over PAPERCLIP_FOO", async () => {
    process.env.AOA_FOO = "aoa-value";
    process.env.PAPERCLIP_FOO = "paperclip-value";
    const { readAoaEnv } = await import("../env-compat.js");
    expect(readAoaEnv("FOO")).toBe("aoa-value");
  });

  it("readAoaEnv falls back to PAPERCLIP_FOO when AOA_FOO is unset", async () => {
    process.env.PAPERCLIP_FOO = "paperclip-value";
    const { readAoaEnv } = await import("../env-compat.js");
    expect(readAoaEnv("FOO")).toBe("paperclip-value");
  });

  it("readAoaEnv returns undefined when neither is set", async () => {
    const { readAoaEnv } = await import("../env-compat.js");
    expect(readAoaEnv("ABSENT_KEY")).toBeUndefined();
  });
});
