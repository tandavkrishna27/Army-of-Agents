import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config.js";
import type { Db } from "@armyofagents/db";

// Avoid the drizzle-orm ESM cycle that better-auth's drizzle adapter pulls in
// transitively. We don't need a real drizzle adapter here — the gate runs
// before betterAuth() is invoked, and when it does run we just need a stub.
vi.mock("better-auth/adapters/drizzle", () => ({
  drizzleAdapter: vi.fn(() => ({})),
}));

vi.mock("better-auth", () => ({
  betterAuth: vi.fn((cfg: unknown) => ({ __cfg: cfg })),
}));

vi.mock("better-auth/node", () => ({
  toNodeHandler: vi.fn(() => () => undefined),
}));

vi.mock("@armyofagents/db", () => {
  const makeTable = (name: string) => new Proxy(
    {} as Record<string, unknown>,
    {
      get(_t, prop) {
        if (prop === "_") return { name };
        if (typeof prop === "string") return Symbol(`${name}.${prop}`);
        return undefined;
      },
    },
  );
  return {
    authUsers: makeTable("auth_users"),
    authSessions: makeTable("auth_sessions"),
    authAccounts: makeTable("auth_accounts"),
    authVerifications: makeTable("auth_verifications"),
  };
});

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
const mockPromoteFirstUser = vi.hoisted(() => vi.fn(async () => true));

vi.mock("../middleware/logger.js", () => ({
  logger: mockLogger,
  httpLogger: vi.fn(),
}));

vi.mock("../services/first-user-bootstrap.js", () => ({
  promoteFirstUserToInstanceAdmin: mockPromoteFirstUser,
  // Mirrors the real chokepoint (server/src/services/first-user-bootstrap.ts)
  // rather than importOriginal — that module also imports drizzle-orm's
  // `and`/`eq`/`sql`, which would reintroduce the ESM cycle this file's mocks
  // (above) exist to avoid. Pure logic, kept in lockstep with the real impl
  // by dedicated coverage in instance-admin-bootstrap-gate.test.ts.
  instanceAdminBootstrapEnabled: (mode: string) => mode !== "cloud_auth",
}));

const { createBetterAuthInstance, deriveAuthTrustedOrigins, buildBetterAuthConfig, assertAuthProviderConfigured } = await import("../auth/better-auth.js");

const SECRET_ENV = "BETTER_AUTH_SECRET";
const FALLBACK_ENV = "AOA_AGENT_JWT_SECRET";

const originalEnv = {
  secret: process.env[SECRET_ENV],
  fallback: process.env[FALLBACK_ENV],
};

function restoreEnv() {
  if (originalEnv.secret === undefined) delete process.env[SECRET_ENV];
  else process.env[SECRET_ENV] = originalEnv.secret;
  if (originalEnv.fallback === undefined) delete process.env[FALLBACK_ENV];
  else process.env[FALLBACK_ENV] = originalEnv.fallback;
}

function makeConfig(overrides: Partial<Config> = {}): Config {
  // Minimal stub — only the fields createBetterAuthInstance touches matter.
  return {
    deploymentMode: "local_trusted",
    deploymentExposure: "private",
    host: "127.0.0.1",
    port: 3100,
    allowedHostnames: [],
    authBaseUrlMode: "auto",
    authPublicBaseUrl: undefined,
    databaseMode: "embedded-postgres",
    databaseUrl: undefined,
    embeddedPostgresDataDir: "/tmp/aoa",
    embeddedPostgresPort: 54329,
    databaseBackupEnabled: false,
    databaseBackupIntervalMinutes: 60,
    databaseBackupRetentionDays: 30,
    databaseBackupDir: "/tmp/aoa/backup",
    serveUi: false,
    uiDevMiddleware: false,
    secretsProvider: "local_encrypted",
    secretsStrictMode: false,
    secretsMasterKeyFilePath: "/tmp/aoa/master.key",
    storageProvider: "local_disk",
    storageLocalDiskBaseDir: "/tmp/aoa/storage",
    storageS3Bucket: "",
    storageS3Region: "",
    storageS3Endpoint: undefined,
    storageS3Prefix: "",
    storageS3ForcePathStyle: false,
    heartbeatSchedulerEnabled: false,
    heartbeatSchedulerIntervalMs: 30000,
    companyDeletionEnabled: false,
    googleClientId: null,
    googleClientSecret: null,
    devLocalIdentity: false,
    ...overrides,
  };
}

