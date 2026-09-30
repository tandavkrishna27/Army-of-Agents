import { createHash, randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { resolveConsentSecret } from "./mcp-connector-consent.js";
import { INTERNAL_RANGE_DENY_CIDRS } from "./w10c-internal-range-deny-set.js";

export const OAUTH_FETCH_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_METADATA_REDIRECTS = 3;

// W13 — THE OAUTH DENY TABLE IS DERIVED, NOT TRANSCRIBED.
//
// These two `BlockList`s used to be hand-typed range lists. Hand-typing is how they
// diverged from `isPrivateIP` — this repository's reference "is this address internal"
// predicate — and E8-F009 measured the divergence: one IPv4 /24 (192.88.99.0/24, the
// relay-anycast END of the 6to4 tunnel) and EIGHT IPv6 classes, including the ADDRESS
// end of that same tunnel (2002::/16) and the NAT64 well-known prefix (64:ff9b::/96),
// which embeds an IPv4 destination and so re-opened every IPv4 range this table denies.
//
// They are now built from `INTERNAL_RANGE_DENY_CIDRS` — the MECHANICALLY DERIVED cover
// of `isPrivateIP`, re-derived from that live predicate in CI on every run
// (w10c-internal-range-deny-set.test.ts: a full 2^24 sweep on IPv4, all 65536 leading
// words on IPv6). So a change to the predicate now propagates here instead of silently
// leaving this table behind, and there is no second list to keep in step by hand.
//
// ★ THAT COVER IS A STRICT SUPERSET OF THE PREDICATE, NOT AN EXACT RENDERING OF IT,
// and this table inherits the difference. On IPv4 it is the exact minimal cover; on
// IPv6 it is deliberately wider, by one enumerated class — `::/16` numerically contains
// every IPv4-mapped address, so this `BlockList` denies `::ffff:<public v4>` while
// `isPrivateIP` allows it (measured: `isBlockedOAuthAddress('::ffff:8.8.8.8')` is
// `true`, `isPrivateIP('::ffff:8.8.8.8')` is `false`). That is PRE-EXISTING — the
// hand-typed table this replaced denied the same `::ffff:0:0/96` explicitly — it fails
// CLOSED, and it is pinned by the two `IPv4-MAPPED:` tests in
// `w13-oauth-deny-table-divergence.test.ts`. Do not "correct" it into exactness: that
// moves addresses denied -> allowed on a live SSRF filter.
//
// `BlockList` is kept as the runtime mechanism (native, and the two `assert*` call sites
// below are unchanged); only the DATA it is loaded with changed.
const blockedIpv4 = new BlockList();
const blockedIpv6 = new BlockList();
for (const cidr of INTERNAL_RANGE_DENY_CIDRS) {
  const slash = cidr.indexOf("/");
  const network = cidr.slice(0, slash);
  const prefix = Number(cidr.slice(slash + 1));
  if (network.includes(":")) blockedIpv6.addSubnet(network, prefix, "ipv6");
  else blockedIpv4.addSubnet(network, prefix, "ipv4");
}

/**
 * True iff `address` is an IP literal this path refuses to reach. Exported so the
 * divergence test can compare THE LIVE TABLE against `isPrivateIP` directly, rather
 * than a reimplementation of it — the mistake that produced E8-F009 in the first place.
 * A non-IP string is NOT blocked here; the two callers below handle that case with the
 * fail-open/fail-closed posture each of them needs.
 */
export function isBlockedOAuthAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return family === 4 ? blockedIpv4.check(address, "ipv4") : blockedIpv6.check(address, "ipv6");
}

export type OAuthRequestFailureKind = "policy" | "transient" | "http" | "invalid_response";

export class OAuthRequestError extends Error {
  constructor(
    message: string,
    readonly kind: OAuthRequestFailureKind,
    readonly status?: number,
    readonly oauthError?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "OAuthRequestError";
  }
}

function normalizedHostname(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

export function assertSafeOAuthUrl(raw: string, label = "OAuth endpoint"): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OAuthRequestError(`${label} is invalid`, "policy");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new OAuthRequestError(`${label} must be credential-free HTTPS`, "policy");
  }
  const hostname = normalizedHostname(url);
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new OAuthRequestError(`${label} targets a blocked host`, "policy");
  }
  // A hostname that is not an IP literal is left to `assertPublicResolvedAddress`,
  // which sees what it actually resolves to.
  if (isBlockedOAuthAddress(hostname)) {
    throw new OAuthRequestError(`${label} targets a blocked address`, "policy");
  }
  return url;
}

