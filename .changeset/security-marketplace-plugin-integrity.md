---
"@armyofagents/shared": patch
"@armyofagents/server": patch
---

Marketplace plugin install now verifies the package's integrity hash against the catalog when the catalog declares `npm.integrity` (e.g. `sha512-...`). Mismatches fail-closed with `IntegrityMismatchError` showing both expected and actual hashes. Catalog items without `integrity` install as before but emit a one-line WARN that integrity is unverified — backward-compat preserved.

Threat model: defends against compromised npm registry mirrors / MITM CDN attacks where the tarball npm pulls doesn't match what the AoA marketplace published.
