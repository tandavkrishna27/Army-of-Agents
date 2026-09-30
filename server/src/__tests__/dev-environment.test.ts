import { describe, expect, it } from "vitest";
import { buildDevEnvironment } from "../../../scripts/dev-environment.mjs";

describe("buildDevEnvironment", () => {
  it("keeps zero-config local development bootable with the identity hatch", () => {
    expect(buildDevEnvironment({}, false).AOA_DEV_LOCAL_IDENTITY).toBe("1");
  });

  it("does not enable the hatch for a Google-backed local install", () => {
    const env = buildDevEnvironment(
      { GOOGLE_CLIENT_ID: "client", GOOGLE_CLIENT_SECRET: "secret" },
      false,
    );
    expect(env.AOA_DEV_LOCAL_IDENTITY).toBeUndefined();
  });

  it("honors an explicit disabled hatch", () => {
    expect(
      buildDevEnvironment({ AOA_DEV_LOCAL_IDENTITY: "0" }, false).AOA_DEV_LOCAL_IDENTITY,
    ).toBe("0");
  });

  it("never enables the hatch for authenticated private development", () => {
    const env = buildDevEnvironment({}, true);
    expect(env.AOA_DEV_LOCAL_IDENTITY).toBeUndefined();
    expect(env.AOA_DEPLOYMENT_MODE).toBe("authenticated");
  });
});
