---
"@armyofagents/server": patch
---

Defense-in-depth nits on the DNS-rebind guard:
- `validateAndResolveFetchUrl` now strips embedded credentials from the URL — basic-auth in URLs (`https://user:pass@host/`) is no longer forwarded to the pinned request, preventing credential leakage if a future caller accepts a URL from an authenticated user.
- Body-cap exceeded now throws a tagged `PinnedRequestBodyCapError` (with `capBytes`) so callers can distinguish from transport errors.
