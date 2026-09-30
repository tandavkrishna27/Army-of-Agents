import type { APIRequestContext, Browser, BrowserContext } from "@playwright/test";

/**
 * Second-identity helper for the invited-teammate e2e journey (N3).
 *
 * local_trusted e2e has exactly ONE implicit identity — the synthetic
 * local-board actor every cookie-less request resolves to. Testing the invited
 * journey needs a SECOND authenticated user, and Google (the sole sign-in
 * provider) can't run in CI. `POST /api/test-support/session` mints a verified
 * better-auth user + session and returns the signed session cookie. The legacy
 * local_trusted path relies on its board actor; dedicated cloud e2e sends the
 * per-run AOA_E2E_TEST_SUPPORT_TOKEN below. A browser context carrying the
 * cookie acts as that user (a resolved better-auth session OVERRIDES the
 * local-board escape hatch in actorMiddleware).
 */

// Mirrors playwright.config.ts — browser.newContext() does NOT inherit the
// config's use.baseURL, so second contexts must pin it explicitly.
const PORT = Number(process.env.AOA_E2E_PORT ?? 3199);
export const E2E_BASE_URL = `http://127.0.0.1:${PORT}`;

export type MintedIdentity = {
  userId: string;
  email: string;
  cookieName: string;
  cookieValue: string;
  /** Ready for context.addCookies() against the e2e BASE_URL. */
  cookies: Array<{
    name: string;
    value: string;
    url: string;
    httpOnly: boolean;
    sameSite: "Lax";
  }>;
};

/** Mint (or re-mint — idempotent per email) a verified second identity. */
export async function mintIdentity(
  request: APIRequestContext,
  opts: { email: string; name?: string },
): Promise<MintedIdentity> {
  const testSupportToken = process.env.AOA_E2E_TEST_SUPPORT_TOKEN?.trim();
  const res = await request.post("/api/test-support/session", {
    data: opts,
    ...(testSupportToken
      ? { headers: { Authorization: `Bearer ${testSupportToken}` } }
      : {}),
  });
  if (!res.ok()) {
    throw new Error(
      `mintIdentity failed: ${res.status()} ${await res.text().catch(() => "")}`,
    );
  }
  const body = (await res.json()) as {
    userId: string;
    email: string;
    cookie: { name: string; value: string };
  };
  return {
    userId: body.userId,
    email: body.email,
    cookieName: body.cookie.name,
    cookieValue: body.cookie.value,
    cookies: [
      {
        name: body.cookie.name,
        value: body.cookie.value,
        url: E2E_BASE_URL,
        httpOnly: true,
        sameSite: "Lax" as const,
      },
    ],
  };
}

/**
 * Convenience: a fresh browser context already authenticated as a newly minted
 * identity. Caller owns the context (close it in a finally block).
 */
export async function newIdentityContext(
  browser: Browser,
  request: APIRequestContext,
  opts: { email: string; name?: string },
): Promise<{ context: BrowserContext; identity: MintedIdentity }> {
  const identity = await mintIdentity(request, opts);
  const context = await browser.newContext({ baseURL: E2E_BASE_URL });
  await context.addCookies(identity.cookies);
  return { context, identity };
}
