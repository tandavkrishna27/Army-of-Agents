import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import type { Db } from "@armyofagents/db";
import { authSessions, authUsers, onboardingProgress } from "@armyofagents/db";
import type { DeploymentMode } from "@armyofagents/shared";
import { eq } from "drizzle-orm";
import type { Config } from "../config.js";
import { resolveBetterAuthSigningSecret } from "../auth/better-auth.js";
import { testSupportTokensMatch } from "../services/test-support-safety.js";

/**
 * Session cookie name for the e2e session mint below. The legacy developer
 * path is local_trusted-only; dedicated cloud e2e uses the separately
 * authenticated AOA_E2E_TEST_SUPPORT seam. Both run on private loopback, where
 * better-auth uses `useSecureCookies: false` (no explicit https
 * base URL — see buildBetterAuthConfig), so the cookie carries no `__Secure-`
 * prefix and the default `better-auth` prefix + `session_token` name apply.
 */
const SESSION_COOKIE_NAME = "better-auth.session_token";

/**
 * Deliberately SHORT — 1 hour, not the production 90d (buildBetterAuthConfig
 * A11). A minted session must not outlive the dev-hatch phase it was created
 * for; e2e specs need minutes. (better-auth refreshes ACTIVELY-USED sessions
 * per its updateAge policy like any real session — the short TTL bounds
 * dormant minted cookies, which is the risk here.)
 */
const SESSION_TTL_MS = 60 * 60 * 1000;

/**
 * Dedicated cloud e2e support is guarded at startup by
 * assertTestSupportFlagSafe. The local_trusted developer escape hatch remains
 * available for the existing browser suite.
 */
export function testSupportEnabled(deploymentMode: DeploymentMode): boolean {
  return (
    process.env.AOA_E2E_TEST_SUPPORT === "1" ||
    (deploymentMode === "local_trusted" && process.env.AOA_DEV_LOCAL_IDENTITY === "1")
  );
}

/**
 * Test-only routes for e2e isolation. app.ts mounts this router only when one
 * of the two explicit test-support gates is active.
 */
