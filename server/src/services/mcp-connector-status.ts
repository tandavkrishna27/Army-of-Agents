/**
 * @fileoverview THE single place that decides whether a connector may be `active`.
 *
 * Credential state and approval state are ORTHOGONAL axes. Collapsing them into
 * one linear status is what produced an earlier defect: `approvals.ts` flipped ANY
 * non-active connector to `active` on approve, which would activate a connector
 * with no credentials.
 *
 * INVARIANT (unconditional): this function never returns "active" while
 * `requiresSecret && !hasSecret`.
 *
 * SCOPE — this is now a CODEBASE-WIDE guarantee, not just a property of this
 * function. `company_mcp_connectors` has exactly two writers, both in
 * `services/mcp-connectors-crud.ts`: the INSERT in `create` and the UPDATE in
 * `update`. Every route into them consults this resolver before "active":
 *
 *  - create (`services/mcp-connector-create.ts`) — derives the status here
 *  - approve (`services/approvals.ts` → `applyConnectorApproval`) — derives it
 *    here. This used to set `status: "active"` directly, which was the exact
 *    defect described above re-introduced on a second path.
 *  - credential binding (`routes/mcp-connectors.ts` POST …/credentials) — derives
 *    it here
 *  - PATCH (`routes/mcp-connectors.ts`) — the one path where the founder ASSERTS
 *    a status rather than deriving one, so it is bounded instead: it refuses
 *    "active" unless this resolver would permit it on the credential axis, in
 *    EVERY deployment mode (FU-15).
 *
 * So: "status is active" implies a bound secret REFERENCE whenever one is
 * required. It does NOT imply a resolvable credential — `secretRef` names a row in
 * `company_secrets`, and that row can later be soft-deleted or deactivated. The
 * connector stays `active` and the delivery path drops it with a
 * `secret_unreachable` skip (see FU-1). Bound-reference is the invariant; live
 * credential is not.
 *
 * The guarantee is also keyed on `secretRef` being write-once-per-binding: a write
 * that CLEARS `secretRef` would break "active ⇒ bound" without being a status write
 * at all, and would therefore slip past every guard described above. That is why
 * `ConnectorPatch.secretRef` is `string` and not `string | null`.
 *
 * What PATCH still permits, deliberately, is GOVERNANCE latitude: in
 * `local_trusted` a founder may hand-set "active" on a connector that needs no
 * secret, with no approval. That is a loopback trust boundary with no governance
 * gate to bypass — and it is orthogonal to the credential invariant above.
 *
 * If you add a third writer to `company_mcp_connectors`, or make `secretRef`
 * clearable, this paragraph is the thing you are invalidating.
 */

export type ConnectorStatus = "pending_approval" | "needs_credentials" | "active" | "disabled";

export function resolveConnectorStatus(input: {
  deploymentMode: string;
  approved: boolean;
  requiresSecret: boolean;
  hasSecret: boolean;
}): ConnectorStatus {
  const { deploymentMode, approved, requiresSecret, hasSecret } = input;

  // Governance axis first: a shared deployment gates on board approval (D6).
  // local_trusted is a loopback trust boundary, so it is implicitly approved.
  const governanceSatisfied = deploymentMode === "local_trusted" || approved;
  if (!governanceSatisfied) return "pending_approval";

  // Credential axis second.
  if (requiresSecret && !hasSecret) return "needs_credentials";

  return "active";
}
