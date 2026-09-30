# AOA Multi-Tenant Cloud — Master Scope & Plan Index

> **Status:** Master scope LOCKED 2026-07-29. Per-phase plans written + cross-phase reconciled. Pre `/plan-eng-review`.
> **Branch:** `claude/multitenant-cloud` (off `origin/main`). **Delivery:** ALL phases → ONE branch → ONE PR (QA-server deploy testing).
> **Do NOT** merge/expand PR #310. **Do NOT** touch the `v2.5` main checkout's user-owned changes.

**Goal:** Turn AoA into a multi-tenant cloud control plane — an **Organization** (tenant) that owns one or more **Companies**, with provider auth configured once and inherited by Commander/Crew/org/future agents — targeting an invite-only, network-private controlled beta on Hetzner, while preserving self-hosted single-tenant.

**Architecture:** Pooled control plane (one Postgres, `organization_id` on every tenant-owned row, central scoping + RLS defense-in-depth via a flag-gated canary now / full-fleet later) + a pluggable execution plane (self-hosted gVisor pool for business-key tenants; dedicated owner-controlled targets for personal-subscription tenants; E2B kept pluggable). A single provider-resolution service (strangler over the existing systems) reconciles today's three credential mechanisms behind an Organization→Company→agent assignment policy.

---

## Locked decisions (ADR summary)

| # | Decision | Rationale |
|---|---|---|
| D1 | Tenant = **Organization** above Company (`organization_id` FK in DB, "Organization" in UI; Company unchanged; onboarding "company" step renamed to "Company") | Consolidated billing/membership/isolation |
| D2 | Launch = **invite-only, network-private beta**; add a distinct **`cloud_auth`** deployment mode | Semi-trusted → gVisor, not micro-VMs; clean hosted on/off switch |
| D3 | Naming **Organization ▸ Company** | Avoids `workspace`/`org` code collisions |
| D4 | Global Google identity; membership per-Org; **operator ≠ owner**; remove global first-user→admin in `cloud_auth` | Public-safe ownership |
| D5 | Business key/gateway shareable (already inherits); **personal sub owner-only + dedicated target**; human-sharing deferred | Vendor ToS |
| D6 | Billing: **BYO for beta**, AoA-managed pass-through later | Zero financial exposure |
| D7 | Execution: **self-hosted gVisor on Hetzner**, pluggable (E2B now, desktop later — Tauri **dropped**) | Free, semi-trusted-adequate; gVisor needs no nested-virt |
| D8 | Operator/support = **break-glass, time-boxed, audited** | No standing cross-tenant access. ⚠ Partial: library + live-TTL check (`hasActiveBreakGlass`, REST-only) + sweeper wired; `grant`/`revoke` have no runtime trigger yet (no route/CLI/MCP tool) and can't be invoked through a running server — operator-console wiring deferred |
| D9 | Quotas = **light: per-Org concurrency cap + existing controls + spend visibility** | Noisy-neighbor + platform-cost protection |
| D10 | **S1 fix** (topology-gated host-login fallback) rides with #310's merge | Preserves solo UX + hosted fail-closed |
| D11 | RLS: app-layer + `organization_id` columns + one canary for beta; **full-fleet RLS = later follow-up** | Ship fast; no backfill later |
| D12 | Credentials: **strangler** (new model is source of truth, old path fallback via dual-write; legacy cleanup = later follow-up) | Safe on the trickiest security code |
| D13 | Enterprise-gateway token = per-connection `config.tokenEnvVar` (default `ANTHROPIC_AUTH_TOKEN`); multi-tenant rejected assignment **throws fail-closed** (no host fallback) | Gateway compat; hard "fail-closed, no ambient host login" constraint |
| D14 | **One branch / one PR + reversibility safety** (compensating migration + snapshot gate + resolver kill-switch + `deploymentMode` flags); clean phase-scoped commits | Honors the QA-deploy-together goal; closes the one-way-door rollback gap without splitting |
| D15 | Provider auth methods first-class = **`api_key` + `personal_subscription` + `enterprise_gateway`**; **defer bedrock/vertex** to ambient passthrough | Beta needs the first three; bedrock/vertex work as ambient env, fold in post-beta |

