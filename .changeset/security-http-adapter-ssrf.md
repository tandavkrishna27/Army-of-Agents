---
"@armyofagents/server": patch
---

fix(security): close SSRF on the http adapter's execute and test-environment paths (C9). Lifts `isPrivateIP` and `validateAndResolveFetchUrl` from `plugin-host-services.ts` into a shared `outbound-url-guard.ts` so adapters and plugins use one source of truth. URLs are parsed, protocol-gated (http/https only), DNS-resolved with timeout, and rejected if any resolved address is in a private/reserved range (RFC 1918, loopback, link-local including 169.254.169.254 cloud metadata, IPv6 ULA/loopback, IPv4-mapped IPv6). Static-misconfig SSRF closed; full DNS-rebind defense (resolved-IP pinning) deferred to a follow-up that switches the adapter from `fetch()` to `https.request`/`undici` dispatcher.
