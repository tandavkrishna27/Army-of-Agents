import { describe, it, expect, afterEach } from "vitest";
import { loadConfig } from "../config.js";

const OLD = { ...process.env };
afterEach(() => {
  process.env = { ...OLD };
});

describe("config: google + escape hatch", () => {
  it("reads GOOGLE_CLIENT_ID/SECRET into config", () => {
    process.env.GOOGLE_CLIENT_ID = "gid";
    process.env.GOOGLE_CLIENT_SECRET = "gsecret";
    const cfg = loadConfig();
    expect(cfg.googleClientId).toBe("gid");
    expect(cfg.googleClientSecret).toBe("gsecret");
  });

  it("defaults google + escape hatch to null/false", () => {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.AOA_DEV_LOCAL_IDENTITY;
    const cfg = loadConfig();
    expect(cfg.googleClientId).toBeNull();
    expect(cfg.googleClientSecret).toBeNull();
    expect(cfg.devLocalIdentity).toBe(false);
  });

  it("reads AOA_DEV_LOCAL_IDENTITY=1 as true", () => {
    process.env.AOA_DEPLOYMENT_MODE = "local_trusted";
    process.env.AOA_DEV_LOCAL_IDENTITY = "1";
    expect(loadConfig().devLocalIdentity).toBe(true);
  });

  it("ignores AOA_DEV_LOCAL_IDENTITY outside local_trusted mode", () => {
    process.env.AOA_DEPLOYMENT_MODE = "authenticated";
    process.env.AOA_DEV_LOCAL_IDENTITY = "1";
    expect(loadConfig().devLocalIdentity).toBe(false);
  });

  it("reads AOA_HEADLESS_BOOTSTRAP and defaults false (A10)", () => {
    delete process.env.AOA_HEADLESS_BOOTSTRAP;
    expect(loadConfig().headlessBootstrap).toBe(false);
    process.env.AOA_HEADLESS_BOOTSTRAP = "1";
    expect(loadConfig().headlessBootstrap).toBe(true);
  });
});