function assertPublicResolvedAddress(address: string): void {
  // Fail CLOSED on a non-IP resolver result: unlike the URL check above, there is no
  // later stage that could vet it.
  if (isIP(address) === 0 || isBlockedOAuthAddress(address)) {
    throw new OAuthRequestError("OAuth endpoint resolved to a blocked address", "policy");
  }
}

type LookupCallback = (error: NodeJS.ErrnoException | null, address?: string, family?: number) => void;

type DnsResolver = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<Array<{ address: string; family: number }>>;

export async function resolvePublicOAuthHost(
  hostname: string,
  resolver: DnsResolver = dnsLookup,
): Promise<{ address: string; family: number }> {
  const addresses = await resolver(hostname, { all: true, verbatim: true });
  if (addresses.length === 0) {
    throw new OAuthRequestError("OAuth endpoint did not resolve", "policy");
  }
  // Reject the hostname if any answer can route to a forbidden boundary. The
  // exact selected public address is then handed to the TLS socket, preventing
  // a second resolver lookup from rebinding the connection.
  for (const result of addresses) assertPublicResolvedAddress(result.address);
  return addresses[0]!;
}

export function safeLookup(
  hostname: string,
  options: unknown,
  callback: LookupCallback,
  resolver: DnsResolver = dnsLookup,
): void {
  // Node's http/https agent calls the custom lookup with `options.all: true`
  // (it wants every address). In that mode node:net expects the ARRAY form
  // `callback(err, [{ address, family }])` — passing the single
  // `callback(err, address, family)` form makes it read `addresses[0].address`
  // off a string and throw ERR_INVALID_IP_ADDRESS ("Invalid IP address:
  // undefined"), which broke every real OAuth request. Honor `options.all`.
  const wantsAll =
    typeof options === "object" && options !== null && (options as { all?: unknown }).all === true;
  void resolvePublicOAuthHost(hostname, resolver).then(
    (selected) => {
      if (wantsAll) {
        (callback as unknown as (
          error: NodeJS.ErrnoException | null,
          addresses: Array<{ address: string; family: number }>,
        ) => void)(null, [{ address: selected.address, family: selected.family }]);
      } else {
        callback(null, selected.address, selected.family);
      }
    },
    (error: NodeJS.ErrnoException) => callback(error),
  );
}

function headersRecord(headers: HeadersInit | undefined): Record<string, string> {
  return Object.fromEntries(new Headers(headers).entries());
}

async function realHttpsRequest(url: URL, init: RequestInit): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const req = httpsRequest(url, {
      method: init.method ?? "GET",
      headers: headersRecord(init.headers),
      lookup: safeLookup as never,
      signal: AbortSignal.timeout(OAUTH_FETCH_TIMEOUT_MS),
    }, (res) => {
      const chunks: Buffer[] = [];
      let total = 0;
      res.on("data", (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += bytes.length;
        if (total > MAX_RESPONSE_BYTES) {
          res.destroy(new OAuthRequestError("OAuth response exceeds size limit", "policy"));
          return;
        }
        chunks.push(bytes);
      });
      res.on("end", () => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(res.headers)) {
          if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
          else if (value !== undefined) headers.set(name, String(value));
        }
        resolve(new Response(Buffer.concat(chunks), {
          status: res.statusCode ?? 500,
          statusText: res.statusMessage,
          headers,
        }));
      });
      res.on("error", reject);
    });
    req.on("error", (error) => {
      reject(error instanceof OAuthRequestError
        ? error
        : new OAuthRequestError("OAuth request failed", "transient", undefined, undefined, { cause: error }));
    });
    if (init.body !== undefined && init.body !== null) {
      if (typeof init.body !== "string" && !Buffer.isBuffer(init.body) && !(init.body instanceof Uint8Array)) {
        reject(new OAuthRequestError("Unsupported OAuth request body", "policy"));
        req.destroy();
        return;
      }
      req.write(init.body);
    }
    req.end();
  });
}

async function readCappedResponse(response: Response): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new OAuthRequestError("OAuth response exceeds size limit", "policy");
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new OAuthRequestError("OAuth response exceeds size limit", "policy");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

