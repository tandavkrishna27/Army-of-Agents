import { describe, it, expect, beforeAll, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  generatePkce,
  signOAuthState,
  verifyOAuthState,
  type OAuthStatePayload,
  discoverOAuthServer,
  registerOAuthClient,
  safeLookup,
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  refreshOAuthToken,
  OAuthRequestError,
  assertSafeOAuthUrl,
  OAUTH_FETCH_TIMEOUT_MS,
  resolvePublicOAuthHost,
} from "../mcp-connector-oauth.js";

beforeAll(() => {
  process.env.BETTER_AUTH_SECRET ||= "test-secret";
});

describe("generatePkce", () => {
  it("produces a URL-safe verifier and a matching S256 challenge", () => {
    const { verifier, challenge } = generatePkce();
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
    expect(challenge).toMatch(/^[A-Za-z0-9\-_]+$/); // base64url, no padding
    const expected = createHash("sha256").update(verifier).digest("base64url");
    expect(challenge).toBe(expected);
  });
  it("is random per call", () => {
    expect(generatePkce().verifier).not.toBe(generatePkce().verifier);
  });
});

describe("oauth state", () => {
  const base: OAuthStatePayload = { connectorId: "c1", companyId: "co1", nonce: "n", exp: 0 };
  it("round-trips a valid unexpired state", () => {
    const token = signOAuthState({ ...base, exp: 10_000 });
    expect(verifyOAuthState(token, 5_000)).toEqual({ ...base, exp: 10_000 });
  });
  it("rejects an expired state", () => {
    const token = signOAuthState({ ...base, exp: 1_000 });
    expect(verifyOAuthState(token, 2_000)).toBeNull();
  });
  it("rejects a tampered payload (signature mismatch)", () => {
    const token = signOAuthState({ ...base, exp: 10_000 });
    const [payload] = token.split(".");
    expect(verifyOAuthState(`${payload}.deadbeef`, 5_000)).toBeNull();
  });
  it("rejects garbage", () => {
    expect(verifyOAuthState("not-a-token", 0)).toBeNull();
    expect(verifyOAuthState("", 0)).toBeNull();
  });
  it("rejects a state whose payload has a non-string nonce", () => {
    const token = signOAuthState({ ...base, nonce: 123 as unknown as string, exp: 10_000 });
    expect(verifyOAuthState(token, 5_000)).toBeNull();
  });
});

function stubFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url in routes) return new Response(JSON.stringify(routes[url]), { status: 200 });
    return new Response("nf", { status: 404 });
  }) as typeof fetch;
}

describe("discoverOAuthServer", () => {
  const CONN = "https://mcp.notion.com/mcp";
  const f = stubFetch({
    "https://mcp.notion.com/.well-known/oauth-protected-resource/mcp": {
      resource: CONN, authorization_servers: ["https://mcp.notion.com"], scopes_supported: ["default"],
    },
    "https://mcp.notion.com/.well-known/oauth-authorization-server": {
      issuer: "https://mcp.notion.com", authorization_endpoint: "https://mcp.notion.com/authorize",
      token_endpoint: "https://mcp.notion.com/token", registration_endpoint: "https://mcp.notion.com/register",
      code_challenge_methods_supported: ["S256"], scopes_supported: ["default"],
    },
  });

  it("resolves endpoints via PRM then AS metadata", async () => {
    const d = await discoverOAuthServer(CONN, f);
    expect(d.authorizationEndpoint).toBe("https://mcp.notion.com/authorize");
    expect(d.tokenEndpoint).toBe("https://mcp.notion.com/token");
    expect(d.registrationEndpoint).toBe("https://mcp.notion.com/register");
    expect(d.codeChallengeMethods).toContain("S256");
  });

  it("throws a clear error when the AS omits S256", async () => {
    const noPkce = stubFetch({
      "https://mcp.notion.com/.well-known/oauth-protected-resource/mcp": { authorization_servers: ["https://as"] },
      "https://as/.well-known/oauth-authorization-server": {
        issuer: "https://as", authorization_endpoint: "https://as/a", token_endpoint: "https://as/t", code_challenge_methods_supported: ["plain"],
      },
    });
    await expect(discoverOAuthServer(CONN, noPkce)).rejects.toThrow(/S256/);
  });

  it("rejects a non-https token endpoint (no cleartext tokens)", async () => {
    const f = stubFetch({
      "https://mcp.notion.com/.well-known/oauth-protected-resource/mcp": { authorization_servers: ["https://mcp.notion.com"] },
      "https://mcp.notion.com/.well-known/oauth-authorization-server": {
        issuer: "https://mcp.notion.com",
        authorization_endpoint: "https://mcp.notion.com/authorize", token_endpoint: "http://mcp.notion.com/token",
        registration_endpoint: "https://mcp.notion.com/register", code_challenge_methods_supported: ["S256"],
      },
    });
    await expect(discoverOAuthServer("https://mcp.notion.com/mcp", f)).rejects.toThrow(/https/i);
  });

  it("rejects a non-https connector URL before making any request (Fix 4)", async () => {
    // The connector URL itself was never https-asserted — only the AS base and
    // the endpoints discovered FROM it. A stub that throws on any call proves
    // the rejection happens before the PRM fetch, not just eventually.
    const noFetch: typeof fetch = (async () => {
      throw new Error("must not fetch — connector URL should be rejected first");
    }) as typeof fetch;
    await expect(discoverOAuthServer("http://mcp.notion.com/mcp", noFetch)).rejects.toThrow(/https/i);
  });

  it.each(["https://127.0.0.1/x", "https://[::1]/x", "https://169.254.169.254/x", "https://user:pass@example.com/x"])(
    "rejects a blocked literal or credential-bearing URL: %s",
    (url) => expect(() => assertSafeOAuthUrl(url)).toThrow(OAuthRequestError),
  );

  it("rejects a DNS answer set containing any private address and never selects it", async () => {
    const resolver = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);

    await expect(resolvePublicOAuthHost("oauth.example", resolver)).rejects.toThrow(
      /blocked address/i,
    );
    expect(resolver).toHaveBeenCalledWith("oauth.example", { all: true, verbatim: true });
  });

  it("returns the exact validated public DNS answer used by the TLS socket", async () => {
    const resolver = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "1.1.1.1", family: 4 },
    ]);

    await expect(resolvePublicOAuthHost("oauth.example", resolver)).resolves.toEqual({
      address: "93.184.216.34",
      family: 4,
    });
  });

  it("allows at most same-origin redirects for metadata GETs", async () => {
    const f = (async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/.well-known/oauth-protected-resource/mcp")) {
        return new Response(null, { status: 302, headers: { location: "https://attacker.example/prm" } });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    await expect(discoverOAuthServer(CONN, f)).rejects.toThrow(/cross-origin|redirect/i);
  });
});

