import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

export const OAUTH_BUNDLE_VERSION = "aoa-oauth-2" as const;
const BUNDLE_KEY_INFO = "aoa:mcp-oauth-bundle:v2";
const MAX_BUNDLE_LENGTH = 96 * 1024;
const MAX_TOKEN_LENGTH = 32 * 1024;
const MAX_SHORT_STRING = 512;
const MAX_URL_LENGTH = 4096;
const MAX_SCOPES = 100;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

export interface OAuthTokenBundlePayload {
  companyId: string;
  connectorId: string;
  catalogEntryId: string;
  oauthPolicyVersion: number;
  secretName: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  issuer: string;
  tokenEndpoint: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  resource: string;
}

export type OAuthTokenBundle = OAuthTokenBundlePayload;

export type OAuthBundleExpectedContext = Pick<
  OAuthTokenBundlePayload,
  "companyId" | "connectorId" | "catalogEntryId" | "oauthPolicyVersion" | "secretName"
>;

export function deriveOAuthBundleKey(rootSecret: string | Uint8Array): Buffer {
  const root = typeof rootSecret === "string" ? Buffer.from(rootSecret, "utf8") : Buffer.from(rootSecret);
  if (root.length === 0) throw new Error("OAuth bundle signing requires a non-empty root secret");
  return Buffer.from(hkdfSync("sha256", root, Buffer.alloc(0), BUNDLE_KEY_INFO, 32));
}

function mac(payloadBytes: Buffer, key: Uint8Array): Buffer {
  return createHmac("sha256", key).update(payloadBytes).digest();
}

function isBoundedString(value: unknown, max: number, allowEmpty = false): value is string {
  return typeof value === "string" && (allowEmpty || value.length > 0) && value.length <= max;
}

function isSafeHttpsUrl(value: unknown): value is string {
  if (!isBoundedString(value, MAX_URL_LENGTH)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

function isSafeRedirectUri(value: unknown): value is string {
  if (!isBoundedString(value, MAX_URL_LENGTH)) return false;
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    if (url.protocol === "https:") return true;
    const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return url.protocol === "http:" && (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1");
  } catch {
    return false;
  }
}

const PAYLOAD_KEYS = new Set([
  "companyId", "connectorId", "catalogEntryId", "oauthPolicyVersion", "secretName",
  "accessToken", "refreshToken", "expiresAt", "issuer", "tokenEndpoint", "clientId",
  "redirectUri", "scopes", "resource",
]);

function parsePayload(value: unknown): OAuthTokenBundlePayload | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  if (Object.keys(o).some((key) => !PAYLOAD_KEYS.has(key)) || Object.keys(o).length !== PAYLOAD_KEYS.size) return null;
  if (!isBoundedString(o.companyId, MAX_SHORT_STRING)) return null;
  if (!isBoundedString(o.connectorId, MAX_SHORT_STRING)) return null;
  if (!isBoundedString(o.catalogEntryId, MAX_SHORT_STRING)) return null;
  if (!Number.isSafeInteger(o.oauthPolicyVersion) || (o.oauthPolicyVersion as number) < 1) return null;
  if (!isBoundedString(o.secretName, MAX_SHORT_STRING)) return null;
  if (!isBoundedString(o.accessToken, MAX_TOKEN_LENGTH)) return null;
  if (o.refreshToken !== null && !isBoundedString(o.refreshToken, MAX_TOKEN_LENGTH)) return null;
  if (!Number.isSafeInteger(o.expiresAt) || (o.expiresAt as number) < 0) return null;
  if (!isSafeHttpsUrl(o.issuer) || !isSafeHttpsUrl(o.tokenEndpoint)) return null;
  if (!isBoundedString(o.clientId, MAX_SHORT_STRING)) return null;
  if (!isSafeRedirectUri(o.redirectUri) || !isSafeHttpsUrl(o.resource)) return null;
  if (!Array.isArray(o.scopes) || o.scopes.length > MAX_SCOPES) return null;
  if (!o.scopes.every((scope) => isBoundedString(scope, MAX_SHORT_STRING))) return null;
  return o as unknown as OAuthTokenBundlePayload;
}

function contextMatches(payload: OAuthTokenBundlePayload, expected: OAuthBundleExpectedContext): boolean {
  return payload.companyId === expected.companyId &&
    payload.connectorId === expected.connectorId &&
    payload.catalogEntryId === expected.catalogEntryId &&
    payload.oauthPolicyVersion === expected.oauthPolicyVersion &&
    payload.secretName === expected.secretName;
}

export function encodeOAuthBundle(payload: OAuthTokenBundlePayload, key: Uint8Array): string {
  const validated = parsePayload(payload);
  if (!validated) throw new Error("Invalid OAuth token bundle payload");
  const payloadBytes = Buffer.from(JSON.stringify(validated), "utf8");
  const encodedPayload = payloadBytes.toString("base64url");
  const encodedMac = mac(payloadBytes, key).toString("base64url");
  const envelope = `${OAUTH_BUNDLE_VERSION}.${encodedPayload}.${encodedMac}`;
  if (envelope.length > MAX_BUNDLE_LENGTH) throw new Error("OAuth token bundle exceeds size limit");
  return envelope;
}

export function decodeOAuthBundle(
  raw: string,
  key: Uint8Array,
  expectedContext: OAuthBundleExpectedContext,
): OAuthTokenBundlePayload | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_BUNDLE_LENGTH) return null;
  const parts = raw.split(".");
  if (parts.length !== 3 || parts[0] !== OAUTH_BUNDLE_VERSION) return null;
  const encodedPayload = parts[1]!;
  const encodedMac = parts[2]!;
  if (!BASE64URL_RE.test(encodedPayload) || !BASE64URL_RE.test(encodedMac)) return null;
  let payloadBytes: Buffer;
  let suppliedMac: Buffer;
  try {
    payloadBytes = Buffer.from(encodedPayload, "base64url");
    suppliedMac = Buffer.from(encodedMac, "base64url");
  } catch {
    return null;
  }
  const expectedMac = mac(payloadBytes, key);
  if (suppliedMac.length !== expectedMac.length || !timingSafeEqual(suppliedMac, expectedMac)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    return null;
  }
  const payload = parsePayload(parsed);
  return payload && contextMatches(payload, expectedContext) ? payload : null;
}

export function isOAuthBundle(raw: string, key: Uint8Array, expectedContext: OAuthBundleExpectedContext): boolean {
  return decodeOAuthBundle(raw, key, expectedContext) !== null;
}

export function isBundleExpired(b: OAuthTokenBundle, nowMs: number, marginMs = 120_000): boolean {
  return nowMs >= b.expiresAt - marginMs;
}
