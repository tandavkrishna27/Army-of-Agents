export const MARKETPLACE_RECONCILIATION_ENTITY_TYPE =
  "marketplace_reconciliation";
export const MARKETPLACE_RECONCILIATION_ACTION_PREFIX =
  "marketplace.reconciliation_";

export class ReservedActivityNamespaceError extends Error {
  constructor() {
    super(
      "Marketplace reconciliation audit events are reserved for the reconciliation service",
    );
  }
}

export function assertUnreservedActivityNamespace(input: {
  action: string;
  entityType: string;
}): void {
  if (
    input.entityType === MARKETPLACE_RECONCILIATION_ENTITY_TYPE ||
    input.action.startsWith(MARKETPLACE_RECONCILIATION_ACTION_PREFIX)
  ) {
    throw new ReservedActivityNamespaceError();
  }
}
