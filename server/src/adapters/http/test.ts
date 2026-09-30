import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "../types.js";
import { asString, parseObject } from "../utils.js";
import { validateAndResolveFetchUrl, executePinnedRequest, type ValidatedFetchTarget } from "../../services/outbound-url-guard.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function normalizeMethod(input: string): string {
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed.toUpperCase() : "POST";
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const urlValue = asString(config.url, "");
  const method = normalizeMethod(asString(config.method, "POST"));

  if (!urlValue) {
    checks.push({
      code: "http_url_missing",
      level: "error",
      message: "HTTP adapter requires a URL.",
      hint: "Set adapterConfig.url to an absolute http(s) endpoint.",
    });
    return {
      adapterType: ctx.adapterType,
      status: summarizeStatus(checks),
      checks,
      testedAt: new Date().toISOString(),
    };
  }

  let url: URL | null = null;
  try {
    url = new URL(urlValue);
  } catch {
    checks.push({
      code: "http_url_invalid",
      level: "error",
      message: `Invalid URL: ${urlValue}`,
    });
  }

  if (url && url.protocol !== "http:" && url.protocol !== "https:") {
    checks.push({
      code: "http_url_protocol_invalid",
      level: "error",
      message: `Unsupported URL protocol: ${url.protocol}`,
      hint: "Use an http:// or https:// endpoint.",
    });
  }

  if (url) {
    checks.push({
      code: "http_url_valid",
      level: "info",
      message: `Configured endpoint: ${url.toString()}`,
    });
  }

  checks.push({
    code: "http_method_configured",
    level: "info",
    message: `Configured method: ${method}`,
  });

  if (url && (url.protocol === "http:" || url.protocol === "https:")) {
    // SSRF guard: validate the URL resolves to a non-private IP before probing.
    // Capture the validated target so the HEAD probe below can pin the resolved
    // IP and close the DNS-rebind window between validation and probe.
    let validatedTarget: ValidatedFetchTarget | null = null;
    try {
      validatedTarget = await validateAndResolveFetchUrl(url.toString());
      checks.push({
        code: "http_url_ssrf_safe",
        level: "info",
        message: "URL resolves to a public IP and uses an allowed protocol.",
      });
    } catch (err) {
      checks.push({
        code: "http_url_ssrf_unsafe",
        level: "error",
        message: err instanceof Error ? err.message : "URL failed SSRF validation",
        hint: "URL must resolve to a non-private IP and use http:// or https://.",
      });
    }

    if (validatedTarget) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      try {
        const response = await executePinnedRequest(
          validatedTarget,
          { method: "HEAD" },
          controller.signal,
        );
        const ok = response.status >= 200 && response.status < 300;
        if (!ok && response.status !== 405 && response.status !== 501) {
          checks.push({
            code: "http_endpoint_probe_unexpected_status",
            level: "warn",
            message: `Endpoint probe returned HTTP ${response.status}.`,
            hint: "Verify the endpoint is reachable from the Paperclip server host.",
          });
        } else {
          checks.push({
            code: "http_endpoint_probe_ok",
            level: "info",
            message: "Endpoint responded to a HEAD probe.",
          });
        }
      } catch (err) {
        checks.push({
          code: "http_endpoint_probe_failed",
          level: "warn",
          message: err instanceof Error ? err.message : "Endpoint probe failed",
          hint: "This may be expected in restricted networks; verify connectivity when invoking runs.",
        });
      } finally {
        clearTimeout(timeout);
      }
    }
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
