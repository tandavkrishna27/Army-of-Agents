interface Actor {
  type: "none" | "board" | "agent" | "mcp" | "commander";
  source: string;
  userId?: string;
  companyId?: string;
  companyIds?: string[];
  organizationIds?: string[];
  /** Operator-plane authority (instance settings). Unclamped. NOT a data-plane bypass. */
  operator?: boolean;
  agentId?: string;
  keyId?: string;
  runId?: string;
  /** Commander JWT actor fields (W7.5a). Set only for type:"commander". */
  userRole?: string;
  conversationId?: string;
  turnId?: string;
  /** Data-plane admin bypass — derived FALSE in cloud_auth (Task 4). Legacy self-hosted only. */
  isInstanceAdmin?: boolean;
}

interface TenantContext {
  /** Reserved org-id hint only. NOT the enforcement source — see tenantIsolationEnforced(). */
  organizationId: string | null;
}

declare namespace Express {
  interface Request {
    actor: Actor;
    tenant?: TenantContext;
  }
}