export function testSupportRoutes(
  db: Db,
  opts: { deploymentMode: DeploymentMode },
): Router {
  const router = Router();

  // Clear the acting user's onboarding_progress (user + org layers) so the next
  // spec starts clean.
  router.delete("/test/onboarding-progress", async (req: Request, res: Response) => {
    const actor = req.actor;
    if (actor.type !== "board" || !actor.userId) {
      res.status(401).json({ error: "authentication required" });
      return;
    }
    await db.delete(onboardingProgress).where(eq(onboardingProgress.userId, actor.userId));
    res.json({ ok: true });
  });

  // Mint a SECOND authenticated identity for e2e (N3): upsert a verified
  // better-auth user + a real session row, and return a session cookie that
  // better-auth's own getSession accepts. This is what lets the invited-teammate
  // journey be tested — local_trusted e2e otherwise only has the synthetic
  // local-board actor, and Google (the sole sign-in provider) can't run in CI.
  //
  // Mechanism — deliberately NOT better-auth's internalAdapter.createUser/
  // createSession: those run the app's databaseHooks, whose first-admin
  // bootstrap (RB3/A7) would promote the minted teammate to instance_admin on a
  // fresh e2e instance (the only existing admin is the synthetic local-board
  // row) and demote local-board — silently flipping the teammate's post-auth
  // journey to "returning" via the admin bypass and breaking the very invited
  // semantics under test. Instead we write the exact rows better-auth reads
  // (user + session) with drizzle, and sign the cookie in better-call's signed
  // cookie format: `${token}.${base64(hmacSha256(token, secret))}`, URI-encoded
  // (see better-call crypto.ts signCookieValue / context.ts getSignedCookie —
  // signature must be 44 base64 chars ending "="). The signing secret comes
  // from the SAME resolver the real auth instance uses. Round-trip is proven
  // in test-support-route.test.ts by feeding the minted cookie to a real
  // betterAuth instance's api.getSession.
  //
  // Idempotent per email: re-minting reuses the existing user (re-verifying the
  // email) and issues a fresh session.
  //
  // Side effect worth knowing on a PERSISTENT dev instance: the minted user is
  // a REAL user (`realUserExists`), so after the first mint the dev escape
  // hatch refuses to boot (assertEscapeHatchAllowed, RB4/R5) unless
  // AOA_DEV_LOCAL_IDENTITY_FORCE=1 is set. Throwaway e2e homes never notice.
  router.post("/test-support/session", async (req: Request, res: Response) => {
    // Defense-in-depth: re-assert the mount gate INSIDE the handler. The mount
    // in app.ts is the primary gate, but a session-minting endpoint is
    // dangerous enough that a future mount refactor must not be able to expose
    // it silently. 404 (not 403) — don't advertise its existence.
    if (!testSupportEnabled(opts.deploymentMode)) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (process.env.AOA_E2E_TEST_SUPPORT === "1") {
      const expectedToken = process.env.AOA_E2E_TEST_SUPPORT_TOKEN?.trim() ?? "";
      const authorization = req.header("authorization")?.trim() ?? "";
      const match = /^Bearer\s+(.+)$/i.exec(authorization);
      const presentedToken = match?.[1]?.trim() ?? "";
      if (
        !expectedToken ||
        !presentedToken ||
        !testSupportTokensMatch(expectedToken, presentedToken)
      ) {
        res.setHeader("WWW-Authenticate", "Bearer");
        res.status(401).json({ error: "authentication required" });
        return;
      }
    }
    const actor = req.actor;
    // The dedicated loopback-only seam must mint the first cloud_auth session,
    // so it cannot require an existing board actor. The legacy local path
    // retains its original actor requirement.
    if (
      process.env.AOA_E2E_TEST_SUPPORT !== "1" &&
      (actor.type !== "board" || !actor.userId)
    ) {
      res.status(401).json({ error: "authentication required" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const email =
      typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!email || !email.includes("@") || email.length > 320) {
      res.status(400).json({ error: "a valid email is required" });
      return;
    }
    const name =
      typeof body.name === "string" && body.name.trim().length > 0
        ? body.name.trim()
        : (email.split("@")[0] ?? "e2e-user");

    const now = new Date();
    // better-auth lowercases emails on write, and this route is the only other
    // writer of these users — a plain equality match is the same lookup
    // better-auth's findUserByEmail performs.
    const existing = await db
      .select({ id: authUsers.id })
      .from(authUsers)
      .where(eq(authUsers.email, email))
      .then((rows) => rows[0] ?? null);

    let userId: string;
    if (existing) {
      userId = existing.id;
      // Re-mint: make sure the identity is in the state the invited flows
      // require (verified email) and carries the requested display name.
      await db
        .update(authUsers)
        .set({ name, displayName: name, emailVerified: true, updatedAt: now })
        .where(eq(authUsers.id, userId));
    } else {
      userId = randomUUID();
      await db.insert(authUsers).values({
        id: userId,
        name,
        email,
        // The invited flows (journey detection, tokenless claim, auto-admit)
        // all gate on a VERIFIED email — mint verified, like a Google sign-in.
        emailVerified: true,
        displayName: name,
        createdAt: now,
        updatedAt: now,
      });
    }

    // A fresh session per mint. Token shape mirrors better-auth's generateId
    // (URL-safe, no "." — the signed-cookie format splits on the last dot).
    const token = randomBytes(24).toString("base64url");
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    await db.insert(authSessions).values({
      id: randomUUID(),
      token,
      userId,
      expiresAt,
      createdAt: now,
      updatedAt: now,
      ipAddress: "",
      userAgent: "aoa-e2e-test-support",
    });

    // Same resolver the real better-auth instance uses (env override or the
    // local_trusted dev fallback), fed the REAL deployment mode threaded from
    // app.ts — so the resolver's fail-closed throw in non-local modes keeps
    // its teeth. The resolver reads nothing else off the config.
    const secret = resolveBetterAuthSigningSecret({
      deploymentMode: opts.deploymentMode,
    } as Pick<Config, "deploymentMode"> as Config);
    const signature = createHmac("sha256", secret).update(token).digest("base64");
    const cookieValue = encodeURIComponent(`${token}.${signature}`);

    res.json({
      userId,
      email,
      cookie: { name: SESSION_COOKIE_NAME, value: cookieValue },
      expiresAt: expiresAt.toISOString(),
    });
  });

  return router;
}
