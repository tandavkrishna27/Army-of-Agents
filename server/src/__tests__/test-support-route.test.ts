import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzleOperatorStubs, makeTableProxy } from "./helpers/drizzle-mock.js";

vi.mock("drizzle-orm", () => drizzleOperatorStubs());
vi.mock("@armyofagents/db", () => ({
  onboardingProgress: makeTableProxy("onboarding_progress"),
  authUsers: makeTableProxy("user"),
  authSessions: makeTableProxy("session"),
  authAccounts: makeTableProxy("account"),
  authVerifications: makeTableProxy("verification"),
}));
// The route imports resolveBetterAuthSigningSecret from ../auth/better-auth.js,
// which pulls better-auth's drizzle adapter + the server logger transitively.
// Stub both (the adapter would re-enter the drizzle-orm ESM cycle; the logger
// creates a log dir at import). better-auth CORE stays REAL — the round-trip
// test below feeds the minted cookie to a genuine betterAuth instance.
vi.mock("better-auth/adapters/drizzle", () => ({ drizzleAdapter: vi.fn(() => ({})) }));
vi.mock("../middleware/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  httpLogger: vi.fn(),
}));

import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { authSessions, authUsers } from "@armyofagents/db";
import { testSupportRoutes } from "../routes/test-support.js";

function makeApp(
  db: unknown,
  actor: Record<string, unknown> = { type: "board", userId: "local-board" },
  deploymentMode: "local_trusted" | "authenticated" | "cloud_auth" = "local_trusted",
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as { actor: unknown }).actor = actor as never;
    next();
  });
  app.use("/api", testSupportRoutes(db as never, { deploymentMode }));
  return app;
}

describe("DELETE /api/test/onboarding-progress", () => {
  let deleted: unknown[];
  beforeEach(() => {
    deleted = [];
  });
  const db = () =>
    ({ delete: () => ({ where: async (w: unknown) => { deleted.push(w); } }) }) as never;

  it("401 for a non-board actor", async () => {
    const res = await request(makeApp(db(), { type: "none" })).delete("/api/test/onboarding-progress");
    expect(res.status).toBe(401);
  });

  it("clears the actor's onboarding_progress rows and returns ok", async () => {
    const app = makeApp(db());
    const res = await request(app).delete("/api/test/onboarding-progress");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(deleted).toHaveLength(1);
  });
});

/**
 * In-memory stand-in for the drizzle Db, keyed by the (mocked) table proxies —
 * captures exactly the rows the route writes so the round-trip test can seed
 * them into a real better-auth memory adapter.
 */
function makeMintDb(seedUsers: Array<Record<string, unknown>> = []) {
  const users: Array<Record<string, unknown>> = [...seedUsers];
  const sessions: Array<Record<string, unknown>> = [];
  const userUpdates: Array<Record<string, unknown>> = [];
  const rowsFor = (table: unknown) =>
    table === (authUsers as unknown) ? users : sessions;
  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => Promise.resolve([...rowsFor(table)]),
      }),
    }),
    insert: (table: unknown) => ({
      values: (row: Record<string, unknown>) => {
        rowsFor(table).push(row);
        return Promise.resolve();
      },
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: () => {
          userUpdates.push(patch);
          const row = rowsFor(table)[0];
          if (row) Object.assign(row, patch);
          return Promise.resolve();
        },
      }),
    }),
    delete: () => ({ where: async () => {} }),
  };
  return { db, users, sessions, userUpdates };
}

const SESSION_SECONDS = { expiresIn: 60 * 60 * 24 * 90, updateAge: 60 * 60 * 24 };

