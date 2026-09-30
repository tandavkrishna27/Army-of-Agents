---
"@armyofagents/server": patch
"@armyofagents/shared": patch
---

Cloud-readiness hardening:
- New `AOA_TRUST_PROXY` env var lets operators opt into Express's `trust proxy` setting (boolean / hop count / CIDR list). Required for cloud deploys behind Cloudflare/ALB/nginx — without it, IP-keyed rate limits from PR #156 collapse to one shared bucket.
- `/api/companies/import` and `/api/companies/import/preview` capped at 20MB body size (was unbounded by the global default's 100KB, which already silently 413'd legitimate bundles).
- Zod array length caps on the portability schema prevent CPU-bound validation on inflated payloads (10M issues → ~500MB Zod walk).
