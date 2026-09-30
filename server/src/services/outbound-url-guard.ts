// server/src/services/outbound-url-guard.ts
//
// Shared SSRF defense for any outbound HTTP from AoA — used by both the plugin
// HTTP service and the http adapter. Centralized here to avoid divergence
// between the two call sites.
//
// See finding C9 in docs/superpowers/specs/2026-05-05-sprint-1-security-fixes-design.md.

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  request as httpRequest,
  type IncomingMessage,
  type RequestOptions as HttpRequestOptions,
} from "node:http";
import { request as httpsRequest } from "node:https";

/** Only these protocols are allowed for outbound HTTP requests. */
export const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/** Maximum time (ms) to wait for a DNS lookup before aborting. */
export const DNS_LOOKUP_TIMEOUT_MS = 5_000;

function parseIpv6Words(ip: string): number[] | null {
  const normalized = ip.toLowerCase().replace(/^\[|\]$/g, "").split("%", 1)[0]!;
  if (!normalized.includes(":")) return null;
  const halves = normalized.split("::");
  if (halves.length > 2) return null;

  const parseHalf = (value: string): number[] | null => {
    if (!value) return [];
    const words: number[] = [];
    for (const token of value.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(token)) return null;
      words.push(Number.parseInt(token, 16));
    }
    return words;
  };
  const left = parseHalf(halves[0] ?? "");
  const right = parseHalf(halves[1] ?? "");
  if (!left || !right) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  const omitted = 8 - left.length - right.length;
  if (omitted < 1) return null;
  return [...left, ...Array<number>(omitted).fill(0), ...right];
}

function mappedIpv4(words: readonly number[]): string | null {
  if (
    words.length !== 8 ||
    words.slice(0, 5).some((word) => word !== 0) ||
    words[5] !== 0xffff
  ) {
    return null;
  }
  return [
    words[6]! >> 8,
    words[6]! & 0xff,
    words[7]! >> 8,
    words[7]! & 0xff,
  ].join(".");
}

/**
 * Check if an IP address is in a private/reserved range (RFC 1918, loopback,
 * link-local, etc.) that outbound HTTP should never be able to reach.
 *
 * Handles IPv4-mapped IPv6 addresses (e.g. ::ffff:127.0.0.1) which Node's
 * dns.lookup may return depending on OS configuration.
 */
