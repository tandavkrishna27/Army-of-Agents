import { describe, expect, it, vi } from "vitest";
import { probeProviderApiKey } from "../services/provider-api-key-probe.js";

function response(status: number, headers: Record<string, string> = {}): Response {
  return new Response("", { status, headers });
}

describe("provider API-key probe", () => {
  it.each([
    [401, "invalid_key", false],
    [403, "insufficient_scope", false],
    [402, "billing_or_quota", false],
    [429, "rate_limited", true],
    [503, "provider_error", true],
  ] as const)("classifies HTTP %s as %s", async (status, code, transient) => {
    const result = await probeProviderApiKey("openai", "secret", {
      fetchFn: vi.fn(async () => response(status, { "retry-after": "9" })) as never,
    });
    expect(result).toMatchObject({ ok: false, code, transient });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("uses provider-specific authentication headers without putting the key in the URL", async () => {
    const fetchFn = vi.fn(async () => response(200));
    await expect(
      probeProviderApiKey("anthropic", "sk-ant-secret", { fetchFn: fetchFn as never }),
    ).resolves.toEqual({ ok: true });
    expect(fetchFn.mock.calls[0]?.[0]).toBe("https://api.anthropic.com/v1/models");
    expect((fetchFn.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({
      "x-api-key": "sk-ant-secret",
    });
  });

  it("distinguishes TLS failures from general network failures", async () => {
    const tls = await probeProviderApiKey("openai", "secret", {
      fetchFn: vi.fn(async () => {
        throw new Error("self signed certificate");
      }) as never,
    });
    const network = await probeProviderApiKey("openai", "secret", {
      fetchFn: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }) as never,
    });
    expect(tls).toMatchObject({ ok: false, code: "tls_or_proxy" });
    expect(network).toMatchObject({ ok: false, code: "network" });
  });
});