describe("registerOAuthClient", () => {
  it("applies the fixed ten-second abort timeout to outbound requests", async () => {
    const signal = new AbortController().signal;
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(signal);
    const f = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ client_id: "dcr-timeout" }), { status: 201 }),
    );

    try {
      await registerOAuthClient("https://as/register", "https://app/cb", f as unknown as typeof fetch);
      expect(timeout).toHaveBeenCalledWith(OAUTH_FETCH_TIMEOUT_MS);
      expect(OAUTH_FETCH_TIMEOUT_MS).toBe(10_000);
      expect(f.mock.calls[0]?.[1]).toMatchObject({ signal });
    } finally {
      timeout.mockRestore();
    }
  });

  it("POSTs a public-client registration and returns the client_id", async () => {
    let captured: { url: string; body: unknown } | null = null;
    const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = { url: input.toString(), body: JSON.parse(String(init?.body)) };
      return new Response(JSON.stringify({ client_id: "dcr-123" }), { status: 201 });
    }) as typeof fetch;
    const out = await registerOAuthClient("https://as/register", "https://app/cb", f);
    expect(out.clientId).toBe("dcr-123");
    expect(captured!.body).toMatchObject({
      redirect_uris: ["https://app/cb"], token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
    });
  });
  it("throws on non-2xx", async () => {
    const f = (async () => new Response("no", { status: 400 })) as typeof fetch;
    await expect(registerOAuthClient("https://as/register", "https://app/cb", f)).rejects.toThrow(/registration/i);
  });

  it("rejects every redirect without following it", async () => {
    let calls = 0;
    const f = (async () => {
      calls += 1;
      return new Response(null, { status: 307, headers: { location: "https://attacker.example/register" } });
    }) as typeof fetch;
    await expect(registerOAuthClient("https://as/register", "https://app/cb", f)).rejects.toThrow(/redirect/i);
    expect(calls).toBe(1);
  });
});

describe("buildAuthorizeUrl", () => {
  it("assembles a spec-correct authorize URL", () => {
    const url = new URL(buildAuthorizeUrl({
      authorizationEndpoint: "https://as/authorize", clientId: "cid", redirectUri: "https://app/cb",
      scopes: ["default"], resource: "https://mcp/x", state: "STATE", codeChallenge: "CHAL",
    }));
    expect(url.origin + url.pathname).toBe("https://as/authorize");
    const q = url.searchParams;
    expect(q.get("response_type")).toBe("code");
    expect(q.get("client_id")).toBe("cid");
    expect(q.get("redirect_uri")).toBe("https://app/cb");
    expect(q.get("scope")).toBe("default");
    expect(q.get("resource")).toBe("https://mcp/x");
    expect(q.get("state")).toBe("STATE");
    expect(q.get("code_challenge")).toBe("CHAL");
    expect(q.get("code_challenge_method")).toBe("S256");
  });
  it("omits scope when empty", () => {
    const url = new URL(buildAuthorizeUrl({
      authorizationEndpoint: "https://as/a", clientId: "c", redirectUri: "https://app/cb",
      scopes: [], resource: "https://mcp/x", state: "s", codeChallenge: "c",
    }));
    expect(url.searchParams.has("scope")).toBe(false);
  });
});

