import {
  MARKETPLACE_RECOVERY,
  MARKETPLACE_RECOVERY_DOC_URL,
  MarketplaceReconcileErrorResponseSchema,
  type MarketplaceReconcileErrorCode,
} from "@armyofagents/shared";

export function isMarketplaceAdminPath(url: string): boolean {
  return url.startsWith("/api/admin/marketplace/");
}

export function marketplaceErrorResponse(
  code: MarketplaceReconcileErrorCode,
  operationId: string | null,
) {
  const recovery = MARKETPLACE_RECOVERY[code];
  const retry =
    recovery.retry.kind === "after"
      ? {
          ...recovery.retry,
          notBefore: new Date(Date.now() + 60_000).toISOString(),
        }
      : recovery.retry;
  return MarketplaceReconcileErrorResponseSchema.parse({
    ok: false,
    error: { code, message: recovery.message },
    operationId,
    retry,
    docUrl: MARKETPLACE_RECOVERY_DOC_URL,
  });
}
