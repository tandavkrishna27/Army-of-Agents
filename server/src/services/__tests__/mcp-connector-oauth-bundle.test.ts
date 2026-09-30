import { describe, expect, it } from "vitest";
import {
  decodeOAuthBundle,
  deriveOAuthBundleKey,
  encodeOAuthBundle,
  isBundleExpired,
  isOAuthBundle,
  type OAuthBundleExpectedContext,
  type OAuthTokenBundlePayload,
} from "../mcp-connector-oauth-bundle.js";

const context: OAuthBundleExpectedContext = {
  companyId: "company-1",
  connectorId: "connector-1",
  catalogEntryId: "notion-hosted",
  oauthPolicyVersion: 1,
  secretName: "mcp:oauth:connector-1",
};
const payload: OAuthTokenBundlePayload = {
  ...context,
  accessToken: "access-token",
  refreshToken: "refresh-token",
  expiresAt: 1_000_000,
  issuer: "https://mcp.notion.com",
  tokenEndpoint: "https://mcp.notion.com/token",
  clientId: "client-id",
  redirectUri: "https://aoa.example/api/mcp-connectors/oauth/callback",
  scopes: ["default"],
  resource: "https://mcp.notion.com/mcp",
};
const key = deriveOAuthBundleKey("root-secret-for-tests");

describe("signed OAuth bundle codec", () => {
  it("round-trips the exact signed bytes and expected owner context", () => {
    const encoded = encodeOAuthBundle(payload, key);
    expect(encoded).toMatch(/^aoa-oauth-2\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(decodeOAuthBundle(encoded, key, context)).toEqual(payload);
    expect(isOAuthBundle(encoded, key, context)).toBe(true);
  });

  it("accepts the local_trusted loopback callback URI", () => {
    const local = { ...payload, redirectUri: "http://127.0.0.1:3100/api/mcp-connectors/oauth/callback" };
    expect(decodeOAuthBundle(encodeOAuthBundle(local, key), key, context)).toEqual(local);
  });

  it("rejects plain, unsigned v1, tampered, and wrong-key values", () => {
    expect(decodeOAuthBundle("ntn_plain", key, context)).toBeNull();
    expect(decodeOAuthBundle(JSON.stringify({ v: "aoa-oauth-1", ...payload }), key, context)).toBeNull();
    const encoded = encodeOAuthBundle(payload, key);
    const [version, body, signature] = encoded.split(".");
    const tamperedBody = `${body!.slice(0, -1)}${body!.endsWith("A") ? "B" : "A"}`;
    expect(decodeOAuthBundle(`${version}.${tamperedBody}.${signature}`, key, context)).toBeNull();
    expect(decodeOAuthBundle(encoded, deriveOAuthBundleKey("different-root"), context)).toBeNull();
  });

  it.each([
    ["company", { ...context, companyId: "company-2" }],
    ["connector", { ...context, connectorId: "connector-2" }],
    ["catalog", { ...context, catalogEntryId: "sentry" }],
    ["policy", { ...context, oauthPolicyVersion: 2 }],
    ["secret", { ...context, secretName: "mcp:oauth:other" }],
  ])("rejects a cross-%s transplant", (_label, wrongContext) => {
    expect(decodeOAuthBundle(encodeOAuthBundle(payload, key), key, wrongContext)).toBeNull();
  });

  it("derives a domain-separated fixed-length key", () => {
    expect(key).toHaveLength(32);
    expect(key.equals(Buffer.from("root-secret-for-tests"))).toBe(false);
  });

  it("rejects unsafe endpoints and malformed scope values before signing", () => {
    expect(() => encodeOAuthBundle({ ...payload, tokenEndpoint: "http://127.0.0.1/token" }, key)).toThrow(/invalid/i);
    expect(() => encodeOAuthBundle({ ...payload, scopes: [123 as unknown as string] }, key)).toThrow(/invalid/i);
  });

  it("supports a null refresh token", () => {
    const withoutRefresh = { ...payload, refreshToken: null };
    expect(decodeOAuthBundle(encodeOAuthBundle(withoutRefresh, key), key, context)).toEqual(withoutRefresh);
  });

  it("respects the refresh margin", () => {
    expect(isBundleExpired(payload, 800_000)).toBe(false);
    expect(isBundleExpired(payload, 900_000)).toBe(true);
    expect(isBundleExpired(payload, 900_000, 60_000)).toBe(false);
  });
});
