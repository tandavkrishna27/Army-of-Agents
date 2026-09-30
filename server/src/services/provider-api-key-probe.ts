import { randomUUID } from "node:crypto";

export type ProviderProbeFailure =
  | "invalid_key"
  | "insufficient_scope"
  | "billing_or_quota"
  | "rate_limited"
  | "network"
  | "tls_or_proxy"
  | "provider_error"
  | "unknown";

export type ProviderApiKeyProbe =
  | { ok: true }
  | {
      ok: false;
      code: ProviderProbeFailure;
      summary: string;
      remediation: string;
      transient: boolean;
      retryAfter: string | null;
      supportId: string;
    };

type FetchLike = typeof fetch;

function failure(
  code: ProviderProbeFailure,
  summary: string,
  remediation: string,
  transient: boolean,
  retryAfter: string | null = null,
): ProviderApiKeyProbe {
  return { ok: false, code, summary, remediation, transient, retryAfter, supportId: randomUUID() };
}

export async function probeProviderApiKey(
  provider: "openai" | "anthropic",
  apiKey: string,
  options: { fetchFn?: FetchLike; timeoutMs?: number } = {},
): Promise<ProviderApiKeyProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 12_000);
  timer.unref?.();
  const url =
    provider === "openai" ? "https://api.openai.com/v1/models" : "https://api.anthropic.com/v1/models";
  const headers: Record<string, string> =
    provider === "openai"
      ? { Authorization: `Bearer ${apiKey}` }
      : { "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
  try {
    const response = await (options.fetchFn ?? fetch)(url, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    if (response.ok) return { ok: true };
    const retryAfter = response.headers.get("retry-after");
    if (response.status === 401)
      return failure("invalid_key", "The provider rejected this API key.", "Check the key and paste it again.", false);
    if (response.status === 403)
      return failure(
        "insufficient_scope",
        "The API key does not have permission for this provider.",
        "Use a key with model access for this project or organization.",
        false,
      );
    if (response.status === 402)
      return failure(
        "billing_or_quota",
        "Provider billing or quota is not available for this key.",
        "Review the provider account's billing and usage limits.",
        false,
      );
    if (response.status === 429)
      return failure(
        "rate_limited",
        "The provider rate-limited key verification.",
        "Wait for the indicated retry period, then verify again.",
        true,
        retryAfter,
      );
    if (response.status >= 500)
      return failure(
        "provider_error",
        "The provider could not verify the key right now.",
        "Retry later; the existing active key has not been changed.",
        true,
        retryAfter,
      );
    return failure(
      "unknown",
      `The provider returned HTTP ${response.status} while verifying the key.`,
      "Check provider access and try again.",
      false,
    );
  } catch (error) {
    const message = error instanceof Error ? `${error.name} ${error.message}` : "";
    if (/cert|tls|ssl|self[- ]signed|unable to verify/i.test(message)) {
      return failure(
        "tls_or_proxy",
        "TLS or proxy configuration blocked provider verification.",
        "Check the server CA bundle, HTTPS proxy, and outbound TLS inspection.",
        true,
      );
    }
    return failure(
      "network",
      "AOA could not reach the provider to verify this key.",
      "Check DNS, firewall, proxy, and outbound HTTPS access from the AOA server.",
      true,
    );
  } finally {
    clearTimeout(timer);
  }
}
