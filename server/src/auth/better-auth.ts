import type { Request, RequestHandler } from "express";
import type { IncomingHttpHeaders } from "node:http";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { toNodeHandler } from "better-auth/node";
import type { Auth } from "better-auth";
import type { Db } from "@armyofagents/db";
import {
  authAccounts,
  authSessions,
  authUsers,
  authVerifications,
} from "@armyofagents/db";
import type { Config } from "../config.js";
import { logger } from "../middleware/logger.js";
import { instanceAdminBootstrapEnabled } from "../services/first-user-bootstrap.js";
import type { DeploymentMode } from "@armyofagents/shared";

const DEV_FALLBACK_SECRET = "aoa-dev-secret";

export type BetterAuthSessionUser = {
  id: string;
  email?: string | null;
  name?: string | null;
};

export type BetterAuthSessionResult = {
  session: { id: string; userId: string } | null;
  user: BetterAuthSessionUser | null;
};

type BetterAuthInstance = Auth<any>;

function headersFromNodeHeaders(rawHeaders: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [key, raw] of Object.entries(rawHeaders)) {
    if (!raw) continue;
    if (Array.isArray(raw)) {
      for (const value of raw) headers.append(key, value);
      continue;
    }
    headers.set(key, raw);
  }
  return headers;
}

function headersFromExpressRequest(req: Request): Headers {
  return headersFromNodeHeaders(req.headers);
}

/**
 * Resolves the better-auth HMAC signing secret with a deployment-mode-aware
 * fail-closed gate.
 *
 * - `local_trusted` mode: if neither env var is set, returns a constant dev
 *   fallback and logs a prominent WARN telling the operator to set
 *   `BETTER_AUTH_SECRET`. Loopback-only deployments are the only place this
 *   constant is acceptable.
 * - Any other deployment mode (e.g. `authenticated`, future `cloud_auth`):
 *   throws a clear startup error if neither `BETTER_AUTH_SECRET` nor
 *   `AOA_AGENT_JWT_SECRET` is set. Refusing to boot with a publicly-knowable
 *   signing secret is intentional — anyone with the source could otherwise
 *   forge session cookies.
 *
 * Whitespace-only values are treated as unset.
 */
export function resolveBetterAuthSigningSecret(config: Config): string {
  const fromPrimary = process.env.BETTER_AUTH_SECRET?.trim();
  const fromFallback = process.env.AOA_AGENT_JWT_SECRET?.trim();
  const configured = (fromPrimary && fromPrimary.length > 0)
    ? fromPrimary
    : (fromFallback && fromFallback.length > 0)
      ? fromFallback
      : null;

  if (configured) return configured;

  // Default-deny: only `local_trusted` is allowed to use the dev fallback.
  if (config.deploymentMode === "local_trusted") {
    logger.warn(
      "BETTER_AUTH_SECRET is unset; using insecure dev fallback. " +
        "Set BETTER_AUTH_SECRET in your environment for any non-loopback deployment.",
    );
    return DEV_FALLBACK_SECRET;
  }

  throw new Error(
    `BETTER_AUTH_SECRET must be set when AOA_DEPLOYMENT_MODE="${String(
      config.deploymentMode,
    )}". Set BETTER_AUTH_SECRET (preferred) or AOA_AGENT_JWT_SECRET to a strong random value before starting the server.`,
  );
}

export function deriveAuthTrustedOrigins(config: Config, opts?: { listenPort?: number }): string[] {
  const baseUrl = config.authBaseUrlMode === "explicit" ? config.authPublicBaseUrl : undefined;
  const trustedOrigins = new Set<string>();
  const port = opts?.listenPort ?? config.port;
  const needsPortVariants = port !== 80 && port !== 443;

  if (baseUrl) {
    try {
      trustedOrigins.add(new URL(baseUrl).origin);
    } catch {
      // Better Auth will surface invalid base URL separately.
    }
  }
  for (const hostname of config.allowedHostnames ?? []) {
    const trimmed = hostname.trim().toLowerCase();
    if (!trimmed) continue;
    trustedOrigins.add(`https://${trimmed}`);
    if (needsPortVariants) {
      trustedOrigins.add(`https://${trimmed}:${port}`);
    }
    if (config.deploymentMode === "local_trusted") {
      trustedOrigins.add(`http://${trimmed}`);
    }
  }

  return Array.from(trustedOrigins);
}

