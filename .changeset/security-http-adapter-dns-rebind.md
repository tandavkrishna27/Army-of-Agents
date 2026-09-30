---
"@armyofagents/server": patch
---

fix(security): close the DNS-rebind window on the http adapter (deferred follow-up from PR #137 / C9). PR #137's `validateAndResolveFetchUrl` validated the URL → resolved DNS → rejected private IPs, but then `fetch(url, ...)` re-resolved DNS, so an attacker controlling authoritative DNS could answer with a public IP during validation and a private IP during the actual request. Now the adapter switches from `fetch()` to `executePinnedRequest()` (lifted from `plugin-host-services.ts` into the shared `outbound-url-guard.ts`) which uses `https.request`/`http.request` with the resolved IP pinned while preserving Host header + TLS SNI. Same pattern the plugin host already uses for outbound HTTP. Both `adapters/http/execute.ts` and `adapters/http/test.ts` updated.
