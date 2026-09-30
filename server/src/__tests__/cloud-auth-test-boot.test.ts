import { describe, it, expect } from "vitest";
import {
  assertAuthProviderConfigured,
  allowCloudAuthBootWithoutGoogle,
  buildBetterAuthConfig,
} from "../auth/better-auth.js";
import { assertTestSupportFlagSafe } from "../services/test-support-safety.js";

const noGoogleCloud = {
  deploymentMode: "cloud_auth", devLocalIdentity: false,
  googleClientId: null, googleClientSecret: null,
  authBaseUrlMode: "explicit", authPublicBaseUrl: "https://a.example.com",
  deploymentExposure: "public",
} as any;

describe("cloud_auth test-support boot relaxation (AOA_E2E_TEST_SUPPORT)", () => {
  it("boots WITHOUT Google creds only on a safety-gated private loopback test process", () => {
    const privateLoopbackCloud = {
      ...noGoogleCloud,
      deploymentExposure: "private",
      authPublicBaseUrl: "http://127.0.0.1:3210",
    };
    expect(() =>
      assertTestSupportFlagSafe({
        testSupportEnabled: true,
        testSupportToken: "t".repeat(32),
        deploymentExposure: privateLoopbackCloud.deploymentExposure,
        bindHost: "127.0.0.1",
        authPublicBaseUrl: privateLoopbackCloud.authPublicBaseUrl,
        nodeEnv: "test",
      }),
    ).not.toThrow();
    expect(() => assertAuthProviderConfigured(privateLoopbackCloud, true)).not.toThrow();
  });
  it("REFUSES to boot without Google creds when the flag is UNSET (real-prod invariant)", () => {
    expect(() => assertAuthProviderConfigured(noGoogleCloud, false)).toThrow(/Google OAuth is not configured/i);
  });
  it("mounts a stub Google provider under the flag (sessions come from the P6 test-mint seam)", () => {
    const built = buildBetterAuthConfig({} as any, noGoogleCloud, [], "s", true) as any;
    expect(built.socialProviders?.google).toBeDefined();
  });
  it("helper is true ONLY for cloud_auth + flag on", () => {
    expect(allowCloudAuthBootWithoutGoogle("cloud_auth", true)).toBe(true);
    expect(allowCloudAuthBootWithoutGoogle("cloud_auth", false)).toBe(false);
    expect(allowCloudAuthBootWithoutGoogle("authenticated", true)).toBe(false);
  });
});
