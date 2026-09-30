# Stage A — Auth & Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Read `2026-07-12-onboarding-auth-redesign-stage0-contracts.md` first — it defines every shared type referenced here.

**Goal:** Make Google the only sign-in/sign-up door (via better-auth), remove email/password, add the 3-journey post-auth router, replace the `local_trusted` auto-admin with a Google identity + a gated dev escape hatch, and auto-promote the first Google user of a fresh instance to instance admin.

**Architecture:** Keep the better-auth engine; swap the provider. Extract a pure `buildBetterAuthConfig` so the provider config is unit-testable. The post-auth journey resolver is a pure function fed by membership + invite lookups. `actorMiddleware`'s default actor stops being an auto-admin; the synthetic admin is produced only behind `AOA_DEV_LOCAL_IDENTITY` in `local_trusted`.

**Tech stack:** better-auth, Express 5, Drizzle, Vitest, React, Playwright.

**Ships independently:** after Stage A, a user can log in only via Google in `authenticated` mode; `local_trusted` dev works via the escape hatch; the first user becomes admin; the journey endpoint returns returning/invited/founder. (The onboarding flow itself is Stage B/C.)

---

## ⚠️ Reconciliation corrections (read before executing — applied 2026-07-12)

1. **Commands:** all inline commands are normalized to the verified forms in Stage 0 §7 — `pnpm test:run <path-substring>` (root vitest; server has NO package `test` script), `pnpm --filter @armyofagents/ui test:run <file>`, `pnpm typecheck`, `pnpm build`, `pnpm db:generate`, `pnpm test:e2e`. Note `pnpm test:run` filters test files by path *substring*, so the relative `src/__tests__/…` paths in the steps below still resolve to the right file.
2. **A5 invited detection was buggy** (compared a hashed stored token to a plaintext token AND ignored email → always no-op). The corrected implementation is in Task A5 below: hash the incoming token before matching, and match open invites by email via `defaultsPayload->'teamInvite'->>'email'`. Stage D Task D3 owns the full invited-detection hardening; A5 must at minimum not be a guaranteed no-op.
3. **A9 must NOT put the invite token in a URL query string.** Send it in an `x-invite-token` request header instead (see corrected A9). The journey route reads the header, not `req.query`.

---

## Pre-flight (once, before Task A1)

- [ ] **Confirm test/build script names**

Run: `node -e "console.log(Object.keys(require('./package.json').scripts))"` (root)
Expected: confirm the verified root scripts — `test:run` (= `vitest run`), `typecheck`, `build`, `db:generate`, `test:e2e`. **There is no root `verify` and no server-package `test` script.** Use `pnpm test:run <path-substring>` for any single server/ui/shared/db test file. These are the commands used in every `Run:` step below.

---

## Task A1: Config plumbing for Google + escape hatch