### Eng-review structural fixes (applied 2026-07-29)
`/plan-eng-review` (4-lens: architecture/migration/security/tests) found 6 blockers + ~10 majors — the plan's bones were sound but it did not fail closed as written. Applied: force `isInstanceAdmin=false` in `cloud_auth` at one auth-middleware chokepoint (collapses ~20 bypass sites); derive gate `enforced` from static `deploymentMode` (fail-closed when middleware absent); break-glass resolved via `hasActiveGrant` at check-time + sweeper; codemod widened to `server/src` (incl. `mcp/server.ts`) + `no-floating-promises` gate; P3 collapsed to a single `0189` (+ contiguous-journal CI gate); P4→P5 credential hint wired; `org_default` org-id predicate; P5 control-plane seed idempotent + worker-heartbeat org-scoped + egress firewall as a hard worker-image deliverable; bedrock/vertex cut.

### Reversibility follow-ups (tracked)
Forward-compensating migration (guarded `assert count(organizations)=1`); automated pre-migration snapshot gate; resolver kill-switch `AOA_PROVIDER_RESOLVER=legacy`; per-table `organization_id` FKs on `provider_connections`/`execution_targets`; full-fleet RLS; threading the dispatching user into agent-run owner-only; legacy credential-path cleanup.

## Phase index (all land on this one branch, in order)

| Phase | Deliverable | Plan doc | Migration |
|---|---|---|---|
| **P1** | `organizations` + memberships + invitations; `organization_id` on companies; backfill; coupled index re-scopes | [phase1-tenant-schema](2026-07-29-aoa-mt-phase1-tenant-schema.md) | **0188** |
| **P2** | Signup→Org journey; Org roles; operator/first-user separation; `cloud_auth`; company-step rename | [phase2-signup-roles-operator](2026-07-29-aoa-mt-phase2-signup-roles-operator.md) | none |
| **P3** | Tenant context; 531-site tenant gate; instance_admin bypass removal; break-glass; RLS canary; **delete/archive founder-gate (commit #1)** | [phase3-authz-isolation](2026-07-29-aoa-mt-phase3-authz-isolation.md) | **0189** |
| **P4** | `provider_connections` + `provider_assignments` + unified strangler resolver | [phase4-provider-connections](2026-07-29-aoa-mt-phase4-provider-connections.md) | **0190** |
| **P5** | `execution_targets` + gVisor provider (+ SSRF `--add-host` fix) + route-by-credential + per-Org cap | [phase5-execution-gvisor](2026-07-29-aoa-mt-phase5-execution-gvisor.md) | **0191/0192** |
| **T&V** | **Test & Verification** — Gate A (local, inside-out) + Gate B (post-deploy QA on `testing.armyofagents.org`) | [phase6-test-and-verification](2026-07-29-aoa-mt-phase6-test-and-verification.md) | cross-cutting |
| Pre-fix | S1 topology-gated host-login fallback (delete/archive fix moved to P3 Task 1) | — | (rides #310 merge) |
| P6 | Plugin trust model | — | **deferred (post-beta)** |
| P7 | Tauri desktop connector | — | **dropped** |

**Migration order is load-bearing:** generate strictly P1→P3→P4→P5 (drizzle-kit auto-numbers; out-of-order generation would collide on `0188`). P2 generates none (consumes P1's schema).

## Relationship to PR #310
PR #310 stays focused and unmerged (CI billing-blocked, not failing). This program branches off `origin/main` (no #310). When #310 lands on main, merge main in, reconcile the provider layer, and apply the S1 fix (a fix to code #310 introduces). P4 flags the `subscription_commander_only`→resolver `owner_only` merge seam.

## Cross-phase reconciliation (applied 2026-07-29)
5 blockers + 6 major + 5 minor resolved: `organization_memberships`/`organizations.ts`/`ORGANIZATION_ROLES`/`cloud_auth` single-owned by P1 (P2 consumes); P3 keyed on `user_id` (not principal_type); P3 owns `company_secrets.organization_id`; P4 routes `await` the async `assertCompanyAccess`; P4↔P5 heartbeat region is P4-first + a normalized `{credentialKind, executionTargetSlug}` seam; create-handler final-owned by P3; `createCompanySchema.organizationId` optional; company-step rename owned by P2; migration numbers sequenced; the two P4 forks resolved (D13). Remaining stubs to fill at execution: P4 backfill body, P3 canary seed, P5 boot-seed site.

## Test matrix (high-level)
Signup/Org lifecycle (no global admin; invite join; multi-Org membership; backfill) · authorization matrix (every actor × action) · cross-tenant isolation negative tests · provider-assignment precedence · personal-subscription safety · worker isolation (gVisor flags, egress, cleanup) · backward-compat (self-hosted single-tenant; Windows/mac/Linux). Windows CI skips `*.integration.test.ts` + e2e — cross-platform-safe coverage planned per phase.

## Next steps
`/plan-eng-review` → `/plan-ceo-review` → code-reviewer pass over the plan set → founder go → implement subagent-driven (P1 first, one branch).