describe("POST /api/test-support/session (e2e second-identity mint)", () => {
  const SECRET_ENV = "BETTER_AUTH_SECRET";
  const FALLBACK_ENV = "AOA_AGENT_JWT_SECRET";
  const HATCH_ENV = "AOA_DEV_LOCAL_IDENTITY";
  const E2E_ENV = "AOA_E2E_TEST_SUPPORT";
  const E2E_TOKEN_ENV = "AOA_E2E_TEST_SUPPORT_TOKEN";
  const E2E_TOKEN = "test-support-token-32-bytes-long";
  let savedSecret: string | undefined;
  let savedFallback: string | undefined;
  let savedHatch: string | undefined;
  let savedE2e: string | undefined;
  let savedE2eToken: string | undefined;

  beforeEach(() => {
    savedSecret = process.env[SECRET_ENV];
    savedFallback = process.env[FALLBACK_ENV];
    savedHatch = process.env[HATCH_ENV];
    savedE2e = process.env[E2E_ENV];
    savedE2eToken = process.env[E2E_TOKEN_ENV];
    // Pin the signing secret so the route and the verifying better-auth
    // instance below provably share it.
    process.env[SECRET_ENV] = "unit-mint-secret";
    delete process.env[FALLBACK_ENV];
    // The in-handler defense-in-depth gate requires the dev escape hatch.
    process.env[HATCH_ENV] = "1";
    delete process.env[E2E_ENV];
    delete process.env[E2E_TOKEN_ENV];
  });
  afterEach(() => {
    if (savedSecret === undefined) delete process.env[SECRET_ENV];
    else process.env[SECRET_ENV] = savedSecret;
    if (savedFallback === undefined) delete process.env[FALLBACK_ENV];
    else process.env[FALLBACK_ENV] = savedFallback;
    if (savedHatch === undefined) delete process.env[HATCH_ENV];
    else process.env[HATCH_ENV] = savedHatch;
    if (savedE2e === undefined) delete process.env[E2E_ENV];
    else process.env[E2E_ENV] = savedE2e;
    if (savedE2eToken === undefined) delete process.env[E2E_TOKEN_ENV];
    else process.env[E2E_TOKEN_ENV] = savedE2eToken;
  });

  it("404 when the deployment mode is not local_trusted (in-handler gate)", async () => {
    const { db, users, sessions } = makeMintDb();
    const res = await request(makeApp(db, undefined, "authenticated"))
      .post("/api/test-support/session")
      .send({ email: "a@b.test" });
    expect(res.status).toBe(404);
    expect(users).toHaveLength(0);
    expect(sessions).toHaveLength(0);
  });

  it("404 when the dev escape hatch env is not set (in-handler gate)", async () => {
    delete process.env[HATCH_ENV];
    const { db, users, sessions } = makeMintDb();
    const res = await request(makeApp(db))
      .post("/api/test-support/session")
      .send({ email: "a@b.test" });
    expect(res.status).toBe(404);
    expect(users).toHaveLength(0);
    expect(sessions).toHaveLength(0);
  });

  it("401 for a non-board actor", async () => {
    const { db } = makeMintDb();
    const res = await request(makeApp(db, { type: "none" }))
      .post("/api/test-support/session")
      .send({ email: "a@b.test" });
    expect(res.status).toBe(401);
  });

  it.each([
    ["missing", undefined],
    ["incorrect", "wrong-test-support-token"],
  ])("denies a cloud_auth mint with a %s bearer token before database writes", async (_label, token) => {
    delete process.env[HATCH_ENV];
    process.env[E2E_ENV] = "1";
    process.env[E2E_TOKEN_ENV] = E2E_TOKEN;
    const { db, users, sessions } = makeMintDb();
    const pending = request(makeApp(db, { type: "none" }, "cloud_auth"))
      .post("/api/test-support/session");
    const res = await (token ? pending.set("Authorization", `Bearer ${token}`) : pending)
      .send({ email: "founder@example.com" });
    expect(res.status).toBe(401);
    expect(users).toHaveLength(0);
    expect(sessions).toHaveLength(0);
  });

  it("mints the first cloud_auth identity with the dedicated e2e bearer token", async () => {
    delete process.env[HATCH_ENV];
    process.env[E2E_ENV] = "1";
    process.env[E2E_TOKEN_ENV] = E2E_TOKEN;
    const { db, users, sessions } = makeMintDb();
    const res = await request(makeApp(db, { type: "none" }, "cloud_auth"))
      .post("/api/test-support/session")
      .set("Authorization", `Bearer ${E2E_TOKEN}`)
      .send({ email: "cloud@example.com" });
    expect(res.status).toBe(200);
    expect(users).toHaveLength(1);
    expect(sessions).toHaveLength(1);
  });

  it("400 without a valid email", async () => {
    const { db } = makeMintDb();
    const res = await request(makeApp(db)).post("/api/test-support/session").send({ name: "No Email" });
    expect(res.status).toBe(400);
  });

  it("mints a verified user + session whose cookie better-auth's own getSession accepts", async () => {
    const { db, users, sessions } = makeMintDb();
    const res = await request(makeApp(db))
      .post("/api/test-support/session")
      .send({ email: "Invitee@Example.com", name: "Invitee One" });

    expect(res.status).toBe(200);
    const body = res.body as {
      userId: string;
      email: string;
      cookie: { name: string; value: string };
      expiresAt: string;
    };
    expect(body.email).toBe("invitee@example.com");
    expect(body.cookie.name).toBe("better-auth.session_token");
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({
      id: body.userId,
      email: "invitee@example.com",
      emailVerified: true,
      name: "Invitee One",
      displayName: "Invitee One",
    });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ userId: body.userId });
    // Short-lived by design: ~1 hour, never the production 90d.
    const ttlMs = new Date(body.expiresAt).getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(50 * 60 * 1000);
    expect(ttlMs).toBeLessThanOrEqual(60 * 60 * 1000);

    // ROUND-TRIP PROOF: hand the minted rows + cookie to a REAL betterAuth
    // instance (memory adapter, same secret + session config as production)
    // and assert its own getSession resolves the minted user. This exercises
    // better-call's signed-cookie verification (44-char base64 HMAC-SHA256,
    // split on the last "."), the session-token lookup, and expiry.
    const store = {
      user: [...users],
      session: [...sessions],
      account: [] as Array<Record<string, unknown>>,
      verification: [] as Array<Record<string, unknown>>,
    };
    const auth = betterAuth({
      baseURL: "http://localhost:3000",
      secret: "unit-mint-secret",
      database: memoryAdapter(store as never),
      session: SESSION_SECONDS,
      advanced: { useSecureCookies: false },
    });
    const resolved = await auth.api.getSession({
      headers: new Headers({ cookie: `${body.cookie.name}=${body.cookie.value}` }),
    });
    expect(resolved?.user?.id).toBe(body.userId);
    expect(resolved?.session?.userId).toBe(body.userId);
    expect(resolved?.user?.email).toBe("invitee@example.com");
    expect(resolved?.user?.emailVerified).toBe(true);
  });

  it("a tampered cookie is rejected by better-auth's verification", async () => {
    const { db, users, sessions } = makeMintDb();
    const res = await request(makeApp(db))
      .post("/api/test-support/session")
      .send({ email: "tamper@example.com" });
    expect(res.status).toBe(200);
    const body = res.body as { cookie: { name: string; value: string } };

    const auth = betterAuth({
      baseURL: "http://localhost:3000",
      secret: "unit-mint-secret",
      database: memoryAdapter({
        user: [...users],
        session: [...sessions],
        account: [],
        verification: [],
      } as never),
      session: SESSION_SECONDS,
      advanced: { useSecureCookies: false },
    });
    // Flip a character in the signed token — signature check must fail closed.
    const raw = decodeURIComponent(body.cookie.value);
    const tampered = encodeURIComponent(
      (raw[0] === "A" ? "B" : "A") + raw.slice(1),
    );
    const resolved = await auth.api.getSession({
      headers: new Headers({ cookie: `${body.cookie.name}=${tampered}` }),
    });
    expect(resolved).toBeNull();
  });

  it("is idempotent per email: re-mint reuses the user and issues a fresh session", async () => {
    const existingUser = {
      id: "existing-user-id",
      name: "Old Name",
      email: "repeat@example.com",
      emailVerified: false,
      displayName: null as string | null,
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    };
    const { db, users, sessions, userUpdates } = makeMintDb([existingUser]);
    const app = makeApp(db);

    const first = await request(app)
      .post("/api/test-support/session")
      .send({ email: "repeat@example.com", name: "New Name" });
    expect(first.status).toBe(200);
    expect(first.body.userId).toBe("existing-user-id");
    // No second user row; the existing one is re-verified + renamed.
    expect(users).toHaveLength(1);
    expect(userUpdates[0]).toMatchObject({ emailVerified: true, name: "New Name", displayName: "New Name" });

    const second = await request(app)
      .post("/api/test-support/session")
      .send({ email: "repeat@example.com" });
    expect(second.status).toBe(200);
    expect(second.body.userId).toBe("existing-user-id");
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.token).not.toBe(sessions[1]!.token);
    expect(second.body.cookie.value).not.toBe(first.body.cookie.value);
  });
});