async function oneRequest(url: URL, init: RequestInit, fetchImpl?: typeof fetch): Promise<Response> {
  if (!fetchImpl) return realHttpsRequest(url, init);
  try {
    return await fetchImpl(url, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(OAUTH_FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof OAuthRequestError) throw error;
    throw new OAuthRequestError("OAuth request failed", "transient", undefined, undefined, { cause: error });
  }
}

async function requestBytes(
  rawUrl: string,
  init: RequestInit,
  options: { metadataRedirects: boolean; fetchImpl?: typeof fetch },
): Promise<{ response: Response; bytes: Buffer }> {
  let url = assertSafeOAuthUrl(rawUrl);
  const initialOrigin = url.origin;
  for (let redirects = 0; ; redirects += 1) {
    const response = await oneRequest(url, init, options.fetchImpl);
    if (response.status < 300 || response.status >= 400) {
      return { response, bytes: await readCappedResponse(response) };
    }
    await response.body?.cancel().catch(() => {});
    if (!options.metadataRedirects || redirects >= MAX_METADATA_REDIRECTS) {
      throw new OAuthRequestError("OAuth endpoint redirect is not allowed", "policy", response.status);
    }
    const location = response.headers.get("location");
    if (!location) throw new OAuthRequestError("OAuth metadata redirect has no location", "policy", response.status);
    const target = assertSafeOAuthUrl(new URL(location, url).toString(), "OAuth redirect target");
    if (target.origin !== initialOrigin) {
      throw new OAuthRequestError("Cross-origin OAuth metadata redirect is not allowed", "policy", response.status);
    }
    url = target;
  }
}

async function requestJson(
  url: string,
  init: RequestInit,
  options: { metadataRedirects?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const { response, bytes } = await requestBytes(url, init, {
    metadataRedirects: options.metadataRedirects ?? false,
    fetchImpl: options.fetchImpl,
  });
  let body: unknown = {};
  if (bytes.length > 0) {
    try {
      body = JSON.parse(bytes.toString("utf8"));
    } catch {
      if (!response.ok) return { response, body: {} };
      throw new OAuthRequestError("OAuth endpoint returned invalid JSON", "invalid_response", response.status);
    }
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    if (!response.ok) return { response, body: {} };
    throw new OAuthRequestError("OAuth endpoint returned an invalid object", "invalid_response", response.status);
  }
  return { response, body: body as Record<string, unknown> };
}

export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export interface OAuthStatePayload {
  connectorId: string;
  companyId: string;
  nonce: string;
  exp: number;
}

export function signOAuthState(p: OAuthStatePayload): string {
  const secret = resolveConsentSecret();
  const encoded = Buffer.from(JSON.stringify(p)).toString("base64url");
  const sig = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${sig}`;
}

export function verifyOAuthState(token: string, nowMs: number): OAuthStatePayload | null {
  const secret = resolveConsentSecret();
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const encoded = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(encoded).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload: OAuthStatePayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload.exp !== "number" || nowMs >= payload.exp) return null;
  if (typeof payload.connectorId !== "string" || typeof payload.companyId !== "string" || typeof payload.nonce !== "string") return null;
  return payload;
}

export interface DiscoveredOAuth {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
  scopesSupported: string[];
  codeChallengeMethods: string[];
}

export async function discoverOAuthServer(connectorUrl: string, fetchImpl?: typeof fetch): Promise<DiscoveredOAuth> {
  const resource = assertSafeOAuthUrl(connectorUrl, "OAuth connector URL");
  const prmUrl = `${resource.origin}/.well-known/oauth-protected-resource${resource.pathname}`;
  const { response: prmResponse, body: prm } = await requestJson(prmUrl, {
    headers: { accept: "application/json" },
  }, { metadataRedirects: true, fetchImpl });
  if (!prmResponse.ok) throw new OAuthRequestError("OAuth protected-resource discovery failed", "http", prmResponse.status);
  if (typeof prm.resource === "string" && prm.resource !== connectorUrl) {
    throw new OAuthRequestError("OAuth resource metadata does not match connector", "policy");
  }
  const servers = Array.isArray(prm.authorization_servers) ? prm.authorization_servers : [];
  const asBase = servers[0];
  if (typeof asBase !== "string" || !asBase) throw new OAuthRequestError("OAuth discovery returned no authorization server", "invalid_response");
  const as = assertSafeOAuthUrl(asBase, "OAuth authorization server");
  const asUrl = `${as.origin}/.well-known/oauth-authorization-server`;
  const { response: mdResponse, body: md } = await requestJson(asUrl, {
    headers: { accept: "application/json" },
  }, { metadataRedirects: true, fetchImpl });
  if (!mdResponse.ok) throw new OAuthRequestError("OAuth authorization-server discovery failed", "http", mdResponse.status);
  const issuer = md.issuer;
  const authorizationEndpoint = md.authorization_endpoint;
  const tokenEndpoint = md.token_endpoint;
  if (typeof issuer !== "string" || typeof authorizationEndpoint !== "string" || typeof tokenEndpoint !== "string") {
    throw new OAuthRequestError("OAuth metadata is missing required endpoints", "invalid_response");
  }
  const safeIssuer = assertSafeOAuthUrl(issuer, "OAuth issuer").toString().replace(/\/$/, "");
  const safeAuthorizationEndpoint = assertSafeOAuthUrl(authorizationEndpoint, "OAuth authorization endpoint").toString();
  const safeTokenEndpoint = assertSafeOAuthUrl(tokenEndpoint, "OAuth token endpoint").toString();
  const registrationEndpoint = typeof md.registration_endpoint === "string"
    ? assertSafeOAuthUrl(md.registration_endpoint, "OAuth registration endpoint").toString()
    : null;
  const codeChallengeMethods = Array.isArray(md.code_challenge_methods_supported)
    ? md.code_challenge_methods_supported.filter((value): value is string => typeof value === "string")
    : [];
  if (!codeChallengeMethods.includes("S256")) {
    throw new OAuthRequestError("OAuth authorization server does not support PKCE S256", "policy");
  }
  return {
    issuer: safeIssuer,
    authorizationEndpoint: safeAuthorizationEndpoint,
    tokenEndpoint: safeTokenEndpoint,
    registrationEndpoint,
    scopesSupported: Array.isArray(md.scopes_supported)
      ? md.scopes_supported.filter((value): value is string => typeof value === "string")
      : [],
    codeChallengeMethods,
  };
}

export async function registerOAuthClient(
  registrationEndpoint: string,
  redirectUri: string,
  fetchImpl?: typeof fetch,
): Promise<{ clientId: string }> {
  assertSafeOAuthUrl(registrationEndpoint, "OAuth registration endpoint");
  const { response, body } = await requestJson(registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: "Army of Agents",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  }, { fetchImpl });
  if (!response.ok) throw new OAuthRequestError("OAuth client registration failed", "http", response.status);
  if (typeof body.client_id !== "string" || body.client_id.length === 0 || body.client_id.length > 4096) {
    throw new OAuthRequestError("OAuth registration returned an invalid client ID", "invalid_response");
  }
  return { clientId: body.client_id };
}

export interface AuthorizeUrlParams {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
  resource: string;
  state: string;
  codeChallenge: string;
}

export function buildAuthorizeUrl(p: AuthorizeUrlParams): string {
  const url = assertSafeOAuthUrl(p.authorizationEndpoint, "OAuth authorization endpoint");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", p.clientId);
  url.searchParams.set("redirect_uri", p.redirectUri);
  if (p.scopes.length > 0) url.searchParams.set("scope", p.scopes.join(" "));
  url.searchParams.set("resource", p.resource);
  url.searchParams.set("state", p.state);
  url.searchParams.set("code_challenge", p.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export interface TokenResponse {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number;
}
export interface ExchangeParams {
  tokenEndpoint: string; code: string; codeVerifier: string;
  clientId: string; redirectUri: string; resource: string;
}
export interface RefreshParams {
  tokenEndpoint: string; refreshToken: string; clientId: string; resource: string;
}

function safeOAuthError(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,100}$/.test(value) ? value : undefined;
}

async function postToken(tokenEndpoint: string, form: URLSearchParams, fetchImpl?: typeof fetch): Promise<TokenResponse> {
  const { response, body } = await requestJson(tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: form.toString(),
  }, { fetchImpl });
  if (!response.ok) {
    const oauthError = safeOAuthError(body.error);
    throw new OAuthRequestError(
      oauthError ? `OAuth token request failed (${oauthError})` : "OAuth token request failed",
      "http",
      response.status,
      oauthError,
    );
  }
  if (
    typeof body.access_token !== "string" || body.access_token.length === 0 || body.access_token.length > 32 * 1024 ||
    typeof body.expires_in !== "number" || !Number.isFinite(body.expires_in) || body.expires_in <= 0
  ) {
    throw new OAuthRequestError("OAuth token response is invalid", "invalid_response", response.status);
  }
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : null,
    expiresIn: body.expires_in,
  };
}

export function exchangeAuthorizationCode(p: ExchangeParams, fetchImpl?: typeof fetch): Promise<TokenResponse> {
  const form = new URLSearchParams({
    grant_type: "authorization_code", code: p.code, code_verifier: p.codeVerifier,
    client_id: p.clientId, redirect_uri: p.redirectUri, resource: p.resource,
  });
  return postToken(p.tokenEndpoint, form, fetchImpl);
}

export function refreshOAuthToken(p: RefreshParams, fetchImpl?: typeof fetch): Promise<TokenResponse> {
  const form = new URLSearchParams({
    grant_type: "refresh_token", refresh_token: p.refreshToken, client_id: p.clientId, resource: p.resource,
  });
  return postToken(p.tokenEndpoint, form, fetchImpl);
}
