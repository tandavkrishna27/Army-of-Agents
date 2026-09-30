import { describe, expect, it } from "vitest";
import { ensureLocalTrustedQuickstartIdentity } from "../commands/run-environment.js";

describe("ensureLocalTrustedQuickstartIdentity", () => {
  it("keeps a zero-config local_trusted quickstart bootable", () => {
    const env: Record<string, string | undefined> = {};

    expect(ensureLocalTrustedQuickstartIdentity("local_trusted", env)).toBe(true);
    expect(env.AOA_DEV_LOCAL_IDENTITY).toBe("1");
  });

  it("does not enable the hatch when Google is fully configured", () => {
    const env = {
      GOOGLE_CLIENT_ID: "client",
      GOOGLE_CLIENT_SECRET: "secret",
    };

    expect(ensureLocalTrustedQuickstartIdentity("local_trusted", env)).toBe(false);
    expect(env).not.toHaveProperty("AOA_DEV_LOCAL_IDENTITY");
  });

  it("honors an explicit disabled hatch", () => {
    const env = { AOA_DEV_LOCAL_IDENTITY: "0" };

    expect(ensureLocalTrustedQuickstartIdentity("local_trusted", env)).toBe(false);
    expect(env.AOA_DEV_LOCAL_IDENTITY).toBe("0");
  });

  it("never enables the hatch for authenticated deployments", () => {
    const env: Record<string, string | undefined> = {};

    expect(ensureLocalTrustedQuickstartIdentity("authenticated", env)).toBe(false);
    expect(env.AOA_DEV_LOCAL_IDENTITY).toBeUndefined();
  });

  it("uses the hatch when Google credentials are only partially configured", () => {
    const env: Record<string, string | undefined> = { GOOGLE_CLIENT_ID: "client" };

    expect(ensureLocalTrustedQuickstartIdentity("local_trusted", env)).toBe(true);
    expect(env.AOA_DEV_LOCAL_IDENTITY).toBe("1");
  });
});