**Files:**
- Modify: `server/src/config.ts` (interface `Config` at :33; resolution block ~:151–239)
- Test: `server/src/__tests__/config-google-escape-hatch.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/config-google-escape-hatch.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { loadConfig } from "../config.js"; // confirm the exported loader name in config.ts

const OLD = { ...process.env };
afterEach(() => { process.env = { ...OLD }; });

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
    process.env.AOA_DEV_LOCAL_IDENTITY = "1";
    expect(loadConfig().devLocalIdentity).toBe(true);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `pnpm test:run src/__tests__/config-google-escape-hatch.test.ts`
Expected: FAIL — `googleClientId`/`devLocalIdentity` not on Config.

- [ ] **Step 3: Add fields to the `Config` interface**

In `server/src/config.ts`, inside `export interface Config {` (line 33), add:

```ts
  googleClientId: string | null;
  googleClientSecret: string | null;
  devLocalIdentity: boolean;
```

- [ ] **Step 4: Resolve them in the loader**

In the config resolution block (before the returned object ~:239), add:

```ts
  const googleClientId = process.env.GOOGLE_CLIENT_ID?.trim() || null;
  const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim() || null;
  const devLocalIdentity = /^(1|true|yes)$/i.test(process.env.AOA_DEV_LOCAL_IDENTITY?.trim() ?? "");
```

Then add `googleClientId, googleClientSecret, devLocalIdentity,` to the returned config object (near `deploymentMode,` at ~:239).

- [ ] **Step 5: Run test, verify pass**

Run: `pnpm test:run src/__tests__/config-google-escape-hatch.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add server/src/config.ts server/src/__tests__/config-google-escape-hatch.test.ts
git commit -m "feat(auth): add GOOGLE_* and AOA_DEV_LOCAL_IDENTITY config"
```

---

## Task A2: Google provider + remove email/password (pure, testable builder)

**Files:**
- Modify: `server/src/auth/better-auth.ts` (`createBetterAuthInstance` at :120–149)
- Test: `server/src/__tests__/better-auth-config.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/better-auth-config.test.ts
import { describe, it, expect } from "vitest";
import { buildBetterAuthConfig } from "../auth/better-auth.js";
import type { Config } from "../config.js";

const baseCfg = (over: Partial<Config> = {}): Config => ({
  deploymentMode: "authenticated",
  googleClientId: "gid",
  googleClientSecret: "gsecret",
  devLocalIdentity: false,
  authBaseUrlMode: "explicit",
  authPublicBaseUrl: "https://app.example.com",
  allowedHostnames: ["app.example.com"],
  // ...other required Config fields filled by the test as needed
} as unknown as Config);

describe("buildBetterAuthConfig", () => {
  it("configures google as a social provider", () => {
    const cfg = buildBetterAuthConfig({} as any, baseCfg(), ["https://app.example.com"], "secret");
    expect(cfg.socialProviders?.google?.clientId).toBe("gid");
    expect(cfg.socialProviders?.google?.clientSecret).toBe("gsecret");
  });
  it("does NOT enable email/password", () => {
    const cfg = buildBetterAuthConfig({} as any, baseCfg(), [], "secret");
    expect((cfg as any).emailAndPassword).toBeUndefined();
  });
  it("omits google provider when client id/secret missing", () => {
    const cfg = buildBetterAuthConfig({} as any, baseCfg({ googleClientId: null, googleClientSecret: null }), [], "secret");
    expect(cfg.socialProviders?.google).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `pnpm test:run src/__tests__/better-auth-config.test.ts`
Expected: FAIL — `buildBetterAuthConfig` not exported.

- [ ] **Step 3: Extract the pure builder and add google / drop email-password**

In `server/src/auth/better-auth.ts`, replace the body of `createBetterAuthInstance` (:120–149) with a call to a new exported pure function:

```ts
export function buildBetterAuthConfig(
  db: Db,
  config: Config,
  trustedOrigins: string[],
  secret: string,
): Record<string, unknown> & { socialProviders?: { google?: { clientId: string; clientSecret: string } } } {
  const baseUrl = config.authBaseUrlMode === "explicit" ? config.authPublicBaseUrl : undefined;
  const authConfig: Record<string, unknown> = {
    baseURL: baseUrl,
    secret,
    trustedOrigins,
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: { user: authUsers, session: authSessions, account: authAccounts, verification: authVerifications },
    }),
  };
  if (config.googleClientId && config.googleClientSecret) {
    (authConfig as any).socialProviders = {
      google: { clientId: config.googleClientId, clientSecret: config.googleClientSecret },
    };
  }
  if (!baseUrl) delete (authConfig as { baseURL?: string }).baseURL;
  return authConfig as any;
}

export function createBetterAuthInstance(db: Db, config: Config, trustedOrigins?: string[]): BetterAuthInstance {
  const secret = resolveBetterAuthSigningSecret(config);
  const effectiveTrustedOrigins = trustedOrigins ?? deriveAuthTrustedOrigins(config);
  return betterAuth(buildBetterAuthConfig(db, config, effectiveTrustedOrigins, secret));
}
```

Note the removed `emailAndPassword` block — email/password is gone.

- [ ] **Step 4: Run test, verify pass**

Run: `pnpm test:run src/__tests__/better-auth-config.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/auth/better-auth.ts server/src/__tests__/better-auth-config.test.ts
git commit -m "feat(auth): configure Google provider, remove email/password from better-auth"
```

---

## Task A3: Remove email/password Express routes + limiters

**Files:**
- Modify: `server/src/app.ts` (routes :244–246; limiter imports :14–15)
- Test: `server/src/__tests__/auth-routes-removed.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/auth-routes-removed.test.ts
import { describe, it, expect } from "vitest";
import request from "supertest";           // confirm supertest is a dev dep; else use the app's existing test harness
import { buildTestApp } from "./helpers/build-test-app.js"; // reuse existing app-test helper if present

describe("email/password auth routes are gone", () => {
  it("POST /api/auth/sign-in/email → 404 (route removed; not handled by wildcard as a real login)", async () => {
    const app = await buildTestApp();
    const res = await request(app).post("/api/auth/sign-in/email").send({ email: "a@b.c", password: "x" });
    // The wildcard /api/auth/* still exists, but email sign-in should no longer authenticate.
    // Assert it is not a 200 success with a session cookie:
    expect(res.status).not.toBe(200);
  });
});
```

> If no `buildTestApp` helper exists, write the assertion as a contract test on the route table instead: assert that `app._router.stack` contains no layer whose route path is `/api/auth/sign-in/email`. Prefer whichever pattern the repo already uses for route tests.

- [ ] **Step 2: Run test, verify it fails**

Run: `pnpm test:run src/__tests__/auth-routes-removed.test.ts`
Expected: FAIL — route still returns 200 / still registered.

- [ ] **Step 3: Delete the three routes**

In `server/src/app.ts`, delete lines 244–246:

```ts
    app.post("/api/auth/sign-in/email", signinLimiter, opts.betterAuthHandler);
    app.post("/api/auth/sign-up/email", signupLimiter, opts.betterAuthHandler);
    app.post("/api/auth/forget-password", forgotPasswordLimiter, opts.betterAuthHandler);
```

Keep line 247 (`app.all("/api/auth/{*authPath}", ...)`) — better-auth still needs the wildcard for `/sign-in/social`, `/callback/google`, `/get-session`, `/sign-out`.

- [ ] **Step 4: Remove now-unused limiter imports**

In `server/src/app.ts` remove `signinLimiter`, `signupLimiter`, and `forgotPasswordLimiter` from the import at :14–15 **only if** they are unused elsewhere (grep first: `grep -n "signinLimiter\|signupLimiter\|forgotPasswordLimiter" server/src/app.ts`). If unused, remove them from the import and, if the limiter definitions are now dead, delete them at their source and note it.

- [ ] **Step 5: Run test + full server typecheck, verify pass**

Run: `pnpm test:run src/__tests__/auth-routes-removed.test.ts` then `pnpm typecheck`
Expected: PASS; no unused-import type errors.

- [ ] **Step 6: Commit**

```bash
git add server/src/app.ts server/src/__tests__/auth-routes-removed.test.ts
git commit -m "feat(auth): remove email/password auth routes + limiters"
```

---

## Task A4: Post-auth journey resolver (pure)

**Files:**
- Create: `server/src/services/post-auth-journey.ts`
- Test: `server/src/__tests__/post-auth-journey.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/post-auth-journey.test.ts
import { describe, it, expect } from "vitest";
import { resolvePostAuthJourney } from "../services/post-auth-journey.js";

describe("resolvePostAuthJourney", () => {
  it("returning when user has memberships", () => {
    expect(resolvePostAuthJourney({ memberships: ["c1"], pendingInvites: [], inviteToken: null }))
      .toEqual({ journey: "returning", targetCompanyId: "c1", inviteToken: null });
  });
  it("invited when an invite token is present and valid", () => {
    expect(resolvePostAuthJourney({ memberships: [], pendingInvites: [{ companyId: "c2", token: "t" }], inviteToken: "t" }))
      .toEqual({ journey: "invited", targetCompanyId: "c2", inviteToken: "t" });
  });
  it("invited when a pending invite exists for the email even without a token", () => {
    expect(resolvePostAuthJourney({ memberships: [], pendingInvites: [{ companyId: "c3", token: "t3" }], inviteToken: null }))
      .toEqual({ journey: "invited", targetCompanyId: "c3", inviteToken: "t3" });
  });
  it("founder when no memberships and no invites", () => {
    expect(resolvePostAuthJourney({ memberships: [], pendingInvites: [], inviteToken: null }))
      .toEqual({ journey: "founder", targetCompanyId: null, inviteToken: null });
  });
  it("returning takes precedence over an invite", () => {
    expect(resolvePostAuthJourney({ memberships: ["c1"], pendingInvites: [{ companyId: "c2", token: "t" }], inviteToken: "t" }).journey)
      .toBe("returning");
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `pnpm test:run src/__tests__/post-auth-journey.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the pure resolver**

```ts
// server/src/services/post-auth-journey.ts
import type { PostAuthJourneyResult } from "@armyofagents/shared";

export type JourneyInput = {
  memberships: string[];                                  // companyIds the user already belongs to
  pendingInvites: { companyId: string; token: string }[]; // open invites for this user's email
  inviteToken: string | null;                             // deep-linked /invite/:token, if any
};

export function resolvePostAuthJourney(input: JourneyInput): PostAuthJourneyResult {
  if (input.memberships.length > 0) {
    return { journey: "returning", targetCompanyId: input.memberships[0], inviteToken: input.inviteToken };
  }
  const byToken = input.inviteToken
    ? input.pendingInvites.find((i) => i.token === input.inviteToken)
    : undefined;
  const invite = byToken ?? input.pendingInvites[0];
  if (invite) {
    return { journey: "invited", targetCompanyId: invite.companyId, inviteToken: invite.token };
  }
  return { journey: "founder", targetCompanyId: null, inviteToken: null };
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `pnpm test:run src/__tests__/post-auth-journey.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/post-auth-journey.ts server/src/__tests__/post-auth-journey.test.ts packages/shared/src/onboarding.ts
git commit -m "feat(auth): pure post-auth journey resolver (returning/invited/founder)"
```

> Note: `packages/shared/src/onboarding.ts` (PostAuthJourneyResult) is defined in Stage 0 §3.2 — create it here if not already present and export it from `packages/shared/src/index.ts`.

---

## Task A5: Journey endpoint (wires resolver to DB)

**Files:**
- Create: `server/src/routes/onboarding-journey.ts` (or fold into `server/src/routes/onboarding.ts` when Stage B creates it — for Stage A, a standalone route)
- Test: `server/src/__tests__/onboarding-journey-route.test.ts` (service-with-mocks pattern)

- [ ] **Step 1: Write the failing test** (mock db with `createSequenceDb`)

```ts
// server/src/__tests__/onboarding-journey-route.test.ts
import { describe, it, expect, vi } from "vitest";
// Follow the existing service-test mock pattern: mock @armyofagents/db + drizzle-orm.
import { getJourneyForUser } from "../routes/onboarding-journey.js";

describe("getJourneyForUser", () => {
  it("returns founder for a user with no memberships/invites", async () => {
    const db = /* sequence mock: memberships → [], invites → [] */ {} as any;
    const result = await getJourneyForUser(db, { userId: "u1", email: "u@x.com", inviteToken: null });
    expect(result.journey).toBe("founder");
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `pnpm test:run src/__tests__/onboarding-journey-route.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the query + route handler**

```ts
// server/src/routes/onboarding-journey.ts
import { createHash } from "node:crypto";
import type { Db } from "@armyofagents/db";
import { companyMemberships, invites } from "@armyofagents/db";
import { and, eq, isNull, gt, or, sql } from "drizzle-orm";
import { resolvePostAuthJourney } from "../services/post-auth-journey.js";
import type { PostAuthJourneyResult } from "@armyofagents/shared";

function hashToken(t: string) {
  return createHash("sha256").update(t).digest("hex");
}

export async function getJourneyForUser(
  db: Db,
  args: { userId: string; email: string; inviteToken: string | null },
): Promise<PostAuthJourneyResult> {
  const memberships = await db
    .select({ companyId: companyMemberships.companyId })
    .from(companyMemberships)
    .where(and(
      eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.principalId, args.userId),
      eq(companyMemberships.status, "active"),
    ));

  // Open invites for this email. NOTE: `invites` has NO email column — the invitee
  // email is stored in defaultsPayload.teamInvite.email (see access.ts TEAM_INVITE_KEY).
  // Open = not revoked, not accepted, not expired. `token` here is the STORED hash.
  const pending = await db
    .select({ companyId: invites.companyId, tokenHash: invites.tokenHash })
    .from(invites)
    .where(and(
      eq(invites.inviteType, "company_join"),
      isNull(invites.revokedAt),
      isNull(invites.acceptedAt),
      or(isNull(invites.expiresAt), gt(invites.expiresAt, new Date())),
      // email match on the jsonb payload:
      sql`lower(${invites.defaultsPayload} -> 'teamInvite' ->> 'email') = lower(${args.email})`,
    ));

  // Hash the deep-link token so it can match the stored hash inside the resolver.
  const hashedInviteToken = args.inviteToken ? hashToken(args.inviteToken) : null;

  return resolvePostAuthJourney({
    memberships: memberships.map((m) => m.companyId),
    pendingInvites: pending.map((p) => ({ companyId: p.companyId, token: p.tokenHash })),
    inviteToken: hashedInviteToken,
  });
}

// Express handler: GET /api/onboarding/journey
//   - actor: board only (req.actor.type === "board"); userId = req.actor.userId
//   - email: from the resolved session user (opts.resolveSession) — NOT from the client
//   - inviteToken: read from the `x-invite-token` REQUEST HEADER (never a query string)
//   - before resolving, call promoteFirstUserToInstanceAdmin(db, userId) (Task A7)
//   - res.json(await getJourneyForUser(db, { userId, email, inviteToken }))
```

> Task author: confirm `invites.defaultsPayload` column name + the `teamInvite.email` path against `packages/db/src/schema/invites.ts` and `access.ts` (`TEAM_INVITE_KEY`). Stage D Task D3 hardens this same detection — keep the two consistent.

> Task author: the `invites` table stores the invitee email inside `defaultsPayload` (the `teamInvite` metadata) — resolve the email-match against that, matching how `access.ts` reads `TEAM_INVITE_KEY`. Confirm the exact column before finalizing the `where`.

- [ ] **Step 4: Run test, verify pass**

Run: `pnpm test:run src/__tests__/onboarding-journey-route.test.ts`
Expected: PASS.

- [ ] **Step 5: Mount the route + commit**

Mount under the authenticated router next to other board routes. Then:

```bash
git add server/src/routes/onboarding-journey.ts server/src/__tests__/onboarding-journey-route.test.ts
git commit -m "feat(auth): GET /api/onboarding/journey endpoint"
```

---

## Task A6: actorMiddleware default-actor change + escape-hatch gating

**Files:**
- Modify: `server/src/middleware/auth.ts` (default actor :22–25)
- Test: `server/src/__tests__/actor-default-identity.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/actor-default-identity.test.ts
import { describe, it, expect } from "vitest";
import { actorMiddleware } from "../middleware/auth.js";

function run(mw: any, req: any) {
  return new Promise((resolve) => mw(req, {}, () => resolve(req.actor)));
}
const baseReq = () => ({ header: () => undefined, method: "GET", originalUrl: "/" });

describe("default actor identity", () => {
  it("local_trusted WITHOUT escape hatch → type none (no auto-admin)", async () => {
    const mw = actorMiddleware({} as any, { deploymentMode: "local_trusted", devLocalIdentity: false });
    const actor: any = await run(mw, baseReq());
    expect(actor.type).toBe("none");
  });
  it("local_trusted WITH escape hatch → synthetic board admin", async () => {
    const mw = actorMiddleware({} as any, { deploymentMode: "local_trusted", devLocalIdentity: true });
    const actor: any = await run(mw, baseReq());
    expect(actor).toMatchObject({ type: "board", userId: "local-board", isInstanceAdmin: true, source: "local_implicit" });
  });
  it("authenticated + escape hatch flag → flag ignored (type none)", async () => {
    const mw = actorMiddleware({} as any, { deploymentMode: "authenticated", devLocalIdentity: true });
    const actor: any = await run(mw, baseReq());
    expect(actor.type).toBe("none");
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `pnpm test:run src/__tests__/actor-default-identity.test.ts`
Expected: FAIL — middleware still auto-admins in local_trusted; `devLocalIdentity` not an option.

- [ ] **Step 3: Extend options + change the default actor**

In `server/src/middleware/auth.ts`, extend `ActorMiddlewareOptions` (:15–18):

```ts
interface ActorMiddlewareOptions {
  deploymentMode: DeploymentMode;
  devLocalIdentity?: boolean;
  resolveSession?: (req: Request) => Promise<BetterAuthSessionResult | null>;
}
```

Replace the default-actor assignment (:22–25):

```ts
    const useEscapeHatch = opts.deploymentMode === "local_trusted" && opts.devLocalIdentity === true;
    if (opts.deploymentMode !== "local_trusted" && opts.devLocalIdentity) {
      logger.warn("AOA_DEV_LOCAL_IDENTITY is set but ignored outside local_trusted mode (fail-closed).");
    }
    req.actor = useEscapeHatch
      ? { type: "board", userId: "local-board", isInstanceAdmin: true, source: "local_implicit" }
      : { type: "none", source: "none" };
```

- [ ] **Step 4: Thread the flag from the caller**

In `server/src/app.ts` at the `actorMiddleware(db, { ... })` call (:226), pass `devLocalIdentity: config.devLocalIdentity` (ensure `config` is in scope there; if the app builder receives `opts`, add it to the options object it already threads).

Also: the `local_trusted` session-resolution path currently only runs under `deploymentMode === "authenticated"` (:31). Change that guard to run whenever `opts.resolveSession` is provided (both modes), so Google identity resolves in local installs too:

```ts
      if (opts.resolveSession) {   // was: opts.deploymentMode === "authenticated" && opts.resolveSession
```

And ensure better-auth is instantiated in `local_trusted` too (see Task A7 note / `server/src/index.ts` wiring): today better-auth is only created in `authenticated` mode. Update `index.ts` so the auth instance + `resolveSession` are wired in BOTH modes (Google identity everywhere), while the escape hatch remains the offline fallback.

- [ ] **Step 5: Run test + verify pass**

Run: `pnpm test:run src/__tests__/actor-default-identity.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add server/src/middleware/auth.ts server/src/app.ts server/src/index.ts
git commit -m "feat(auth): Google identity in both modes; gate synthetic admin behind AOA_DEV_LOCAL_IDENTITY"
```

> ⚠️ This is the highest-risk task. After it, run the full server suite (`pnpm test:run`) to catch any test that assumed the old local_trusted auto-admin default. Fix fallout before proceeding.

---

## Task A7: First Google user → instance admin

**Files:**
- Create: `server/src/services/first-user-bootstrap.ts`
- Test: `server/src/__tests__/first-user-bootstrap.test.ts`

- [ ] **Step 1: Write the failing test** (sequence-mock db)

```ts
// server/src/__tests__/first-user-bootstrap.test.ts
import { describe, it, expect } from "vitest";
import { promoteFirstUserToInstanceAdmin } from "../services/first-user-bootstrap.js";

describe("promoteFirstUserToInstanceAdmin", () => {
  it("promotes when NO instance_admin exists yet", async () => {
    const inserted: any[] = [];
    const db = /* sequence mock: count instance_admins → 0; capture insert */ {
      select: () => ({ from: () => ({ where: async () => [] }) }),
      insert: () => ({ values: async (v: any) => { inserted.push(v); } }),
    } as any;
    const did = await promoteFirstUserToInstanceAdmin(db, "u1");
    expect(did).toBe(true);
    expect(inserted[0]).toMatchObject({ userId: "u1", role: "instance_admin" });
  });
  it("does NOT promote when an instance_admin already exists", async () => {
    const db = { select: () => ({ from: () => ({ where: async () => [{ id: "x" }] }) }), insert: () => { throw new Error("should not insert"); } } as any;
    const did = await promoteFirstUserToInstanceAdmin(db, "u2");
    expect(did).toBe(false);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `pnpm test:run src/__tests__/first-user-bootstrap.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement (idempotent, race-safe)**

```ts
// server/src/services/first-user-bootstrap.ts
import type { Db } from "@armyofagents/db";
import { instanceUserRoles } from "@armyofagents/db";
import { eq } from "drizzle-orm";

// Promotes the given user to instance_admin IFF no instance_admin exists yet.
// Idempotent + race-safe: the unique index on (userId, role) makes a duplicate insert a no-op.
export async function promoteFirstUserToInstanceAdmin(db: Db, userId: string): Promise<boolean> {
  const existing = await db.select({ id: instanceUserRoles.id }).from(instanceUserRoles)
    .where(eq(instanceUserRoles.role, "instance_admin"));
  if (existing.length > 0) return false;
  try {
    await db.insert(instanceUserRoles).values({ userId, role: "instance_admin" }).onConflictDoNothing();
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Call it on first sign-in**

Hook this into the journey endpoint (Task A5) or a better-auth `after` hook on user creation. Simplest + explicit: call `promoteFirstUserToInstanceAdmin(db, req.actor.userId)` at the start of `GET /api/onboarding/journey` (every authenticated call is cheap — one indexed count; it self-guards). Wire it there.

- [ ] **Step 5: Run test, verify pass**

Run: `pnpm test:run src/__tests__/first-user-bootstrap.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add server/src/services/first-user-bootstrap.ts server/src/__tests__/first-user-bootstrap.test.ts server/src/routes/onboarding-journey.ts
git commit -m "feat(auth): first Google user of a fresh instance becomes instance admin"
```

---

## Task A8: Frontend — single "Continue with Google"

**Files:**
- Modify: `ui/src/pages/Auth.tsx` (whole `AuthPage`)
- Modify: `ui/src/api/auth.ts` (add `signInSocial`; remove `signInEmail`/`signUpEmail`)
- Test: `ui/src/api/__tests__/auth-client.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// ui/src/api/__tests__/auth-client.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { authApi } from "../auth";

describe("authApi.signInSocial", () => {
  beforeEach(() => { (globalThis as any).fetch = vi.fn(async () => ({ ok: true, json: async () => ({ url: "https://accounts.google.com/..." }) })); });
  it("posts to /api/auth/sign-in/social with provider google", async () => {
    await authApi.signInSocial("google");
    const [url, init] = (globalThis.fetch as any).mock.calls[0];
    expect(url).toContain("/api/auth/sign-in/social");
    expect(JSON.parse(init.body)).toMatchObject({ provider: "google" });
    expect(init.credentials).toBe("include");
  });
  it("no longer exports email/password methods", () => {
    expect((authApi as any).signInEmail).toBeUndefined();
    expect((authApi as any).signUpEmail).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `pnpm --filter @armyofagents/ui test:run src/api/__tests__/auth-client.test.ts`
Expected: FAIL — `signInSocial` missing; email methods still present.

- [ ] **Step 3: Update the API client**

In `ui/src/api/auth.ts`, remove `signInEmail` and `signUpEmail`; add:

```ts
  async signInSocial(provider: "google", callbackURL = "/") {
    const res = await fetch("/api/auth/sign-in/social", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ provider, callbackURL }),
    });
    if (!res.ok) throw new Error(`social sign-in failed: ${res.status}`);
    const data = await res.json();
    if (data?.url) window.location.href = data.url; // redirect to Google
    return data;
  },
```

- [ ] **Step 4: Replace the Auth page body**

Rewrite `AuthPage` in `ui/src/pages/Auth.tsx` to a single-action screen: product name + one-line value prop + a "Continue with Google" button calling `authApi.signInSocial("google", nextParam)`. Keep the existing `?next` redirect-on-session logic and the right-half `AsciiArtAnimation`. Remove the mode toggle, email/password/name fields, and inline error-for-credentials UI. Keep a small error surface for a failed social start.

- [ ] **Step 5: Run test, verify pass**

Run: `pnpm --filter @armyofagents/ui test:run src/api/__tests__/auth-client.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add ui/src/pages/Auth.tsx ui/src/api/auth.ts ui/src/api/__tests__/auth-client.test.ts
git commit -m "feat(auth): single Continue-with-Google auth screen"
```

---

## Task A9: Frontend post-auth routing (consume journey)

**Files:**
- Modify: `ui/src/App.tsx` (`CloudAccessGate` :90–128) or a new `PostAuthRouter` wrapper
- Create: `ui/src/api/onboarding.ts` (client for `/api/onboarding/journey`)
- Test: `ui/src/__tests__/post-auth-routing.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// ui/src/__tests__/post-auth-routing.test.tsx
import { describe, it, expect } from "vitest";
import { destinationForJourney } from "../api/onboarding";

describe("destinationForJourney", () => {
  it("returning → lobby/last org", () => {
    expect(destinationForJourney({ journey: "returning", targetCompanyId: "c1", inviteToken: null })).toBe("/");
  });
  it("founder → onboarding root", () => {
    expect(destinationForJourney({ journey: "founder", targetCompanyId: null, inviteToken: null })).toBe("/onboarding");
  });
  it("invited → invite join flow", () => {
    expect(destinationForJourney({ journey: "invited", targetCompanyId: "c2", inviteToken: "t" })).toBe("/onboarding/join?company=c2");
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `pnpm --filter @armyofagents/ui test:run src/__tests__/post-auth-routing.test.tsx`
Expected: FAIL — `destinationForJourney` missing.

- [ ] **Step 3: Implement the client + destination mapper**

```ts
// ui/src/api/onboarding.ts
import type { PostAuthJourneyResult } from "@armyofagents/shared";

export async function fetchJourney(inviteToken?: string | null): Promise<PostAuthJourneyResult> {
  // The invite token is a secret — send it in a header, NEVER in the URL (no query string).
  const headers: Record<string, string> = {};
  if (inviteToken) headers["x-invite-token"] = inviteToken;
  const res = await fetch("/api/onboarding/journey", { credentials: "include", headers });
  if (!res.ok) throw new Error(`journey fetch failed: ${res.status}`);
  return res.json();
}

export function destinationForJourney(j: PostAuthJourneyResult): string {
  if (j.journey === "returning") return "/";
  if (j.journey === "invited") return `/onboarding/join?company=${j.targetCompanyId}`;
  return "/onboarding";
}
```

- [ ] **Step 4: Wire into the gate**

In `CloudAccessGate` (or a new `PostAuthRouter`), after a session is confirmed, call `fetchJourney()` once and redirect to `destinationForJourney(...)`. Guard against loops (don't re-route when already on the destination). `/onboarding` + `/onboarding/join` routes are stubbed here and filled by Stage B/C.

- [ ] **Step 5: Run test, verify pass**

Run: `pnpm --filter @armyofagents/ui test:run src/__tests__/post-auth-routing.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add ui/src/api/onboarding.ts ui/src/App.tsx ui/src/__tests__/post-auth-routing.test.tsx
git commit -m "feat(auth): route users to returning/invited/founder after Google login"
```

---

## Task A10: Retire bootstrap-ceo / board-claim from the human flow

**Files:**
- Modify: `ui/src/App.tsx` (remove `/board-claim/:token` public route + `BoardClaimPage` usage)
- Modify: `server/src/index.ts` (`initializeBoardClaimChallenge()` call — guard behind headless flag)
- Test: `server/src/__tests__/bootstrap-headless-guard.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/bootstrap-headless-guard.test.ts
import { describe, it, expect } from "vitest";
import { shouldEnableHeadlessBootstrap } from "../services/first-user-bootstrap.js";

describe("headless bootstrap guard", () => {
  it("disabled by default (normal Google flow handles admin)", () => {
    expect(shouldEnableHeadlessBootstrap({ headlessBootstrap: false } as any)).toBe(false);
  });
  it("enabled only when AOA_HEADLESS_BOOTSTRAP is set", () => {
    expect(shouldEnableHeadlessBootstrap({ headlessBootstrap: true } as any)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `pnpm test:run src/__tests__/bootstrap-headless-guard.test.ts`
Expected: FAIL — helper missing.

- [ ] **Step 3: Add the guard + config field**

Add `headlessBootstrap: boolean` to `Config` (from `AOA_HEADLESS_BOOTSTRAP`, default false) and:

```ts
// in first-user-bootstrap.ts
export function shouldEnableHeadlessBootstrap(config: { headlessBootstrap: boolean }): boolean {
  return config.headlessBootstrap === true;
}
```

Guard `initializeBoardClaimChallenge()` in `server/src/index.ts` behind `shouldEnableHeadlessBootstrap(config)`. Remove the `/board-claim/:token` route + `BoardClaimPage` from `ui/src/App.tsx` (the normal instance-admin path is now Task A7). Keep the server board-claim service intact (for the guarded headless fallback), just don't wire the human URL by default.

- [ ] **Step 4: Run test, verify pass**

Run: `pnpm test:run src/__tests__/bootstrap-headless-guard.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/config.ts server/src/index.ts server/src/services/first-user-bootstrap.ts ui/src/App.tsx server/src/__tests__/bootstrap-headless-guard.test.ts
git commit -m "feat(auth): retire board-claim URL from human flow; keep guarded headless bootstrap"
```

---

## Task A11: Persisted local session (local-first longevity)

**Files:**
- Modify: `server/src/auth/better-auth.ts` (`buildBetterAuthConfig` — add `session.expiresIn`)
- Test: extend `server/src/__tests__/better-auth-config.test.ts`

- [ ] **Step 1: Add a failing assertion**

Append to `better-auth-config.test.ts`:

```ts
it("configures a long-lived session for local-first use", () => {
  const cfg = buildBetterAuthConfig({} as any, baseCfg(), [], "secret");
  expect((cfg as any).session?.expiresIn).toBeGreaterThanOrEqual(60 * 60 * 24 * 30); // ≥ 30 days
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `pnpm test:run src/__tests__/better-auth-config.test.ts`
Expected: FAIL — no `session.expiresIn`.

- [ ] **Step 3: Add session config**

In `buildBetterAuthConfig`, add to `authConfig`:

```ts
    session: { expiresIn: 60 * 60 * 24 * 90, updateAge: 60 * 60 * 24 }, // 90-day session, refresh daily
```

- [ ] **Step 4: Run test, verify pass**

Run: `pnpm test:run src/__tests__/better-auth-config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/auth/better-auth.ts server/src/__tests__/better-auth-config.test.ts
git commit -m "feat(auth): long-lived session for local-first operation"
```

---

## Task A12: E2E — mocked Google login

**Files:**
- Create: `tests/e2e/auth-google.spec.ts`
- Create/confirm: a deterministic Google mock (test IdP stub or better-auth session injection helper)

- [ ] **Step 1: Write the e2e**

```ts
// tests/e2e/auth-google.spec.ts
import { test, expect } from "@playwright/test";

test("login shows only Continue-with-Google and lands post-auth", async ({ page }) => {
  await page.goto("/auth");
  await expect(page.getByRole("button", { name: /continue with google/i })).toBeVisible();
  await expect(page.getByLabel(/password/i)).toHaveCount(0); // no password field
  // With the Google mock/session-injection helper, complete auth and assert redirect to /onboarding (founder).
});
```

- [ ] **Step 2: Run it, verify it fails / then passes after the mock is wired**

Run: `pnpm test:e2e tests/e2e/auth-google.spec.ts` (confirm the repo's e2e run command)
Expected: first FAIL (no mock), then PASS once the session-injection helper is added. Respect the Windows e2e skip caveat (embedded-pg) per CLAUDE.md.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/auth-google.spec.ts
git commit -m "test(auth): e2e for Google-only login + post-auth landing"
```

---

## Stage A self-review checklist (run before handing off)

- [ ] Spec coverage: Google-only (A2,A3,A8) · escape hatch (A1,A6) · Google-in-both-modes (A6) · 3-journey router (A4,A5,A9) · first-user-admin (A7) · board-claim retired (A10) · local-first session (A11). ✔ all mapped.
- [ ] Placeholder scan: the two `> Task author:` notes (A5 invites-email column, pre-flight script names) are *verification pointers*, not code placeholders — resolve them during execution, not left as TODO in code.
- [ ] Type consistency: `PostAuthJourneyResult` (Stage 0 §3.2) used identically in A4/A5/A9; `resolvePostAuthJourney` signature stable; `devLocalIdentity` name consistent across config/middleware/app.
- [ ] Full server suite green after A6 (the risky one) before continuing.
