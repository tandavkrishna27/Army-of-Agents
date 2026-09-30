export type PreviewAccess = "local" | "company" | "external";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function isExactLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

export function buildRuntimeServicePreviewUrl(serviceId: string): string {
  return `/preview/services/${encodeURIComponent(serviceId)}/`;
}

export function isAllowedPreviewUpstream(rawUrl: string | null | undefined): boolean {
  if (!rawUrl) return false;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    if (parsed.username || parsed.password) return false;
    return isExactLoopbackHost(parsed.hostname);
  } catch {
    return false;
  }
}

export function classifyRuntimeServiceTarget(rawUrl: string | null | undefined): {
  access: PreviewAccess | null;
  localTargetUrl: string | null;
} {
  if (!rawUrl || !isAllowedPreviewUpstream(rawUrl)) {
    return { access: null, localTargetUrl: null };
  }
  return { access: "local", localTargetUrl: new URL(rawUrl).href };
}
