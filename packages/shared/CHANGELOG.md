# @armyofagents/shared

## 1.0.1

### Patch Changes

- 40688fc: fix(security): close cross-tenant IDOR on /approvals/:id/approve|reject|request-revision (C3) and remove the spoofable `decidedByUserId` body field (C4). Decider is now derived from `req.actor.userId` server-side; CLI no longer accepts `--decided-by-user-id`.
- 40688fc: Cloud-readiness hardening:
  - New `AOA_TRUST_PROXY` env var lets operators opt into Express's `trust proxy` setting (boolean / hop count / CIDR list). Required for cloud deploys behind Cloudflare/ALB/nginx — without it, IP-keyed rate limits from PR #156 collapse to one shared bucket.
  - `/api/companies/import` and `/api/companies/import/preview` capped at 20MB body size (was unbounded by the global default's 100KB, which already silently 413'd legitimate bundles).
  - Zod array length caps on the portability schema prevent CPU-bound validation on inflated payloads (10M issues → ~500MB Zod walk).
- 40688fc: Marketplace plugin install now verifies the package's integrity hash against the catalog when the catalog declares `npm.integrity` (e.g. `sha512-...`). Mismatches fail-closed with `IntegrityMismatchError` showing both expected and actual hashes. Catalog items without `integrity` install as before but emit a one-line WARN that integrity is unverified — backward-compat preserved.

  Threat model: defends against compromised npm registry mirrors / MITM CDN attacks where the tarball npm pulls doesn't match what the AoA marketplace published.

- 40688fc: fix(security): require founder role to set workspace shell commands (provision/teardown/cleanup) on projects, and reject agent/MCP actors entirely. Validator tightened to a strict Zod schema. Closes C1 (RCE via executionWorkspacePolicy.provisionCommand).
- 40688fc: ci: SHA-pin all GitHub Actions, add Dependabot for weekly updates, add `permissions: contents: read` to pr.yml and release-smoke.yml. Closes the moving-tag supply-chain attack vector (C16). Marketplace `pluginUpdatePolicy` now defaults to `notify_all` to close the auto-update mass-exploit vector pending full integrity verification (C11 step 1).

## 0.2.7

### Patch Changes

- Version bump (patch)

## 0.2.6

### Patch Changes

- Version bump (patch)

## 0.2.5

### Patch Changes

- Version bump (patch)

## 0.2.4

### Patch Changes

- Version bump (patch)

## 0.2.3

### Patch Changes

- Version bump (patch)

## 0.2.2

### Patch Changes

- Version bump (patch)

## 0.2.1

### Patch Changes

- Version bump (patch)
