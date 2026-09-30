import type { Request } from "express";
import type { Db } from "@armyofagents/db";
import { forbidden, unauthorized } from "../errors.js";
import { assertTenantMembership, resolveCompanyTenant } from "./authz-tenant.js";
import { tenantIsolationEnforced } from "../config/deployment-mode.js";
import { hasActiveBreakGlass } from "../services/operator-break-glass.js";

export function assertBoard(req: Request) {
  // R9a: an unauthenticated request gets 401 (not the 403 below), mirroring
  // assertCompanyAccess. Routes that ran assertCompanyAccess first purely to
  // surface 401-for-`none` (e.g. cockpit.ts) no longer need that ordering.
  if (req.actor.type === "none") {
    throw unauthorized();
  }
  if (req.actor.type !== "board") {
    throw forbidden("Board access required");
  }
}

/**
 * Assert the actor may access the given company. ASYNC + FAIL-CLOSED (Phase 3).
 *
 * Enforcement derives from the STATIC deployment mode via
 * `tenantIsolationEnforced()` — NOT `req.tenant?.enforced`. Reading the mutable
 * per-request tenant hint would fail OPEN whenever the tenant-context middleware
 * was skipped (e.g. a route mounted before it, or a future refactor). Closing
 * over the static primitive means a handler reached without that middleware still
 * fails CLOSED in cloud_auth.
 *
 * cloud_auth: allow iff the actor is a member of the company's owning
 * organization AND holds a company membership; operators reach tenant data ONLY
 * via a live `hasActiveBreakGlass()` check (never a cached flag). Otherwise 403.
 * self-hosted (not enforced): the pre-existing behavior — `local_implicit`
 * loopback and legacy `isInstanceAdmin` bypass preserved.
 */
export async function assertCompanyAccess(db: Db, req: Request, companyId: string): Promise<void> {
  if (req.actor.type === "none") {
    throw unauthorized();
  }
  if (req.actor.type === "board" && req.actor.source === "local_implicit") {
    return; // self-hosted loopback
  }

  if (req.actor.type === "agent") {
    if (req.actor.companyId !== companyId) {
      throw forbidden("Agent key cannot access another company");
    }
    return;
  }
  if (req.actor.type === "commander") {
    // F1 (W7.5a): a Commander run-JWT is company-bound by construction (SC2
    // sets req.actor.companyId = jwt.company_id). It carries NO org/company
    // membership arrays, so it must NOT reach the cloud board branch below —
    // that branch would find memberOk === false and 403 EVERY same-company
    // Commander broker call. `ensureProtocolAccess` calls this for every actor,
    // so this branch is the ONLY gate that admits a cloud_auth Commander broker
    // call. Mirrors the agent branch above.
    if (req.actor.companyId !== companyId) {
      throw forbidden("Commander JWT cannot access another company");
    }
    return;
  }
  if (req.actor.type === "mcp") {
    if (req.actor.companyId !== companyId) {
      throw forbidden("MCP key cannot access another company");
    }
    // MCP keys are delegated user credentials. In cloud mode, the durable key
    // record is not sufficient authorization: an organization suspension can
    // leave both the company membership and key active. Authentication
    // revalidates both memberships once per request and caches the authorized
    // company snapshot here, so suspended keys cannot supply live company scope
    // to bare pre-handler lookups and normal requests do not repeat the query.
    if (tenantIsolationEnforced()) {
      if (!req.actor.userId || !(req.actor.companyIds ?? []).includes(companyId)) {
        throw forbidden("MCP key owner does not have active company access");
      }
    }
    return;
  }

  // board (session / board_key). Enforcement from STATIC mode — never req.tenant.
  if (!tenantIsolationEnforced()) {
    if (req.actor.isInstanceAdmin) return; // legacy self-hosted bypass
    const allowedCompanies = req.actor.companyIds ?? [];
    if (!allowedCompanies.includes(companyId)) {
      throw forbidden("User does not have access to this company");
    }
    return;
  }

  // cloud_auth: tenant + company membership; operators only via live break-glass.
  const tenantId = await resolveCompanyTenant(db, companyId);
  const orgs = req.actor.organizationIds ?? [];
  const companyIds = req.actor.companyIds ?? [];
  const memberOk = tenantId !== null && orgs.includes(tenantId) && companyIds.includes(companyId);
  if (memberOk) return;
  if (
    req.actor.operator &&
    req.actor.userId &&
    tenantId !== null &&
    (await hasActiveBreakGlass(db, req.actor.userId, companyId, tenantId))
  ) {
    return;
  }
  // Surface the org-mismatch error when the tenant boundary is what failed; else company-scope error.
  if (tenantId !== null && !orgs.includes(tenantId)) assertTenantMembership(req, tenantId);
  throw forbidden("User does not have access to this company");
}

