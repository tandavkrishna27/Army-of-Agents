---
"@armyofagents/server": patch
---

Gate the URL/GitHub import paths in company-portability and company-skills services through the shared `validateAndResolveFetchUrl` + `executePinnedRequest` SSRF guard. Closes the link-local / RFC-1918 / file:// vectors that were reachable via `POST /companies/import/preview`, `POST /companies/import`, and skill-install URL/GitHub flows.