function tokenStub(assert: (form: URLSearchParams) => void, resp: unknown): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    assert(new URLSearchParams(String(init?.body)));
    return new Response(JSON.stringify(resp), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

describe("token endpoint", () => {
  it("exchangeAuthorizationCode posts the PKCE verifier + resource and maps the response", async () => {
    const f = tokenStub((form) => {
      expect(form.get("grant_type")).toBe("authorization_code");
      expect(form.get("code")).toBe("CODE");
      expect(form.get("code_verifier")).toBe("VER");
      expect(form.get("client_id")).toBe("cid");
      expect(form.get("redirect_uri")).toBe("https://app/cb");
      expect(form.get("resource")).toBe("https://mcp/x");
    }, { access_token: "at", refresh_token: "rt", expires_in: 3600 });
    const out = await exchangeAuthorizationCode({
      tokenEndpoint: "https://as/token", code: "CODE", codeVerifier: "VER", clientId: "cid",
      redirectUri: "https://app/cb", resource: "https://mcp/x",
    }, f);
    expect(out).toEqual({ accessToken: "at", refreshToken: "rt", expiresIn: 3600 });
  });

  it("refreshOAuthToken posts grant_type=refresh_token and keeps the old refresh token if none returned", async () => {
    const f = tokenStub((form) => {
      expect(form.get("grant_type")).toBe("refresh_token");
      expect(form.get("refresh_token")).toBe("OLD");
    }, { access_token: "at2", expires_in: 3600 });
    const out = await refreshOAuthToken({
      tokenEndpoint: "https://as/token", refreshToken: "OLD", clientId: "cid", resource: "https://mcp/x",
    }, f);
    expect(out).toEqual({ accessToken: "at2", refreshToken: null, expiresIn: 3600 });
  });

  it("throws on token error", async () => {
    const f = (async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as typeof fetch;
    await expect(refreshOAuthToken({ tokenEndpoint: "https://as/token", refreshToken: "x", clientId: "c", resource: "r" }, f))
      .rejects.toThrow(/invalid_grant|token/i);
  });

  it("does not follow a token redirect or replay the refresh token", async () => {
    let calls = 0;
    const f = (async () => {
      calls += 1;
      return new Response(null, { status: 307, headers: { location: "https://attacker.example/token" } });
    }) as typeof fetch;
    await expect(refreshOAuthToken({ tokenEndpoint: "https://as/token", refreshToken: "SECRET", clientId: "c", resource: "https://mcp/x" }, f))
      .rejects.toThrow(/redirect/i);
    expect(calls).toBe(1);
  });

  it("aborts responses larger than 1 MiB before JSON parsing", async () => {
    const f = (async () => new Response(`{"padding":"${"x".repeat(1024 * 1024)}"}`, { status: 200 })) as typeof fetch;
    await expect(refreshOAuthToken({ tokenEndpoint: "https://as/token", refreshToken: "x", clientId: "c", resource: "https://mcp/x" }, f))
      .rejects.toThrow(/size limit/i);
  });
});

describe("safeLookup — node http/https custom-lookup contract (SSRF guard)", () => {
  // Regression for the P0 caught by the live Notion test: node's http/https
  // agent calls the custom lookup with `options.all: true` and expects the
  // ARRAY form `callback(err, [{ address, family }])`. Returning the single
  // `callback(err, address, family)` form made node:net read addresses[0].address
  // off a string -> ERR_INVALID_IP_ADDRESS -> every real OAuth request failed.
  const publicResolver = async () => [{ address: "93.184.216.34", family: 4 }];

  it("returns the ARRAY form when options.all is true", async () => {
    const result = await new Promise((resolve, reject) =>
      safeLookup(
        "example.com",
        { all: true, verbatim: true },
        (err, addr) => (err ? reject(err) : resolve(addr)),
        publicResolver,
      ),
    );
    expect(result).toEqual([{ address: "93.184.216.34", family: 4 }]);
  });

  it("returns the single (address, family) form when options.all is falsy", async () => {
    const result = await new Promise((resolve, reject) =>
      safeLookup(
        "example.com",
        { all: false },
        (err, address, family) => (err ? reject(err) : resolve({ address, family })),
        publicResolver,
      ),
    );
    expect(result).toEqual({ address: "93.184.216.34", family: 4 });
  });

  it("rejects (via callback error) when the resolved address is private/blocked", async () => {
    const privateResolver = async () => [{ address: "10.0.0.5", family: 4 }];
    await expect(
      new Promise((resolve, reject) =>
        safeLookup("internal.invalid", { all: true }, (err, addr) => (err ? reject(err) : resolve(addr)), privateResolver),
      ),
    ).rejects.toThrow(/blocked address/i);
  });
});
