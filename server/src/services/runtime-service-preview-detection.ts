import type {
  AdapterExecutionResult,
  AdapterRuntimeServiceReport,
} from "@armyofagents/adapter-utils";

const EXPLICIT_PREVIEW_URL_PATTERN =
  /\b(?:AOA_PREVIEW_URL|aoaPreviewUrl)\s*[:=]\s*(https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/[^\s\\"'<>)]*)?)/gi;
const EXPLICIT_PREVIEW_MARKER_PATTERN = /\b(?:AOA_PREVIEW_URL|aoaPreviewUrl)\s*[:=]/i;

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function normalizeOrigin(value: string): string | null {
  const url = parseUrl(value);
  return url ? url.origin.toLowerCase() : null;
}

function isLoopbackPreviewUrl(url: URL): boolean {
  const hostname = url.hostname.toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

export function extractLoopbackPreviewUrls(
  text: string,
  opts: { excludedOrigins: string[] },
): string[] {
  const excludedOrigins = new Set(
    opts.excludedOrigins
      .map(normalizeOrigin)
      .filter((origin): origin is string => Boolean(origin)),
  );
  const seen = new Set<string>();
  const urls: string[] = [];

  for (const match of text.matchAll(EXPLICIT_PREVIEW_URL_PATTERN)) {
    const rawUrl = match[1];
    if (!rawUrl) continue;
    const parsed = parseUrl(rawUrl);
    if (!parsed || !isLoopbackPreviewUrl(parsed)) continue;
    if (excludedOrigins.has(parsed.origin.toLowerCase())) continue;

    const normalized = parsed.toString();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    urls.push(normalized);
  }

  return urls;
}

export function containsExplicitPreviewUrlMarker(text: string): boolean {
  return EXPLICIT_PREVIEW_MARKER_PATTERN.test(text);
}

export function createLivePreviewDetectionScheduler(opts: {
  onDetect: (text: string, source: "stream") => Promise<unknown>;
  maxBufferChars?: number;
  minDetectionIntervalMs?: number;
  onError?: (err: unknown) => void;
}) {
  const maxBufferChars = opts.maxBufferChars ?? 64_000;
  const minDetectionIntervalMs = opts.minDetectionIntervalMs ?? 2_000;
  let buffer = "";
  let inFlight: Promise<void> = Promise.resolve();
  let lastScheduledAt = 0;

  const schedule = (text: string) => {
    lastScheduledAt = Date.now();
    inFlight = inFlight
      .catch(() => undefined)
      .then(() => opts.onDetect(text, "stream"))
      .then(() => undefined)
      .catch((err: unknown) => {
        opts.onError?.(err);
      });
  };

  return {
    observeChunk(chunk: string) {
      buffer = (buffer + chunk).slice(-maxBufferChars);
      const markerInChunk = containsExplicitPreviewUrlMarker(chunk);
      if (!markerInChunk && !containsExplicitPreviewUrlMarker(buffer)) return;
      const intervalElapsed = Date.now() - lastScheduledAt >= minDetectionIntervalMs;
      if (!markerInChunk && !intervalElapsed) return;
      schedule(buffer);
    },
    flush() {
      return inFlight;
    },
  };
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function buildPreviewDetectionText(input: {
  streamedText: string;
  adapterResult: AdapterExecutionResult;
}): string {
  const resultJson = input.adapterResult.resultJson ?? {};
  return [
    input.streamedText,
    input.adapterResult.summary,
    readNonEmptyString(resultJson.stdout),
    readNonEmptyString(resultJson.stderr),
    readNonEmptyString(resultJson.output),
    readNonEmptyString(resultJson.text),
    readNonEmptyString(resultJson.summary),
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n");
}

export async function probePreviewUrl(
  url: string,
  opts: { timeoutMs: number },
): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      redirect: "manual",
    });
    return response.status >= 200 && response.status < 400;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export async function detectPreviewRuntimeServiceReports(input: {
  text: string;
  cwd: string | null;
  excludedOrigins: string[];
  timeoutMs?: number;
}): Promise<AdapterRuntimeServiceReport[]> {
  const urls = extractLoopbackPreviewUrls(input.text, {
    excludedOrigins: input.excludedOrigins,
  });
  const reports: AdapterRuntimeServiceReport[] = [];

  for (const url of urls) {
    const healthy = await probePreviewUrl(url, { timeoutMs: input.timeoutMs ?? 1500 });
    if (!healthy) continue;

    const parsed = new URL(url);
    const port = parsed.port ? Number(parsed.port) : null;
    reports.push({
      serviceName: port ? `localhost:${port}` : parsed.hostname,
      status: "running",
      lifecycle: "ephemeral",
      scopeType: "execution_workspace",
      command: null,
      cwd: input.cwd,
      port,
      url,
      providerRef: null,
      stopPolicy: null,
      healthStatus: "healthy",
    });
  }

  return reports;
}

export function shouldDetectAoaAppPreviews(runtimeConfig: Record<string, unknown>): boolean {
  return runtimeConfig.aoaAppPreviews !== false;
}
