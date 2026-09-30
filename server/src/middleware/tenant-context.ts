import type { RequestHandler } from "express";

/**
 * Sets a reserved per-request tenant hint (`req.tenant`). This is a HINT only —
 * NOT the enforcement source. Tenant isolation is decided by the STATIC
 * `tenantIsolationEnforced()` (see config/deployment-mode.ts), never by this
 * mutable per-request field. If this middleware is skipped for any handler,
 * enforcement still fails CLOSED because the static source is authoritative.
 *
 * `organizationId` is left null; the resolved org id is derived at decision
 * time (resolveCompanyTenant) rather than eagerly per request.
 */
export function tenantContextMiddleware(): RequestHandler {
  return (req, _res, next) => {
    req.tenant = { organizationId: null };
    next();
  };
}
