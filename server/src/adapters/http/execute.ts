import type { AdapterExecutionContext, AdapterExecutionResult } from "../types.js";
import { asString, asNumber, parseObject } from "../utils.js";
import { validateAndResolveFetchUrl, executePinnedRequest } from "../../services/outbound-url-guard.js";

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { config, runId, agent, context } = ctx;
  const url = asString(config.url, "");
  if (!url) throw new Error("HTTP adapter missing url");

  // SSRF guard: parse + protocol whitelist + DNS resolution + private IP rejection.
  // The resolved target is then PINNED into the request below — this closes the
  // DNS-rebind window where an attacker could flip DNS between validation and fetch.
  const target = await validateAndResolveFetchUrl(url);

  const method = asString(config.method, "POST");
  const timeoutMs = asNumber(config.timeoutMs, 0);
  const headers = parseObject(config.headers) as Record<string, string>;
  const payloadTemplate = parseObject(config.payloadTemplate);
  const body = { ...payloadTemplate, agentId: agent.id, runId, context };

  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const res = await executePinnedRequest(
      target,
      {
        method,
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      },
      controller.signal,
    );

    if (res.status < 200 || res.status >= 300) {
      throw new Error(`HTTP invoke failed with status ${res.status}`);
    }

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: `HTTP ${method} ${url}`,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
