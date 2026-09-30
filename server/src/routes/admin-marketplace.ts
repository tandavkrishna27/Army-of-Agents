import { Router } from "express";
import {
  MarketplaceReconcileRequestSchema,
  MarketplaceReconcileResponseSchema,
  MarketplaceReconciliationOperationIdSchema,
  MarketplaceReconciliationInspectionSchema,
  type MarketplaceReconciliationInspection,
} from "@armyofagents/shared";
import {
  MarketplaceCatalogRefreshError,
  MarketplaceReconcileExecutionError,
  MarketplaceReconciliationAlreadyExistsError,
  MarketplaceReconciliationInFlightError,
  MarketplaceReconciliationNotFoundError,
  MarketplaceReconciliationRetryReferenceInvalidError,
  MarketplaceReconciliationRetryRequiredError,
  MarketplaceReconciliationRetryUnsafeError,
  type MarketplaceReconciliationActor,
  type MarketplaceReconcileResult,
} from "../services/marketplace-reconcile.js";
import { marketplaceErrorResponse } from "../services/marketplace-http-contract.js";
import {
  canManageInstanceSettings,
  getActorInfo,
} from "./authz.js";

export interface AdminMarketplaceRoutesDeps {
  reconcile: (
    actor: MarketplaceReconciliationActor,
    operationId: string,
    retryOfOperationId: string | null,
  ) => Promise<MarketplaceReconcileResult>;
  inspect: (
    operationId: string,
    isActive: boolean,
  ) => Promise<MarketplaceReconciliationInspection>;
}

function authorize(req: Parameters<typeof canManageInstanceSettings>[0]) {
  if (req.actor.type === "none") {
    return { status: 401, code: "authentication_required" as const };
  }
  if (!canManageInstanceSettings(req)) {
    return { status: 403, code: "instance_admin_required" as const };
  }
  return null;
}

/**
 * Instance-wide operational controls. A matching concurrent operation joins
 * the same promise; a different ID cannot run until the active pass finishes.
 */
export function createAdminMarketplaceRouter(
  deps: AdminMarketplaceRoutesDeps,
): Router {
  const router = Router();
  let inFlight:
    | { operationId: string; promise: Promise<MarketplaceReconcileResult> }
    | null = null;

  router.post("/reconcile", async (req, res) => {
    const denied = authorize(req);
    if (denied) {
      res
        .status(denied.status)
        .json(marketplaceErrorResponse(denied.code, null));
      return;
    }

    const parsedRequest = MarketplaceReconcileRequestSchema.safeParse(req.body);
    if (!parsedRequest.success) {
      res.status(400).json(marketplaceErrorResponse("invalid_request", null));
      return;
    }
    const { operationId, retryOfOperationId = null } =
      parsedRequest.data;
    if (inFlight && inFlight.operationId !== operationId) {
      res
        .status(409)
        .json(
          marketplaceErrorResponse(
            "operation_in_flight",
            inFlight.operationId,
          ),
        );
      return;
    }

    let executionDisposition: "started" | "joined_in_flight" =
      "joined_in_flight";
    let operation = inFlight?.promise ?? null;
    if (!operation) {
      executionDisposition = "started";
      const actorInfo = getActorInfo(req);
      operation = (async () => {
        try {
          await deps.inspect(operationId, false);
          throw new MarketplaceReconciliationAlreadyExistsError(operationId);
        } catch (error) {
          if (
            !(error instanceof MarketplaceReconciliationNotFoundError)
          ) {
            throw error;
          }
        }
        if (retryOfOperationId) {
          let inspection: MarketplaceReconciliationInspection;
          try {
            inspection = await deps.inspect(retryOfOperationId, false);
          } catch {
            throw new MarketplaceReconciliationRetryUnsafeError(
              retryOfOperationId,
            );
          }
          if (
            inspection.operationId !== retryOfOperationId ||
            inspection.state !== "outcome_unknown_after_mutation" ||
            !inspection.safeToRetry
          ) {
            throw new MarketplaceReconciliationRetryUnsafeError(
              retryOfOperationId,
            );
          }
        }
        return deps.reconcile(
          { actorType: "user", actorId: actorInfo.actorId },
          operationId,
          retryOfOperationId,
        );
      })();
      // Publish the promise before the durable lookup yields so concurrent
      // callers either join this exact operation or receive operation_in_flight.
      inFlight = { operationId, promise: operation };
    }

    try {
      const result = await operation;
      res.json(
        MarketplaceReconcileResponseSchema.parse({
          ok: true,
          ...result,
          executionDisposition,
          replayed: executionDisposition === "joined_in_flight",
        }),
      );
    } catch (error) {
      if (error instanceof MarketplaceReconciliationAlreadyExistsError) {
        res
          .status(409)
          .json(marketplaceErrorResponse("invalid_request", operationId));
        return;
      }
      if (error instanceof MarketplaceReconciliationInFlightError) {
        res
          .status(409)
          .json(
            marketplaceErrorResponse(
              "operation_in_flight",
              error.activeOperationId,
            ),
          );
        return;
      }
      if (error instanceof MarketplaceReconciliationRetryRequiredError) {
        res
          .status(409)
          .json(
            marketplaceErrorResponse(
              "outcome_unknown_after_mutation",
              error.requiredOperationId,
            ),
          );
        return;
      }
      if (error instanceof MarketplaceReconciliationRetryUnsafeError) {
        res
          .status(409)
          .json(
            marketplaceErrorResponse(
              "outcome_unknown_after_mutation",
              error.retryOfOperationId,
            ),
          );
        return;
      }
      if (
        error instanceof
        MarketplaceReconciliationRetryReferenceInvalidError
      ) {
        res
          .status(409)
          .json(marketplaceErrorResponse("invalid_request", operationId));
        return;
      }
      if (error instanceof MarketplaceCatalogRefreshError) {
        const code =
          error.catalogOutcome === "failure"
            ? "catalog_temporarily_unavailable"
            : "catalog_refresh_failed";
        res
          .status(502)
          .json(marketplaceErrorResponse(code, error.operationId));
        return;
      }
      if (error instanceof MarketplaceReconcileExecutionError) {
        res
          .status(500)
          .json(
            marketplaceErrorResponse(error.outcome, error.operationId),
          );
        return;
      }
      res
        .status(500)
        .json(marketplaceErrorResponse("internal_error", operationId));
    } finally {
      if (inFlight?.promise === operation) {
        inFlight = null;
      }
    }
  });

  router.get("/reconciliations/:operationId", async (req, res) => {
    const denied = authorize(req);
    if (denied) {
      res
        .status(denied.status)
        .json(marketplaceErrorResponse(denied.code, null));
      return;
    }

    const parsedId =
      MarketplaceReconciliationOperationIdSchema.safeParse(
        req.params.operationId,
      );
    if (!parsedId.success) {
      res.status(400).json(marketplaceErrorResponse("invalid_request", null));
      return;
    }
    try {
      const inspection = await deps.inspect(
        parsedId.data,
        inFlight?.operationId === parsedId.data,
      );
      res.json(MarketplaceReconciliationInspectionSchema.parse(inspection));
    } catch (error) {
      if (error instanceof MarketplaceReconciliationNotFoundError) {
        res
          .status(404)
          .json(marketplaceErrorResponse("operation_not_found", parsedId.data));
        return;
      }
      res
        .status(500)
        .json(marketplaceErrorResponse("internal_error", parsedId.data));
    }
  });

  return router;
}