/**
 * Derive the set of company ids an actor may access, for scoping bare-identifier
 * (no-company-in-URL) resolution.
 *
 * `undefined` = all-access (self-hosted loopback / self-hosted instance-admin):
 * the caller keeps the global unfiltered reject-ambiguous resolve.
 * `[]` = access nothing. Mirrors {@link assertCompanyAccess}'s allow rules so
 * bare-route identifier resolution is scoped to what the actor can reach.
 *
 * NOTE: intentionally does NOT mirror assertCompanyAccess's cloud break-glass
 * branch (~:73-80). A cloud operator with an active break-glass grant hitting a
 * BARE identifier route for a non-member company resolves to []→null→404
 * (fail-closed) rather than the task. Acceptable + unreachable today (break-glass
 * grant/revoke are inert); revisit if governed break-glass endpoints ever ship.
 */
export function accessibleCompanyIdsForActor(actor: Actor | undefined): string[] | undefined {
  if (!actor) return [];
  if (actor.type === "agent") return actor.companyId ? [actor.companyId] : [];
  if (actor.type === "mcp") {
    if (tenantIsolationEnforced()) return actor.companyIds ?? [];
    return actor.companyId ? [actor.companyId] : [];
  }
  if (actor.type === "board") {
    if (actor.source === "local_implicit") return undefined;
    if (!tenantIsolationEnforced() && actor.isInstanceAdmin) return undefined;
    return actor.companyIds ?? [];
  }
  return [];
}

export function getActorInfo(req: Request) {
  if (req.actor.type === "none") {
    throw unauthorized();
  }
  if (req.actor.type === "agent") {
    return {
      actorType: "agent" as const,
      actorId: req.actor.agentId ?? "unknown-agent",
      agentId: req.actor.agentId ?? null,
      runId: req.actor.runId ?? null,
    };
  }

  if (req.actor.type === "mcp") {
    return {
      actorType: "user" as const,
      actorId: req.actor.userId ?? "mcp-user",
      agentId: null,
      runId: req.actor.runId ?? null,
    };
  }

  return {
    actorType: "user" as const,
    actorId: req.actor.userId ?? "board",
    agentId: null,
    runId: req.actor.runId ?? null,
  };
}

/**
 * Non-throwing form of {@link assertCanManageInstanceSettings} — the single
 * source of truth for "can this actor manage instance settings". This reads the
 * operator-plane field `req.actor.operator` (computed by the auth middleware from
 * instance_user_roles; middleware/auth.ts) — NOT `isInstanceAdmin`, which is
 * clamped to false in cloud_auth to neutralize the DATA-plane bypass. Reading
 * `operator` keeps the OPERATOR plane (instance-settings management) intact after
 * that clamp. The local_trusted synthetic board user (source local_implicit) is
 * always allowed.
 */
export function canManageInstanceSettings(req: Request): boolean {
  if (req.actor.type !== "board") return false;
  return req.actor.source === "local_implicit" || req.actor.operator === true;
}

export function assertCanManageInstanceSettings(req: Request): void {
  if (req.actor.type !== "board") {
    throw forbidden("Board access required");
  }
  if (canManageInstanceSettings(req)) {
    return;
  }
  throw forbidden("Instance admin access required");
}