export function isPrivateIP(ip: string): boolean {
  const lower = ip.toLowerCase().replace(/^\[|\]$/g, "");

  // Unwrap IPv4-mapped IPv6 addresses (::ffff:x.x.x.x) and re-check as IPv4
  const v4MappedMatch = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4MappedMatch && v4MappedMatch[1]) return isPrivateIP(v4MappedMatch[1]);
  const ipv6Words = parseIpv6Words(lower);
  const canonicalMapped = ipv6Words ? mappedIpv4(ipv6Words) : null;
  if (canonicalMapped) return isPrivateIP(canonicalMapped);

  // IPv4 patterns
  const octets = ip.split(".").map(Number);
  if (
    octets.length === 4 &&
    octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
  ) {
    const [first, second, third] = octets as [number, number, number, number];
    if (first === 0) return true; // current network / unspecified
    if (first === 100 && second >= 64 && second <= 127) return true; // carrier-grade NAT
    if (first === 192 && second === 0 && third === 0) return true; // IETF protocol assignments
    if (first === 192 && second === 0 && third === 2) return true; // TEST-NET-1
    if (first === 192 && second === 88 && third === 99) return true; // deprecated 6to4 relay
    if (first === 198 && (second === 18 || second === 19)) return true; // benchmarking
    if (first === 198 && second === 51 && third === 100) return true; // TEST-NET-2
    if (first === 203 && second === 0 && third === 113) return true; // TEST-NET-3
    if (first >= 224) return true; // multicast and reserved
  }
  if (ip.startsWith("10.")) return true;
  if (ip.startsWith("172.")) {
    const second = parseInt(ip.split(".")[1]!, 10);
    if (second >= 16 && second <= 31) return true;
  }
  if (ip.startsWith("192.168.")) return true;
  if (ip.startsWith("127.")) return true;                   // loopback
  if (ip.startsWith("169.254.")) return true;               // link-local
  if (ip === "0.0.0.0") return true;

  // IPv6 special-use ranges. Compare parsed words so compressed and canonical
  // forms receive identical treatment.
  if (ipv6Words) {
    const [first, second, third, fourth] = ipv6Words;
    if (first === 0) return true; // unspecified, loopback, IPv4-compatible
    if ((first! & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
    if ((first! & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((first! & 0xffc0) === 0xfec0) return true; // fec0::/10 deprecated site-local
    if ((first! & 0xff00) === 0xff00) return true; // ff00::/8 multicast
    if (
      first === 0x0064 &&
      second === 0xff9b &&
      (third === 0 || third === 1)
    ) {
      return true; // NAT64 translation prefixes
    }
    if (
      first === 0x0100 &&
      second === 0 &&
      third === 0 &&
      fourth === 0
    ) {
      return true; // 100::/64 discard-only
    }
    if (
      first === 0x2001 &&
      (second === 0 ||
        second === 0x0002 ||
        (second! >= 0x0010 && second! <= 0x002f) ||
        second === 0x0db8)
    ) {
      return true; // Teredo/benchmark/ORCHID/documentation
    }
    if (first === 0x2002) return true; // 2002::/16 6to4
    if (first! >= 0x3ff0 && first! <= 0x3fff) return true; // 3fff::/20 docs
  }

  return false;
}

/**
 * Request-routing metadata returned by `validateAndResolveFetchUrl`. Callers
 * that want full DNS-rebind defense can use these fields to build a request
 * that connects to `resolvedAddress` directly (via `https.request` / undici
 * dispatcher) while preserving the original `hostHeader` and `tlsServername`
 * so the remote endpoint matches its TLS cert and Host-header routing.
 */
export interface ValidatedFetchTarget {
  parsedUrl: URL;
  resolvedAddress: string;
  hostHeader: string;
  tlsServername?: string;
  useTls: boolean;
}

/**
 * Validate a URL for outbound fetch: protocol whitelist + private IP blocking
 * + DNS-resolution timeout. Returns request-routing metadata that can be used
 * either with fetch (validation-only — DNS-rebind window remains) OR with
 * `https.request` / undici dispatcher to pin the resolved IP and close the
 * DNS-rebind window entirely.
 *
 * For the static-misconfig SSRF threat (e.g. `http://169.254.169.254/...`),
 * fetch + this validation is sufficient. For DNS-rebind defense, the caller
 * must additionally pin the resolved IP — see `buildPinnedRequestOptions`
 * in `plugin-host-services.ts` for an example.
 */
export async function validateAndResolveFetchUrl(urlString: string): Promise<ValidatedFetchTarget> {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new Error(`Invalid URL: ${urlString}`);
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(
      `Disallowed protocol "${parsed.protocol}" — only http: and https: are permitted`,
    );
  }

  // Strip any embedded basic-auth credentials. Forwarding `https://user:pass@host/`
  // creds to the pinned IP is a footgun: if a future caller accepts a URL field
  // from an authenticated user, those creds could leak to a private host post
  // DNS-rebind. Callers that legitimately need basic-auth should pass it via
  // explicit headers in `RequestInit`, not embedded in the URL.
  if (parsed.username || parsed.password) {
    parsed.username = "";
    parsed.password = "";
  }

  // Resolve the hostname to an IP and check for private ranges.
  // We pin the resolved IP into the URL to eliminate the TOCTOU window
  // between DNS resolution here and the second resolution fetch() would do.
  const originalHostname = parsed.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  const hostHeader = parsed.host; // includes port if non-default
  if (isIP(originalHostname) !== 0) {
    if (isPrivateIP(originalHostname)) {
      throw new Error(
        `All resolved IPs for ${originalHostname} are in private/reserved ranges`,
      );
    }
    return {
      parsedUrl: parsed,
      resolvedAddress: originalHostname,
      hostHeader,
      tlsServername: undefined,
      useTls: parsed.protocol === "https:",
    };
  }

  // Race the DNS lookup against a timeout to prevent indefinite hangs
  // when DNS is misconfigured or unresponsive.
  const dnsPromise = dnsLookup(originalHostname, { all: true });
  let timeoutHandle: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error(`DNS lookup timed out after ${DNS_LOOKUP_TIMEOUT_MS}ms for ${originalHostname}`)),
      DNS_LOOKUP_TIMEOUT_MS,
    );
  });

  try {
    const results = await Promise.race([dnsPromise, timeoutPromise]);
    if (results.length === 0) {
      throw new Error(`DNS resolution returned no results for ${originalHostname}`);
    }

    // Filter to only non-private IPs instead of rejecting the entire request
    // when some IPs are private. This handles multi-homed hosts that resolve
    // to both private and public addresses.
    const safeResults = results.filter((entry) => !isPrivateIP(entry.address));
    if (safeResults.length === 0) {
      throw new Error(
        `All resolved IPs for ${originalHostname} are in private/reserved ranges`,
      );
    }

    const resolved = safeResults[0]!;
    return {
      parsedUrl: parsed,
      resolvedAddress: resolved.address,
      hostHeader,
      tlsServername: parsed.protocol === "https:" && isIP(originalHostname) === 0
        ? originalHostname
        : undefined,
      useTls: parsed.protocol === "https:",
    };
  } catch (err) {
    // Re-throw our own errors; wrap DNS failures
    if (err instanceof Error && (
      err.message.startsWith("All resolved IPs") ||
      err.message.startsWith("DNS resolution returned") ||
      err.message.startsWith("DNS lookup timed out")
    )) throw err;
    throw new Error(`DNS resolution failed for ${originalHostname}: ${(err as Error).message}`);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

/**
 * Build IP-pinned `https.request` / `http.request` options for a previously
 * validated fetch target. Used by both the plugin HTTP service and the http
 * adapter to close the DNS-rebind window between `validateAndResolveFetchUrl`
 * and the actual outbound request: the request connects to `target.resolvedAddress`
 * directly while preserving the original Host header and TLS SNI so virtual-host
 * routing and certificate validation continue to work.
 *
 * Callers should not invoke this directly with an unvalidated URL — always go
 * through `validateAndResolveFetchUrl()` first to enforce the protocol whitelist
 * and private-IP block.
 */
export function buildPinnedRequestOptions(
  target: ValidatedFetchTarget,
  init?: RequestInit,
): { options: HttpRequestOptions & { servername?: string }; body: string | Buffer | undefined } {
  const headers = new Headers(init?.headers);
  const method = init?.method ?? "GET";

  const rawBody = init?.body;
  let body: string | Buffer | undefined;
  if (rawBody === undefined || rawBody === null) {
    body = undefined;
  } else if (typeof rawBody === "string") {
    body = rawBody;
  } else if (Buffer.isBuffer(rawBody)) {
    body = rawBody;
  } else if (rawBody instanceof Uint8Array) {
    body = Buffer.from(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength);
  } else {
    // RequestInit.body also covers Blob / ReadableStream / FormData / URLSearchParams.
    // None are exercised by current callers; reject explicitly so a future caller
    // doesn't get silent String(...) corruption like the previous implementation.
    throw new TypeError(
      `Unsupported body type for pinned request: ${Object.prototype.toString.call(rawBody)}`,
    );
  }

  headers.set("Host", target.hostHeader);
  if (body !== undefined && !headers.has("content-length") && !headers.has("transfer-encoding")) {
    headers.set("content-length", String(Buffer.byteLength(body)));
  }

  const pathname = `${target.parsedUrl.pathname}${target.parsedUrl.search}`;

  // Belt-and-suspenders: never forward URL-embedded credentials to the pinned
  // request. `validateAndResolveFetchUrl` already strips creds from `parsedUrl`,
  // but we deliberately do not derive an `auth` field here even if a caller
  // somehow constructs a `ValidatedFetchTarget` with creds bypassing that path.
  return {
    options: {
      protocol: target.parsedUrl.protocol,
      host: target.resolvedAddress,
      port: target.parsedUrl.port
        ? Number(target.parsedUrl.port)
        : target.useTls
          ? 443
          : 80,
      path: pathname,
      method,
      headers: Object.fromEntries(headers.entries()),
      servername: target.tlsServername,
    },
    body,
  };
}

/**
 * Executes an HTTP request with the resolved IP pinned (closes the DNS-rebind
 * window between validation and request). Returns the response status, headers,
 * and a small body sample.
 *
 * Use this from any caller that has a `ValidatedFetchTarget` from
 * `validateAndResolveFetchUrl()`. The plugin host wraps this with a heavier
 * 200MB body-capture variant; adapters use this directly because they only
 * need fire-and-check-status.
 *
 * The body is read up to `maxBodyBytes` (default 1 MiB) so error responses
 * are diagnosable but oversized successful responses don't OOM the server.
 */
export interface PinnedResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * Thrown by `executePinnedRequest` when the response body exceeds the configured
 * `maxBodyBytes` cap. Tagged so callers (e.g. plugin host with its 200 MB cap)
 * can programmatically distinguish "response too big" from a transport error
 * and surface a more specific message to plugins.
 */
export class PinnedRequestBodyCapError extends Error {
  readonly capBytes: number;
  constructor(capBytes: number) {
    super(`Response body exceeded ${capBytes} bytes`);
    this.name = "PinnedRequestBodyCapError";
    this.capBytes = capBytes;
  }
}

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024; // 1 MiB

export async function executePinnedRequest(
  target: ValidatedFetchTarget,
  init: RequestInit | undefined,
  signal: AbortSignal,
  options?: { maxBodyBytes?: number },
): Promise<PinnedResponse> {
  const { options: reqOptions, body } = buildPinnedRequestOptions(target, init);
  const maxBodyBytes = options?.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const requestFn = target.useTls ? httpsRequest : httpRequest;
    const req = requestFn({ ...reqOptions, signal }, resolve);
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  await new Promise<void>((resolve, reject) => {
    response.on("data", (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buf.length;
      if (totalBytes > maxBodyBytes) {
        chunks.length = 0;
        response.destroy(new PinnedRequestBodyCapError(maxBodyBytes));
        return;
      }
      chunks.push(buf);
    });
    response.on("end", resolve);
    response.on("error", reject);
  });

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(response.headers)) {
    if (Array.isArray(value)) headers[key] = value.join(", ");
    else if (value !== undefined) headers[key] = value;
  }

  return {
    status: response.statusCode ?? 500,
    statusText: response.statusMessage ?? "",
    headers,
    body: Buffer.concat(chunks).toString("utf8"),
  };
}
