---
"@armyofagents/server": patch
---

Auth + logging hardening:
- Better-auth fails closed at startup if `BETTER_AUTH_SECRET` is unset in `authenticated` or `cloud_auth` deployments. The dev fallback is preserved only for `local_trusted` mode and emits a startup WARN.
- Error-handler and request logger now redact sensitive body/query/params fields (`password`, `pat`, `secret`, `token`, `apiKey`, etc.) before serialising to logs. Recursion depth and array length are bounded to prevent log-pump DoS.