const fakeDb = {} as unknown as Db;

describe("createBetterAuthInstance — fail-closed secret gate", () => {
  beforeEach(() => {
    delete process.env[SECRET_ENV];
    delete process.env[FALLBACK_ENV];
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
    mockPromoteFirstUser.mockReset();
    mockPromoteFirstUser.mockResolvedValue(true);
  });

  afterEach(() => {
    restoreEnv();
  });

  it("local_trusted mode without env returns instance and logs WARN", () => {
    const config = makeConfig({ deploymentMode: "local_trusted" });

    const instance = createBetterAuthInstance(fakeDb, config, []);

    expect(instance).toBeDefined();
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    const [warnArg] = mockLogger.warn.mock.calls[0]!;
    const warnText =
      typeof warnArg === "string"
        ? warnArg
        : JSON.stringify(warnArg);
    expect(warnText).toMatch(/BETTER_AUTH_SECRET/);
    expect(warnText.toLowerCase()).toMatch(/dev|fallback/);
  });

  it("authenticated mode without env throws with clear message", () => {
    const config = makeConfig({ deploymentMode: "authenticated" });

    expect(() => createBetterAuthInstance(fakeDb, config, [])).toThrow(
      /BETTER_AUTH_SECRET/,
    );
  });

  it("non-local-trusted modes (cloud_auth) without env throw", () => {
    // cloud_auth isn't in the canonical DeploymentMode union today, but the
    // gate must default-deny — any future mode that isn't local_trusted
    // must fail closed.
    const config = makeConfig({
      // Intentional cast: we're verifying default-deny behaviour.
      deploymentMode: "cloud_auth" as unknown as Config["deploymentMode"],
    });

    expect(() => createBetterAuthInstance(fakeDb, config, [])).toThrow(
      /BETTER_AUTH_SECRET/,
    );
  });

  it("local_trusted with BETTER_AUTH_SECRET set returns instance and does NOT warn", () => {
    process.env[SECRET_ENV] = "real-secret-32-chars-of-entropy-here";
    const config = makeConfig({ deploymentMode: "local_trusted" });

    const instance = createBetterAuthInstance(fakeDb, config, []);

    expect(instance).toBeDefined();
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it("authenticated with BETTER_AUTH_SECRET set returns instance and does NOT warn", () => {
    process.env[SECRET_ENV] = "real-secret-32-chars-of-entropy-here";
    const config = makeConfig({ deploymentMode: "authenticated" });

    const instance = createBetterAuthInstance(fakeDb, config, []);

    expect(instance).toBeDefined();
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it("authenticated with AOA_AGENT_JWT_SECRET fallback set returns instance", () => {
    process.env[FALLBACK_ENV] = "fallback-secret-32-chars-of-entropy";
    const config = makeConfig({ deploymentMode: "authenticated" });

    const instance = createBetterAuthInstance(fakeDb, config, []);

    expect(instance).toBeDefined();
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it("rejects whitespace-only BETTER_AUTH_SECRET in authenticated mode", () => {
    process.env[SECRET_ENV] = "   ";
    const config = makeConfig({ deploymentMode: "authenticated" });

    expect(() => createBetterAuthInstance(fakeDb, config, [])).toThrow(
      /BETTER_AUTH_SECRET/,
    );
  });
});

describe("deriveAuthTrustedOrigins — scheme rules per deployment mode", () => {
  it("authenticated mode: HTTPS only, no http:// fallback", () => {
    const config = makeConfig({
      deploymentMode: "authenticated",
      allowedHostnames: ["example.com"],
      authBaseUrlMode: "auto",
    });
    const origins = deriveAuthTrustedOrigins(config);
    expect(origins).toContain("https://example.com");
    expect(origins).not.toContain("http://example.com");
  });

  it("local_trusted mode: both http:// and https:// allowed (loopback dev)", () => {
    const config = makeConfig({
      deploymentMode: "local_trusted",
      allowedHostnames: ["localhost"],
      authBaseUrlMode: "auto",
    });
    const origins = deriveAuthTrustedOrigins(config);
    expect(origins).toContain("http://localhost");
    expect(origins).toContain("https://localhost");
  });
});

describe("deriveAuthTrustedOrigins port variants", () => {
  it("emits :port variants for allowed hostnames when listenPort ≠ 80,443", async () => {
    const { deriveAuthTrustedOrigins } = await import("../auth/better-auth.js");
    const config = {
      deploymentMode: "authenticated",
      port: 3100,
      allowedHostnames: ["app.example.com", "founder.tail.example.ts.net"],
    } as any;
    const origins = deriveAuthTrustedOrigins(config, { listenPort: 3101 });
    expect(origins).toContain("https://app.example.com");
    expect(origins).toContain("https://app.example.com:3101");
    expect(origins).toContain("https://founder.tail.example.ts.net:3101");
  });

  it("omits :port variants when listenPort is 443", async () => {
    const { deriveAuthTrustedOrigins } = await import("../auth/better-auth.js");
    const config = {
      deploymentMode: "authenticated",
      port: 443,
      allowedHostnames: ["app.example.com"],
    } as any;
    const origins = deriveAuthTrustedOrigins(config, { listenPort: 443 });
    expect(origins).toContain("https://app.example.com");
    expect(origins).not.toContain("https://app.example.com:443");
  });

  it("uses config.port when no listenPort opt is given (back-compat)", async () => {
    const { deriveAuthTrustedOrigins } = await import("../auth/better-auth.js");
    const config = {
      deploymentMode: "authenticated",
      port: 3100,
      allowedHostnames: ["app.example.com"],
    } as any;
    const origins = deriveAuthTrustedOrigins(config);
    expect(origins).toContain("https://app.example.com:3100");
  });
});

describe("buildBetterAuthConfig — google provider, no email/password (Stage A / A2)", () => {
  beforeEach(() => {
    mockLogger.error.mockClear();
    mockPromoteFirstUser.mockReset();
    mockPromoteFirstUser.mockResolvedValue(true);
  });

  it("configures google when creds present", () => {
    const c = buildBetterAuthConfig(
      fakeDb,
      makeConfig({ deploymentMode: "authenticated", googleClientId: "gid", googleClientSecret: "gsecret" }),
      [],
      "secret",
    ) as Record<string, any>;
    expect(c.socialProviders?.google?.clientId).toBe("gid");
    expect(c.socialProviders?.google?.clientSecret).toBe("gsecret");
  });

  it("does NOT enable email/password", () => {
    const c = buildBetterAuthConfig(fakeDb, makeConfig(), [], "secret") as Record<string, any>;
    expect(c.emailAndPassword).toBeUndefined();
  });

  it("omits google when creds absent (builder is silent; startup guard enforces)", () => {
    const c = buildBetterAuthConfig(
      fakeDb,
      makeConfig({ googleClientId: null, googleClientSecret: null }),
      [],
      "secret",
    ) as Record<string, any>;
    expect(c.socialProviders?.google).toBeUndefined();
  });

  it("wires the first-user admin bootstrap hook (RB3/A7)", () => {
    const c = buildBetterAuthConfig(fakeDb, makeConfig(), [], "secret") as Record<string, any>;
    expect(typeof c.databaseHooks?.user?.create?.after).toBe("function");
  });

  it("retries the idempotent admin bootstrap whenever a new session is created", async () => {
    const c = buildBetterAuthConfig(fakeDb, makeConfig(), [], "secret") as Record<string, any>;
    await c.databaseHooks.session.create.after({ userId: "u1" });
    expect(mockPromoteFirstUser).toHaveBeenCalledWith(fakeDb, "u1", {
      preserveSyntheticAdmin: false,
    });
  });

  it("preserves the synthetic admin while the explicit headless claim gate is active", async () => {
    const c = buildBetterAuthConfig(
      fakeDb,
      makeConfig({ headlessBootstrap: true }),
      [],
      "secret",
    ) as Record<string, any>;
    await c.databaseHooks.session.create.after({ userId: "u1" });
    expect(mockPromoteFirstUser).toHaveBeenCalledWith(fakeDb, "u1", {
      preserveSyntheticAdmin: true,
    });
  });

  it("logs bootstrap failures at error level without blocking sign-in", async () => {
    mockPromoteFirstUser.mockRejectedValueOnce(new Error("database unavailable"));
    const c = buildBetterAuthConfig(fakeDb, makeConfig(), [], "secret") as Record<string, any>;
    await expect(c.databaseHooks.session.create.after({ userId: "u1" })).resolves.toBeUndefined();
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u1", source: "session_create" }),
      expect.stringMatching(/admin bootstrap failed/i),
    );
  });

  it("configures a long-lived session for local-first use (A11)", () => {
    const c = buildBetterAuthConfig(fakeDb, makeConfig(), [], "secret") as Record<string, any>;
    expect(c.session?.expiresIn).toBeGreaterThanOrEqual(60 * 60 * 24 * 30);
    expect(c.session?.updateAge).toBeGreaterThan(0);
  });
});

describe("assertAuthProviderConfigured (revA R6 — fail startup on missing google)", () => {
  it("throws in authenticated mode when google creds missing", () => {
    expect(() =>
      assertAuthProviderConfigured(
        makeConfig({ deploymentMode: "authenticated", googleClientId: null, googleClientSecret: null }),
      ),
    ).toThrow(/google/i);
  });

  it("passes in authenticated mode when creds present", () => {
    expect(() =>
      assertAuthProviderConfigured(
        makeConfig({ deploymentMode: "authenticated", googleClientId: "gid", googleClientSecret: "gsecret" }),
      ),
    ).not.toThrow();
  });

  it("throws in local_trusted without escape hatch when creds missing", () => {
    expect(() =>
      assertAuthProviderConfigured(
        makeConfig({ deploymentMode: "local_trusted", googleClientId: null, googleClientSecret: null, devLocalIdentity: false }),
      ),
    ).toThrow();
  });

  it("passes in local_trusted with escape hatch even when creds missing", () => {
    expect(() =>
      assertAuthProviderConfigured(
        makeConfig({ deploymentMode: "local_trusted", googleClientId: null, googleClientSecret: null, devLocalIdentity: true }),
      ),
    ).not.toThrow();
  });
});

describe("buildBetterAuthConfig — security hardening (Stage D / D6)", () => {
  it("enables the Google social provider (better-auth applies OAuth state + PKCE for social sign-in)", () => {
    const c = buildBetterAuthConfig(
      fakeDb,
      makeConfig({ googleClientId: "gid", googleClientSecret: "gsecret" }),
      ["https://app.example.com"],
      "secret",
    ) as Record<string, any>;
    expect(c.socialProviders?.google?.clientId).toBe("gid");
  });

  it("hardens the session cookie for public authenticated deployments", () => {
    const c = buildBetterAuthConfig(
      fakeDb,
      makeConfig({
        deploymentMode: "authenticated",
        deploymentExposure: "public",
        googleClientId: "gid",
        googleClientSecret: "gsecret",
      }),
      ["https://app.example.com"],
      "secret",
    ) as Record<string, any>;
    const cookie = c.advanced?.defaultCookieAttributes;
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.secure).toBe(true);
    expect(String(cookie?.sameSite)).toMatch(/lax|strict/i);
  });

  it("does NOT force Secure for private authenticated deployments served over HTTP", () => {
    const c = buildBetterAuthConfig(
      fakeDb,
      makeConfig({
        deploymentMode: "authenticated",
        deploymentExposure: "private",
        authBaseUrlMode: "auto",
        authPublicBaseUrl: undefined,
      }),
      [],
      "secret",
    ) as Record<string, any>;
    expect(c.advanced?.defaultCookieAttributes?.secure).toBe(false);
    expect(c.advanced?.useSecureCookies).toBe(false);
  });

  it("keeps Secure for a private authenticated deployment with an explicit HTTPS base URL", () => {
    const c = buildBetterAuthConfig(
      fakeDb,
      makeConfig({
        deploymentMode: "authenticated",
        deploymentExposure: "private",
        authBaseUrlMode: "explicit",
        authPublicBaseUrl: "https://aoa.tailnet.example",
      }),
      ["https://aoa.tailnet.example"],
      "secret",
    ) as Record<string, any>;
    expect(c.advanced?.defaultCookieAttributes?.secure).toBe(true);
    expect(c.advanced?.useSecureCookies).toBe(true);
  });

  it("does NOT force Secure in local_trusted (loopback http dev would drop a Secure cookie)", () => {
    const c = buildBetterAuthConfig(
      fakeDb,
      makeConfig({ deploymentMode: "local_trusted" }),
      [],
      "secret",
    ) as Record<string, any>;
    expect(c.advanced?.defaultCookieAttributes?.secure).toBe(false);
    expect(c.advanced?.defaultCookieAttributes?.httpOnly).toBe(true);
  });
});
