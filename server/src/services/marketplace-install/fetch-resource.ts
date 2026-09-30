import type { CatalogItem } from "@armyofagents/shared";
import {
  executePinnedRequest,
  validateAndResolveFetchUrl,
} from "../outbound-url-guard.js";

export const FETCH_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
const MAX_RESOURCE_BYTES = 8 * 1024 * 1024;
const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/i;

export class MarketplaceResourceFetchError extends Error {
  constructor(
    message: string,
    readonly code:
      | "missing_url"
      | "unsafe_url"
      | "redirect_limit"
      | "http_error"
      | "transport_error",
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

function assertMarketplaceResourceUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch (cause) {
    throw new MarketplaceResourceFetchError(
      "Marketplace resource URL is invalid",
      "unsafe_url",
      undefined,
      { cause },
    );
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password
  ) {
    throw new MarketplaceResourceFetchError(
      "Marketplace resources require credential-free HTTPS URLs",
      "unsafe_url",
    );
  }

  const host = parsed.hostname.toLowerCase();
  const parts = parsed.pathname.split("/").filter(Boolean);
  const rawGitHubPinned =
    host === "raw.githubusercontent.com" &&
    parts.length >= 4 &&
    FULL_COMMIT_SHA.test(parts[2]!);
  const githubPinned =
    host === "github.com" &&
    parts.length >= 5 &&
    parts[2] === "raw" &&
    FULL_COMMIT_SHA.test(parts[3]!);
  const marketplaceCdn =
    host === "meteoritelabs.github.io" &&
    parsed.pathname.startsWith("/aoa-marketplace-cdn/");

  if (!rawGitHubPinned && !githubPinned && !marketplaceCdn) {
    throw new MarketplaceResourceFetchError(
      "Marketplace resource URL is outside the pinned marketplace allowlist",
      "unsafe_url",
    );
  }
  return parsed;
}

/**
 * Fetch a marketplace catalog resource through the shared DNS/IP guard and an
 * IP-pinned request. Redirects are manual and every hop is revalidated.
 */
export async function fetchCatalogResource(
  item: CatalogItem,
  kind: string,
  signal?: AbortSignal,
): Promise<string> {
  if (!item.resourceUrl) {
    throw new MarketplaceResourceFetchError(
      `${kind}: catalog item has no resourceUrl`,
      "missing_url",
    );
  }
  return fetchCatalogResourceUrl(item.resourceUrl, kind, signal);
}

export async function fetchCatalogResourceUrl(
  url: string,
  kind: string,
  signal?: AbortSignal,
): Promise<string> {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const combinedSignal = signal
    ? AbortSignal.any([timeout, signal])
    : timeout;
  let current = assertMarketplaceResourceUrl(url);

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    try {
      const target = await validateAndResolveFetchUrl(current.toString());
      const response = await executePinnedRequest(
        target,
        { method: "GET", redirect: "manual" },
        combinedSignal,
        { maxBodyBytes: MAX_RESOURCE_BYTES },
      );

      if (
        response.status >= 300 &&
        response.status < 400 &&
        response.headers.location
      ) {
        if (redirects === MAX_REDIRECTS) {
          throw new MarketplaceResourceFetchError(
            `Failed to fetch ${kind}: redirect limit exceeded`,
            "redirect_limit",
            response.status,
          );
        }
        current = assertMarketplaceResourceUrl(
          new URL(response.headers.location, current).toString(),
        );
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        throw new MarketplaceResourceFetchError(
          `Failed to fetch ${kind}: HTTP ${response.status}`,
          "http_error",
          response.status,
        );
      }
      return response.body;
    } catch (cause) {
      if (cause instanceof MarketplaceResourceFetchError) throw cause;
      throw new MarketplaceResourceFetchError(
        `Failed to fetch ${kind}`,
        "transport_error",
        undefined,
        { cause },
      );
    }
  }

  throw new MarketplaceResourceFetchError(
    `Failed to fetch ${kind}: redirect limit exceeded`,
    "redirect_limit",
  );
}

export async function loadSkillContent(
  item: CatalogItem,
  signal?: AbortSignal,
): Promise<string> {
  if (item.content?.inline) return item.content.inline;
  return fetchCatalogResource(item, "skill content", signal);
}
