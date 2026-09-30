---
"@armyofagents/server": patch
"@armyofagents/shared": patch
---

ci: SHA-pin all GitHub Actions, add Dependabot for weekly updates, add `permissions: contents: read` to pr.yml and release-smoke.yml. Closes the moving-tag supply-chain attack vector (C16). Marketplace `pluginUpdatePolicy` now defaults to `notify_all` to close the auto-update mass-exploit vector pending full integrity verification (C11 step 1).
