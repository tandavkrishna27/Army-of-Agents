export async function validateAndResolveFetchUrl(url: string) {
  const parsedUrl = new URL(url);
  return {
    parsedUrl,
    resolvedAddress: "93.184.216.34",
    hostHeader: parsedUrl.host,
    tlsServername: parsedUrl.hostname,
    useTls: parsedUrl.protocol === "https:",
  };
}

export async function executePinnedRequest(
  target: { parsedUrl: URL },
  init: RequestInit | undefined,
  signal: AbortSignal,
) {
  const response = await globalThis.fetch(target.parsedUrl.toString(), {
    ...init,
    signal,
  });
  return {
    status: response.status,
    statusText: response.statusText ?? "",
    headers:
      response.headers && typeof response.headers.entries === "function"
        ? Object.fromEntries(response.headers.entries())
        : {},
    body:
      typeof response.text === "function"
        ? await response.text()
        : "",
  };
}
