import os from "node:os";
import path from "node:path";
import type { DeploymentMode } from "@armyofagents/shared";

export interface CompanyWorkspaceRoot {
  /** Base directory the company's filesystem browse/mkdir is confined to. */
  baseDir: string;
  /**
   * Whether browse/mkdir must be confined (jailed) to `baseDir`. false in
   * local_trusted mode — the founder is a trusted, loopback-only actor and
   * browses their real filesystem (starting at their home dir) so they can
   * reach existing repos anywhere on disk.
   */
  jailed: boolean;
}

// A companyId is expected to be a UUID (or similarly opaque id). Reject
// anything containing a path separator or traversal segment up front so a
// malformed/attacker-controlled companyId can never influence which
// directory gets joined onto the jail base — path.join() alone would
// silently normalize `..` segments into an escape.
const SAFE_COMPANY_ID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * WS0a — single capability, two deployment-mode implementations, behind one
 * seam. This is where a future `environments`/`environment_leases` volume
 * backend swaps in without touching onboarding UI or the route layer.
 *
 * - `local_trusted`: the founder IS trusted (loopback boundary). Return the
 *   real home area (unjailed) so "bring your existing work in" can reach
 *   real, pre-existing repos anywhere on disk — matching today's founder
 *   instance-admin browse flow.
 * - `authenticated` (multi-tenant): return a server-owned, per-company base
 *   dir under the instance-configured workspace base — NOT the
 *   user-mutable `company.rootFolder` column (a member can PATCH that).
 *   Callers MUST treat the result as jailed (see services/fs-jail.ts).
 */
export function resolveCompanyWorkspaceRoot(
  companyId: string,
  deploymentMode: DeploymentMode,
  opts: { companyWorkspaceBaseDir: string },
): CompanyWorkspaceRoot {
  if (deploymentMode === "local_trusted") {
    return { baseDir: os.homedir(), jailed: false };
  }

  if (!SAFE_COMPANY_ID_RE.test(companyId)) {
    throw new Error(`Invalid companyId for workspace root: '${companyId}'`);
  }

  return {
    baseDir: path.join(opts.companyWorkspaceBaseDir, companyId),
    jailed: true,
  };
}
