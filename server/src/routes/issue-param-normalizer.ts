import type { Request, Router } from "express";
import type { Db } from "@armyofagents/db";
import { issueService } from "../services/issues.js";
import { accessibleCompanyIdsForActor, assertCompanyAccess } from "./authz.js";
import { notFound } from "../errors.js";

const ISSUE_IDENTIFIER_RE = /^[A-Z]+-\d+$/i;

export function createIssueParamNormalizer(db: Db) {
  const issues = issueService(db);

  /**
   * Resolve an issue identifier (e.g. `ACM-1`) to its UUID. When `companyId`
   * is provided, the lookup is company-scoped (`getByIdentifierInCompany`) so
   * an identifier that two orgs' companies both own resolves to THIS company's
   * task — never another org's. When `companyId` is absent (bare
   * `/issues/:id…` routes with no company in the URL), it falls back to the
   * bare-route resolve scoped to `accessibleCompanyIds` (the actor's reachable
   * companies) so a cross-tenant collision can't 409/leak to a legitimate
   * single-org user; those callers still re-check authz on the resolved issue's
   * company (see `issueService.getByIdentifier` doc).
   */
  return async function normalizeIssueParam(
    rawId: string,
    companyId?: string,
    accessibleCompanyIds?: string[],
  ): Promise<string> {
    if (ISSUE_IDENTIFIER_RE.test(rawId)) {
      const issue = companyId
        ? await issues.getByIdentifierInCompany(companyId, rawId)
        : await issues.getByIdentifier(rawId, accessibleCompanyIds);
      if (issue) return issue.id;
      // Identifier-shaped but nothing resolved: DON'T return the raw
      // `ACM-999` — the UUID-column callers (artifacts/output-detection/
      // task-outputs/dependencies) would feed it into a uuid comparison and
      // hit Postgres 22P02 → un-statused → 500. Emit a proper 404 instead. A
      // real UUID cannot match ISSUE_IDENTIFIER_RE, so a genuine-but-absent
      // UUID still falls through to the handler's own 404 below.
      throw notFound(`Task ${rawId} not found`);
    }
    return rawId;
  };
}

/**
 * Register `router.param` normalizers that resolve issue identifiers to UUIDs.
 *
 * When `companyParamName` is supplied AND that param is present on the request
 * (a company-scoped route such as `/companies/:companyId/issues/:issueId/…`),
 * the resolve is company-scoped. Otherwise it falls back to the unscoped global
 * resolve (bare `/issues/:id…` routes). Express populates all of a matched
 * route's params before the param callbacks fire, and `:companyId` precedes
 * `:issueId` in the company-scoped route paths, so `req.params[companyParamName]`
 * is available here without needing `mergeParams`.
 */
export function registerIssueParamNormalizer(
  router: Router,
  db: Db,
  paramNames: string[],
  companyParamName?: string,
) {
  const normalizeIssueParam = createIssueParamNormalizer(db);
  for (const paramName of paramNames) {
    router.param(paramName, async (req: Request, _res, next, rawId) => {
      try {
        const companyId = companyParamName
          ? (req.params[companyParamName] as string | undefined)
          : undefined;
        // Express parameter hooks run before handlers. Authorize the URL company
        // before resolving a human-readable identifier inside it; otherwise an
        // unauthorized caller can distinguish an existing task (later 401/403)
        // from an absent one (404 here).
        if (companyId) {
          await assertCompanyAccess(db, req, companyId);
        }
        // Bare route (no company in URL): scope the global resolve to the
        // actor's accessible companies. Company-scoped routes ignore this.
        req.params[paramName] = await normalizeIssueParam(
          rawId,
          companyId,
          companyId ? undefined : accessibleCompanyIdsForActor(req.actor),
        );
        next();
      } catch (err) {
        next(err);
      }
    });
  }
}
