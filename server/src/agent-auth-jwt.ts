import { createHmac, timingSafeEqual } from "node:crypto";

interface JwtHeader {
  alg: string;
  typ?: string;
}

export interface LocalAgentJwtClaims {
  sub: string;
  company_id: string;
  adapter_type: string;
  run_id: string;
  iat: number;
  exp: number;
  iss?: string;
  aud?: string;
  jti?: string;
}

const JWT_ALGORITHM = "HS256";

function parseNumber(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function jwtConfig() {
  const secret = process.env.AOA_AGENT_JWT_SECRET?.trim() || process.env.BETTER_AUTH_SECRET?.trim();
  if (!secret) return null;

  return {
    secret,
    ttlSeconds: parseNumber(process.env.AOA_AGENT_JWT_TTL_SECONDS, 60 * 60 * 48),
    issuer: process.env.AOA_AGENT_JWT_ISSUER ?? "aoa",
    audience: process.env.AOA_AGENT_JWT_AUDIENCE ?? "aoa-api",
  };
}

function base64UrlEncode(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signPayload(secret: string, signingInput: string) {
  return createHmac("sha256", secret).update(signingInput).digest("base64url");
}

function parseJson(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function safeCompare(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function createLocalAgentJwt(agentId: string, companyId: string, adapterType: string, runId: string) {
  const config = jwtConfig();
  if (!config) return null;

  const now = Math.floor(Date.now() / 1000);
  const claims: LocalAgentJwtClaims = {
    sub: agentId,
    company_id: companyId,
    adapter_type: adapterType,
    run_id: runId,
    iat: now,
    exp: now + config.ttlSeconds,
    iss: config.issuer,
    aud: config.audience,
  };

  const header = {
    alg: JWT_ALGORITHM,
    typ: "JWT",
  };

  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(claims))}`;
  const signature = signPayload(config.secret, signingInput);

  return `${signingInput}.${signature}`;
}

export function verifyLocalAgentJwt(token: string): LocalAgentJwtClaims | null {
  if (!token) return null;
  const config = jwtConfig();
  if (!config) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, claimsB64, signature] = parts;

  const header = parseJson(base64UrlDecode(headerB64));
  if (!header || header.alg !== JWT_ALGORITHM) return null;

  const signingInput = `${headerB64}.${claimsB64}`;
  const expectedSig = signPayload(config.secret, signingInput);
  if (!safeCompare(signature, expectedSig)) return null;

  const claims = parseJson(base64UrlDecode(claimsB64));
  if (!claims) return null;

  const sub = typeof claims.sub === "string" ? claims.sub : null;
  const companyId = typeof claims.company_id === "string" ? claims.company_id : null;
  const adapterType = typeof claims.adapter_type === "string" ? claims.adapter_type : null;
  const runId = typeof claims.run_id === "string" ? claims.run_id : null;
  const iat = typeof claims.iat === "number" ? claims.iat : null;
  const exp = typeof claims.exp === "number" ? claims.exp : null;
  if (!sub || !companyId || !adapterType || !runId || !iat || !exp) return null;

  const now = Math.floor(Date.now() / 1000);
  if (exp < now) return null;

  const issuer = typeof claims.iss === "string" ? claims.iss : undefined;
  const audience = typeof claims.aud === "string" ? claims.aud : undefined;
  // Accept both legacy ("paperclip"/"paperclip-api") and current issuer/audience
  // to avoid rejecting in-flight JWTs during the rename transition.
  const validIssuers = new Set([config.issuer, "paperclip"]);
  const validAudiences = new Set([config.audience, "paperclip-api"]);
  if (issuer && !validIssuers.has(issuer)) return null;
  if (audience && !validAudiences.has(audience)) return null;

  return {
    sub,
    company_id: companyId,
    adapter_type: adapterType,
    run_id: runId,
    iat,
    exp,
    ...(issuer ? { iss: issuer } : {}),
    ...(audience ? { aud: audience } : {}),
    jti: typeof claims.jti === "string" ? claims.jti : undefined,
  };
}

// ---------------------------------------------------------------------------
// Commander run-JWT (W7.5a / SC1)
//
// A SIBLING JWT type to the local-agent JWT above. It is minted per Commander
// turn so a sandboxed Commander CLI can reach the control plane through the MCP
// broker without ever holding DB credentials. It shares the SAME HS256 secret +
// machinery (jwtConfig/base64UrlEncode/base64UrlDecode/signPayload/parseJson/
// safeCompare/JWT_ALGORITHM/parseNumber) but carries an EXPLICIT
// `kind:"commander"` discriminant and a DISJOINT claim set (no sub/adapter_type/
// run_id). That disjointness is the security property: `verifyCommanderRunJwt`
// rejects an agent token (no `kind:"commander"`) and `verifyLocalAgentJwt`
// rejects a commander token (no sub/adapter_type/run_id), so an agent-expecting
// path can never trust a commander token and vice-versa.
// ---------------------------------------------------------------------------

export interface CommanderJwtClaims {
  kind: "commander";
  company_id: string;
  user_id: string;
  user_role: string;
  conversation_id: string;
  turn_id: string;
  iat: number;
  exp: number;
  iss?: string;
  aud?: string;
  jti?: string;
}

// Commander run-JWTs are turn-scoped, so they get a SHORT ttl of their own
// (default 10 min) — an agent JWT's 48h default would keep a stolen/injected
// Commander token alive far past its turn. Same secret + HS256 machinery.
function commanderJwtTtlSeconds(): number {
  return parseNumber(process.env.AOA_COMMANDER_JWT_TTL_SECONDS, 60 * 10);
}

export function createCommanderRunJwt(input: {
  companyId: string;
  userId: string;
  userRole: string;
  conversationId: string;
  turnId: string;
}): string | null {
  const config = jwtConfig();
  if (!config) return null;

  const now = Math.floor(Date.now() / 1000);
  const claims: CommanderJwtClaims = {
    kind: "commander",
    company_id: input.companyId,
    user_id: input.userId,
    user_role: input.userRole,
    conversation_id: input.conversationId,
    turn_id: input.turnId,
    iat: now,
    exp: now + commanderJwtTtlSeconds(),
    iss: config.issuer,
    aud: config.audience,
  };

  const header = { alg: JWT_ALGORITHM, typ: "JWT" };
  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(claims))}`;
  const signature = signPayload(config.secret, signingInput);
  return `${signingInput}.${signature}`;
}

export function verifyCommanderRunJwt(token: string): CommanderJwtClaims | null {
  if (!token) return null;
  const config = jwtConfig();
  if (!config) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, claimsB64, signature] = parts;

  const header = parseJson(base64UrlDecode(headerB64));
  if (!header || header.alg !== JWT_ALGORITHM) return null;

  const signingInput = `${headerB64}.${claimsB64}`;
  const expectedSig = signPayload(config.secret, signingInput);
  if (!safeCompare(signature, expectedSig)) return null;

  const claims = parseJson(base64UrlDecode(claimsB64));
  if (!claims) return null;

  // The explicit discriminant is the whole point (SC1): an agent token has no
  // `kind`, so it fails here before any commander-only path can trust it.
  if (claims.kind !== "commander") return null;

  const companyId = typeof claims.company_id === "string" ? claims.company_id : null;
  const userId = typeof claims.user_id === "string" ? claims.user_id : null;
  const userRole = typeof claims.user_role === "string" ? claims.user_role : null;
  const conversationId = typeof claims.conversation_id === "string" ? claims.conversation_id : null;
  const turnId = typeof claims.turn_id === "string" ? claims.turn_id : null;
  const iat = typeof claims.iat === "number" ? claims.iat : null;
  const exp = typeof claims.exp === "number" ? claims.exp : null;
  if (!companyId || !userId || !userRole || !conversationId || !turnId || !iat || !exp) return null;

  const now = Math.floor(Date.now() / 1000);
  if (exp < now) return null;

  const issuer = typeof claims.iss === "string" ? claims.iss : undefined;
  const audience = typeof claims.aud === "string" ? claims.aud : undefined;
  const validIssuers = new Set([config.issuer, "paperclip"]);
  const validAudiences = new Set([config.audience, "paperclip-api"]);
  if (issuer && !validIssuers.has(issuer)) return null;
  if (audience && !validAudiences.has(audience)) return null;

  return {
    kind: "commander",
    company_id: companyId,
    user_id: userId,
    user_role: userRole,
    conversation_id: conversationId,
    turn_id: turnId,
    iat,
    exp,
    ...(issuer ? { iss: issuer } : {}),
    ...(audience ? { aud: audience } : {}),
    jti: typeof claims.jti === "string" ? claims.jti : undefined,
  };
}
