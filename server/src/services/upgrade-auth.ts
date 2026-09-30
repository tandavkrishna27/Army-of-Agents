import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import {
  agentApiKeys,
  agents,
  companyMemberships,
  instanceUserRoles,
  type Db,
} from "@armyofagents/db";
import type { DeploymentMode } from "@armyofagents/shared";
import { and, eq, isNull } from "drizzle-orm";
import type { BetterAuthSessionResult } from "../auth/better-auth.js";
import { getPreviewQueryAuthToken } from "./preview-auth-query.js";
import {
  hasActiveCloudMembership,
  type UpgradeSocketActorContext,
} from "./upgrade-socket-authorization.js";

export type UpgradeActorContext = UpgradeSocketActorContext;

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function parseBearerToken(rawAuth: string | string[] | undefined) {
  const auth = Array.isArray(rawAuth) ? rawAuth[0] : rawAuth;
  if (!auth) return null;
  if (!auth.toLowerCase().startsWith("bearer ")) return null;
  const token = auth.slice("bearer ".length).trim();
  return token.length > 0 ? token : null;
}

export function headersFromIncomingMessage(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, raw] of Object.entries(req.headers)) {
    if (!raw) continue;
    if (Array.isArray(raw)) {
      for (const value of raw) headers.append(key, value);
      continue;
    }
    headers.set(key, raw);
  }
  return headers;
}

export async function authorizeCompanyUpgrade(
  db: Db,
  req: IncomingMessage,
  companyId: string,
  url: URL,
  opts: {
    deploymentMode: DeploymentMode;
    resolveSessionFromHeaders?: (headers: Headers) => Promise<BetterAuthSessionResult | null>;
    /**
     * Exact trusted origins (scheme://host[:port], no wildcards) — the same
     * allowlist better-auth uses. Consulted ONLY on the cookie/session branch
     * to defend against Cross-Site WebSocket Hijacking. See the Origin check
     * below.
     */
    trustedOrigins?: string[];
  },
): Promise<UpgradeActorContext | null> {
  const queryToken = getPreviewQueryAuthToken(url);
  const authToken = parseBearerToken(req.headers.authorization);
  const token = authToken ?? queryToken;

  if (!token) {
    if (opts.deploymentMode === "local_trusted") {
      return { companyId, actorType: "board", actorId: "board" };
    }

    // Cookie/session (board) path for the two multi-user modes. `cloud_auth`
    // was previously excluded here (only `authenticated` was allowed through),
    // so a legitimate cloud board user opening a preview WebSocket with a session
    // cookie fell through to `return null` → 403.
    if (
      (opts.deploymentMode !== "authenticated" && opts.deploymentMode !== "cloud_auth") ||
      !opts.resolveSessionFromHeaders
    ) {
      return null;
    }

    // CSWSH defense-in-depth: cookie-authenticated WebSocket upgrades must carry
    // a trusted Origin. Browsers always send Origin on WS handshakes, so a
    // missing/empty Origin on this path is untrusted (agents authenticate with a
    // bearer/query token, which skips this branch entirely). SameSite=Lax only
    // mitigates a random third-party origin; same-site sibling subdomains remain
    // exploitable, and the protection regresses fully if cookies ever become
    // SameSite=None. `trustedOrigins` is the exact allowlist better-auth uses,
    // so any deploy where sign-in works already trusts the board origin.
    const origin = req.headers.origin;
    if (!origin || !(opts.trustedOrigins ?? []).includes(origin)) {
      return null;
    }

    const session = await opts.resolveSessionFromHeaders(headersFromIncomingMessage(req));
    const userId = session?.user?.id;
    if (!userId) return null;

    if (opts.deploymentMode === "cloud_auth") {
      // Mirror assertCompanyAccess (routes/authz.ts) tenant-isolation semantics:
      // allow iff the actor holds BOTH an active organization membership for the
      // company's owning organization AND an active company membership. A company
      // membership WITHOUT an org membership is DENIED (the deliberate tenant
      // invariant). No instance_admin/operator bypass here — assertCompanyAccess
      // reaches operators only via a live break-glass check, which this WS path
      // does not implement, so operators fall back to their real memberships.
      if (!(await hasActiveCloudMembership(db, companyId, userId))) return null;
      return { companyId, actorType: "board", actorId: userId };
    }

    // authenticated: instance_admin OR an active company membership (unchanged).
    const [roleRow, memberships] = await Promise.all([
      db
        .select({ id: instanceUserRoles.id })
        .from(instanceUserRoles)
        .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
        .then((rows) => rows[0] ?? null),
      db
        .select({ companyId: companyMemberships.companyId })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, userId),
            eq(companyMemberships.status, "active"),
          ),
        ),
    ]);

    const hasCompanyMembership = memberships.some((row) => row.companyId === companyId);
    if (!roleRow && !hasCompanyMembership) return null;
    return { companyId, actorType: "board", actorId: userId };
  }

  const tokenHash = hashToken(token);
  const key = await db
    .select()
    .from(agentApiKeys)
    .where(and(eq(agentApiKeys.keyHash, tokenHash), isNull(agentApiKeys.revokedAt)))
    .then((rows) => rows[0] ?? null);

  if (!key || key.companyId !== companyId) {
    return null;
  }

  const agent = await db
    .select()
    .from(agents)
    .where(eq(agents.id, key.agentId))
    .then((rows) => rows[0] ?? null);

  if (
    !agent ||
    agent.companyId !== key.companyId ||
    agent.status === "terminated" ||
    agent.status === "pending_approval"
  ) {
    return null;
  }

  await db
    .update(agentApiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(agentApiKeys.id, key.id));

  return { companyId, actorType: "agent", actorId: key.agentId, keyId: key.id };
}