async function attemptFirstAdminBootstrap(
  db: Db,
  userId: string,
  source: "user_create" | "session_create",
  preserveSyntheticAdmin: boolean,
): Promise<void> {
  try {
    const { promoteFirstUserToInstanceAdmin } = await import(
      "../services/first-user-bootstrap.js"
    );
    await promoteFirstUserToInstanceAdmin(db, userId, { preserveSyntheticAdmin });
  } catch (err) {
    logger.error(
      { err, userId, source },
      "first-user admin bootstrap failed (non-fatal; will retry on next sign-in)",
    );
  }
}

/**
 * Task 10b (Phase 2 lockout cluster) — e2e/test-support boot relaxation:
 * `cloud_auth` may boot WITHOUT real Google creds ONLY when
 * `AOA_E2E_TEST_SUPPORT === "1"` (sessions come from the P6 test-mint seam,
 * never real OAuth). Real prod `cloud_auth` still hard-requires Google
 * creds — the fail-closed guard that refuses to boot with this flag set on
 * a real public deployment is P6 §4.0's; this helper does not weaken it.
 */
export function allowCloudAuthBootWithoutGoogle(
  deploymentMode: DeploymentMode,
  e2eTestSupport: boolean,
): boolean {
  return deploymentMode === "cloud_auth" && e2eTestSupport;
}

/**
 * Pure builder for the better-auth options object. Extracted so the provider
 * configuration is unit-testable without instantiating better-auth.
 *
 * Google is the ONLY sign-in provider (email/password removed). The google
 * social provider is attached only when both credentials are present; the
 * `assertAuthProviderConfigured` gate (called at startup) is what refuses to
 * boot a would-be-locked-out deployment. `e2eTestSupport` defaults from the
 * `AOA_E2E_TEST_SUPPORT` env var so runtime boot honors it without every
 * call site having to thread it through explicitly.
 */
export function buildBetterAuthConfig(
  db: Db,
  config: Config,
  trustedOrigins: string[],
  secret: string,
  e2eTestSupport: boolean = process.env.AOA_E2E_TEST_SUPPORT === "1",
): Record<string, unknown> {
  const baseUrl = config.authBaseUrlMode === "explicit" ? config.authPublicBaseUrl : undefined;

  const authConfig: Record<string, unknown> = {
    baseURL: baseUrl,
    secret,
    trustedOrigins,
    // A11 — long-lived session so a local-first install authenticates to the
    // cloud once, then operates offline until it expires (90d, refreshed daily).
    session: { expiresIn: 60 * 60 * 24 * 90, updateAge: 60 * 60 * 24 },
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        user: authUsers,
        session: authSessions,
        account: authAccounts,
        verification: authVerifications,
      },
    }),
  };

  if (config.googleClientId && config.googleClientSecret) {
    authConfig.socialProviders = {
      google: {
        clientId: config.googleClientId,
        clientSecret: config.googleClientSecret,
      },
    };
  } else if (allowCloudAuthBootWithoutGoogle(config.deploymentMode, e2eTestSupport)) {
    // e2e-only stub: mount a no-op Google provider so /api/auth/* routes
    // exist and better-auth doesn't refuse to construct. Real sessions in
    // this mode are minted by the P6 test-support seam, never by this
    // provider — no real OAuth ever happens through it.
    authConfig.socialProviders = {
      google: { clientId: "e2e-stub-client", clientSecret: "e2e-stub-secret" },
    };
  }

  // D6 — session-cookie hardening. better-auth applies OAuth state + PKCE for
  // the social flow internally; here we make the cookie intent explicit.
  // Secure follows the endpoint's exposure and transport.
  // Public and explicit HTTPS deployments use Secure. Private authenticated
  // deployments may intentionally use HTTP over a trusted LAN or tailnet, where
  // browsers would drop a Secure cookie. SameSite stays Lax so the OAuth redirect
  // round-trip keeps the callback cookie (Strict would drop it).
  let explicitBaseUrlUsesHttps = false;
  if (baseUrl) {
    try {
      explicitBaseUrlUsesHttps = new URL(baseUrl).protocol === "https:";
    } catch {
      // Startup configuration validates the URL. Keep direct helper calls
      // usable for private HTTP if they receive an invalid value.
    }
  }
  const useSecureCookies = config.deploymentExposure === "public" || explicitBaseUrlUsesHttps;
  authConfig.advanced = {
    useSecureCookies,
    defaultCookieAttributes: {
      httpOnly: true,
      secure: useSecureCookies,
      sameSite: "lax",
    },
  };

  // RB3/A7 — the first Google user of a fresh instance becomes instance admin.
  // Fires at real user creation and again at session creation. The service is
  // advisory-locked + idempotent, so the session hook backfills an admin-less
  // instance after a transient create-hook failure without blocking sign-in.
  //
  // Task 10 (Phase 2 lockout cluster, ATOMIC cutover) — gated through the
  // Task-4 chokepoint. `cloud_auth` (hosted multi-tenant beta) mints ZERO
  // runtime instance_admins: both hooks are omitted entirely, not merely
  // no-op'd, so there is no code path in that mode that can ever promote a
  // user to the self-hosted global-admin role. Self-hosted local_trusted /
  // authenticated keep both hooks exactly as before this change.
  if (instanceAdminBootstrapEnabled(config.deploymentMode)) {
    authConfig.databaseHooks = {
      user: {
        create: {
          after: async (user: { id: string }) => {
            await attemptFirstAdminBootstrap(
              db,
              user.id,
              "user_create",
              config.headlessBootstrap === true,
            );
          },
        },
      },
      session: {
        create: {
          after: async (session: { userId: string }) => {
            await attemptFirstAdminBootstrap(
              db,
              session.userId,
              "session_create",
              config.headlessBootstrap === true,
            );
          },
        },
      },
    };
  } else {
    authConfig.databaseHooks = {};
  }

  if (!baseUrl) {
    delete (authConfig as { baseURL?: string }).baseURL;
  }

  return authConfig;
}

/**
 * revA R6 — fail closed on a missing auth provider.
 *
 * Google is the only sign-in provider. If its credentials are absent, an
 * `authenticated` deployment would ship a login screen whose only button
 * cannot work — an instance lockout. A `local_trusted` deployment may boot
 * without Google ONLY when the dev escape hatch (`AOA_DEV_LOCAL_IDENTITY`) is
 * active. Call this at startup before serving traffic.
 *
 * Task 10b — `cloud_auth` may ALSO boot without Google creds, but ONLY under
 * `e2eTestSupport` (defaults from `AOA_E2E_TEST_SUPPORT === "1"`). Real prod
 * `cloud_auth` (flag unset) keeps hard-requiring Google creds — the error
 * message below is UNCHANGED for that case.
 */
export function assertAuthProviderConfigured(
  config: Config,
  e2eTestSupport: boolean = process.env.AOA_E2E_TEST_SUPPORT === "1",
): void {
  const hasGoogle = Boolean(config.googleClientId && config.googleClientSecret);
  if (hasGoogle) return;
  if (config.deploymentMode === "local_trusted" && config.devLocalIdentity) return;
  if (allowCloudAuthBootWithoutGoogle(config.deploymentMode, e2eTestSupport)) return;
  throw new Error(
    "Google OAuth is not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET). " +
      "It is the only sign-in provider; set both before starting the server" +
      (config.deploymentMode === "local_trusted"
        ? ", or set AOA_DEV_LOCAL_IDENTITY=1 for local development."
        : "."),
  );
}

export function createBetterAuthInstance(db: Db, config: Config, trustedOrigins?: string[]): BetterAuthInstance {
  const secret = resolveBetterAuthSigningSecret(config);
  const effectiveTrustedOrigins = trustedOrigins ?? deriveAuthTrustedOrigins(config);
  const authConfig = buildBetterAuthConfig(db, config, effectiveTrustedOrigins, secret);
  return betterAuth(authConfig as Parameters<typeof betterAuth>[0]);
}

export function createBetterAuthHandler(auth: BetterAuthInstance): RequestHandler {
  const handler = toNodeHandler(auth);
  return (req, res, next) => {
    void Promise.resolve(handler(req, res)).catch(next);
  };
}

export async function resolveBetterAuthSessionFromHeaders(
  auth: BetterAuthInstance,
  headers: Headers,
): Promise<BetterAuthSessionResult | null> {
  const api = (auth as unknown as { api?: { getSession?: (input: unknown) => Promise<unknown> } }).api;
  if (!api?.getSession) return null;

  const sessionValue = await api.getSession({
    headers,
  });
  if (!sessionValue || typeof sessionValue !== "object") return null;

  const value = sessionValue as {
    session?: { id?: string; userId?: string } | null;
    user?: { id?: string; email?: string | null; name?: string | null } | null;
  };
  const session = value.session?.id && value.session.userId
    ? { id: value.session.id, userId: value.session.userId }
    : null;
  const user = value.user?.id
    ? {
        id: value.user.id,
        email: value.user.email ?? null,
        name: value.user.name ?? null,
      }
    : null;

  if (!session || !user) return null;
  return { session, user };
}

export async function resolveBetterAuthSession(
  auth: BetterAuthInstance,
  req: Request,
): Promise<BetterAuthSessionResult | null> {
  return resolveBetterAuthSessionFromHeaders(auth, headersFromExpressRequest(req));
}
